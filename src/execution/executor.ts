import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import bs58 from "bs58";
import { createRequire } from "node:module";

import type {
  PumpSdk as PumpSdkType,
  OnlinePumpSdk as OnlinePumpSdkType,
} from "@pump-fun/pump-sdk";

const require = createRequire(import.meta.url);

const {
  PumpSdk,
  OnlinePumpSdk,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
} = require("@pump-fun/pump-sdk");

import { config } from "../config.js";
import { logger } from "../logger.js";

export function loadWallet(): Keypair {
  return Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey));
}

/**
 * @pump-fun/pump-sdk (v1.36.0) splits into two classes:
 *   - OnlinePumpSdk: takes a Connection, fetches on-chain state
 *     (fetchGlobal, fetchFeeConfig, fetchBuyState, fetchSellState).
 *   - PumpSdk: no-arg, pure instruction builder — you feed it the state
 *     OnlinePumpSdk fetched (buyInstructions, sellInstructions).
 * Verified against node_modules/@pump-fun/pump-sdk/src/{sdk.ts,onlineSdk.ts,bondingCurve.ts}
 * on 2026-08-04 — re-check this comment against the installed version if
 * buy/sell starts throwing type errors after a npm update.
 */
export class Executor {
  private online: OnlinePumpSdkType;
  private offline: PumpSdkType;
  private connection: Connection;
  private wallet: Keypair;
  private protocolState: { expiresAt: number; value: Promise<[any, any]> } | null = null;

  constructor(connection: Connection, wallet: Keypair) {
    this.connection = connection;
    this.wallet = wallet;
    this.online = new OnlinePumpSdk(connection);
    this.offline = new PumpSdk();
  }

  get walletPublicKey(): PublicKey {
    return this.wallet.publicKey;
  }

  private priorityFeeIxs() {
    return [
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: config.risk.priorityFeeMicroLamports,
      }),
    ];
  }

  // slippage in this SDK is a PERCENTAGE number, not a fraction or bps —
  // confirmed from sdk.ts's fee math: `slippage * 10 / 1000` (slippage=1 → 1%).
  private slippagePct(): number {
    return config.risk.slippageBps / 100;
  }

  /** Global/fee state is shared by every pump.fun trade and changes far
   * less often than the per-mint bonding-curve state. Caching it keeps the
   * critical path to the mint-specific RPC reads. */
  private getProtocolState(): Promise<[any, any]> {
    const now = Date.now();
    if (!this.protocolState || now >= this.protocolState.expiresAt) {
      this.protocolState = {
        expiresAt: now + config.execution.protocolStateCacheMs,
        value: Promise.all([this.online.fetchGlobal(), this.online.fetchFeeConfig()]),
      };
    }
    return this.protocolState.value;
  }

  /** Submit first; confirmation is deliberately not on the snipe path.
   * A fast RPC can accept the packet immediately, while a standard RPC still
   * performs its normal preflight unless FAST_SUBMIT is explicitly enabled. */
  private async submit(tx: Transaction): Promise<string> {
    tx.feePayer = this.wallet.publicKey;
    const { blockhash } = await this.connection.getLatestBlockhash("processed");
    tx.recentBlockhash = blockhash;
    tx.sign(this.wallet);
    return this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: config.execution.fastSubmit,
      preflightCommitment: "processed",
      maxRetries: config.execution.maxRetries,
    });
  }

  /**
   * Buy `sizeSol` worth of `mint`. Returns the tx signature and the token
   * amount received (raw units, per the SDK's BN), or null if the buy
   * failed — callers should NOT record a position on null.
   */
  private async getTokenProgram(mint: PublicKey): Promise<PublicKey> {
    const accountInfo = await this.connection.getAccountInfo(mint);

    if (!accountInfo) {
      throw new Error(`Mint account not found: ${mint.toBase58()}`);
    }

    if (accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      return TOKEN_2022_PROGRAM_ID;
    }

    if (accountInfo.owner.equals(TOKEN_PROGRAM_ID)) {
      return TOKEN_PROGRAM_ID;
    }

    throw new Error(
      `Unsupported token program ${accountInfo.owner.toBase58()} for mint ${mint.toBase58()}`
    );
  }
  async buy(mint: string, sizeSol: number): Promise<{ signature: string; tokenAmount: BN } | null> {
    try {
      if (config.dryRun) {
        const tokenAmount = new BN(Math.round(sizeSol * 1e9));
        logger.trade(`[DRY RUN] BUY ${mint}: ${sizeSol} SOL (no transaction sent)`);
        return { signature: `dry-run-buy-${Date.now()}`, tokenAmount };
      }
      const mintPk = new PublicKey(mint);
      const user = this.wallet.publicKey;
      const tokenProgram = await this.getTokenProgram(mintPk);

      const [global, feeConfig] = await this.getProtocolState();
      const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } =
        await this.online.fetchBuyState(mintPk, user, tokenProgram);

      const solAmount = new BN(Math.round(sizeSol * 1e9)); // SOL -> lamports
      const tokenAmount = getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: bondingCurve.tokenTotalSupply,
        bondingCurve,
        amount: solAmount,
        quoteMint: bondingCurve.quoteMint,
      });

      const ixs = await this.offline.buyInstructions({
        global,
        bondingCurveAccountInfo,
        bondingCurve,
        associatedUserAccountInfo,
        mint: mintPk,
        user,
        solAmount,
        amount: tokenAmount,
        slippage: this.slippagePct(),
        tokenProgram,
      });

      const tx = new Transaction().add(...this.priorityFeeIxs(), ...ixs);
      const signature = await this.submit(tx);

      logger.trade(`BUY submitted ${mint}: ${sizeSol} SOL -> tx ${signature}`);
      return { signature, tokenAmount };
    } catch (err) {
      logger.error(`Buy failed for ${mint}:`, err);
      return null;
    }
  }

  /** Sell an entire position. Returns the SOL received, or null on failure. */
  async sellAll(mint: string, tokenAmount: BN): Promise<{ signature: string; solReceived: number } | null> {
    try {
      if (config.dryRun) {
        const solReceived = tokenAmount.toNumber() / 1e9;
        logger.trade(`[DRY RUN] SELL ${mint}: ~${solReceived.toFixed(4)} SOL (no transaction sent)`);
        return { signature: `dry-run-sell-${Date.now()}`, solReceived };
      }
      const mintPk = new PublicKey(mint);
      const user = this.wallet.publicKey;
      const tokenProgram = await this.getTokenProgram(mintPk);

      const [global, feeConfig] = await this.getProtocolState();
      const { bondingCurveAccountInfo, bondingCurve } = await this.online.fetchSellState(
        mintPk,
        user,
        tokenProgram
      );

      const solAmount = getSellSolAmountFromTokenAmount({
        global,
        feeConfig,
        mintSupply: bondingCurve.tokenTotalSupply,
        bondingCurve,
        amount: tokenAmount,
      });

      const ixs = await this.offline.sellInstructions({
        global,
        bondingCurveAccountInfo,
        bondingCurve,
        mint: mintPk,
        user,
        amount: tokenAmount,
        solAmount,
        slippage: this.slippagePct(),
        tokenProgram,
        mayhemMode: bondingCurve.isMayhemMode,
      });

      const tx = new Transaction().add(...this.priorityFeeIxs(), ...ixs);
      const signature = await this.submit(tx);

      const solReceived = solAmount.toNumber() / 1e9;
      logger.trade(`SELL submitted ${mint}: -> ${solReceived.toFixed(4)} SOL, tx ${signature}`);
      return { signature, solReceived };
    } catch (err) {
      logger.error(`Sell failed for ${mint}:`, err);
      return null;
    }
  }
}

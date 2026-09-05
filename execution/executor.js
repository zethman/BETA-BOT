import { Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, } from "@solana/spl-token";
import BN from "bn.js";
import bs58 from "bs58";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PumpSdk, OnlinePumpSdk, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount, } = require("@pump-fun/pump-sdk");
import { config } from "../config.js";
import { logger } from "../logger.js";
export function loadWallet() {
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
    online;
    offline;
    connection;
    wallet;
    constructor(connection, wallet) {
        this.connection = connection;
        this.wallet = wallet;
        this.online = new OnlinePumpSdk(connection);
        this.offline = new PumpSdk();
    }
    get walletPublicKey() {
        return this.wallet.publicKey;
    }
    priorityFeeIxs() {
        return [
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: config.risk.priorityFeeMicroLamports,
            }),
        ];
    }
    // slippage in this SDK is a PERCENTAGE number, not a fraction or bps —
    // confirmed from sdk.ts's fee math: `slippage * 10 / 1000` (slippage=1 → 1%).
    slippagePct() {
        return config.risk.slippageBps / 100;
    }
    /**
     * Buy `sizeSol` worth of `mint`. Returns the tx signature and the token
     * amount received (raw units, per the SDK's BN), or null if the buy
     * failed — callers should NOT record a position on null.
     */
    async getTokenProgram(mint) {
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
        throw new Error(`Unsupported token program ${accountInfo.owner.toBase58()} for mint ${mint.toBase58()}`);
    }
    async buy(mint, sizeSol) {
        try {
            if (config.dryRun) {
                const tokenAmount = new BN(Math.round(sizeSol * 1e9));
                logger.trade(`[DRY RUN] BUY ${mint}: ${sizeSol} SOL (no transaction sent)`);
                return { signature: `dry-run-buy-${Date.now()}`, tokenAmount };
            }
            const mintPk = new PublicKey(mint);
            const user = this.wallet.publicKey;
            const tokenProgram = await this.getTokenProgram(mintPk);
            const [global, feeConfig] = await Promise.all([
                this.online.fetchGlobal(),
                this.online.fetchFeeConfig(),
            ]);
            const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } = await this.online.fetchBuyState(mintPk, user, tokenProgram);
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
            const signature = await sendAndConfirmTransaction(this.connection, tx, [this.wallet], {
                commitment: "confirmed",
            });
            logger.trade(`BUY ${mint}: ${sizeSol} SOL -> tx ${signature}`);
            return { signature, tokenAmount };
        }
        catch (err) {
            logger.error(`Buy failed for ${mint}:`, err);
            return null;
        }
    }
    /** Sell an entire position. Returns the SOL received, or null on failure. */
    async sellAll(mint, tokenAmount) {
        try {
            if (config.dryRun) {
                const solReceived = tokenAmount.toNumber() / 1e9;
                logger.trade(`[DRY RUN] SELL ${mint}: ~${solReceived.toFixed(4)} SOL (no transaction sent)`);
                return { signature: `dry-run-sell-${Date.now()}`, solReceived };
            }
            const mintPk = new PublicKey(mint);
            const user = this.wallet.publicKey;
            const tokenProgram = await this.getTokenProgram(mintPk);
            const [global, feeConfig] = await Promise.all([
                this.online.fetchGlobal(),
                this.online.fetchFeeConfig(),
            ]);
            const { bondingCurveAccountInfo, bondingCurve } = await this.online.fetchSellState(mintPk, user, tokenProgram);
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
            const signature = await sendAndConfirmTransaction(this.connection, tx, [this.wallet], {
                commitment: "confirmed",
            });
            const solReceived = solAmount.toNumber() / 1e9;
            logger.trade(`SELL ${mint}: -> ${solReceived.toFixed(4)} SOL, tx ${signature}`);
            return { signature, solReceived };
        }
        catch (err) {
            logger.error(`Sell failed for ${mint}:`, err);
            return null;
        }
    }
}

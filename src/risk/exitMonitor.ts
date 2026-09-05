import BN from "bn.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { createRequire } from "node:module";

import type {
  OnlinePumpSdk as OnlinePumpSdkType,
} from "@pump-fun/pump-sdk";

const require = createRequire(import.meta.url);

const {
  OnlinePumpSdk,
  getSellSolAmountFromTokenAmount,
} = require("@pump-fun/pump-sdk");
import { Executor } from "../execution/executor.js";
import { RiskManager } from "./riskManager.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

interface TrackedPosition {
  mint: string;
  entrySol: number;
  tokenAmount: BN;
}

/**
 * Polls every open position's current sellable SOL value and exits on
 * take-profit or stop-loss. This is intentionally simple (poll + compare)
 * rather than event-driven — it's the part of the bot least sensitive to
 * data-layer latency, so the free RPC tier is genuinely fine here.
 */
export class ExitMonitor {
  private tracked = new Map<string, TrackedPosition>();
  private online: OnlinePumpSdkType;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private connection: Connection,
    private executor: Executor,
    private riskManager: RiskManager
  ) {
    this.online = new OnlinePumpSdk(connection);
  }

  track(mint: string, entrySol: number, tokenAmount: BN) {
    this.tracked.set(mint, { mint, entrySol, tokenAmount });
  }

  /** External trigger (e.g. copy-trade target sold) — exits immediately if we hold it. */
  async forceExit(mint: string): Promise<boolean> {
    const pos = this.tracked.get(mint);
    if (!pos) return false;
    await this.exit(pos);
    return true;
  }

  start() {
    this.timer = setInterval(() => this.checkAll(), config.risk.exitPollIntervalSec * 1000);
    logger.info(`Exit monitor started (poll every ${config.risk.exitPollIntervalSec}s)`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async checkAll() {
    for (const pos of this.tracked.values()) {
      try {
        await this.checkOne(pos);
      } catch (err) {
        logger.warn(`Exit check failed for ${pos.mint}:`, err);
      }
    }
  }

  private async checkOne(pos: TrackedPosition) {
    const mintPk = new PublicKey(pos.mint);
    const [global, feeConfig] = await Promise.all([
      this.online.fetchGlobal(),
      this.online.fetchFeeConfig(),
    ]);
    const { bondingCurve } = await this.online.fetchSellState(mintPk, this.executor.walletPublicKey);

    const currentSolValue =
      getSellSolAmountFromTokenAmount({
        global,
        feeConfig,
        mintSupply: bondingCurve.tokenTotalSupply,
        bondingCurve,
        amount: pos.tokenAmount,
      }).toNumber() / 1e9;

    const changePct = ((currentSolValue - pos.entrySol) / pos.entrySol) * 100;

    if (changePct >= config.risk.takeProfitPct) {
      logger.trade(`TAKE PROFIT ${pos.mint}: +${changePct.toFixed(1)}%`);
      await this.exit(pos);
    } else if (changePct <= -config.risk.stopLossPct) {
      logger.trade(`STOP LOSS ${pos.mint}: ${changePct.toFixed(1)}%`);
      await this.exit(pos);
    }
  }

  private async exit(pos: TrackedPosition) {
    this.tracked.delete(pos.mint);
    const result = await this.executor.sellAll(pos.mint, pos.tokenAmount);
    if (result) {
      this.riskManager.recordClose(pos.mint, result.solReceived);
    } else {
      // Sell failed (e.g. RPC hiccup) — re-track so the next poll retries
      // rather than silently dropping the position from monitoring.
      this.tracked.set(pos.mint, pos);
    }
  }
}

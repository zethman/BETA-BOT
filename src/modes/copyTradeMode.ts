import { Connection, PublicKey } from "@solana/web3.js";
import { subscribeWalletLogs } from "../data/rpcListener.js";
import { classifyLogs, parseTradeEvent } from "../parsing/pumpfunParser.js";
import { evaluateMirror } from "../filters/copyFilters.js";
import { Executor } from "../execution/executor.js";
import { RiskManager } from "../risk/riskManager.js";
import { ExitMonitor } from "../risk/exitMonitor.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

export function startCopyTradeMode(
  connection: Connection,
  executor: Executor,
  riskManager: RiskManager,
  exitMonitor: ExitMonitor
) {
  for (const targetAddr of config.copyTargetWallets) {
    const target = new PublicKey(targetAddr);

    subscribeWalletLogs(connection, target, async (logs) => {
      try {
        const kind = classifyLogs(logs.logs);
        if (kind !== "trade") return;

        const event = await parseTradeEvent(connection, logs.signature, null, targetAddr);
        if (!event || event.kind !== "trade") return;

        logger.info(`Target ${targetAddr} ${event.side} ${event.solAmount.toFixed(4)} SOL of ${event.mint}`);

        if (event.side === "sell") {
          // If we're mirroring this wallet and WE hold the position, exit
          // ours too — don't wait on our own TP/SL if the wallet we're
          // copying just dumped.
          const exited = await exitMonitor.forceExit(event.mint);
          if (exited) logger.trade(`Target sold ${event.mint} — mirrored exit`);
          return;
        }

        const decision = evaluateMirror(event);
        if (!decision.approve) {
          logger.info(`Skip mirroring ${event.mint}: ${decision.reason}`);
          return;
        }

        const blockReason = riskManager.reserveOpen(event.mint, decision.sizeSol);
        if (blockReason) {
          logger.info(`Blocked by risk manager for ${event.mint}: ${blockReason}`);
          return;
        }

        const result = await executor.buy(event.mint, decision.sizeSol);
        if (result) {
          riskManager.recordOpen(event.mint, decision.sizeSol, result.tokenAmount.toNumber());
          exitMonitor.track(event.mint, decision.sizeSol, result.tokenAmount);
        } else {
          riskManager.releaseOpenReservation(event.mint);
        }
      } catch (err) {
        logger.error("Copy-trade handler error (continuing):", err);
      }
    });
  }

  logger.info(`Copy trade mode active, mirroring ${config.copyTargetWallets.length} wallet(s)`);
}

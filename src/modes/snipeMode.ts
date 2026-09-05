import { Connection, PublicKey } from "@solana/web3.js";
import { PUMPFUN_PROGRAM_ID } from "../constants.js";
import { subscribeProgramLogs } from "../data/rpcListener.js";
import { classifyLogs, parseCreateEvent } from "../parsing/pumpfunParser.js";
import { fetchTokenEnrichment } from "../data/solanaTracker.js";
import { evaluateSnipe } from "../filters/snipeFilters.js";
import { Executor } from "../execution/executor.js";
import { RiskManager } from "../risk/riskManager.js";
import { ExitMonitor } from "../risk/exitMonitor.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

export function startSnipeMode(
  connection: Connection,
  executor: Executor,
  riskManager: RiskManager,
  exitMonitor: ExitMonitor
) {
  const programId = new PublicKey(PUMPFUN_PROGRAM_ID);

  // Processed commitment reduces launch-detection latency. The parsed
  // transaction and actual execution still use confirmed RPC calls below.
  subscribeProgramLogs(connection, programId, async (logs) => {
    try {
      const kind = classifyLogs(logs.logs);
      if (kind !== "create") return;

      const event = await parseCreateEvent(connection, logs.signature, null);
      if (!event || event.kind !== "create") return;

      logger.info(`New launch detected: ${event.mint} by ${event.creator}`);

      const enriched = await fetchTokenEnrichment(config.solanaTrackerApiKey, event.mint);
      const decision = evaluateSnipe(event, enriched);

      if (!decision.approve) {
        logger.info(`Skip ${event.mint}: ${decision.reason}`);
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
      // Never let a single bad event kill the process — a crash here
      // means the exit monitor stops watching any open positions too.
      logger.error("Snipe handler error (continuing):", err);
    }
  }, "processed");

  logger.info("Snipe mode active");
}

import { Connection, PublicKey, Logs, Context, Commitment } from "@solana/web3.js";
import { logger } from "../logger.js";

export type LogHandler = (logs: Logs, ctx: Context) => void;

/**
 * Subscribe to every log line that mentions the pump.fun program — this
 * is the firehose used for sniping (new Create instructions) and for
 * general trade detection.
 *
 * NOTE (free tier caveat): logsSubscribe over a public/shared RPC will
 * lag behind a real Yellowstone/Geyser gRPC stream by anywhere from
 * ~200ms to multiple seconds depending on provider load. Fine for
 * proving out strategy logic and for copy trading (you're reacting to a
 * wallet, not racing other snipers). Swap this module out for a
 * Yellowstone client later — nothing else in the pipeline needs to change,
 * since everything downstream consumes the same PumpfunEvent shape.
 */
export function subscribeProgramLogs(
  connection: Connection,
  programId: PublicKey,
  onLogs: LogHandler,
  commitment: Commitment = "confirmed"
): number {
  logger.info(`Subscribing to ${commitment} logs for program ${programId.toBase58()}`);
  return connection.onLogs(programId, (logs, ctx) => {
    if (logs.err) return; // skip failed txs, nothing to act on
    onLogs(logs, ctx);
  }, commitment);
}

/**
 * Subscribe to logs mentioning a specific wallet — used for copy trading.
 * `mentions` matches any transaction where the address appears in the
 * account list, which covers that wallet's own buys/sells.
 */
export function subscribeWalletLogs(
  connection: Connection,
  wallet: PublicKey,
  onLogs: LogHandler
): number {
  logger.info(`Subscribing to logs for wallet ${wallet.toBase58()}`);
  return connection.onLogs(wallet, (logs, ctx) => {
    if (logs.err) return;
    onLogs(logs, ctx);
  }, "confirmed");
}

export async function unsubscribe(connection: Connection, id: number): Promise<void> {
  await connection.removeOnLogsListener(id);
}

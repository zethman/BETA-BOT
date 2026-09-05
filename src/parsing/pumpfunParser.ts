import { Connection, PublicKey, ParsedTransactionWithMeta } from "@solana/web3.js";
import { PUMPFUN_PROGRAM_ID, LOG_MARKERS } from "../constants.js";
import { PumpfunEvent } from "../types.js";
import { logger } from "../logger.js";
import { throttledRpcCall } from "../data/rpcThrottle.js";
import { fetchTokenMetadata } from "./metadata.js";

const PUMP_PROGRAM = new PublicKey(PUMPFUN_PROGRAM_ID);

export function getBondingCurvePda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_PROGRAM
  );
  return pda;
}

/** Cheap pre-filter on raw log strings before we pay for a getTransaction call. */
export function classifyLogs(logLines: string[]): "create" | "trade" | null {
  const joined = logLines.join("\n");
  if (joined.includes(LOG_MARKERS.CREATE)) return "create";
  if (joined.includes(LOG_MARKERS.BUY) || joined.includes(LOG_MARKERS.SELL)) return "trade";
  return null;
}

async function fetchParsedTx(
  connection: Connection,
  signature: string
): Promise<ParsedTransactionWithMeta | null> {
  // maxSupportedTransactionVersion: 0 covers both legacy and v0 txs.
  // Throttled: on a shared public RPC, the pump.fun program-wide firehose
  // generates far more getParsedTransaction calls than the free tier
  // tolerates, and unthrottled 429 storms crash the process (see
  // rpcThrottle.ts and index.ts's process-level safety net).
  // getTransaction is only available at confirmed/finalized commitment on
  // Solana RPC. Retry briefly because a null response is propagation delay,
  // not an invalid event. For sub-confirmation detection, replace this
  // parser with the configured Geyser/Yellowstone listener.
  for (let attempt = 0; attempt < 4; attempt++) {
    const tx = await throttledRpcCall(() =>
      connection.getParsedTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      })
    );
    if (tx) return tx;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)));
  }
  return null;
}

/**
 * Decode a Create event.
 *
 * Approach: the newly-minted token's address is reliably the mint field
 * of the first postTokenBalances entry (this is the same technique used
 * in Shyft's and Chainstack's public pump.fun monitoring guides) — it
 * doesn't depend on decoding pump.fun's internal Anchor event bytes, so
 * it keeps working across the program upgrades pump.fun has shipped
 * before (fee-recipient changes, create_v2, mayhem mode, etc).
 */
export async function parseCreateEvent(
  connection: Connection,
  signature: string,
  blockTime: number | null
): Promise<PumpfunEvent | null> {
  const tx = await fetchParsedTx(connection, signature);
  if (!tx || !tx.meta) return null;

  const postBalances = tx.meta.postTokenBalances;
  if (!postBalances || postBalances.length === 0) {
    logger.warn(`No postTokenBalances for create tx ${signature}, skipping`);
    return null;
  }

  const mint = postBalances[0].mint;
  const creator = tx.transaction.message.accountKeys[0].pubkey.toBase58();
  const bondingCurve = getBondingCurvePda(new PublicKey(mint)).toBase58();
  const metadata = await fetchTokenMetadata(connection, new PublicKey(mint));

  return {
    kind: "create",
    signature,
    mint,
    creator,
    bondingCurve,
    name: metadata?.name,
    symbol: metadata?.symbol,
    uri: metadata?.uri,
    timestamp: blockTime ?? Math.floor(Date.now() / 1000),
  };
}

/**
 * Decode a Buy/Sell event from SOL balance deltas on the trader (fee
 * payer) account. This sidesteps needing pump.fun's exact instruction
 * account ordering or event discriminators — it just reads what actually
 * moved, which is program-upgrade-proof by construction.
 *
 * Caveat: the SOL delta includes the ~5000-lamport (0.000005 SOL) network
 * fee, which is noise at any realistic trade size but worth knowing about
 * if you're reconciling exact amounts later.
 */
export async function parseTradeEvent(
  connection: Connection,
  signature: string,
  blockTime: number | null,
  traderHint?: string
): Promise<PumpfunEvent | null> {
  const tx = await fetchParsedTx(connection, signature);
  if (!tx || !tx.meta) return null;

  const accountKeys = tx.transaction.message.accountKeys;
  const traderIndex = traderHint
    ? accountKeys.findIndex((k) => k.pubkey.toBase58() === traderHint)
    : 0; // fall back to fee payer
  if (traderIndex === -1) return null;

  const trader = accountKeys[traderIndex].pubkey.toBase58();
  const preSol = tx.meta.preBalances[traderIndex];
  const postSol = tx.meta.postBalances[traderIndex];
  const solDeltaLamports = postSol - preSol; // negative = spent SOL (buy)

  const pre = tx.meta.preTokenBalances ?? [];
  const post = tx.meta.postTokenBalances ?? [];
  // A complete sell has no post balance, so selecting only a post balance
  // misses precisely the exits copy trading needs to mirror. Compare raw
  // amounts (not uiAmount floats) for every mint owned by the target.
  const amounts = new Map<string, { pre: bigint; post: bigint; decimals: number }>();
  for (const balance of pre) {
    if (balance.owner !== trader) continue;
    const current = amounts.get(balance.mint) ?? { pre: 0n, post: 0n, decimals: balance.uiTokenAmount.decimals };
    current.pre += BigInt(balance.uiTokenAmount.amount);
    amounts.set(balance.mint, current);
  }
  for (const balance of post) {
    if (balance.owner !== trader) continue;
    const current = amounts.get(balance.mint) ?? { pre: 0n, post: 0n, decimals: balance.uiTokenAmount.decimals };
    current.post += BigInt(balance.uiTokenAmount.amount);
    current.decimals = balance.uiTokenAmount.decimals;
    amounts.set(balance.mint, current);
  }
  const changed = [...amounts.entries()]
    .map(([mint, amount]) => ({ mint, ...amount, delta: amount.post - amount.pre }))
    .filter((amount) => amount.delta !== 0n)
    .sort((a, b) => (a.delta < 0n ? -a.delta : a.delta) > (b.delta < 0n ? -b.delta : b.delta) ? -1 : 1)[0];
  if (!changed) return null;

  const mint = changed.mint;
  const side: "buy" | "sell" = changed.delta > 0n ? "buy" : "sell";
  const rawTokenDelta = changed.delta < 0n ? -changed.delta : changed.delta;
  const solAmount = Math.abs(solDeltaLamports) / 1e9;

  return {
    kind: "trade",
    signature,
    mint,
    trader,
    side,
    solAmount,
    tokenAmount: Number(rawTokenDelta) / 10 ** changed.decimals,
    timestamp: blockTime ?? Math.floor(Date.now() / 1000),
  };
}

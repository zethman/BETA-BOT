# pump.fun Sniper + Copy Trading Bot (free-tier data layer)

Solo-build scaffold for sniping new pump.fun launches and mirroring
target wallets, built to run entirely on free infrastructure first so
you can validate strategy logic before paying for a low-latency data
feed.

## What this is (and isn't)

- **Is:** a working pipeline — detect → filter → risk-check → execute →
  monitor exit — using public RPC `logsSubscribe` and optional free-tier
  Solana Tracker enrichment.
- **Isn't:** competitive with dedicated Yellowstone/Geyser gRPC bots on
  raw speed. Public RPC log subscriptions lag a real Geyser stream by
  roughly 200ms–2s depending on provider load. That's a real disadvantage
  for sniping (you're racing other bots) and a much smaller one for copy
  trading (you're reacting to a wallet, not a launch).

## Setup

```bash
npm install
cp .env.example .env
# fill in WALLET_PRIVATE_KEY at minimum; everything else has a
# conservative default
```

Use a **dedicated burner wallet** funded only with what you're willing
to lose. Never point this at your main wallet.

```bash
npm run snipe   # sniping only
npm run copy    # copy trading only (requires COPY_TARGET_WALLETS)
npm run both    # both simultaneously
```

The bot defaults to `DRY_RUN=true`, which runs the detection, filtering,
risk, execution, and exit pipeline without submitting transactions. Keep this
setting for demos and validation. Live trading requires setting
`DRY_RUN=false` and explicitly setting
`LIVE_TRADING_CONFIRMATION=I_UNDERSTAND_LIVE_TRADING` after reviewing the
wallet and limits.

## Before you run it with real money

1. **Verify `PUMPFUN_PROGRAM_ID` in `src/constants.ts`** against a
   current source (Solscan, pump.fun's own `pump-public-docs` GitHub repo).
   pump.fun has shipped breaking on-chain changes before; a stale program
   ID or account layout means the bot silently does nothing or fails buys.
2. **Start with `MAX_POSITION_SOL` and `MAX_EXPOSURE_SOL` small** (the
   `.env.example` defaults are intentionally tiny — 0.05 / 0.2 SOL) and
   run in snipe-only or copy-only mode on a handful of trades before
   sizing up.
3. **Run on devnet or with dry logging first if you can** — this
   scaffold sends real transactions the moment `buy`/`sellAll` are
   called; there's no paper-trading mode built in yet.

`npm install` + `npx tsc --noEmit -p .` both pass clean as of `@pump-fun/pump-sdk@1.36.0` — the executor and exit monitor were built and typechecked directly against that version's source (`node_modules/@pump-fun/pump-sdk/src/{sdk.ts,onlineSdk.ts,bondingCurve.ts}`), not against its README, since the README's example signatures turned out to be simplified/outdated relative to what's actually installed. If `npm update` bumps the SDK later and something like `buyInstructions` or `getSellSolAmountFromTokenAmount` starts throwing type errors, that's why — re-check those three source files again; the shape has changed before (e.g. `slippage` is a percentage number like `1` for 1%, not a fraction or bps).

## Architecture

```
src/
  data/rpcListener.ts       free-tier logsSubscribe (swap point for paid Yellowstone later)
  data/solanaTracker.ts     optional REST enrichment (risk score, dev holding %)
  parsing/pumpfunParser.ts  turns a signature into a typed Create/Trade event
  filters/                  snipe and copy-trade decision logic
  risk/riskManager.ts       exposure caps, daily loss cap, per-token cooldown
  risk/exitMonitor.ts       polls open positions, exits on TP/SL
  execution/executor.ts     builds+sends buy/sell via the official @pump-fun/pump-sdk
  modes/                    wires the above into snipe / copy-trade flows
```

The parser deliberately avoids decoding pump.fun's internal Anchor event
bytes (discriminators, struct layouts) and instead reads SOL/token
balance deltas from the confirmed transaction. That's slightly less
precise (a few thousand lamports of tx-fee noise on trade amounts) but
means it keeps working across pump.fun program upgrades without needing
a code change every time they ship one.

## Upgrading the data layer later

Everything downstream of `src/data/` consumes the same `PumpfunEvent`
shape. When you're ready to pay for speed:

1. Pick a Geyser provider (Helius, Shyft, Triton, QuickNode add-on).
2. Write a new `src/data/yellowstoneListener.ts` that subscribes to the
   same pump.fun program / wallet filters and calls the same
   `classifyLogs` + `parse*Event` functions (or their gRPC equivalents).
3. Swap the import in `modes/snipeMode.ts` / `modes/copyTradeMode.ts`.
4. Consider adding Jito bundle submission in `executor.ts` at the same
   time — that's the other half of the speed upgrade (landing your tx in
   the target slot, not just seeing the event faster).

## Dedicated RPC fast path

The executor accepts a signed transaction without waiting for its
confirmation, so an accepted packet no longer holds up the next detection
handler. On a dedicated RPC, set `RPC_MIN_INTERVAL_MS=0` to remove the
shared-endpoint read queue. After a successful dry-run validation, setting
`FAST_SUBMIT=true` also skips RPC simulation, which saves another network
round trip. It is deliberately off by default: a bad instruction or stale
quote will then be rejected after submission rather than caught by preflight.

The listener still uses `getParsedTransaction`, whose Solana RPC minimum
commitment is `confirmed`. A standard HTTP/WebSocket RPC therefore cannot
deliver a true sub-confirmation snipe; use the documented Geyser/Yellowstone
listener swap for that level of latency.

## Known gaps to close before this is production-grade

- No dry-run / paper-trading mode.
- `snipeFilters.ts` requires enrichment data to approve a buy (fails
  closed without a Solana Tracker key) — intentional for safety, but
  means sniping is off by default until you add a free API key.
- Proportional mirror sizing in copy mode falls back to fixed sizing
  (no reliable free way to estimate a target wallet's bankroll).
- The public RPC free tier will 429 under snipe mode's full-program
  firehose volume — the bot throttles and backs off (`src/data/rpcThrottle.ts`)
  so it stays alive, but throughput is capped by the free endpoint, not
  your logic. That's the #1 reason to eventually move to a paid Geyser
  stream (see "Upgrading the data layer" above).

// pump.fun mainnet program ID. Verify this against
// https://docs.bitquery.io (or Solscan) before running — pump.fun has
// shipped breaking on-chain upgrades before (e.g. a fee-recipient account
// change), and a stale program ID here means the bot silently sees nothing.
export const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
// Anchor log lines pump.fun emits — used for cheap pre-filtering before
// we pay for a full getTransaction call.
export const LOG_MARKERS = {
    CREATE: "Instruction: Create",
    BUY: "Instruction: Buy",
    SELL: "Instruction: Sell",
};

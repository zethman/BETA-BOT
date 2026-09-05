import "dotenv/config";
function requireEnv(key) {
    const v = process.env[key];
    if (!v || v.trim() === "") {
        throw new Error(`Missing required env var ${key}. Copy .env.example to .env and fill it in.`);
    }
    return v;
}
function num(key, fallback) {
    const v = process.env[key];
    if (!v)
        return fallback;
    const n = Number(v);
    if (Number.isNaN(n))
        throw new Error(`Env var ${key} must be a number, got "${v}"`);
    return n;
}
function bool(key, fallback) {
    const v = process.env[key];
    if (v === undefined)
        return fallback;
    return v.toLowerCase() === "true";
}
function positive(key, fallback) {
    const n = num(key, fallback);
    if (!Number.isFinite(n) || n <= 0)
        throw new Error(`Env var ${key} must be greater than 0`);
    return n;
}
function nonNegative(key, fallback) {
    const n = num(key, fallback);
    if (!Number.isFinite(n) || n < 0)
        throw new Error(`Env var ${key} must be zero or greater`);
    return n;
}
function list(key) {
    const v = process.env[key];
    if (!v || v.trim() === "")
        return [];
    return v.split(",").map((s) => s.trim()).filter(Boolean);
}
// CLI --mode= overrides env MODE
function resolveMode() {
    const arg = process.argv.find((a) => a.startsWith("--mode="));
    const raw = (arg ? arg.split("=")[1] : process.env.MODE) ?? "snipe";
    if (raw !== "snipe" && raw !== "copy" && raw !== "both") {
        throw new Error(`MODE must be snipe | copy | both, got "${raw}"`);
    }
    return raw;
}
export const config = {
    rpcHttpUrl: requireEnv("RPC_HTTP_URL"),
    rpcWsUrl: requireEnv("RPC_WS_URL"),
    solanaTrackerApiKey: process.env.SOLANA_TRACKER_API_KEY ?? "",
    walletPrivateKey: requireEnv("WALLET_PRIVATE_KEY"),
    rpc: {
        // Set this to 0 on a dedicated/paid RPC. Keep a small interval on a
        // shared endpoint so transaction parsing does not create a 429 backlog.
        minIntervalMs: nonNegative("RPC_MIN_INTERVAL_MS", 250),
    },
    execution: {
        // Fast submission returns as soon as the RPC accepts the signed packet.
        // It intentionally skips simulation, so only enable it on a reliable RPC
        // after validating the bot in dry-run mode.
        fastSubmit: bool("FAST_SUBMIT", false),
        maxRetries: Math.floor(nonNegative("TX_MAX_RETRIES", 2)),
        protocolStateCacheMs: nonNegative("PROTOCOL_STATE_CACHE_MS", 1_000),
    },
    // Safe by default. Live execution requires an explicit acknowledgement so
    // a copied .env cannot unexpectedly place real trades.
    dryRun: bool("DRY_RUN", true),
    mode: resolveMode(),
    copyTargetWallets: list("COPY_TARGET_WALLETS"),
    risk: {
        maxPositionSol: positive("MAX_POSITION_SOL", 0.05),
        maxExposureSol: positive("MAX_EXPOSURE_SOL", 0.2),
        dailyLossCapSol: positive("DAILY_LOSS_CAP_SOL", 0.3),
        perTokenCooldownSec: positive("PER_TOKEN_COOLDOWN_SEC", 60),
        slippageBps: num("SLIPPAGE_BPS", 300),
        priorityFeeMicroLamports: num("PRIORITY_FEE_MICROLAMPORTS", 200_000),
        takeProfitPct: num("TAKE_PROFIT_PCT", 50),
        stopLossPct: num("STOP_LOSS_PCT", 25),
        exitPollIntervalSec: positive("EXIT_POLL_INTERVAL_SEC", 5),
    },
    snipeFilters: {
        maxDevHoldingPct: num("MAX_DEV_HOLDING_PCT", 15),
        requireMetadata: bool("REQUIRE_METADATA", true),
        creatorBlocklist: new Set(list("CREATOR_BLOCKLIST")),
    },
    copyFilters: {
        minMirrorTradeSol: num("MIN_MIRROR_TRADE_SOL", 0.02),
        mirrorSizingMode: (process.env.MIRROR_SIZING_MODE ?? "fixed"),
    },
};
if (!config.dryRun && process.env.LIVE_TRADING_CONFIRMATION !== "I_UNDERSTAND_LIVE_TRADING") {
    throw new Error("Live trading is locked. Set LIVE_TRADING_CONFIRMATION=I_UNDERSTAND_LIVE_TRADING only after reviewing the wallet and risk limits.");
}
// Fail fast and loud if copy/both mode has no targets — this is the #1
// "bot runs but does nothing" support request.
if ((config.mode === "copy" || config.mode === "both") && config.copyTargetWallets.length === 0) {
    throw new Error("MODE is copy/both but COPY_TARGET_WALLETS is empty. Add at least one wallet to mirror.");
}

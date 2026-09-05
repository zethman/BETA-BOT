import { Connection } from "@solana/web3.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { loadWallet, Executor } from "./execution/executor.js";
import { RiskManager } from "./risk/riskManager.js";
import { ExitMonitor } from "./risk/exitMonitor.js";
import { startSnipeMode } from "./modes/snipeMode.js";
import { startCopyTradeMode } from "./modes/copyTradeMode.js";
async function main() {
    logger.info(`Starting Sniper in "${config.mode}" mode (${config.dryRun ? "DRY RUN" : "LIVE TRADING"})`);
    logger.warn("Free-tier data layer (logsSubscribe, not Yellowstone gRPC) — expect latency behind dedicated sniper bots, and expect 429s under load on shared public RPCs. Prove out the strategy here, then swap the data layer in src/data/ for a paid Geyser stream.");
    // Last-resort net: individual handlers already try/catch (see
    // modes/*.ts), but a crash while positions are open means the exit
    // monitor stops watching them — worse than a logged error. Log and
    // keep running rather than let Node's default fatal-on-unhandled-
    // rejection behavior take the process down mid-position.
    process.on("unhandledRejection", (reason) => {
        logger.error("Unhandled rejection (bot continues running):", reason);
    });
    process.on("uncaughtException", (err) => {
        logger.error("Uncaught exception (bot continues running):", err);
    });
    const connection = new Connection(config.rpcHttpUrl, {
        commitment: "confirmed",
        wsEndpoint: config.rpcWsUrl,
    });
    const wallet = loadWallet();
    logger.info(`Trading wallet: ${wallet.publicKey.toBase58()}`);
    const balanceLamports = await connection.getBalance(wallet.publicKey);
    const balanceSol = balanceLamports / 1e9;
    logger.info(`Wallet balance: ${balanceSol.toFixed(4)} SOL`);
    if (balanceSol < config.risk.maxPositionSol) {
        logger.warn(`Wallet balance (${balanceSol.toFixed(4)} SOL) is below MAX_POSITION_SOL (${config.risk.maxPositionSol}) — buys will fail until funded.`);
    }
    const executor = new Executor(connection, wallet);
    const riskManager = new RiskManager();
    const exitMonitor = new ExitMonitor(connection, executor, riskManager);
    exitMonitor.start();
    if (config.mode === "snipe" || config.mode === "both") {
        startSnipeMode(connection, executor, riskManager, exitMonitor);
    }
    if (config.mode === "copy" || config.mode === "both") {
        startCopyTradeMode(connection, executor, riskManager, exitMonitor);
    }
    process.on("SIGINT", () => {
        logger.info("Shutting down...");
        exitMonitor.stop();
        process.exit(0);
    });
}
main().catch((err) => {
    logger.error("Fatal error:", err);
    process.exit(1);
});

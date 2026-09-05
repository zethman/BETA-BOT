import { logger } from "../logger.js";
import { config } from "../config.js";
export class RiskManager {
    openPositions = new Map();
    // A reservation closes the race between a log arriving and a submitted
    // buy being recorded. Without it, two concurrent handlers can buy a mint.
    pendingOpens = new Map();
    lastBuyAt = new Map();
    realizedPnlTodaySol = 0;
    dayKey = this.todayKey();
    todayKey() {
        return new Date().toISOString().slice(0, 10); // UTC date
    }
    rolloverIfNewDay() {
        const key = this.todayKey();
        if (key !== this.dayKey) {
            logger.info(`New UTC day — resetting daily loss counter (was ${this.realizedPnlTodaySol.toFixed(4)} SOL)`);
            this.dayKey = key;
            this.realizedPnlTodaySol = 0;
        }
    }
    currentExposureSol() {
        let sum = 0;
        for (const p of this.openPositions.values())
            sum += p.entrySol;
        return sum;
    }
    pendingExposureSol() {
        let sum = 0;
        for (const size of this.pendingOpens.values())
            sum += size;
        return sum;
    }
    /** Call before every buy. Returns a reason string if blocked, or null if OK. */
    canOpenPosition(mint, sizeSol) {
        this.rolloverIfNewDay();
        if (this.realizedPnlTodaySol <= -config.risk.dailyLossCapSol) {
            return `daily loss cap hit (${this.realizedPnlTodaySol.toFixed(4)} SOL) — no new trades until UTC rollover`;
        }
        if (sizeSol > config.risk.maxPositionSol) {
            return `position size ${sizeSol} SOL exceeds MAX_POSITION_SOL (${config.risk.maxPositionSol})`;
        }
        const exposure = this.currentExposureSol() + this.pendingExposureSol();
        if (exposure + sizeSol > config.risk.maxExposureSol) {
            return `would exceed MAX_EXPOSURE_SOL (current ${exposure.toFixed(4)} + ${sizeSol} > ${config.risk.maxExposureSol})`;
        }
        const last = this.lastBuyAt.get(mint);
        if (last && Date.now() - last < config.risk.perTokenCooldownSec * 1000) {
            return `per-token cooldown active for ${mint}`;
        }
        if (this.openPositions.has(mint)) {
            return `already holding a position in ${mint}`;
        }
        if (this.pendingOpens.has(mint))
            return `buy already pending for ${mint}`;
        return null;
    }
    /** Atomically reserve capacity before awaiting an RPC submission. */
    reserveOpen(mint, sizeSol) {
        const reason = this.canOpenPosition(mint, sizeSol);
        if (reason)
            return reason;
        this.pendingOpens.set(mint, sizeSol);
        return null;
    }
    releaseOpenReservation(mint) {
        this.pendingOpens.delete(mint);
    }
    recordOpen(mint, entrySol, entryTokenAmount) {
        this.pendingOpens.delete(mint);
        this.openPositions.set(mint, { mint, entrySol, entryTokenAmount, openedAt: Date.now() });
        this.lastBuyAt.set(mint, Date.now());
    }
    recordClose(mint, exitSol) {
        const pos = this.openPositions.get(mint);
        if (!pos)
            return;
        const pnl = exitSol - pos.entrySol;
        this.realizedPnlTodaySol += pnl;
        this.openPositions.delete(mint);
        logger.trade(`Closed ${mint}: entry ${pos.entrySol.toFixed(4)} SOL, exit ${exitSol.toFixed(4)} SOL, pnl ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL. Day total: ${this.realizedPnlTodaySol.toFixed(4)} SOL`);
    }
    getOpenPosition(mint) {
        return this.openPositions.get(mint);
    }
}

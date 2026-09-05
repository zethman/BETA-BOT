import { config } from "../config.js";
export function evaluateMirror(event) {
    if (event.side !== "buy") {
        // We mirror buys; sells from the target are handled separately by
        // checking whether WE hold a position in that mint (see copyTradeMode).
        return { approve: false, reason: "not a buy, handled by exit logic", sizeSol: 0 };
    }
    if (event.solAmount < config.copyFilters.minMirrorTradeSol) {
        return {
            approve: false,
            reason: `target trade ${event.solAmount} SOL below MIN_MIRROR_TRADE_SOL (${config.copyFilters.minMirrorTradeSol})`,
            sizeSol: 0,
        };
    }
    // Fixed sizing: always trade MAX_POSITION_SOL regardless of the
    // target's size. Proportional sizing needs an estimate of the target's
    // own bankroll (not available for free) — falls back to fixed.
    const sizeSol = config.risk.maxPositionSol;
    return { approve: true, reason: `mirroring buy of ${event.solAmount} SOL`, sizeSol };
}

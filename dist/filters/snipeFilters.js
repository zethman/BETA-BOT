import { config } from "../config.js";
/**
 * Evaluate a freshly-created pump.fun token. `enriched` is best-effort —
 * it will be null/partial whenever Solana Tracker enrichment wasn't
 * configured or the request failed, so every check treats "unknown" as
 * "fail closed" rather than assuming the best.
 */
export function evaluateSnipe(event, enriched) {
    if (config.snipeFilters.creatorBlocklist.has(event.creator)) {
        return { approve: false, reason: `creator ${event.creator} is blocklisted`, sizeSol: 0 };
    }
    if (config.snipeFilters.requireMetadata) {
        const hasMetadata = Boolean(event.name && event.symbol);
        if (!hasMetadata) {
            return { approve: false, reason: "missing token metadata (name/symbol)", sizeSol: 0 };
        }
    }
    if (enriched?.devHoldingPct !== undefined) {
        if (enriched.devHoldingPct > config.snipeFilters.maxDevHoldingPct) {
            return {
                approve: false,
                reason: `dev holding ${enriched.devHoldingPct}% exceeds max ${config.snipeFilters.maxDevHoldingPct}%`,
                sizeSol: 0,
            };
        }
    }
    else {
        // No enrichment data = we can't verify dev holding. Fail closed.
        return { approve: false, reason: "no enrichment data to verify dev holding %", sizeSol: 0 };
    }
    if (enriched.riskScore !== undefined && enriched.riskScore <= 3) {
        return { approve: false, reason: `risk score ${enriched.riskScore}/10 too low`, sizeSol: 0 };
    }
    return { approve: true, reason: "passed snipe filters", sizeSol: config.risk.maxPositionSol };
}

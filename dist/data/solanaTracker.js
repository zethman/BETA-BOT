import fetch from "node-fetch";
import { logger } from "../logger.js";
const BASE_URL = "https://data.solanatracker.io";
// NOTE: Solana Tracker's WebSocket Datastream is a paid-plan feature —
// the free tier (2,500 req/month) is REST only. That's fine here: we
// only call this to enrich a candidate AFTER our free logsSubscribe
// firehose already flagged it, so call volume stays low by construction.
export async function fetchTokenEnrichment(apiKey, mint) {
    if (!apiKey)
        return null; // enrichment is optional — bot runs fine without it
    try {
        const res = await fetch(`${BASE_URL}/tokens/${mint}`, {
            headers: { "x-api-key": apiKey },
        });
        if (!res.ok) {
            logger.warn(`Solana Tracker enrichment failed for ${mint}: HTTP ${res.status}`);
            return null;
        }
        const data = (await res.json());
        const pool = data?.pools?.[0];
        const bondingCurveProgressPct = pool?.market === "pumpfun" && typeof pool?.curvePercentage === "number"
            ? pool.curvePercentage
            : undefined;
        const liquidityUsd = typeof pool?.liquidity?.usd === "number" ? pool.liquidity.usd : undefined;
        return {
            mint,
            bondingCurveProgressPct,
            holderCount: data?.holders ?? undefined,
            riskScore: data?.risk?.score ?? undefined,
            devHoldingPct: data?.risk?.dev?.percentage ?? undefined,
            liquidityUsd,
        };
    }
    catch (err) {
        logger.warn(`Solana Tracker enrichment error for ${mint}:`, err);
        return null; // never let enrichment failures block the trading pipeline
    }
}

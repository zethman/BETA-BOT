export interface TokenCreateEvent {
  kind: "create";
  signature: string;
  mint: string;
  creator: string;
  bondingCurve: string;
  name?: string;
  symbol?: string;
  uri?: string;
  timestamp: number;
}

export interface TokenTradeEvent {
  kind: "trade";
  signature: string;
  mint: string;
  trader: string;
  side: "buy" | "sell";
  solAmount: number; // in SOL, not lamports
  tokenAmount: number;
  timestamp: number;
}

export type PumpfunEvent = TokenCreateEvent | TokenTradeEvent;

export interface EnrichedTokenData {
  mint: string;
  bondingCurveProgressPct?: number;
  holderCount?: number;
  riskScore?: number;
  devHoldingPct?: number;
  liquidityUsd?: number;
}

export interface TradeDecision {
  approve: boolean;
  reason: string;
  sizeSol: number;
}

export interface OpenPosition {
  mint: string;
  entrySol: number;
  entryTokenAmount: number;
  openedAt: number;
}

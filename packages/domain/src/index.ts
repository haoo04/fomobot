import type { ZodType } from 'zod';

export const EXCHANGES = ['BITGET', 'HYPERLIQUID'] as const;
export const MARKET_TYPES = ['SPOT', 'PERP'] as const;
export const TIMEFRAMES = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '4h',
  '1d',
] as const;

export type ExchangeId = (typeof EXCHANGES)[number];
export type MarketType = (typeof MARKET_TYPES)[number];
export type Timeframe = (typeof TIMEFRAMES)[number];

export interface MarketIdentity {
  exchange: ExchangeId;
  marketType: MarketType;
  productType: string;
  venue: string;
  nativeSymbol: string;
  baseAsset: string;
  quoteAsset: string;
}

export interface MarketCapabilities {
  intervals: Timeframe[];
  hasOpenInterest: boolean;
  hasOrderBook: boolean;
  hasFundingRate: boolean;
  supportsReadOnlyPositions: boolean;
  hasReliableBaseVolume: boolean;
  sessionType: 'CONTINUOUS' | 'RWA_WITH_REFERENCE_SESSION' | 'UNKNOWN';
  restrictions: string[];
}

export interface Candle {
  marketId: string;
  timeframe: Timeframe;
  openTimeMs: number;
  closeTimeMs: number;
  open: string;
  high: string;
  low: string;
  close: string;
  baseVolume: string | null;
  quoteTurnover: string | null;
  isClosed: boolean;
  source: 'WS' | 'REST' | 'AGGREGATED';
  qualityFlags: string[];
}

export interface OiSnapshot {
  marketId: string;
  timestampMs: number;
  value: string;
  unit: 'BASE_ASSET' | 'CONTRACTS' | 'USD_NOTIONAL' | 'OTHER';
  unitDetails: string;
  source: 'REST' | 'WS';
  qualityFlags: string[];
}

export type SignalDirection = 'LONG' | 'SHORT' | 'BEARISH_WATCH' | 'NO_TRADE';

export interface StrategyContext<Params = Readonly<Record<string, unknown>>> {
  market: MarketIdentity;
  evaluationTimeMs: number;
  candles: Readonly<Partial<Record<Timeframe, readonly Candle[]>>>;
  oiSnapshots: readonly OiSnapshot[];
  quote: {
    last: string | null;
    mark: string | null;
    bid: string | null;
    ask: string | null;
    timestampMs: number;
  };
  params: Readonly<Params>;
}

export interface CandidateSignal {
  candidateId: string;
  strategyId: string;
  strategyVersion: string;
  triggerCandleOpenMs: number;
  direction: SignalDirection;
  evidence: Record<string, unknown>;
  reasonCodes: string[];
  proposedEntry: string;
}

export interface StrategyDefinition<
  Params = Readonly<Record<string, unknown>>,
> {
  id: string;
  version: string;
  paramsSchema: ZodType<Params>;
  requiredTimeframes: readonly Timeframe[];
  requiresOi: boolean;
  evaluate(context: StrategyContext<Params>): CandidateSignal[];
}

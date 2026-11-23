import type {
  Market,
  MarketQuote,
  MonitorConfig,
} from '@market-sentinel/contracts/markets';
import type {
  Candle,
  ExchangeId,
  OiSnapshot,
  Timeframe,
} from '@market-sentinel/domain';
import { Decimal } from 'decimal.js';
import { z } from 'zod';

export type MarketListing = Omit<
  Market,
  'id' | 'stale' | 'intervalRestrictions'
>;

export interface CatalogPartition {
  productType: string;
  venue: string;
  listings: MarketListing[] | null;
}

export const duration: Record<Timeframe, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export const closeDelayMs = 5_000;
export const warmupTarget = 500;
export const warmupMinimum = 300;
export const closeCutoff = (now: number, timeframe: Timeframe) =>
  Math.floor((now - closeDelayMs) / duration[timeframe]) * duration[timeframe];

export function monitoredTimeframes(config: MonitorConfig): Timeframe[] {
  return [
    ...new Set([config.trigger, config.confirm, config.trend, ...config.extra]),
  ];
}

export const decimal = z
  .string()
  .max(100)
  .regex(/^\d+(\.\d+)?$/);
export const price = decimal.refine((value) => /[1-9]/.test(value));
export const epoch = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().nonnegative());

const Exact = Decimal.clone({ precision: 220 });

export interface CandleBar {
  openTimeMs: number;
  open: string;
  high: string;
  low: string;
  close: string;
  baseVolume?: string | null;
  quoteTurnover?: string | null;
}

export function normalizeCandle(
  marketId: string,
  timeframe: Timeframe,
  bar: CandleBar,
  source: 'WS' | 'REST',
): Candle | null {
  const { openTimeMs, open, high, low, close } = bar;
  if (
    !Number.isSafeInteger(openTimeMs) ||
    openTimeMs < 0 ||
    openTimeMs % duration[timeframe] !== 0 ||
    ![open, high, low, close].every((value) => price.safeParse(value).success)
  )
    return null;
  const maximum = new Exact(high);
  const minimum = new Exact(low);
  if (
    minimum.gt(open) ||
    minimum.gt(close) ||
    maximum.lt(open) ||
    maximum.lt(close)
  )
    return null;

  const base = decimal.safeParse(bar.baseVolume);
  const turnover = decimal.safeParse(bar.quoteTurnover);
  return {
    marketId,
    timeframe,
    openTimeMs,
    closeTimeMs: openTimeMs + duration[timeframe],
    open,
    high,
    low,
    close,
    baseVolume: base.success ? base.data : null,
    quoteTurnover: turnover.success ? turnover.data : null,
    isClosed: source === 'REST',
    source,
    qualityFlags: [
      ...(!base.success ? ['MISSING_BASE_VOLUME'] : []),
      ...(!turnover.success ? ['MISSING_QUOTE_TURNOVER'] : []),
    ],
  };
}

export function aggregateRealityCandles(
  bars: Candle[],
  start: number,
  end: number,
): Candle[] {
  const byOpen = new Map(bars.map((bar) => [bar.openTimeMs, bar]));
  const result: Candle[] = [];
  for (let open = start; open + duration['3m'] <= end; open += duration['3m']) {
    const first = byOpen.get(open);
    const second = byOpen.get(open + duration['1m']);
    const third = byOpen.get(open + 2 * duration['1m']);
    if (!first || !second || !third || open % duration['3m'] !== 0) continue;
    const group = [first, second, third];
    if (
      !group.every(
        (bar) =>
          bar.marketId === first.marketId &&
          bar.timeframe === '1m' &&
          bar.isClosed &&
          bar.source === 'REST' &&
          bar.baseVolume !== null &&
          bar.quoteTurnover !== null,
      )
    )
      continue;
    result.push({
      ...first,
      timeframe: '3m',
      closeTimeMs: third.closeTimeMs,
      high: Exact.max(...group.map((bar) => bar.high)).toFixed(),
      low: Exact.min(...group.map((bar) => bar.low)).toFixed(),
      close: third.close,
      baseVolume: group
        .reduce((sum, bar) => sum.plus(bar.baseVolume!), new Exact(0))
        .toFixed(),
      quoteTurnover: group
        .reduce((sum, bar) => sum.plus(bar.quoteTurnover!), new Exact(0))
        .toFixed(),
      source: 'AGGREGATED',
      qualityFlags: [],
    });
  }
  return result;
}

export type QuoteField = 'last' | 'mark' | 'bid' | 'ask';
export interface QuoteUpdate {
  timestampMs: number;
  source: 'WS' | 'REST';
  fields: Partial<Record<QuoteField, string | null>>;
}

export function mergeQuote(
  current: MarketQuote,
  observed: Partial<Record<QuoteField, number>>,
  update: QuoteUpdate,
): void {
  for (const field of ['last', 'mark', 'bid', 'ask'] as const) {
    const value = update.fields[field];
    if (
      value === undefined ||
      update.timestampMs <
        (observed[field] ?? current[field]?.timestampMs ?? -1)
    )
      continue;
    observed[field] = update.timestampMs;
    current[field] =
      value !== null && price.safeParse(value).success
        ? { value, timestampMs: update.timestampMs, source: update.source }
        : null;
  }

  const { bid, ask } = current;
  current.spread =
    bid &&
    ask &&
    bid.timestampMs === ask.timestampMs &&
    bid.source === ask.source &&
    new Exact(ask.value).gte(bid.value)
      ? { ...ask, value: new Exact(ask.value).minus(bid.value).toFixed() }
      : null;
}

export type OpenInterest = OiSnapshot & { series: string };
export type RequestPriority = 'live' | 'sample' | 'backfill';

export type MarketEvent =
  | {
      kind: 'candle';
      key: string;
      timeframe: Timeframe;
      bar: CandleBar;
      timestampMs?: number;
    }
  | { kind: 'quote'; key: string; update: QuoteUpdate };

export interface Subscription {
  key: string;
  args: Record<string, string>;
}

export interface MarketSocketProtocol {
  url: string;
  capacity: number;
  ping: string;
  encode(
    operation: 'subscribe' | 'unsubscribe',
    subscriptions: Subscription[],
  ): string[];
  decode(text: string, receivedAtMs: number): MarketEvent[];
}

export interface MarketProvider {
  exchange: ExchangeId;
  socket: MarketSocketProtocol;
  discover(knownVenues: string[]): Promise<CatalogPartition[]>;
  candles(
    market: Market,
    timeframe: Timeframe,
    from: number,
    to: number,
    priority: RequestPriority,
  ): Promise<Candle[]>;
  quote(market: Market): Promise<QuoteUpdate | null>;
  openInterest(markets: Market[]): Promise<OpenInterest[]>;
  key(market: Market): string;
  subscriptions(market: Market, timeframes: Timeframe[]): Subscription[];
}

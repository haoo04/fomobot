import {
  TIMEFRAMES,
  type Candle,
  type Timeframe,
} from '@market-sentinel/domain';
import { z } from 'zod';
import { decimal, duration, epoch, normalizeCandle, price } from './model.js';
import type {
  CandleBar,
  MarketEvent,
  MarketListing,
  MarketProvider,
  OpenInterest,
  QuoteUpdate,
  Subscription,
} from './model.js';
import { ProviderError, type RestQueue } from './transport.js';

const restOrigin = 'https://api.bitget.com';
const products = [
  'SPOT',
  'USDT-FUTURES',
  'USDC-FUTURES',
  'COIN-FUTURES',
] as const;
const intervals: Record<Timeframe, string> = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1H',
  '4h': '4H',
  '1d': '1D',
};
const realityIntervals: Timeframe[] = ['1m', '5m', '15m', '1h', '4h'];
const normalIntervals = TIMEFRAMES.filter((value) => value !== '1d');
const address = (product: string, symbol: string) =>
  product.toUpperCase() + ':' + symbol;

const envelope = z.object({
  code: z.string(),
  msg: z.string().optional(),
  requestTime: epoch.optional(),
  data: z.unknown(),
});
const instrument = z.object({
  symbol: z.string().min(1),
  category: z.enum(products),
  baseCoin: z.string().min(1),
  quoteCoin: z.string().min(1),
  status: z.string().min(1),
  type: z.string().optional(),
  pricePrecision: z.string().optional(),
  priceMultiplier: z.string().optional(),
  instrumentType: z.string().optional(),
  isReality: z.string().optional(),
  isRwa: z.string().optional(),
});
const candleRow = z
  .tuple([epoch, z.string(), z.string(), z.string(), z.string()])
  .rest(z.string().nullable());
const wsBar = z.object({
  start: epoch,
  open: z.string(),
  high: z.string(),
  low: z.string(),
  close: z.string(),
  volume: z.string().nullish(),
  turnover: z.string().nullish(),
});
const ticker = z.object({
  symbol: z.string().optional(),
  lastPrice: z.string().nullish(),
  markPrice: z.string().nullish(),
  bid1Price: z.string().nullish(),
  ask1Price: z.string().nullish(),
  ts: epoch.optional(),
});
const socketEnvelope = z.object({
  event: z.string().optional(),
  arg: z
    .object({
      instType: z.string(),
      symbol: z.string(),
      topic: z.string(),
      interval: z.string().optional(),
    })
    .optional(),
  data: z.array(z.unknown()).optional(),
  ts: epoch.optional(),
});

function tickerUpdate(
  tick: z.infer<typeof ticker>,
  seen: number,
  source: QuoteUpdate['source'],
): QuoteUpdate {
  return {
    source,
    timestampMs: tick.ts ?? seen,
    fields: {
      last: tick.lastPrice ?? null,
      mark: tick.markPrice ?? null,
      bid: tick.bid1Price ?? null,
      ask: tick.ask1Price ?? null,
    },
  };
}

function decode(message: string, receivedAt: number): MarketEvent[] {
  if (message === 'pong') return [];
  const packet = socketEnvelope.parse(JSON.parse(message));
  if (packet.event === 'error') throw new ProviderError('INVALID_RESPONSE');
  if (!packet.arg || !packet.data) return [];
  const { instType, symbol, topic, interval } = packet.arg;
  const key = address(instType, symbol);
  if (topic === 'ticker') {
    return packet.data.map((raw) => ({
      kind: 'quote',
      key,
      update: tickerUpdate(ticker.parse(raw), packet.ts ?? receivedAt, 'WS'),
    }));
  }
  const timeframe = TIMEFRAMES.find(
    (candidate) => intervals[candidate] === interval,
  );
  if (topic !== 'kline' || !timeframe) return [];
  return packet.data.map((raw) => {
    const { start, volume, turnover, ...ohlc } = wsBar.parse(raw);
    return {
      kind: 'candle',
      key,
      timeframe,
      timestampMs: packet.ts ?? receivedAt,
      bar: {
        ...ohlc,
        openTimeMs: start,
        baseVolume: volume,
        quoteTurnover: turnover,
      },
    };
  });
}

export function createBitgetProvider(queue: RestQueue): MarketProvider {
  async function get(
    path: string,
    params: Record<string, string>,
    priority: 'live' | 'sample' | 'backfill',
  ) {
    const url = new URL(path, restOrigin);
    url.search = new URLSearchParams(params).toString();
    const body = envelope.parse(await queue.request(url, priority));
    if (body.code !== '00000') {
      const unsupported =
        /(?:endpoint|category|product type).{0,35}(?:not supported|unsupported)|not support(?:ed)? (?:this |the )?(?:category|endpoint|product type)/i.test(
          body.msg ?? '',
        );
      throw new ProviderError(unsupported ? 'UNSUPPORTED' : 'INVALID_RESPONSE');
    }
    return body;
  }

  return {
    exchange: 'BITGET',
    socket: {
      url: 'wss://ws.bitget.com/v3/ws/public',
      capacity: 49,
      ping: 'ping',
      encode(operation, subscriptions) {
        const messages: string[] = [];
        for (let i = 0; i < subscriptions.length; i += 12) {
          messages.push(
            JSON.stringify({
              op: operation,
              args: subscriptions.slice(i, i + 12).map(({ args }) => args),
            }),
          );
        }
        return messages;
      },
      decode,
    },
    async discover() {
      return Promise.all(
        products.map(async (productType) => {
          try {
            const { data } = await get(
              '/api/v3/market/instruments',
              { category: productType },
              'backfill',
            );
            const rows = z.array(instrument).parse(data);
            if (rows.some((row) => row.category !== productType))
              throw new ProviderError('INVALID_RESPONSE');
            const spot = productType === 'SPOT';
            if (
              !spot &&
              rows.some(
                (row) => row.type !== 'perpetual' && row.type !== 'delivery',
              )
            ) {
              throw new ProviderError('INVALID_RESPONSE');
            }
            const listings: MarketListing[] = rows
              .filter((row) => spot || row.type === 'perpetual')
              .map((row) => {
                const isReality =
                  spot && row.isReality?.toLowerCase() === 'yes';
                const rwaFlag = row.isRwa?.toLowerCase();
                const isRwa =
                  isReality || rwaFlag === 'yes'
                    ? true
                    : rwaFlag === 'no' || row.isReality?.toLowerCase() === 'no'
                      ? false
                      : null;
                const precision = Number(row.pricePrecision);
                return {
                  exchange: 'BITGET',
                  productType,
                  venue: 'main',
                  marketType: spot ? 'SPOT' : 'PERP',
                  nativeSymbol: row.symbol,
                  baseAsset: row.baseCoin,
                  quoteAsset: row.quoteCoin,
                  collateralAsset: null,
                  instrumentType: row.instrumentType || null,
                  status:
                    row.status.toLowerCase() === 'online'
                      ? 'ACTIVE'
                      : 'INACTIVE',
                  exchangeStatus: row.status,
                  isReality,
                  isRwa,
                  pricePrecision:
                    row.pricePrecision &&
                    /^\d+$/.test(row.pricePrecision) &&
                    Number.isSafeInteger(precision)
                      ? precision
                      : null,
                  tickSize: price.safeParse(row.priceMultiplier).success
                    ? row.priceMultiplier!
                    : null,
                  capabilities: {
                    intervals: [
                      ...(isReality ? realityIntervals : normalIntervals),
                    ],
                    hasOpenInterest: !spot,
                    hasOrderBook: true,
                    hasFundingRate: !spot,
                    supportsReadOnlyPositions: false,
                    hasReliableBaseVolume: !isReality,
                    sessionType: isRwa
                      ? 'RWA_WITH_REFERENCE_SESSION'
                      : isRwa === false
                        ? 'CONTINUOUS'
                        : 'UNKNOWN',
                    restrictions: isReality
                      ? ['Reality 的 WS 1m 缺少成交量，使用 REST 核验。']
                      : [],
                  },
                };
              });
            return { productType, venue: 'main', listings };
          } catch {
            return { productType, venue: 'main', listings: null };
          }
        }),
      );
    },
    async candles(market, timeframe, from, to, priority) {
      const size = duration[timeframe];
      const bars: Candle[] = [];
      const cutoff = Date.now() - 89 * duration['1d'];
      for (let end = to; end > from;) {
        const historical = end <= cutoff;
        const start = Math.max(from, end - (historical ? 100 : 500) * size);
        const { data, requestTime } = await get(
          historical
            ? '/api/v3/market/history-candles'
            : '/api/v3/market/candles',
          {
            category: market.productType,
            symbol: market.nativeSymbol,
            interval: timeframe === '1d' ? '1Dutc' : intervals[timeframe],
            type: 'market',
            startTime: String(start),
            endTime: String(end - 1),
            limit: String((end - start) / size),
          },
          priority,
        );
        for (const raw of z.array(z.unknown()).parse(data)) {
          const parsed = candleRow.safeParse(raw);
          if (!parsed.success) continue;
          const [
            openTimeMs,
            open,
            high,
            low,
            close,
            baseVolume,
            quoteTurnover,
          ] = parsed.data;
          const bar: CandleBar = {
            openTimeMs,
            open,
            high,
            low,
            close,
            baseVolume,
            quoteTurnover,
          };
          const validated = normalizeCandle(market.id, timeframe, bar, 'REST');
          if (
            validated &&
            openTimeMs >= start &&
            validated.closeTimeMs <= Math.min(end, requestTime ?? end)
          ) {
            bars.push(validated);
          }
        }
        end = start;
      }
      return bars;
    },
    async quote(market) {
      const { data, requestTime } = await get(
        '/api/v3/market/tickers',
        {
          category: market.productType,
          symbol: market.nativeSymbol,
        },
        'sample',
      );
      const tick = z
        .array(ticker)
        .parse(data)
        .find((row) => row.symbol === market.nativeSymbol);
      return tick
        ? tickerUpdate(tick, requestTime ?? Date.now(), 'REST')
        : null;
    },
    async openInterest(markets) {
      const results = await Promise.allSettled(
        products
          .filter((product) => product !== 'SPOT')
          .map(async (category) => {
            const active = markets.filter(
              (market) => market.productType === category,
            );
            if (!active.length) return [];
            try {
              const { data } = await get(
                '/api/v3/market/open-interest',
                { category },
                'sample',
              );
              const result = z
                .object({
                  ts: epoch,
                  list: z.array(
                    z.object({ symbol: z.string(), openInterest: decimal }),
                  ),
                })
                .parse(data);
              const bySymbol = new Map(
                result.list.map((row) => [row.symbol, row.openInterest]),
              );
              return active.flatMap((market): OpenInterest[] => {
                const value = bySymbol.get(market.nativeSymbol);
                return value === undefined
                  ? []
                  : [
                      {
                        marketId: market.id,
                        timestampMs: result.ts,
                        value,
                        unit: 'BASE_ASSET',
                        unitDetails:
                          market.baseAsset + ' · Bitget V3 openInterest',
                        source: 'REST',
                        series: 'BITGET_V3',
                        qualityFlags: [],
                      },
                    ];
              });
            } catch (error) {
              if (
                !(error instanceof ProviderError) ||
                error.code !== 'UNSUPPORTED'
              )
                throw error;
              const classic = await Promise.allSettled(
                active.map(async (market): Promise<OpenInterest | null> => {
                  const { data } = await get(
                    '/api/v2/mix/market/open-interest',
                    {
                      productType: category,
                      symbol: market.nativeSymbol,
                    },
                    'sample',
                  );
                  const result = z
                    .object({
                      ts: epoch,
                      openInterestList: z.array(
                        z.object({ symbol: z.string(), size: decimal }),
                      ),
                    })
                    .parse(data);
                  const row = result.openInterestList.find(
                    ({ symbol }) => symbol === market.nativeSymbol,
                  );
                  return row
                    ? {
                        marketId: market.id,
                        timestampMs: result.ts,
                        value: row.size,
                        unit: 'BASE_ASSET',
                        unitDetails:
                          market.baseAsset + ' · Bitget Classic V2 size',
                        source: 'REST',
                        series: 'BITGET_V2',
                        qualityFlags: [],
                      }
                    : null;
                }),
              );
              return classic.flatMap((row) =>
                row.status === 'fulfilled' && row.value ? [row.value] : [],
              );
            }
          }),
      );
      return results.flatMap((row) =>
        row.status === 'fulfilled' ? row.value : [],
      );
    },
    key: (market) => address(market.productType, market.nativeSymbol),
    subscriptions(market, timeframes) {
      const base = {
        instType: market.productType.toLowerCase(),
        symbol: market.nativeSymbol,
      };
      const key = address(market.productType, market.nativeSymbol);
      const all = new Set(
        timeframes.map((timeframe) =>
          market.isReality && timeframe === '3m' ? '1m' : timeframe,
        ),
      );
      const subscriptions: Subscription[] = [
        { key: key + '|ticker', args: { ...base, topic: 'ticker' } },
      ];
      for (const timeframe of all) {
        if (timeframe === '1d') continue;
        subscriptions.push({
          key: key + '|' + timeframe,
          args: { ...base, topic: 'kline', interval: intervals[timeframe] },
        });
      }
      return subscriptions;
    },
  };
}

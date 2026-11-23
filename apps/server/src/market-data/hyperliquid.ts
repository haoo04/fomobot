import { TIMEFRAMES, type Candle } from '@market-sentinel/domain';
import { z } from 'zod';
import { decimal, duration, epoch, normalizeCandle } from './model.js';
import type {
  MarketEvent,
  MarketListing,
  MarketProvider,
  OpenInterest,
  RequestPriority,
  Subscription,
} from './model.js';
import { ProviderError, type RestQueue } from './transport.js';

const url = new URL('https://api.hyperliquid.xyz/info');
const nativePerp = 'HYPERLIQUID-PERP';
const hip3Perp = 'HIP3-PERP';
const spotMetadata = z.object({
  tokens: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      name: z.string().min(1),
      szDecimals: z.number().int().nonnegative(),
    }),
  ),
  universe: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      name: z.string().min(1),
      tokens: z.tuple([
        z.number().int().nonnegative(),
        z.number().int().nonnegative(),
      ]),
      isDelisted: z.boolean().optional(),
    }),
  ),
});
const perpContext = z.tuple([
  z.object({
    universe: z.array(
      z.object({
        name: z.string().min(1),
        szDecimals: z.number().int().nonnegative(),
        isDelisted: z.boolean().optional(),
      }),
    ),
    collateralToken: z.number().int().nonnegative().optional(),
  }),
  z.array(z.object({ openInterest: z.string().nullish() })),
]);
const candle = z.object({
  t: epoch,
  T: epoch,
  s: z.string(),
  i: z.enum(TIMEFRAMES),
  o: z.string(),
  h: z.string(),
  l: z.string(),
  c: z.string(),
  v: z.string().nullish(),
});
const bookLevel = z.object({ px: z.string() });

function validBoundary(bar: z.infer<typeof candle>) {
  return bar.T === bar.t + duration[bar.i] - 1;
}

function candleBar(row: z.infer<typeof candle>) {
  return {
    openTimeMs: row.t,
    open: row.o,
    high: row.h,
    low: row.l,
    close: row.c,
    baseVolume: row.v,
    quoteTurnover: null,
  };
}

function decode(message: string, receivedAt: number): MarketEvent[] {
  const packet = z
    .object({ channel: z.string(), data: z.unknown().optional() })
    .parse(JSON.parse(message));
  if (packet.channel === 'error') throw new ProviderError('INVALID_RESPONSE');
  if (packet.channel === 'candle') {
    return (Array.isArray(packet.data) ? packet.data : [packet.data]).flatMap(
      (raw): MarketEvent[] => {
        const row = candle.parse(raw);
        return validBoundary(row)
          ? [
              {
                kind: 'candle',
                key: row.s,
                timeframe: row.i,
                bar: candleBar(row),
                timestampMs: receivedAt,
              },
            ]
          : [];
      },
    );
  }
  if (packet.channel === 'bbo') {
    const row = z
      .object({
        coin: z.string(),
        time: epoch,
        bbo: z.tuple([bookLevel.nullable(), bookLevel.nullable()]),
      })
      .parse(packet.data);
    return [
      {
        kind: 'quote',
        key: row.coin,
        update: {
          source: 'WS',
          timestampMs: row.time,
          fields: { bid: row.bbo[0]?.px ?? null, ask: row.bbo[1]?.px ?? null },
        },
      },
    ];
  }
  if (packet.channel === 'trades') {
    const rows = z
      .array(z.object({ coin: z.string(), time: epoch, px: z.string() }))
      .parse(packet.data);
    return rows.map((row) => ({
      kind: 'quote',
      key: row.coin,
      update: { source: 'WS', timestampMs: row.time, fields: { last: row.px } },
    }));
  }
  if (
    packet.channel === 'activeAssetCtx' ||
    packet.channel === 'activeSpotAssetCtx'
  ) {
    const row = z
      .object({
        coin: z.string(),
        ctx: z.object({ markPx: z.string().nullish(), time: epoch.optional() }),
      })
      .parse(packet.data);
    return [
      {
        kind: 'quote',
        key: row.coin,
        update: {
          source: 'WS',
          timestampMs: row.ctx.time ?? receivedAt,
          fields: { mark: row.ctx.markPx ?? null },
        },
      },
    ];
  }
  return [];
}

export function createHyperliquidProvider(queue: RestQueue): MarketProvider {
  const request = (body: unknown, priority: RequestPriority, weight = 20) =>
    queue.request(url, priority, body, weight);
  const context = async (venue: string, priority: RequestPriority) =>
    perpContext.parse(
      await request(
        { type: 'metaAndAssetCtxs', dex: venue === 'main' ? '' : venue },
        priority,
      ),
    );
  let knownTokens = new Map<
    number,
    z.infer<typeof spotMetadata>['tokens'][number]
  >();

  return {
    exchange: 'HYPERLIQUID',
    socket: {
      url: 'wss://api.hyperliquid.xyz/ws',
      capacity: 1_000,
      ping: '{"method":"ping"}',
      encode: (method, subscriptions) =>
        subscriptions.map(({ args: subscription }) =>
          JSON.stringify({ method, subscription }),
        ),
      decode,
    },
    async discover(knownVenues) {
      const spot = request({ type: 'spotMeta' }, 'backfill').then((value) => {
        const data = spotMetadata.parse(value);
        knownTokens = new Map(data.tokens.map((token) => [token.index, token]));
        return data;
      });
      const dexList = request({ type: 'perpDexs' }, 'backfill').then((value) =>
        z
          .array(z.object({ name: z.string().min(1) }).nullable())
          .parse(value)
          .flatMap((entry) =>
            entry && entry.name !== 'main' ? [entry.name] : [],
          ),
      );
      const native = context('main', 'backfill');
      const [spotResult, dexResult, nativeResult] = await Promise.allSettled([
        spot,
        dexList,
        native,
      ]);

      function perpListing(
        entry: z.infer<typeof perpContext>[0]['universe'][number],
        venue: string,
        collateral: string | null,
      ): MarketListing {
        const isHip3 = venue !== 'main';
        return {
          exchange: 'HYPERLIQUID',
          marketType: 'PERP',
          productType: isHip3 ? hip3Perp : nativePerp,
          venue,
          nativeSymbol: entry.name,
          baseAsset: isHip3 ? entry.name.slice(venue.length + 1) : entry.name,
          quoteAsset: null,
          collateralAsset: collateral,
          instrumentType: null,
          status: entry.isDelisted ? 'INACTIVE' : 'ACTIVE',
          exchangeStatus: entry.isDelisted ? 'isDelisted' : 'listed',
          isReality: false,
          isRwa: isHip3 ? null : false,
          pricePrecision: Math.max(0, 6 - entry.szDecimals),
          tickSize: null,
          capabilities: {
            intervals: [...TIMEFRAMES],
            hasOpenInterest: true,
            hasOrderBook: true,
            hasFundingRate: true,
            supportsReadOnlyPositions: false,
            hasReliableBaseVolume: true,
            sessionType: isHip3 ? 'UNKNOWN' : 'CONTINUOUS',
            restrictions: isHip3 ? ['HIP-3 合成永续'] : [],
          },
        };
      }

      function normalizePerps(
        [meta]: z.infer<typeof perpContext>,
        venue: string,
      ) {
        if (
          venue !== 'main' &&
          meta.universe.some(
            (item) =>
              !item.name.startsWith(venue + ':') ||
              item.name.length <= venue.length + 1,
          )
        ) {
          throw new ProviderError('INVALID_RESPONSE');
        }
        const collateral =
          meta.collateralToken === undefined
            ? null
            : (knownTokens.get(meta.collateralToken)?.name ?? null);
        return meta.universe.map((entry) =>
          perpListing(entry, venue, collateral),
        );
      }

      let spotListings: MarketListing[] | null = null;
      if (spotResult.status === 'fulfilled') {
        const rows: MarketListing[] = [];
        for (const entry of spotResult.value.universe) {
          const base = knownTokens.get(entry.tokens[0]);
          const quote = knownTokens.get(entry.tokens[1]);
          if (!base || !quote) break;
          rows.push({
            exchange: 'HYPERLIQUID',
            marketType: 'SPOT',
            productType: 'SPOT',
            venue: 'main',
            nativeSymbol: entry.index === 0 ? entry.name : '@' + entry.index,
            baseAsset: base.name,
            quoteAsset: quote.name,
            collateralAsset: null,
            instrumentType: null,
            status: entry.isDelisted ? 'INACTIVE' : 'ACTIVE',
            exchangeStatus: entry.isDelisted ? 'isDelisted' : 'listed',
            isReality: false,
            isRwa: null,
            pricePrecision: Math.max(0, 8 - base.szDecimals),
            tickSize: null,
            capabilities: {
              intervals: [...TIMEFRAMES],
              hasOpenInterest: false,
              hasOrderBook: true,
              hasFundingRate: false,
              supportsReadOnlyPositions: false,
              hasReliableBaseVolume: true,
              sessionType: 'CONTINUOUS',
              restrictions: [],
            },
          });
        }
        if (rows.length === spotResult.value.universe.length)
          spotListings = rows;
      }
      const primary = [
        { productType: 'SPOT', venue: 'main', listings: spotListings },
        {
          productType: nativePerp,
          venue: 'main',
          listings:
            nativeResult.status === 'fulfilled'
              ? normalizePerps(nativeResult.value, 'main')
              : null,
        },
      ];
      if (dexResult.status === 'rejected') {
        return [
          ...primary,
          { productType: 'perpDexs', venue: 'main', listings: null },
          ...knownVenues.map((venue) => ({
            productType: hip3Perp,
            venue,
            listings: null,
          })),
        ];
      }
      const names = [...new Set(dexResult.value)];
      const builders = await Promise.all(
        names.map(async (venue) => {
          try {
            return {
              productType: hip3Perp,
              venue,
              listings: normalizePerps(await context(venue, 'backfill'), venue),
            };
          } catch {
            return { productType: hip3Perp, venue, listings: null };
          }
        }),
      );
      return [
        ...primary,
        ...builders,
        ...knownVenues
          .filter((venue) => !names.includes(venue))
          .map((venue) => ({ productType: hip3Perp, venue, listings: [] })),
      ];
    },
    async candles(market, timeframe, from, to, priority) {
      const size = duration[timeframe];
      const bars: Candle[] = [];
      for (let end = to; end > from;) {
        const start = Math.max(from, end - 500 * size);
        const result = await request(
          {
            type: 'candleSnapshot',
            req: {
              coin: market.nativeSymbol,
              interval: timeframe,
              startTime: start,
              endTime: end - 1,
            },
          },
          priority,
          20 + Math.ceil((end - start) / size / 60),
        );
        for (const raw of z.array(z.unknown()).parse(result)) {
          const parsed = candle.safeParse(raw);
          if (!parsed.success) continue;
          const row = parsed.data;
          if (
            row.s !== market.nativeSymbol ||
            row.i !== timeframe ||
            !validBoundary(row)
          )
            continue;
          const validated = normalizeCandle(
            market.id,
            timeframe,
            candleBar(row),
            'REST',
          );
          if (validated && row.t >= start && validated.closeTimeMs <= end)
            bars.push(validated);
        }
        end = start;
      }
      return bars;
    },
    async quote(market) {
      const row = z
        .object({
          coin: z.string(),
          time: epoch,
          levels: z.tuple([z.array(bookLevel), z.array(bookLevel)]),
        })
        .nullable()
        .parse(
          await request(
            { type: 'l2Book', coin: market.nativeSymbol },
            'sample',
            2,
          ),
        );
      if (!row || row.coin !== market.nativeSymbol) return null;
      return {
        source: 'REST',
        timestampMs: row.time,
        fields: {
          bid: row.levels[0][0]?.px ?? null,
          ask: row.levels[1][0]?.px ?? null,
        },
      };
    },
    async openInterest(markets) {
      const venues = new Set(
        markets
          .filter((market) => market.marketType === 'PERP')
          .map(({ venue }) => venue),
      );
      const results = await Promise.allSettled(
        [...venues].map(async (venue) => {
          const [meta, contexts] = await context(venue, 'sample');
          if (meta.universe.length !== contexts.length)
            throw new ProviderError('INVALID_RESPONSE');
          const bySymbol = new Map(
            meta.universe.map(({ name }, i) => [
              name,
              contexts[i]?.openInterest,
            ]),
          );
          const timestampMs = Date.now();
          return markets
            .filter(
              (market) =>
                market.venue === venue && market.marketType === 'PERP',
            )
            .flatMap((market): OpenInterest[] => {
              const value = decimal.safeParse(
                bySymbol.get(market.nativeSymbol),
              );
              return value.success
                ? [
                    {
                      marketId: market.id,
                      timestampMs,
                      value: value.data,
                      unit: 'BASE_ASSET',
                      unitDetails:
                        market.baseAsset + ' · Hyperliquid perp size',
                      source: 'REST',
                      series: 'HYPERLIQUID_' + venue,
                      qualityFlags: ['TIMESTAMP_AT_RECEIPT'],
                    },
                  ]
                : [];
            });
        }),
      );
      return results.flatMap((result) =>
        result.status === 'fulfilled' ? result.value : [],
      );
    },
    key: (market) => market.nativeSymbol,
    subscriptions(market, timeframes) {
      const coin = market.nativeSymbol;
      const subscriptions: Subscription[] = [
        'bbo',
        'trades',
        'activeAssetCtx',
      ].map((type) => ({
        key: coin + '|' + type,
        args: { coin, type },
      }));
      for (const interval of timeframes) {
        subscriptions.push({
          key: coin + '|candle|' + interval,
          args: { coin, interval, type: 'candle' },
        });
      }
      return subscriptions;
    },
  };
}

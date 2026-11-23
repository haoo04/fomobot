import { randomUUID } from 'node:crypto';
import type { Market, MarketQuote } from '@market-sentinel/contracts/markets';
import type { Candle, ExchangeId, Timeframe } from '@market-sentinel/domain';
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import type { AppDatabase } from '../database.js';
import {
  candles,
  markets,
  monitorConfigs,
  oiSnapshots,
  quotes,
} from '../schema.js';
import type { CatalogPartition, OpenInterest } from './model.js';
import { duration } from './model.js';

export type MarketRow = typeof markets.$inferSelect;
export type MonitorRow = typeof monitorConfigs.$inferSelect;

export function saveCatalog(
  db: AppDatabase,
  exchange: ExchangeId,
  partition: CatalogPartition,
  now: number,
) {
  const group = and(
    eq(markets.exchange, exchange),
    eq(markets.productType, partition.productType),
    eq(markets.venue, partition.venue),
  );
  const listings = partition.listings;
  const key = (item: Pick<Market, 'marketType' | 'nativeSymbol'>) =>
    item.marketType + ':' + item.nativeSymbol;
  if (
    !listings ||
    new Set(listings.map(key)).size !== listings.length ||
    listings.some(
      (item) =>
        item.exchange !== exchange ||
        item.productType !== partition.productType ||
        item.venue !== partition.venue,
    )
  ) {
    db.update(markets).set({ stale: true }).where(group).run();
    return false;
  }
  db.transaction((tx) => {
    const existing = new Map(
      tx
        .select()
        .from(markets)
        .where(group)
        .all()
        .map((row) => [key(row), row]),
    );
    for (const item of listings) {
      const previous = existing.get(key(item));
      existing.delete(key(item));
      const values = { ...item, updatedAtMs: now, stale: false };
      if (previous) {
        tx.update(markets).set(values).where(eq(markets.id, previous.id)).run();
      } else {
        tx.insert(markets)
          .values({ ...values, id: randomUUID() })
          .run();
      }
    }
    for (const previous of existing.values()) {
      tx.update(markets)
        .set({
          status: 'UNLISTED',
          exchangeStatus: 'missing-from-catalog',
          updatedAtMs: now,
          stale: false,
        })
        .where(eq(markets.id, previous.id))
        .run();
    }
  });
  return true;
}

export function marketById(db: AppDatabase, id: string) {
  return db.select().from(markets).where(eq(markets.id, id)).get();
}

export function marketPage(
  db: AppDatabase,
  params: {
    exchange?: ExchangeId;
    type?: Market['marketType'];
    q?: string;
    offset: number;
    limit: number;
  },
) {
  const search = params.q?.toLowerCase();
  return db
    .select()
    .from(markets)
    .where(
      and(
        params.exchange ? eq(markets.exchange, params.exchange) : undefined,
        params.type ? eq(markets.marketType, params.type) : undefined,
        search
          ? sql`(instr(lower(${markets.nativeSymbol}), ${search}) > 0 or instr(lower(${markets.baseAsset}), ${search}) > 0)`
          : undefined,
      ),
    )
    .orderBy(
      sql`case when ${markets.status} = 'ACTIVE' then 0 else 1 end`,
      asc(markets.exchange),
      asc(markets.marketType),
      asc(markets.nativeSymbol),
      asc(markets.id),
    )
    .limit(params.limit + 1)
    .offset(params.offset)
    .all();
}

export function configuredMarkets(db: AppDatabase) {
  return db
    .select({ config: monitorConfigs, market: markets })
    .from(monitorConfigs)
    .innerJoin(markets, eq(monitorConfigs.marketId, markets.id))
    .orderBy(
      asc(markets.exchange),
      asc(markets.nativeSymbol),
      asc(monitorConfigs.id),
    )
    .all();
}

export function readCandles(
  db: AppDatabase,
  marketId: string,
  timeframe: Timeframe,
  limit: number,
  throughMs?: number,
): Candle[] {
  return db
    .select()
    .from(candles)
    .where(
      and(
        eq(candles.marketId, marketId),
        eq(candles.timeframe, timeframe),
        throughMs === undefined
          ? undefined
          : lte(candles.openTimeMs, throughMs - duration[timeframe]),
      ),
    )
    .orderBy(desc(candles.openTimeMs))
    .limit(limit)
    .all();
}

export function storeCandles(db: AppDatabase, bars: Candle[]) {
  const unique = [
    ...new Map(
      bars.filter((bar) => bar.isClosed).map((bar) => [bar.openTimeMs, bar]),
    ).values(),
  ].sort((a, b) => a.openTimeMs - b.openTimeMs);
  const inserted = new Set<number>();
  if (!unique.length) return inserted;
  db.transaction((tx) => {
    for (let i = 0; i < unique.length; i += 200) {
      const batch = unique.slice(i, i + 200);
      const fresh = tx
        .insert(candles)
        .values(batch)
        .onConflictDoNothing()
        .returning({ openTimeMs: candles.openTimeMs })
        .all();
      for (const row of fresh) inserted.add(row.openTimeMs);
      for (const bar of batch) {
        if (inserted.has(bar.openTimeMs) || bar.baseVolume === null) continue;
        tx.update(candles)
          .set({
            baseVolume: bar.baseVolume,
            quoteTurnover: bar.quoteTurnover,
            qualityFlags: bar.qualityFlags,
          })
          .where(
            and(
              eq(candles.marketId, bar.marketId),
              eq(candles.timeframe, bar.timeframe),
              eq(candles.openTimeMs, bar.openTimeMs),
              sql`${candles.baseVolume} is null`,
            ),
          )
          .run();
      }
    }
  });
  return inserted;
}

export function latestOi(
  db: AppDatabase,
  marketId: string,
): OpenInterest | null {
  return (
    db
      .select()
      .from(oiSnapshots)
      .where(eq(oiSnapshots.marketId, marketId))
      .orderBy(desc(oiSnapshots.timestampMs), desc(oiSnapshots.series))
      .limit(1)
      .get() ?? null
  );
}

export function saveOi(db: AppDatabase, items: OpenInterest[]) {
  if (items.length)
    db.insert(oiSnapshots).values(items).onConflictDoNothing().run();
}

export function latestQuote(
  db: AppDatabase,
  marketId: string,
): MarketQuote | null {
  return (
    db
      .select({ quote: quotes.quote })
      .from(quotes)
      .where(eq(quotes.marketId, marketId))
      .get()?.quote ?? null
  );
}

export function saveQuote(
  db: AppDatabase,
  marketId: string,
  quote: MarketQuote,
) {
  db.insert(quotes)
    .values({ marketId, quote })
    .onConflictDoUpdate({ target: quotes.marketId, set: { quote } })
    .run();
}

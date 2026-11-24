import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  marketListResponseSchema,
  marketResponseSchema,
  monitorResponseSchema,
  monitorsResponseSchema,
} from '@market-sentinel/contracts/markets';
import type { Candle, Timeframe } from '@market-sentinel/domain';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { initializeAdministrator } from '../src/auth.js';
import { readConfig } from '../src/config.js';
import {
  migrateDatabase,
  openDatabase,
  type AppDatabase,
} from '../src/database.js';
import { createBitgetProvider } from '../src/market-data/bitget.js';
import {
  aggregateRealityCandles,
  closeCutoff,
  duration,
  normalizeCandle,
} from '../src/market-data/model.js';
import { createMarketData } from '../src/market-data/service.js';
import {
  latestOi,
  readCandles,
  storeCandles,
} from '../src/market-data/store.js';
import { createRestQueue } from '../src/market-data/transport.js';
import { auditLogs, markets, monitorConfigs } from '../src/schema.js';

const fixedTime = Date.UTC(2026, 10, 23, 12, 0, 6);
const bgSymbols = Array.from(
  { length: 10 },
  (_, index) => 'B' + index + 'USDT',
);
const hlNative = Array.from({ length: 9 }, (_, index) => 'COIN' + index);
const hlBuilder = 'xyz:ASSET';
const fixtures = {
  o: '100.123456789123456789123',
  h: '123.3456',
  l: '99.123456789123456789124',
  c: '104.8756',
  v: '0.123456789123456789123',
  q: '101.111',
};

class FixtureSocket extends EventEmitter {
  sent: string[] = [];
  closed = false;

  send(frame: string) {
    this.sent.push(frame);
    if (frame === 'ping') this.emit('message', Buffer.from('pong'));
    if (frame === '{"method":"ping"}') this.push({ channel: 'pong' });
  }

  push(value: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(value)));
  }

  terminate() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

function exchangeFixture() {
  const state = {
    time: fixedTime,
    openBitget: true,
    realityVolume: true,
    spotHealthy: true,
    bitgetStatus: 'online',
    removedSymbol: '',
    alignedDaily: false,
    oiStatus: 200,
    v2Calls: 0,
  };
  const sockets = {
    BITGET: [] as FixtureSocket[],
    HYPERLIQUID: [] as FixtureSocket[],
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
    );
    const json = (data: unknown) => Response.json(data);
    const bitget = (data: unknown) =>
      json({ code: '00000', requestTime: state.time, data });

    if (url.hostname === 'api.bitget.com') {
      const category = url.searchParams.get('category');
      const symbol = url.searchParams.get('symbol');
      if (url.pathname.endsWith('/instruments')) {
        if (category === 'SPOT' && !state.spotHealthy)
          return new Response(null, { status: 503 });
        if (category === 'SPOT')
          return bitget([
            {
              category,
              symbol: 'RAAPLUSDT',
              baseCoin: 'RAAPL',
              quoteCoin: 'USDT',
              status: 'online',
              isReality: 'yes',
              instrumentType: 'stock',
              pricePrecision: '3',
            },
            {
              category,
              symbol: 'FIXUSDT',
              baseCoin: 'FIX',
              quoteCoin: 'USDT',
              status: 'online',
              isReality: 'no',
              pricePrecision: '2',
            },
          ]);
        return bitget(
          category === 'USDT-FUTURES'
            ? bgSymbols
                .filter((name) => name !== state.removedSymbol)
                .map((name) => ({
                  category,
                  symbol: name,
                  baseCoin: name.replace('USDT', ''),
                  quoteCoin: 'USDT',
                  status: state.bitgetStatus,
                  type: 'perpetual',
                  instrumentType: 'crypto',
                  isRwa: 'NO',
                  pricePrecision: '2',
                  priceMultiplier: '0.02',
                }))
            : [],
        );
      }
      if (
        url.pathname.endsWith('/candles') ||
        url.pathname.endsWith('/history-candles')
      ) {
        const interval = url.searchParams
          .get('interval')!
          .toLowerCase()
          .replace('utc', '') as Timeframe;
        const size = duration[interval];
        const start = Number(url.searchParams.get('startTime'));
        const end = Number(url.searchParams.get('endTime'));
        const candles = [];
        for (let at = start; at <= end; at += size) {
          candles.push([
            String(
              at +
                (interval === '1d' && !state.alignedDaily
                  ? 8 * duration['1h']
                  : 0),
            ),
            fixtures.o,
            fixtures.h,
            fixtures.l,
            fixtures.c,
            symbol === 'RAAPLUSDT' && !state.realityVolume ? '' : fixtures.v,
            symbol === 'RAAPLUSDT' && !state.realityVolume ? '' : fixtures.q,
          ]);
        }
        const limited = candles.slice(-Number(url.searchParams.get('limit')));
        return bitget([...limited.reverse(), limited[0]]);
      }
      if (url.pathname.endsWith('/tickers')) {
        return bitget([
          {
            symbol,
            lastPrice: '105.0',
            markPrice: '104.9',
            bid1Price: '104.8',
            ask1Price: '104.9',
            ts: String(state.time),
          },
        ]);
      }
      if (url.pathname.startsWith('/api/v2')) {
        state.v2Calls++;
        return bitget({
          ts: String(state.time),
          openInterestList: [{ symbol, size: '42.25' }],
        });
      }
      if (url.pathname.endsWith('/open-interest')) {
        if (state.oiStatus !== 200)
          return new Response(null, {
            status: state.oiStatus,
            headers: { 'Retry-After': '2' },
          });
        return bitget({
          ts: String(state.time),
          list: bgSymbols.map((name) => ({
            symbol: name,
            openInterest: '123.456',
          })),
        });
      }
    }

    if (url.hostname === 'api.hyperliquid.xyz') {
      const body = JSON.parse(String(init?.body));
      if (body.type === 'spotMeta')
        return json({
          tokens: [
            { index: 0, name: 'USDC', szDecimals: 2 },
            { index: 1, name: 'PURR', szDecimals: 0 },
            { index: 150, name: 'HYPE', szDecimals: 2 },
          ],
          universe: [
            { index: 0, name: 'PURR/USDC', tokens: [1, 0] },
            { index: 107, name: '@107', tokens: [150, 0] },
          ],
        });
      if (body.type === 'perpDexs') return json([null, { name: 'xyz' }]);
      if (body.type === 'metaAndAssetCtxs') {
        const universe = (body.dex === 'xyz' ? [hlBuilder] : hlNative).map(
          (name) => ({ name, szDecimals: 3 }),
        );
        return json([
          { universe, collateralToken: 0 },
          universe.map(() => ({ openInterest: '98.765' })),
        ]);
      }
      if (body.type === 'l2Book')
        return json({
          coin: body.coin,
          time: state.time,
          levels: [[{ px: '101.25' }], [{ px: '101.26' }]],
        });
      if (body.type === 'candleSnapshot') {
        const { coin, interval, startTime, endTime } = body.req;
        const size = duration[interval as Timeframe];
        const candles = [];
        for (let at = startTime; at <= endTime + 1; at += size) {
          candles.push({
            t: at,
            T: at + size - 1,
            i: interval,
            s: coin,
            ...fixtures,
          });
        }
        return json(candles.reverse());
      }
    }
    throw new Error('Unrecognized fixture request ' + url.pathname);
  };
  return {
    state,
    sockets,
    fetcher,
    socketFactory(url: string) {
      const exchange = url.includes('bitget') ? 'BITGET' : 'HYPERLIQUID';
      const socket = new FixtureSocket();
      sockets[exchange].push(socket);
      if (exchange === 'HYPERLIQUID' || state.openBitget)
        queueMicrotask(() => socket.emit('open'));
      return socket;
    },
    now: () => state.time,
  };
}

let database: AppDatabase;
let directory: string;
let runtime: ReturnType<typeof createMarketData> | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'market-sentinel-m1-'));
  database = openDatabase(join(directory, 'test.sqlite'));
});

afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
  vi.useRealTimers();
  database.$client.close();
  for (const name of ['test.sqlite', 'test.sqlite-wal', 'test.sqlite-shm']) {
    rmSync(join(directory, name), { force: true });
  }
  rmdirSync(directory);
});

function market(exchange: 'BITGET' | 'HYPERLIQUID', nativeSymbol: string) {
  return database
    .select()
    .from(markets)
    .where(
      and(
        eq(markets.exchange, exchange),
        eq(markets.nativeSymbol, nativeSymbol),
      ),
    )
    .get()!;
}

test('upgrades a real M0 database twice and retains its administrator and audit history', async () => {
  const original = fileURLToPath(new URL('../drizzle/', import.meta.url));
  const m0 = readdirSync(original).find((name) =>
    name.endsWith('_m0_initial'),
  )!;
  const legacy = join(directory, 'legacy', m0);
  mkdirSync(legacy, { recursive: true });
  const legacySql = join(legacy, 'migration.sql');
  try {
    copyFileSync(join(original, m0, 'migration.sql'), legacySql);
    migrate(database, { migrationsFolder: join(directory, 'legacy') });
    expect(
      await initializeAdministrator(database, {
        username: 'legacy',
        password: 'fixture passphrase 2026',
      }),
    ).toBe(true);
    migrateDatabase(database);
    migrateDatabase(database);
    expect(
      database.$client.prepare('SELECT username FROM administrators').get(),
    ).toMatchObject({ username: 'legacy' });
    expect(database.select().from(auditLogs).all()).toHaveLength(1);
    expect(
      database.$client
        .prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations')
        .get(),
    ).toMatchObject({ n: 4 });
    expect(database.select().from(markets).all()).toEqual([]);
  } finally {
    rmSync(legacySql, { force: true });
    rmdirSync(legacy);
    rmdirSync(join(directory, 'legacy'));
  }
});

test('validates price and alignment and only aggregates exact complete REST minute volume', () => {
  const start = closeCutoff(fixedTime, '3m');
  const fixture = {
    open: fixtures.o,
    high: fixtures.h,
    low: fixtures.l,
    close: fixtures.c,
    baseVolume: fixtures.v,
    quoteTurnover: fixtures.q,
  };
  const samples = Array.from({ length: 3 }, (_, index) =>
    normalizeCandle(
      'fixture',
      '1m',
      { ...fixture, openTimeMs: start + index * duration['1m'] },
      'REST',
    )!,
  );
  expect(
    aggregateRealityCandles(samples, start, start + duration['3m']),
  ).toEqual([
    expect.objectContaining({
      baseVolume: '0.370370367370370367369',
      quoteTurnover: '303.333',
      source: 'AGGREGATED',
    }),
  ]);
  expect(
    aggregateRealityCandles(
      [samples[0]!, { ...samples[1]!, baseVolume: null }, samples[2]!],
      start,
      start + duration['3m'],
    ),
  ).toEqual([]);
  expect(
    aggregateRealityCandles(
      [samples[0]!, { ...samples[1]!, isClosed: false }, samples[2]!],
      start,
      start + duration['3m'],
    ),
  ).toEqual([]);
  expect(
    normalizeCandle(
      'fixture',
      '1m',
      { ...fixture, openTimeMs: start + 1 },
      'REST',
    ),
  ).toBeNull();
  expect(
    normalizeCandle(
      'fixture',
      '1m',
      { ...fixture, low: '101', openTimeMs: start },
      'REST',
    ),
  ).toBeNull();
});

test('preserves stable catalog IDs across sync, isolates failed partitions and disables delisted markets', async () => {
  migrateDatabase(database);
  const fixture = exchangeFixture();
  runtime = createMarketData(database, fixture);
  await runtime.runSync();
  const reality = market('BITGET', 'RAAPLUSDT');
  const futures = market('BITGET', bgSymbols[0]!);
  const removed = market('BITGET', bgSymbols[1]!);
  expect(reality).toMatchObject({
    isReality: true,
    isRwa: true,
    quoteAsset: 'USDT',
  });
  expect(market('HYPERLIQUID', '@107')).toMatchObject({
    baseAsset: 'HYPE',
    quoteAsset: 'USDC',
  });
  expect(market('HYPERLIQUID', hlBuilder)).toMatchObject({
    venue: 'xyz',
    quoteAsset: null,
    collateralAsset: 'USDC',
  });
  const verified = await runtime.checkPeriods(reality, ['3m', '1d']);
  expect(verified.capabilities.intervals).toContain('3m');
  expect(verified.capabilities.intervals).not.toContain('1d');

  fixture.state.time += 6 * duration['1h'] + 1;
  fixture.state.realityVolume = false;
  fixture.state.alignedDaily = true;
  fixture.state.spotHealthy = false;
  fixture.state.bitgetStatus = 'offline';
  fixture.state.removedSymbol = removed.nativeSymbol;
  await runtime.runSync();
  expect(market('BITGET', 'RAAPLUSDT')).toMatchObject({
    id: reality.id,
    stale: true,
    status: 'ACTIVE',
  });
  expect(market('BITGET', bgSymbols[0]!)).toMatchObject({
    id: futures.id,
    stale: false,
    status: 'INACTIVE',
  });
  expect(market('BITGET', removed.nativeSymbol)).toMatchObject({
    id: removed.id,
    status: 'UNLISTED',
  });
  const restricted = await runtime.checkPeriods(market('BITGET', 'RAAPLUSDT'), [
    '3m',
    '1d',
  ]);
  expect(restricted.capabilities.intervals).not.toContain('3m');
  expect(restricted.capabilities.intervals).toContain('1d');
  expect(restricted.intervalRestrictions['3m']).toContain('成交量完整');
  expect(
    runtime.diagnostics().providers[0]?.catalog.failedPartitions,
  ).toContain('SPOT/main');
});

test('honors Retry-After and dispatches a queued close before backfill', async () => {
  vi.useFakeTimers();
  const order: string[] = [];
  const queue = createRestQueue('BITGET', async (input) => {
    order.push(String(input));
    return order.length === 1
      ? new Response(null, { status: 429, headers: { 'Retry-After': '7' } })
      : Response.json({});
  });
  try {
    const urls = ['first', 'backfill', 'close'].map(
      (key) => new URL('https://api.bitget.com/' + key),
    );
    await expect(queue.request(urls[0]!, 'live')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    const backfill = queue.request(urls[1]!, 'backfill');
    const close = queue.request(urls[2]!, 'live');
    await vi.advanceTimersByTimeAsync(6_999);
    expect(order).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([backfill, close]);
    expect(order).toEqual([String(urls[0]), String(urls[2]), String(urls[1])]);
  } finally {
    queue.stop();
  }
});

test('only switches Bitget OI series after an explicit unsupported result', async () => {
  migrateDatabase(database);
  const fixture = exchangeFixture();
  runtime = createMarketData(database, fixture);
  await runtime.runSync();
  const selected = [runtime.view(market('BITGET', bgSymbols[0]!))];
  const queue = createRestQueue('BITGET', fixture.fetcher);
  try {
    const adapter = createBitgetProvider(queue);
    expect(await adapter.openInterest(selected)).toEqual([
      expect.objectContaining({ series: 'BITGET_V3', unit: 'BASE_ASSET' }),
    ]);
    fixture.state.oiStatus = 503;
    expect(await adapter.openInterest(selected)).toEqual([]);
    expect(fixture.state.v2Calls).toBe(0);
    fixture.state.oiStatus = 404;
    expect(await adapter.openInterest(selected)).toEqual([
      expect.objectContaining({ series: 'BITGET_V2', value: '42.25' }),
    ]);
    expect(fixture.state.v2Calls).toBe(1);
  } finally {
    queue.stop();
  }
});

test('protects and audits market operations and rolls back a batch containing an unavailable market', async () => {
  migrateDatabase(database);
  const fixture = exchangeFixture();
  runtime = createMarketData(database, fixture);
  await runtime.runSync();
  const credentials = {
    username: 'm1-admin',
    password: 'fixture password 2026',
  };
  const config = readConfig({
    NODE_ENV: 'test',
    APP_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
    SESSION_SECRET: randomBytes(32).toString('base64'),
    LOG_LEVEL: 'silent',
  });
  await initializeAdministrator(database, credentials);
  const app = await buildApp(database, config, runtime);
  try {
    const first = market('BITGET', bgSymbols[0]!).id;
    const second = market('HYPERLIQUID', hlBuilder).id;
    const origin = config.WEB_ORIGIN;
    expect((await app.inject('/api/v1/markets')).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/markets/sync',
          headers: { origin },
        })
      ).statusCode,
    ).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin },
      payload: credentials,
    });
    const cookies = { market_sentinel_session: login.cookies[0]!.value };
    const get = (url: string) => app.inject({ url, cookies });
    const mutate = (
      method: 'POST' | 'PATCH' | 'DELETE',
      url: string,
      payload?: Record<string, unknown>,
    ) => app.inject({ method, url, payload, cookies, headers: { origin } });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/monitors',
          headers: { origin: 'https://wrong.example' },
          cookies,
          payload: { marketId: first },
        })
      ).statusCode,
    ).toBe(403);
    const search = marketListResponseSchema.parse(
      (
        await get('/api/v1/markets?exchange=HYPERLIQUID&type=SPOT&q=%40107')
      ).json(),
    );
    expect(search.data.items.map((row) => row.nativeSymbol)).toEqual(['@107']);
    const onlyHyperliquid = await get(
      '/api/v1/markets?exchange=HYPERLIQUID&q=B0',
    );
    expect(
      marketListResponseSchema.parse(onlyHyperliquid.json()).data.items,
    ).toEqual([]);
    expect(
      marketResponseSchema.parse(
        (await get('/api/v1/markets/' + second)).json(),
      ).data.venue,
    ).toBe('xyz');

    const a = await mutate('POST', '/api/v1/monitors', {
      marketId: first,
      enabled: false,
    });
    const b = await mutate('POST', '/api/v1/monitors', {
      marketId: second,
      enabled: false,
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(
      (await mutate('POST', '/api/v1/monitors', { marketId: first }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await mutate('POST', '/api/v1/monitors', {
          marketId: first,
          trigger: '2m',
        })
      ).statusCode,
    ).toBe(400);
    const aId = monitorResponseSchema.parse(a.json()).data.id;
    const bId = monitorResponseSchema.parse(b.json()).data.id;
    const ids = [aId, bId];
    database
      .update(markets)
      .set({ status: 'INACTIVE' })
      .where(eq(markets.id, second))
      .run();
    expect(
      (await mutate('PATCH', '/api/v1/monitors/batch', { ids, enabled: true }))
        .statusCode,
    ).toBe(409);
    expect(
      monitorsResponseSchema
        .parse((await get('/api/v1/monitors')).json())
        .data.every(({ enabled }) => !enabled),
    ).toBe(true);
    database
      .update(markets)
      .set({ status: 'ACTIVE' })
      .where(eq(markets.id, second))
      .run();
    expect(
      (await mutate('PATCH', '/api/v1/monitors/batch', { ids, enabled: true }))
        .statusCode,
    ).toBe(200);
    expect(
      (await mutate('PATCH', '/api/v1/monitors/' + aId, { extra: ['15m'] }))
        .statusCode,
    ).toBe(200);

    const open = closeCutoff(fixedTime, '3m') - duration['3m'];
    storeCandles(database, [
      normalizeCandle(
        first,
        '3m',
        {
          openTimeMs: open,
          open: '11',
          high: '12',
          low: '10',
          close: '11.1',
          baseVolume: '10',
        },
        'REST',
      )!,
    ]);
    expect((await mutate('DELETE', '/api/v1/monitors/' + aId)).statusCode).toBe(
      200,
    );
    expect(readCandles(database, first, '3m', 1)).toHaveLength(1);
    expect(
      database
        .select()
        .from(auditLogs)
        .all()
        .filter(({ action }) => action.startsWith('MONITOR_')),
    ).toHaveLength(6);
  } finally {
    await app.close();
  }
});

describe('dual provider collection', () => {
  test('warms 60 timeframe streams and recovers one exchange while the other keeps confirming candles', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedTime);
    migrateDatabase(database);
    const fixture = exchangeFixture();
    runtime = createMarketData(database, fixture);
    await runtime.runSync();
    const rows = [
      ...bgSymbols.map((name) => market('BITGET', name)),
      ...[...hlNative, hlBuilder].map((name) => market('HYPERLIQUID', name)),
    ];
    database
      .insert(monitorConfigs)
      .values(
        rows.map((row) => ({
          id: randomUUID(),
          marketId: row.id,
          enabled: true,
          trigger: '3m',
          confirm: '5m',
          trend: '1h',
          extra: [],
        })),
      )
      .run();
    const events: Candle[] = [];
    runtime.onCandleClosed((event) => events.push(event));
    runtime.start();
    await vi.advanceTimersByTimeAsync(105_000);

    const list = runtime.listMonitors();
    expect(list).toHaveLength(20);
    expect(list.flatMap(({ periods }) => periods)).toHaveLength(60);
    expect(
      list
        .flatMap(({ periods }) => periods)
        .every((item) => item.validCandles === 500 && item.state === 'ACTIVE'),
    ).toBe(true);
    expect(
      runtime.diagnostics().providers.map(({ subscriptions }) => subscriptions),
    ).toEqual([40, 60]);
    expect(
      runtime
        .diagnostics()
        .providers.map(({ lastSocketError }) => lastSocketError),
    ).toEqual([null, null]);
    expect(events).toHaveLength(0);
    const bitget = rows[0]!;
    const hl = rows[10]!;
    expect(latestOi(database, bitget.id)?.series).toBe('BITGET_V3');
    expect(latestOi(database, hl.id)?.series).toBe('HYPERLIQUID_main');

    const firstSocket = fixture.sockets.BITGET[0]!;
    const current = closeCutoff(fixture.state.time, '3m');
    const push = (close: string, stamp: number, start: number) =>
      firstSocket.push({
        action: 'update',
        ts: stamp,
        arg: {
          instType: 'usdt-futures',
          symbol: bitget.nativeSymbol,
          topic: 'kline',
          interval: '3m',
        },
        data: [
          {
            start: String(start),
            open: fixtures.o,
            high: fixtures.h,
            low: fixtures.l,
            close,
            volume: fixtures.v,
            turnover: fixtures.q,
          },
        ],
      });
    push('105.11', fixture.state.time + 1, current);
    push('105.12', fixture.state.time, current);
    push('105.13', fixture.state.time + 2, current - duration['3m']);
    expect(
      runtime.listMonitors().find(({ market }) => market.id === bitget.id)
        ?.periods[0]?.preview,
    ).toMatchObject({ close: '105.11', isClosed: false });
    expect(readCandles(database, bitget.id, '3m', 1)[0]?.openTimeMs).toBe(
      current - duration['3m'],
    );

    fixture.state.openBitget = false;
    firstSocket.terminate();
    fixture.state.time += duration['3m'];
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events).toHaveLength(10);
    expect(
      events.every(
        (event) =>
          !bgSymbols.includes(
            rows.find(({ id }) => id === event.marketId)!.nativeSymbol,
          ),
      ),
    ).toBe(true);
    expect(
      runtime.listMonitors().find(({ market }) => market.id === bitget.id)
        ?.periods[0]?.state,
    ).toBe('RECOVERING');

    fixture.sockets.BITGET.at(-1)!.emit('open');
    await vi.advanceTimersByTimeAsync(75_000);
    expect(events).toHaveLength(10);
    expect(readCandles(database, bitget.id, '3m', 1)[0]?.openTimeMs).toBe(
      current,
    );
    fixture.state.time += duration['3m'];
    await vi.advanceTimersByTimeAsync(40_000);
    expect(events.filter(({ timeframe }) => timeframe === '3m')).toHaveLength(
      30,
    );
    expect(
      new Set(
        events.map(({ marketId, timeframe, openTimeMs }) =>
          [marketId, timeframe, openTimeMs].join('/'),
        ),
      ).size,
    ).toBe(events.length);

    const count = database.$client
      .prepare('SELECT COUNT(*) AS n FROM candles')
      .get()!.n;
    await runtime.stop();
    fixture.state.openBitget = true;
    runtime = createMarketData(database, fixture);
    runtime.onCandleClosed((event) => events.push(event));
    const before = events.length;
    runtime.start();
    await vi.advanceTimersByTimeAsync(105_000);
    expect(
      database.$client.prepare('SELECT COUNT(*) AS n FROM candles').get()!.n,
    ).toBe(count);
    expect(events).toHaveLength(before);
  });
});

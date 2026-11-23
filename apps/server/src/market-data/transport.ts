import type { ProviderDiagnostics } from '@market-sentinel/contracts/markets';
import type { ExchangeId } from '@market-sentinel/domain';
import WebSocket, { type RawData } from 'ws';
import type {
  MarketEvent,
  MarketSocketProtocol,
  RequestPriority,
  Subscription,
} from './model.js';

export type ProviderErrorCode =
  | 'UNSUPPORTED'
  | 'ACCESS_DENIED'
  | 'HTTP_ERROR'
  | 'UPSTREAM_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'INVALID_RESPONSE'
  | 'STOPPED';

export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode) {
    super(code);
  }
}

export function providerError(error: unknown) {
  return error instanceof ProviderError ? error.code : 'INVALID_RESPONSE';
}

const priorities: Record<RequestPriority, number> = {
  live: 0,
  sample: 1,
  backfill: 2,
};
type RestDiagnostics = Pick<
  ProviderDiagnostics,
  'lastRestAtMs' | 'lastRestLatencyMs' | 'lastRestError'
>;
type SocketDiagnostics = Pick<
  ProviderDiagnostics,
  | 'connection'
  | 'subscriptions'
  | 'reconnects'
  | 'lastMessageAtMs'
  | 'lastSocketError'
>;

interface PendingRequest {
  url: URL;
  body: unknown;
  priority: RequestPriority;
  cost: number;
  resolve(data: unknown): void;
  reject(error: unknown): void;
}

export function createRestQueue(
  exchange: ExchangeId,
  fetcher: typeof fetch = fetch,
) {
  const bitget = exchange === 'BITGET';
  const capacity = bitget ? 5 : 120;
  const refillPerMs = (bitget ? 5 : 15) / 1_000;
  const buckets = new Map<string, { tokens: number; since: number }>();
  const pending: PendingRequest[] = [];
  const stopSignal = new AbortController();
  const diagnostics: RestDiagnostics = {
    lastRestAtMs: null,
    lastRestLatencyMs: null,
    lastRestError: null,
  };
  let running = 0;
  let blockedUntil = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function send(job: PendingRequest) {
    const at = Date.now();
    try {
      const response = await fetcher(job.url, {
        signal: AbortSignal.any([
          stopSignal.signal,
          AbortSignal.timeout(10_000),
        ]),
        redirect: 'error',
        ...(job.body === undefined
          ? {}
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(job.body),
            }),
      });
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const seconds =
          retryAfter && /^\d+(\.\d+)?$/.test(retryAfter)
            ? Number(retryAfter) * 1_000
            : Date.parse(retryAfter ?? '') - Date.now();
        blockedUntil = Math.max(
          blockedUntil,
          Date.now() +
            (Number.isFinite(seconds) ? Math.max(1_000, seconds) : 5_000),
        );
        throw new ProviderError('RATE_LIMITED');
      }
      if ([404, 405, 501].includes(response.status))
        throw new ProviderError('UNSUPPORTED');
      if ([401, 403, 451].includes(response.status))
        throw new ProviderError('ACCESS_DENIED');
      if (!response.ok)
        throw new ProviderError(
          response.status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'HTTP_ERROR',
        );
      const value: unknown = await response.json().catch(() => {
        throw new ProviderError('INVALID_RESPONSE');
      });
      diagnostics.lastRestError = null;
      job.resolve(value);
    } catch (error) {
      const failure =
        error instanceof ProviderError
          ? error
          : new ProviderError(
              stopSignal.signal.aborted ? 'STOPPED' : 'UPSTREAM_UNAVAILABLE',
            );
      diagnostics.lastRestError = failure.code;
      job.reject(failure);
    } finally {
      diagnostics.lastRestAtMs = Date.now();
      diagnostics.lastRestLatencyMs = Math.max(0, Date.now() - at);
      running--;
      pump();
    }
  }

  function pump() {
    clearTimeout(timer);
    if (stopSignal.signal.aborted || pending.length === 0 || running >= 4)
      return;
    const now = Date.now();
    let delay = Math.max(0, blockedUntil - now);
    if (delay === 0) {
      delay = Infinity;
      for (let i = 0; i < pending.length && running < 4;) {
        const job = pending[i]!;
        const key = bitget ? job.url.pathname : 'info';
        const bucket = buckets.get(key) ?? { tokens: capacity, since: now };
        bucket.tokens = Math.min(
          capacity,
          bucket.tokens + Math.max(0, now - bucket.since) * refillPerMs,
        );
        bucket.since = now;
        buckets.set(key, bucket);
        if (bucket.tokens < job.cost) {
          delay = Math.min(delay, (job.cost - bucket.tokens) / refillPerMs);
          i++;
          continue;
        }
        bucket.tokens -= job.cost;
        pending.splice(i, 1);
        running++;
        void send(job);
      }
    }
    if (pending.length > 0 && running < 4 && Number.isFinite(delay)) {
      timer = setTimeout(
        pump,
        Math.min(2_147_483_647, Math.max(1, Math.ceil(delay))),
      );
    }
  }

  return {
    diagnostics,
    request(url: URL, priority: RequestPriority, body?: unknown, cost = 20) {
      return new Promise<unknown>((resolve, reject) => {
        if (stopSignal.signal.aborted) {
          reject(new ProviderError('STOPPED'));
          return;
        }
        pending.push({
          url,
          body,
          priority,
          cost: bitget ? 1 : cost,
          resolve,
          reject,
        });
        pending.sort((a, b) => priorities[a.priority] - priorities[b.priority]);
        pump();
      });
    },
    stop() {
      clearTimeout(timer);
      stopSignal.abort();
      for (const job of pending.splice(0))
        job.reject(new ProviderError('STOPPED'));
    },
  };
}

export type RestQueue = ReturnType<typeof createRestQueue>;

export interface SocketLike {
  on(event: 'open' | 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'message', listener: (data: RawData) => void): void;
  send(text: string): void;
  terminate(): void;
}
export type SocketFactory = (url: string) => SocketLike;

export function createMarketSocket(
  exchange: ExchangeId,
  protocol: MarketSocketProtocol,
  onData: (event: MarketEvent) => void,
  onDisconnect: () => void,
  connect: SocketFactory = (url) =>
    new WebSocket(url, {
      maxPayload: 4 * 1024 * 1024,
      handshakeTimeout: 10_000,
    }),
) {
  const diagnostics: SocketDiagnostics = {
    connection: 'IDLE',
    subscriptions: 0,
    reconnects: 0,
    lastMessageAtMs: null,
    lastSocketError: null,
  };
  let desired = new Map<string, Subscription>();
  let sent = new Map<string, Subscription>();
  let socket: SocketLike | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let sendTimer: ReturnType<typeof setTimeout> | undefined;
  let retry = 0;
  let lastReceived = 0;
  const commands: string[] = [];
  const bitgetCommandTimes: number[] = [];

  function cancelTimers() {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    clearInterval(heartbeat);
    clearTimeout(sendTimer);
    sendTimer = undefined;
  }

  function flush() {
    if (
      sendTimer ||
      !socket ||
      diagnostics.connection !== 'CONNECTED' ||
      !commands.length
    )
      return;
    const now = Date.now();
    while (
      bitgetCommandTimes[0] !== undefined &&
      bitgetCommandTimes[0] <= now - 3_600_000
    ) {
      bitgetCommandTimes.shift();
    }
    if (exchange === 'BITGET' && bitgetCommandTimes.length >= 240) {
      sendTimer = setTimeout(
        () => {
          sendTimer = undefined;
          flush();
        },
        bitgetCommandTimes[0]! + 3_600_000 - now,
      );
    } else {
      try {
        socket.send(commands.shift()!);
      } catch {
        diagnostics.lastSocketError = 'SEND_FAILED';
        socket.terminate();
        return;
      }
      if (exchange === 'BITGET') bitgetCommandTimes.push(now);
      sendTimer = setTimeout(() => {
        sendTimer = undefined;
        flush();
      }, 120);
    }
    sendTimer.unref();
  }

  function reconcile() {
    if (diagnostics.connection !== 'CONNECTED') return;
    const remove = [...sent.values()].filter(({ key }) => !desired.has(key));
    const add = [...desired.values()].filter(({ key }) => !sent.has(key));
    commands.push(
      ...protocol.encode('unsubscribe', remove),
      ...protocol.encode('subscribe', add),
    );
    sent = new Map(desired);
    flush();
  }

  function reconnect() {
    if (!desired.size || reconnectTimer) return;
    diagnostics.connection = 'RECONNECTING';
    diagnostics.reconnects++;
    const delay =
      Math.min(30_000, 1_000 * 2 ** Math.min(retry++, 5)) +
      Math.floor(Math.random() * 500);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      open();
    }, delay);
    reconnectTimer.unref();
  }

  function open() {
    if (socket || !desired.size) return;
    diagnostics.connection = retry ? 'RECONNECTING' : 'CONNECTING';
    try {
      socket = connect(protocol.url);
    } catch {
      diagnostics.lastSocketError = 'CONNECT_FAILED';
      reconnect();
      return;
    }
    const connection = socket;
    connection.on('open', () => {
      if (socket !== connection) return;
      diagnostics.connection = 'CONNECTED';
      diagnostics.lastSocketError = null;
      lastReceived = Date.now();
      sent.clear();
      bitgetCommandTimes.length = 0;
      reconcile();
      heartbeat = setInterval(() => {
        if (Date.now() - lastReceived > 60_000) {
          diagnostics.lastSocketError = 'HEARTBEAT_TIMEOUT';
          connection.terminate();
          return;
        }
        try {
          connection.send(protocol.ping);
        } catch {
          connection.terminate();
        }
      }, 30_000);
      heartbeat.unref();
    });
    connection.on('message', (data) => {
      if (socket !== connection) return;
      lastReceived = Date.now();
      retry = 0;
      diagnostics.lastMessageAtMs = lastReceived;
      const message = Array.isArray(data)
        ? Buffer.concat(data).toString()
        : Buffer.isBuffer(data)
          ? data.toString()
          : Buffer.from(data).toString();
      let events: MarketEvent[];
      try {
        events = protocol.decode(message, lastReceived);
      } catch {
        diagnostics.lastSocketError = 'INVALID_OR_REJECTED_MESSAGE';
        return;
      }
      try {
        for (const event of events) onData(event);
      } catch {
        diagnostics.lastSocketError = 'DATA_HANDLER_FAILED';
      }
    });
    connection.on('error', () => {
      if (socket === connection)
        diagnostics.lastSocketError = 'CONNECTION_ERROR';
    });
    connection.on('close', () => {
      if (socket !== connection) return;
      const connected = diagnostics.connection === 'CONNECTED';
      socket = undefined;
      cancelTimers();
      commands.length = 0;
      sent.clear();
      if (connected) onDisconnect();
      reconnect();
    });
  }

  function stop() {
    cancelTimers();
    desired.clear();
    sent.clear();
    commands.length = 0;
    retry = 0;
    const current = socket;
    socket = undefined;
    current?.terminate();
    diagnostics.connection = 'IDLE';
    diagnostics.subscriptions = 0;
  }

  return {
    diagnostics,
    setSubscriptions(subscriptions: Subscription[]) {
      if (!subscriptions.length) {
        stop();
        return;
      }
      desired = new Map(
        subscriptions.map((subscription) => [subscription.key, subscription]),
      );
      diagnostics.subscriptions = desired.size;
      if (!reconnectTimer) open();
      reconcile();
    },
    stop,
  };
}

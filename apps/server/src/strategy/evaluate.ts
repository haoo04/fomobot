import type { Market, MarketQuote } from '@market-sentinel/contracts/markets';
import type {
  CandidateDirection,
  CandidateReview,
  RiskLevels,
  StrategyParameters,
} from '@market-sentinel/contracts/strategies';
import type { Candle, MarketType, Timeframe } from '@market-sentinel/domain';
import { Decimal } from 'decimal.js';
import {
  decimal,
  duration,
  price,
  type OpenInterest,
} from '../market-data/model.js';

const Exact = Decimal.clone({ precision: 220 });

export function closedHistory(
  candles: Candle[],
  marketId: string,
  timeframe: Timeframe,
  throughMs: number,
  minimum: number,
) {
  const size = duration[timeframe];
  let closeMs = Math.floor(throughMs / size) * size;
  const history: Candle[] = [];
  for (const bar of candles) {
    if (
      bar.marketId !== marketId ||
      bar.timeframe !== timeframe ||
      bar.closeTimeMs !== closeMs ||
      bar.openTimeMs !== closeMs - size ||
      !bar.isClosed ||
      bar.baseVolume === null ||
      bar.qualityFlags.some((flag) => flag !== 'MISSING_QUOTE_TURNOVER')
    )
      break;
    history.push(bar);
    closeMs -= size;
  }
  if (history.length >= minimum)
    return { bars: history.reverse(), reason: null };
  return {
    bars: null,
    reason:
      history.length < candles.length ? 'REJECT_INCOMPLETE_CANDLE' : 'WARMING',
  };
}

export function ema(values: number[], period: number) {
  let value =
    values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i++)
    value += alpha * (values[i]! - value);
  return value;
}

export function rsi(values: number[], period: number) {
  let gain = 0;
  let loss = 0;
  let current = NaN;
  let previous = NaN;
  for (let i = 1; i < values.length; i++) {
    const change = values[i]! - values[i - 1]!;
    const up = Math.max(0, change);
    const down = Math.max(0, -change);
    if (i <= period) {
      gain += up / period;
      loss += down / period;
    } else {
      gain += (up - gain) / period;
      loss += (down - loss) / period;
    }
    if (i >= period) {
      previous = current;
      current =
        loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
    }
  }
  return { current, previous };
}

export function atr(bars: Candle[], period: number) {
  let average = 0;
  for (let i = 1; i < bars.length; i++) {
    const { high, low } = bars[i]!;
    const close = Number(bars[i - 1]!.close);
    const h = Number(high);
    const l = Number(low);
    const range = Math.max(h - l, Math.abs(h - close), Math.abs(l - close));
    average += (i <= period ? range : range - average) / period;
  }
  return average;
}

export function relativeVolume(volumes: number[], lookback: number) {
  const average =
    volumes.slice(-lookback - 1, -1).reduce((sum, value) => sum + value, 0) /
    lookback;
  return average > 0 ? volumes.at(-1)! / average : NaN;
}

export function trendSetup(
  marketType: MarketType,
  params: StrategyParameters,
  trigger: Candle[],
  confirm: Candle[],
  trend: Candle[],
) {
  const closes = trigger.map((bar) => Number(bar.close));
  const trendCloses = trend.map((bar) => Number(bar.close));
  const confirmCloses = confirm.map((bar) => Number(bar.close));
  const volumes = trigger.map((bar) => Number(bar.baseVolume));
  if (
    ![...closes, ...trendCloses, ...confirmCloses].every(
      (value) => Number.isFinite(value) && value > 0,
    ) ||
    !volumes.every((value) => Number.isFinite(value) && value >= 0)
  )
    return null;

  const [fast, medium, slow] = params.emaPeriods.map((period) =>
    ema(trendCloses, period),
  );
  const triggerEma = ema(closes, params.emaPeriods[0]);
  const momentum = rsi(confirmCloses, params.rsi.period);
  const rvol = relativeVolume(volumes, params.volume.lookback);
  const volatility = atr(trigger, params.atr.period);
  if (
    ![
      fast,
      medium,
      slow,
      triggerEma,
      momentum.current,
      momentum.previous,
      rvol,
      volatility,
    ].every(Number.isFinite)
  )
    return null;

  const directions: CandidateDirection[] = [];
  const indicators = {
    triggerEma,
    trendEma: [fast!, medium!, slow!],
    rsi: momentum.current,
    previousRsi: momentum.previous,
    rvol,
    atr: volatility,
  };
  const previous = trigger.at(-2)!;
  const close = closes.at(-1)!;
  const trendClose = trendCloses.at(-1)!;
  const { longMin, longMax, shortMin, shortMax } = params.rsi;
  if (rvol >= params.volume.relativeMin) {
    if (
      fast! > medium! &&
      medium! > slow! &&
      trendClose > fast! &&
      momentum.current >= longMin &&
      momentum.current <= longMax &&
      momentum.current > momentum.previous &&
      close > triggerEma &&
      (!params.breakPreviousCandle || close > Number(previous.high))
    )
      directions.push('LONG');
    if (
      fast! < medium! &&
      medium! < slow! &&
      trendClose < fast! &&
      momentum.current >= shortMin &&
      momentum.current <= shortMax &&
      momentum.current < momentum.previous &&
      close < triggerEma &&
      (!params.breakPreviousCandle || close < Number(previous.low))
    )
      directions.push(marketType === 'SPOT' ? 'BEARISH_WATCH' : 'SHORT');
  }
  return { directions, indicators };
}

export const oiToleranceMs = 90_000;

export function oiChange(
  samples: OpenInterest[],
  params: NonNullable<StrategyParameters['oi']>,
  triggerCloseMs: number,
  evaluatedAtMs: number,
) {
  const ordered = samples
    .filter((sample) => sample.timestampMs <= triggerCloseMs)
    .sort(
      (a, b) =>
        b.timestampMs - a.timestampMs || b.series.localeCompare(a.series),
    );
  const latest = ordered[0] ?? null;
  if (
    !latest ||
    evaluatedAtMs - latest.timestampMs > params.maxAgeSeconds * 1000
  )
    return { latest, reference: null, deltaPct: null };
  const comparable = ordered.filter(
    (sample) =>
      sample.series === latest.series &&
      sample.unit === latest.unit &&
      sample.unitDetails === latest.unitDetails &&
      sample.qualityFlags.length === 0,
  );
  const targetMs = triggerCloseMs - params.lookbackMinutes * 60_000;
  let bestDistance = oiToleranceMs + 1;
  let reference: OpenInterest | null = null;
  let previousMs = latest.timestampMs;
  for (const sample of comparable) {
    if (sample.timestampMs === latest.timestampMs) continue;
    if (previousMs - sample.timestampMs > 180_000) break;
    const distance = Math.abs(sample.timestampMs - targetMs);
    if (distance <= oiToleranceMs && distance <= bestDistance) {
      bestDistance = distance;
      reference = sample;
    }
    previousMs = sample.timestampMs;
  }
  if (
    !reference ||
    latest.qualityFlags.length ||
    !price.safeParse(reference.value).success
  )
    return { latest, reference, deltaPct: null };
  if (!decimal.safeParse(latest.value).success)
    return { latest, reference, deltaPct: null };
  const now = new Exact(latest.value);
  const deltaPct = now.div(reference.value).minus(1).times(100).toNumber();
  return {
    latest,
    reference,
    deltaPct: Number.isFinite(deltaPct) ? deltaPct : null,
  };
}

export function roundPrice(market: Market, value: Decimal): Decimal | null {
  const { pricePrecision, tickSize } = market;
  if (
    pricePrecision === null ||
    pricePrecision > 100 ||
    !value.isFinite() ||
    value.lte(0)
  )
    return null;
  if (market.exchange === 'HYPERLIQUID') {
    const places = Math.max(0, Math.min(pricePrecision, 4 - value.e));
    return value.toDecimalPlaces(places, Decimal.ROUND_HALF_UP);
  }
  if (tickSize === null)
    return market.marketType === 'SPOT'
      ? value.toDecimalPlaces(pricePrecision, Decimal.ROUND_HALF_UP)
      : null;
  if (!price.safeParse(tickSize).success) return null;
  const tick = new Exact(tickSize);
  if (tick.decimalPlaces() > pricePrecision) return null;
  return value.div(tick).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(tick);
}

export interface RiskResult extends CandidateReview {
  levels: RiskLevels | null;
}

export function reject(
  reasonCode: string,
  levels: RiskLevels | null = null,
): RiskResult {
  return { outcome: 'REJECTED', reasonCode, levels };
}

export function triggerTurnover(bar: Candle) {
  return bar.quoteTurnover === null
    ? {
        value: new Exact(bar.low).times(bar.baseVolume!).toFixed(),
        source: 'LOW_TIMES_BASE_VOLUME',
      }
    : { value: bar.quoteTurnover, source: 'EXCHANGE_QUOTE_TURNOVER' };
}

export function evaluateRisk(
  market: Market,
  quote: MarketQuote | null,
  bars: Candle[],
  volatility: number,
  direction: 'LONG' | 'SHORT',
  params: StrategyParameters,
  evaluatedAtMs: number,
): RiskResult {
  const { risk, atr: atrParams } = params;
  const { maxSpreadBps, minTurnover, minStopPct, maxStopPct, maxAtrPct } = risk;
  if (
    maxSpreadBps === null ||
    minTurnover === null ||
    minStopPct === null ||
    maxStopPct === null ||
    maxAtrPct === null
  )
    return reject('REJECT_RISK_CONFIG_REQUIRED');

  const { bid, ask } = quote ?? {};
  if (
    !bid ||
    !ask ||
    bid.source !== ask.source ||
    bid.timestampMs !== ask.timestampMs ||
    !price.safeParse(bid.value).success ||
    !price.safeParse(ask.value).success
  )
    return reject('REJECT_LIQUIDITY');
  const ageMs = evaluatedAtMs - ask.timestampMs;
  if (ageMs < 0 || ageMs > risk.maxAgeSeconds * 1000)
    return reject('REJECT_STALE_QUOTE');
  const buy = new Exact(bid.value);
  const sell = new Exact(ask.value);
  const spreadBps = sell.minus(buy).times(20_000).div(sell.plus(buy));
  const bar = bars.at(-1)!;
  const turnover = new Exact(triggerTurnover(bar).value);
  if (
    spreadBps.lt(0) ||
    spreadBps.gt(maxSpreadBps) ||
    !turnover.isFinite() ||
    turnover.lt(minTurnover)
  )
    return reject('REJECT_LIQUIDITY');

  const long = direction === 'LONG';
  const entry = roundPrice(market, long ? sell : buy);
  if (!entry || entry.lte(0)) return reject('REJECT_PRICE_PRECISION');
  const atrValue = new Exact(volatility);
  if (atrValue.lte(0) || atrValue.times(100).div(bar.close).gt(maxAtrPct))
    return reject('REJECT_VOLATILITY');
  if (entry.minus(bar.close).abs().gt(atrValue.times(risk.maxEntryDriftAtr)))
    return reject('REJECT_PRICE_DRIFT');

  const swing = bars
    .slice(-risk.swingLookback)
    .map((item) => (long ? item.low : item.high));
  const buffer = atrValue.times(atrParams.stopMultiplier);
  const stop = roundPrice(
    market,
    long
      ? Exact.min(Exact.min(...swing), entry.minus(buffer))
      : Exact.max(Exact.max(...swing), entry.plus(buffer)),
  );
  if (!stop || stop.lte(0)) return reject('REJECT_INVALID_STOP');
  const distance = long ? entry.minus(stop) : stop.minus(entry);
  const stopPct = distance.times(100).div(entry);
  if (distance.lte(0) || stopPct.lt(minStopPct) || stopPct.gt(maxStopPct))
    return reject('REJECT_INVALID_STOP');

  const takeProfits: RiskLevels['takeProfits'] = [];
  let weightedMove = new Exact(0);
  let previous = entry;
  for (const target of risk.takeProfits) {
    const move = distance.times(target.rMultiple);
    const rounded = roundPrice(
      market,
      long ? entry.plus(move) : entry.minus(move),
    );
    if (
      !rounded ||
      rounded.lte(0) ||
      (long ? rounded.lte(previous) : rounded.gte(previous))
    )
      return reject('REJECT_INVALID_TARGET');
    takeProfits.push({ price: rounded.toFixed(), closePct: target.closePct });
    weightedMove = weightedMove.plus(
      rounded.minus(entry).abs().times(target.closePct),
    );
    previous = rounded;
  }
  const weightedRR = weightedMove.div(distance.times(100));
  const levels = {
    entry: entry.toFixed(),
    stop: stop.toFixed(),
    takeProfits,
    weightedRR: weightedRR.toDecimalPlaces(8).toFixed(),
  };
  return weightedMove.lt(distance.times(100).times(risk.minWeightedRR))
    ? reject('REJECT_LOW_RR', levels)
    : { outcome: 'PASSED', reasonCode: null, levels };
}

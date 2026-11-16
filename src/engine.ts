import type { Direction, KlineChartItem } from "@tradejs/types";

export const BAR_MS = 15 * 60_000;
export const H4_MS = 16 * BAR_MS;
const ATR_LENGTH = 14;
const HISTORY_LENGTH = ATR_LENGTH + 3;
export const WARMUP_BARS = HISTORY_LENGTH * 16;

export type PriceBar = Pick<
  KlineChartItem,
  "timestamp" | "open" | "high" | "low" | "close"
>;

export interface Impulse {
  direction: Direction;
  candles: [PriceBar, PriceBar, PriceBar];
  confirmedAt: number;
  atrAtSignal: number;
  strength: number;
  gap: { low: number; high: number } | null;
  gapBodyShare: number;
  exceedsHalfBody: boolean;
  overlapping: boolean;
}

function atrAt(candles: PriceBar[], end: number) {
  let total = 0;
  for (let i = end - ATR_LENGTH + 1; i <= end; i++) {
    const { low, high } = candles[i];
    const previousClose = candles[i - 1].close;
    total += Math.max(high - low, high - previousClose, previousClose - low);
  }
  return total / ATR_LENGTH;
}

function measureImpulse(history: PriceBar[]): Impulse | null {
  if (history.length !== HISTORY_LENGTH) return null;
  const [first, middle, third] = history.slice(-3);
  const body = Math.abs(middle.close - middle.open);
  const atrBefore = atrAt(history, history.length - 3);
  const atrAtSignal = atrAt(history, history.length - 1);
  if (body === 0 || atrBefore <= 0 || atrAtSignal <= 0) return null;

  const direction = middle.close > middle.open ? "LONG" : "SHORT";
  const low = direction === "LONG" ? first.high : third.high;
  const high = direction === "LONG" ? third.low : first.low;
  const gap = high > low ? { low, high } : null;
  const bodyLow = Math.min(middle.open, middle.close);
  const bodyHigh = Math.max(middle.open, middle.close);
  const insideBody = gap
    ? Math.max(0, Math.min(high, bodyHigh) - Math.max(low, bodyLow))
    : 0;

  return {
    direction,
    candles: [first, middle, third],
    confirmedAt: third.timestamp + H4_MS,
    atrAtSignal,
    strength: body / atrBefore,
    gap,
    gapBodyShare: insideBody / body,
    exceedsHalfBody:
      2 * insideBody - body >
      4 * Number.EPSILON * Math.max(Math.abs(bodyLow), Math.abs(bodyHigh)),
    overlapping: first.low <= third.high && third.low <= first.high,
  };
}

export function createImpulseDetector() {
  const history: PriceBar[] = [];
  let partial: PriceBar | null = null;
  let previousTimestamp = -Infinity;

  return (bar: PriceBar): Impulse | null => {
    if (bar.timestamp <= previousTimestamp || bar.timestamp % BAR_MS !== 0) {
      return null;
    }
    if (bar.timestamp !== previousTimestamp + BAR_MS) {
      history.length = 0;
      partial = null;
    }
    previousTimestamp = bar.timestamp;

    const offset = bar.timestamp % H4_MS;
    if (offset === 0) partial = { ...bar };
    if (!partial) return null;
    partial.high = Math.max(partial.high, bar.high);
    partial.low = Math.min(partial.low, bar.low);
    partial.close = bar.close;
    if (offset !== H4_MS - BAR_MS) return null;

    history.push(partial);
    if (history.length > HISTORY_LENGTH) history.shift();
    partial = null;
    return measureImpulse(history);
  };
}

export function tightenStop({
  side,
  entry,
  distance,
  best,
  currentStop,
}: {
  side: 1 | -1;
  entry: number;
  distance: number;
  best: number;
  currentStop: number;
}) {
  const tolerance =
    4 *
    Number.EPSILON *
    Math.max(Math.abs(best), Math.abs(entry), Math.abs(currentStop));
  if (side * (best - entry) + tolerance < 3 * distance) return null;
  const nextStop = best - side * distance;
  return side * (nextStop - currentStop) > tolerance ? nextStop : null;
}

import assert from "node:assert/strict";
import test from "node:test";
import { strategyEntries } from "../dist/index.js";

const [strategy] = strategyEntries;
const m15 = 15 * 60_000;
const h4 = 16 * m15;
const start = Date.UTC(2026, 0, 1);

const warmup = Array.from({ length: 14 }, () => [100, 105, 95, 100]);
const gap = [
  [100, 104, 95, 99],
  [100, 121, 99, 120],
  [117, 125, 116, 121],
];

function bars(pattern = gap, direction = "LONG") {
  return [...warmup, ...pattern].flatMap((prices, h4Index) => {
    const [open, high, low, close] =
      direction === "LONG"
        ? prices
        : [300 - prices[0], 300 - prices[2], 300 - prices[1], 300 - prices[3]];
    return Array.from({ length: 16 }, (_, index) => ({
      timestamp: start + h4Index * h4 + index * m15,
      open: index === 0 ? open : close,
      high,
      low,
      close,
    }));
  });
}

function harness(mode = "gap", data = []) {
  let current;
  let position = null;
  const run = strategy.createCore({
    config: strategy.parseConfig({ IMBALANCE_MODE: mode }),
    data,
    strategyApi: {
      skip: (code) => ({ kind: "skip", code }),
      entry: (params) => ({
        kind: "entry",
        ...params,
        signal: { symbol: "BTCUSDT" },
      }),
      protect: (params) => ({ kind: "protect", ...params }),
      getCurrentPosition: () => position,
      getDecisionPriceContext: () => ({ currentPrice: current.close }),
    },
  });
  return {
    next(candle) {
      current = candle;
      return run(candle, candle);
    },
    setPosition(next) {
      position = next;
    },
  };
}

async function play(candles, mode, data) {
  const core = harness(mode, data);
  const decisions = [];
  for (const candle of candles) decisions.push(await core.next(candle));
  return decisions;
}

for (const direction of ["LONG", "SHORT"]) {
  test(`${direction} enters only after the complete third H4 candle`, async () => {
    const candles = bars(gap, direction);
    const decisions = await play(candles);
    assert.ok(decisions.slice(0, -1).every((d) => d.kind === "skip"));
    const entry = decisions.at(-1);
    const sign = direction === "LONG" ? 1 : -1;
    assert.equal(entry.kind, "entry");
    assert.equal(entry.direction, direction);
    assert.equal(entry.indicators.confirmedAt, start + 17 * h4);
    assert.equal(entry.indicators.gapBodyShare, 0.6);
    assert.equal(entry.indicators.impulseStrength, 20 / (139 / 14));
    assert.equal(entry.indicators.atrAtSignal, 150 / 14);
    assert.ok(
      Math.abs(entry.orderPlan.stopLossDistance - (3 * 150) / 14) < 1e-9,
    );
    assert.equal(
      entry.orderPlan.stopLossPrice,
      candles.at(-1).close - sign * entry.orderPlan.stopLossDistance,
    );
    assert.deepEqual(entry.orderPlan.takeProfits, []);
    assert.equal(entry.figures.lines.length, 6);
    assert.equal(entry.figures.zones.length, 1);
    assert.deepEqual(
      entry.figures.points.map((figure) => figure.id),
      ["entry", "initial-stop"],
    );
    assert.equal((await play(candles, "overlap")).at(-1).kind, "skip");
  });

  test(`${direction} activates and tightens the stop at 3R using the actual fill`, async () => {
    const candles = bars(gap, direction);
    const core = harness();
    for (const candle of candles) await core.next(candle);

    const entry = direction === "LONG" ? 122 : 178;
    const side = direction === "LONG" ? 1 : -1;
    const risk = (3 * 150) / 14;
    const position = {
      qty: 1,
      direction,
      price: entry,
      slPrice: entry - side * risk,
    };
    core.setPosition(position);
    const next = (offset, extreme) =>
      core.next({
        timestamp: start + 17 * h4 + offset * m15,
        open: entry,
        close: entry,
        high: Math.max(entry, extreme),
        low: Math.min(entry, extreme),
      });

    assert.equal(
      (await next(0, entry + side * (3 * risk - 0.01))).kind,
      "skip",
    );
    const activation = await next(1, entry + side * (3 * risk));
    assert.equal(activation.kind, "protect");
    const activeStop = entry + side * (2 * risk);
    assert.ok(
      Math.abs(activation.protectPlan.stopLossPrice - activeStop) < 1e-9,
    );
    core.setPosition({ ...position, slPrice: activeStop });
    assert.equal((await next(2, entry + side * 2.9 * risk)).kind, "skip");
    const tightened = await next(3, entry + side * 4 * risk);
    assert.equal(tightened.kind, "protect");
    assert.ok(
      Math.abs(
        tightened.protectPlan.stopLossPrice - (entry + side * 3 * risk),
      ) < 1e-9,
    );
  });
}

const cases = [
  {
    name: "touch is eligible only for the control",
    pattern: [gap[0], gap[1], [105, 125, 104, 121]],
    accepted: ["overlap"],
  },
  {
    name: "exactly half the body is excluded from both modes",
    pattern: [gap[0], gap[1], [117, 125, 114, 121]],
    accepted: [],
  },
  {
    name: "part of a gap outside the body cannot make a signal",
    pattern: [[90, 95, 89, 91], gap[1], [117, 125, 109, 121]],
    accepted: [],
  },
  {
    name: "a clipped gap can still exceed half the body",
    pattern: [[90, 95, 89, 91], gap[1], [117, 125, 112, 121]],
    accepted: ["gap"],
  },
  {
    name: "a zero-body candle cannot produce a signal",
    pattern: [gap[0], [100, 121, 99, 100], gap[2]],
    accepted: [],
  },
  {
    name: "disjoint ranges against the impulse are excluded from the control",
    pattern: [[122, 130, 122, 125], gap[1], [105, 120, 103, 110]],
    accepted: [],
  },
];

for (const { name, pattern, accepted } of cases) {
  test(name, async () => {
    for (const direction of ["LONG", "SHORT"]) {
      for (const mode of ["gap", "overlap"]) {
        const decision = (await play(bars(pattern, direction), mode)).at(-1);
        assert.equal(decision.kind, accepted.includes(mode) ? "entry" : "skip");
      }
    }
  });
}

test("a missing M15 or H4 bar breaks the consecutive sequence", async () => {
  const candles = bars();
  for (const [from, to] of [
    [241, 242],
    [240, 256],
  ]) {
    const missing = [...candles.slice(0, from), ...candles.slice(to)];
    assert.equal((await play(missing)).at(-1).kind, "skip");
  }
});

test("history reconstruction and sequential processing agree for both modes", async () => {
  for (const mode of ["gap", "overlap"]) {
    const pattern =
      mode === "gap" ? gap : [gap[0], gap[1], [105, 125, 104, 121]];
    const candles = bars(pattern);
    const expected = (await play(candles, mode)).at(-1);
    assert.equal(expected.kind, "entry");
    for (const from of [200, 250, candles.length - 1]) {
      const fromHistory = await play(candles.slice(from), mode, candles);
      assert.deepEqual(fromHistory.at(-1), expected);
    }
    const core = harness(mode, candles.slice(0, -1));
    assert.equal((await core.next(candles.at(-1))).kind, "entry");
    assert.equal((await core.next(candles.at(-1))).kind, "skip");
  }
});

test("the 3R boundary is inclusive and an existing position blocks a new entry", async () => {
  const candles = bars();
  const core = harness("gap", candles.slice(0, -1));
  const price = candles.at(-1).high - 30;
  core.setPosition({ qty: 1, direction: "LONG", price, slPrice: price - 10 });
  const decision = await core.next(candles.at(-1));
  assert.equal(decision.kind, "protect");
  assert.equal(decision.protectPlan.stopLossPrice, price + 20);
});

test("only the two modes and the M15 execution interval are accepted", () => {
  for (const config of [
    { IMBALANCE_MODE: "other" },
    { INTERVAL: "240" },
    { MAX_LOSS_VALUE: 0 },
  ]) {
    assert.throws(() => strategy.parseConfig(config), /ImbalanceMomentum/);
  }
});

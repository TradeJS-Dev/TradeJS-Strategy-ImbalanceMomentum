import type {
  CreateStrategyCore,
  Position,
  StrategyConfig,
  StrategyEntryOrderPlan,
} from "@tradejs/types";
import { createImpulseDetector, tightenStop, WARMUP_BARS } from "./engine.js";
import { buildFigures } from "./figures.js";

export interface ImbalanceMomentumConfig extends StrategyConfig {
  INTERVAL: "15";
  IMBALANCE_MODE: "gap" | "overlap";
  MAX_LOSS_VALUE: number;
}

interface Trail {
  direction: Position["direction"];
  entry: number;
  distance: number;
  best: number;
}

export const createImbalanceMomentumCore: CreateStrategyCore<
  ImbalanceMomentumConfig
> = ({ config, data, strategyApi }) => {
  const detect = createImpulseDetector();
  let previousTimestamp: number | undefined;
  let signalDistance: number | undefined;
  let trail: Trail | undefined;

  return async (bar) => {
    if (previousTimestamp === undefined) {
      const before = data.findIndex(
        (candle) => candle.timestamp >= bar.timestamp,
      );
      const end = before < 0 ? data.length : before;
      for (const candle of data.slice(Math.max(0, end - WARMUP_BARS), end)) {
        detect(candle);
      }
    } else if (bar.timestamp <= previousTimestamp) {
      return strategyApi.skip("IMBALANCE_ALREADY_PROCESSED");
    }
    previousTimestamp = bar.timestamp;
    const impulse = detect(bar);

    const position = await strategyApi.getCurrentPosition();
    if (position && position.qty > 0) {
      const { price: entry, direction, slPrice } = position;
      const side = direction === "LONG" ? 1 : -1;
      if (slPrice == null)
        return strategyApi.skip("IMBALANCE_STOP_UNAVAILABLE");
      if (!trail || trail.entry !== entry || trail.direction !== direction) {
        const distance = signalDistance ?? side * (entry - slPrice);
        if (!Number.isFinite(distance) || distance <= 0) {
          return strategyApi.skip("IMBALANCE_INITIAL_RISK_UNAVAILABLE");
        }
        trail = { entry, direction, distance, best: entry };
      }
      const extreme = side === 1 ? bar.high : bar.low;
      if (side * (extreme - trail.best) > 0) trail.best = extreme;
      const nextStop = tightenStop({
        side,
        entry,
        distance: trail.distance,
        best: trail.best,
        currentStop: slPrice,
      });
      return nextStop == null
        ? strategyApi.skip("IMBALANCE_POSITION_OPEN")
        : strategyApi.protect({
            code: "IMBALANCE_TRAILING_STOP",
            protectPlan: { direction, stopLossPrice: nextStop },
          });
    }

    trail = undefined;
    signalDistance = undefined;
    if (!impulse) return strategyApi.skip("IMBALANCE_WAIT_CONFIRMATION");
    const qualifies =
      config.IMBALANCE_MODE === "gap"
        ? impulse.exceedsHalfBody
        : impulse.overlapping;
    if (!qualifies) return strategyApi.skip("IMBALANCE_GEOMETRY_REJECTED");

    const { currentPrice } = await strategyApi.getDecisionPriceContext();
    const stopLossDistance = 3 * impulse.atrAtSignal;
    const side = impulse.direction === "LONG" ? 1 : -1;
    const stopLossPrice = currentPrice - side * stopLossDistance;
    if (stopLossPrice <= 0) return strategyApi.skip("IMBALANCE_INVALID_STOP");

    const orderPlan: StrategyEntryOrderPlan & { stopLossDistance: number } = {
      qty: config.MAX_LOSS_VALUE / stopLossDistance,
      stopLossPrice,
      stopLossDistance,
      takeProfits: [],
    };
    const decision = await strategyApi.entry({
      code: "IMBALANCE_MOMENTUM_ENTRY",
      direction: impulse.direction,
      indicators: {
        impulseStrength: impulse.strength,
        gapBodyShare: impulse.gapBodyShare,
        atrAtSignal: impulse.atrAtSignal,
        confirmedAt: impulse.confirmedAt,
      },
      figures: buildFigures(impulse, currentPrice, stopLossPrice),
      orderPlan,
    });
    if (decision.signal) {
      decision.signal.signalId = [
        "ImbalanceMomentum",
        decision.signal.symbol,
        impulse.direction,
        impulse.confirmedAt,
      ].join(":");
    }
    signalDistance = stopLossDistance;
    return decision;
  };
};

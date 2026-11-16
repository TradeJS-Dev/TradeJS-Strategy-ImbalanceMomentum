import { defineStrategyPlugin } from "@tradejs/core/config";
import { createStrategyConfigParser } from "@tradejs/strategy-kit/config";
import type { ValidatedStrategyRegistryEntry } from "@tradejs/strategy-kit/config";
import {
  createImbalanceMomentumCore,
  type ImbalanceMomentumConfig,
} from "./core.js";
import { BAR_MS } from "./engine.js";
import { executionFigures } from "./figures.js";

export const STRATEGY_NAME = "ImbalanceMomentum";

const defaults: ImbalanceMomentumConfig = {
  INTERVAL: "15",
  IMBALANCE_MODE: "gap",
  MAX_LOSS_VALUE: 10,
};

const parseDefaults = createStrategyConfigParser({
  strategyName: STRATEGY_NAME,
  defaults,
});

const entry: ValidatedStrategyRegistryEntry<ImbalanceMomentumConfig> = {
  defaults,
  parseConfig(input) {
    const config = parseDefaults(input);
    if (config.INTERVAL !== "15") {
      throw new Error("ImbalanceMomentum.INTERVAL must be 15");
    }
    if (
      config.IMBALANCE_MODE !== "gap" &&
      config.IMBALANCE_MODE !== "overlap"
    ) {
      throw new Error(
        "ImbalanceMomentum.IMBALANCE_MODE must be gap or overlap",
      );
    }
    if (!Number.isFinite(config.MAX_LOSS_VALUE) || config.MAX_LOSS_VALUE <= 0) {
      throw new Error("ImbalanceMomentum.MAX_LOSS_VALUE must be positive");
    }
    return config;
  },
  manifest: {
    name: STRATEGY_NAME,
    hooks: {
      afterPlaceOrder({ order, market }) {
        const signal = order.result;
        if (typeof signal === "string" || signal.orderStatus !== "completed") {
          return;
        }
        const execution = signal.additionalIndicators?.backtestExecution;
        const timestamp =
          execution?.executionTimestamp ?? market.candle.timestamp + BAR_MS;
        Object.assign(
          signal.figures,
          executionFigures(
            timestamp,
            signal.prices.currentPrice,
            signal.prices.stopLossPrice,
          ),
        );
      },
    },
  },
  createCore: createImbalanceMomentumCore,
};

export const strategyEntries = defineStrategyPlugin({
  strategyEntries: [entry],
}).strategyEntries;

export default defineStrategyPlugin({ strategyEntries });

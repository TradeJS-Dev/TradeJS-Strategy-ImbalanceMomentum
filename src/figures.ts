import type { Signal } from "@tradejs/types";
import { BAR_MS, H4_MS, type Impulse } from "./engine.js";

export function buildFigures(
  impulse: Impulse,
  entryPrice: number,
  stopPrice: number,
): Signal["figures"] {
  return {
    lines: impulse.candles.flatMap((candle, index) => {
      const timestamp = candle.timestamp + H4_MS / 2;
      const color = candle.close >= candle.open ? "#15803d" : "#be123c";
      return [
        {
          id: `h4-wick-${index + 1}`,
          color,
          points: [
            { timestamp, value: candle.low },
            { timestamp, value: candle.high },
          ],
        },
        {
          id: `h4-body-${index + 1}`,
          color,
          width: 8,
          points: [
            { timestamp, value: candle.open },
            { timestamp, value: candle.close },
          ],
        },
      ];
    }),
    zones: impulse.gap
      ? [
          {
            id: "three-candle-gap",
            start: {
              timestamp: impulse.candles[0].timestamp + H4_MS / 2,
              value: impulse.gap.low,
            },
            end: { timestamp: impulse.confirmedAt, value: impulse.gap.high },
            color: "rgba(37, 99, 235, 0.18)",
          },
        ]
      : [],
    ...executionFigures(impulse.confirmedAt, entryPrice, stopPrice),
  };
}

export function executionFigures(
  timestamp: number,
  entryPrice: number,
  stopPrice: number,
): Pick<Signal["figures"], "points"> {
  return {
    points: [
      {
        id: "entry",
        color: "#1d4ed8",
        points: [{ timestamp, value: entryPrice }],
      },
      {
        id: "initial-stop",
        color: "#be123c",
        points: [
          { timestamp, value: stopPrice },
          { timestamp: timestamp + BAR_MS, value: stopPrice },
        ],
      },
    ],
  };
}

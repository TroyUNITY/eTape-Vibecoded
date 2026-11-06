import { describe, expect, it } from "vitest";
import type { Bar } from "../wire/contract";
import {
  DEFAULT_CANDIDATE_TECHNICAL_CRITERIA,
  analyzeCandidateTechnicalContext,
} from "./candidateTechnicalAnalysis";

function dailyBars(count = 25, high = 5.1): Bar[] {
  const out: Bar[] = [];
  const day = new Date("2026-10-30T12:00:00Z");
  while (out.length < count) {
    day.setUTCDate(day.getUTCDate() - 1);
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    out.push({
      symbol: "US.TEST",
      timeframe: "D",
      bucketStart: new Date(day.toISOString().slice(0, 10) + "T00:00:00-04:00").toISOString(),
      o: 5,
      h: high,
      l: 4.9,
      c: 5,
      v: 100_000,
      inProgress: false,
    });
  }
  return out.reverse();
}

function intradayBars(count = 21, lastClose = 5.2, lastVolume = 250): Bar[] {
  const start = Date.parse("2026-11-05T09:30:00-05:00");
  return Array.from({ length: count }, (_, index) => {
    const latest = index === count - 1;
    return {
      symbol: "US.TEST",
      timeframe: "1m",
      bucketStart: new Date(start + index * 60_000).toISOString(),
      o: latest ? Math.min(5.15, lastClose) : 5,
      h: latest ? Math.max(5.3, lastClose) : 5.1,
      l: latest ? Math.min(5.1, lastClose) : 4.9,
      c: latest ? lastClose : 5,
      v: latest ? lastVolume : 100,
      inProgress: false,
    };
  });
}

describe("DEFAULT_CANDIDATE_TECHNICAL_CRITERIA", () => {
  it("documents the eTape heuristics without treating them as source-prescribed rules", () => {
    expect(DEFAULT_CANDIDATE_TECHNICAL_CRITERIA.nearbyResistancePct).toBe(3);
    expect(DEFAULT_CANDIDATE_TECHNICAL_CRITERIA.breakoutLookbackBars).toBe(20);
    expect(DEFAULT_CANDIDATE_TECHNICAL_CRITERIA.breakoutMinVolumeMultiple).toBe(2);
  });
});

describe("analyzeCandidateTechnicalContext — resistance", () => {
  it("finds a nearby overhead level from completed daily candles", () => {
    const result = analyzeCandidateTechnicalContext({
      price: 5,
      dailyBars: dailyBars(25, 5.1),
      oneMinuteBars: [],
      asOfMs: Date.parse("2026-11-05T15:00:00-05:00"),
    });
    expect(result.resistance.nearby).toBe(true);
    expect(result.resistance.state).toBe("fail");
    expect(result.resistance.levelPrice).toBe(5.1);
    expect(result.resistance.distancePct).toBeCloseTo(2);
  });

  it("passes when the current price is above all assessed daily levels", () => {
    const result = analyzeCandidateTechnicalContext({
      price: 6,
      dailyBars: dailyBars(25, 5.1),
      oneMinuteBars: [],
      asOfMs: Date.parse("2026-11-05T15:00:00-05:00"),
    });
    expect(result.resistance.nearby).toBe(false);
    expect(result.resistance.state).toBe("pass");
    expect(result.resistance.levelPrice).toBeNull();
  });

  it("keeps resistance unknown when daily history is insufficient", () => {
    const result = analyzeCandidateTechnicalContext({
      price: 5,
      dailyBars: dailyBars(8),
      oneMinuteBars: [],
      asOfMs: Date.parse("2026-11-05T15:00:00-05:00"),
    });
    expect(result.resistance.nearby).toBeNull();
    expect(result.resistance.state).toBe("unknown");
  });

  it("excludes current-day and in-progress daily candles", () => {
    const bars = dailyBars(25);
    bars.push({
      ...bars[bars.length - 1],
      bucketStart: new Date("2026-11-05T00:00:00-05:00").toISOString(),
      h: 20,
      inProgress: true,
    });
    const result = analyzeCandidateTechnicalContext({
      price: 5,
      dailyBars: bars,
      oneMinuteBars: [],
      asOfMs: Date.parse("2026-11-05T15:00:00-05:00"),
    });
    expect(result.resistance.levelPrice).toBe(5.1);
  });
});

describe("analyzeCandidateTechnicalContext — intraday breakout", () => {
  it("confirms a close above the prior 20-bar high with 2x volume", () => {
    const bars = intradayBars();
    const result = analyzeCandidateTechnicalContext({
      price: 5.2,
      dailyBars: [],
      oneMinuteBars: bars,
      asOfMs: Date.parse(bars[bars.length - 1].bucketStart) + 60_000,
    });
    expect(result.breakout.detected).toBe(true);
    expect(result.breakout.referenceHigh).toBe(5.1);
    expect(result.breakout.triggerClose).toBe(5.2);
    expect(result.breakout.volumeMultiple).toBe(2.5);
  });

  it("does not confirm a price break without the required volume", () => {
    const bars = intradayBars(21, 5.2, 150);
    const result = analyzeCandidateTechnicalContext({
      price: 5.2,
      dailyBars: [],
      oneMinuteBars: bars,
      asOfMs: Date.parse(bars[bars.length - 1].bucketStart) + 60_000,
    });
    expect(result.breakout.detected).toBe(false);
    expect(result.breakout.volumeMultiple).toBe(1.5);
    expect(result.breakout.detail).toContain("requires 2.0x");
  });

  it("does not confirm an intraday wick that did not close above the reference high", () => {
    const bars = intradayBars(21, 5.05, 250);
    const result = analyzeCandidateTechnicalContext({
      price: 5.05,
      dailyBars: [],
      oneMinuteBars: bars,
      asOfMs: Date.parse(bars[bars.length - 1].bucketStart) + 60_000,
    });
    expect(result.breakout.detected).toBe(false);
    expect(result.breakout.detail).toContain("has not closed above");
  });

  it("keeps breakout unknown when the latest completed candle is stale", () => {
    const bars = intradayBars();
    const result = analyzeCandidateTechnicalContext({
      price: 5.2,
      dailyBars: [],
      oneMinuteBars: bars,
      asOfMs: Date.parse(bars[bars.length - 1].bucketStart) + 8 * 60_000,
    });
    expect(result.breakout.detected).toBeNull();
    expect(result.breakout.detail).toContain("old");
  });

  it("does not combine earlier sessions to manufacture a current-session breakout", () => {
    const bars = intradayBars(10);
    const oldStart = Date.parse("2026-11-04T09:30:00-05:00");
    const previousSession = Array.from({ length: 11 }, (_, index) => ({
      ...bars[0],
      bucketStart: new Date(oldStart + index * 60_000).toISOString(),
      h: 5.1,
      c: 5,
      v: 100,
    }));
    const combined = [...previousSession, ...bars];
    const result = analyzeCandidateTechnicalContext({
      price: 5.2,
      dailyBars: [],
      oneMinuteBars: combined,
      asOfMs: Date.parse(bars[bars.length - 1].bucketStart) + 60_000,
    });
    expect(result.breakout.detected).toBeNull();
    expect(result.breakout.detail).toContain("Needs 20");
  });
});

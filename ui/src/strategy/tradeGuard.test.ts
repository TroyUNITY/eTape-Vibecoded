import { describe, expect, it } from "vitest";
import type { Bar, ScannerRow } from "../wire/contract";
import { evaluateTradeGuard, sameTimeRelativeVolume, TradeGuardTracker } from "./tradeGuard";

function makeBar(time: string, volume: number, overrides: Partial<Bar> = {}): Bar {
  return {
    symbol: "US.TEST",
    timeframe: "1m",
    bucketStart: new Date(time).toISOString(),
    o: 5,
    h: 5.05,
    l: 4.95,
    c: 5,
    v: volume,
    inProgress: false,
    ...overrides,
  };
}

function priorWeekdays(currentDay: string, count: number): string[] {
  const out: string[] = [];
  const day = new Date(currentDay + "T12:00:00Z");
  while (out.length < count) {
    day.setUTCDate(day.getUTCDate() - 1);
    const weekday = day.getUTCDay();
    if (weekday !== 0 && weekday !== 6) out.push(day.toISOString().slice(0, 10));
  }
  return out.reverse();
}

function scannerRow(): ScannerRow {
  return {
    symbol: "US.TEST",
    shortSellRestricted: false,
    changePct: 25,
    last: 5,
    floatShares: 5_000_000,
    volume: 1_000_000,
    sessionVolume: 1_000_000,
    turnover: 5_000_000,
    relativeVolume: 12,
    shortInterest: null,
    shortInterestAsOf: null,
  };
}

describe("sameTimeRelativeVolume", () => {
  it("compares cumulative volume at the same ET minute over prior sessions", () => {
    const currentDay = "2026-10-30";
    const currentTime = currentDay + "T13:35:00Z";
    const bars: Bar[] = priorWeekdays(currentDay, 10)
      .map((day) => makeBar(day + "T13:35:00Z", 500));
    bars.push(makeBar(currentTime, 1_000));
    const result = sameTimeRelativeVolume(bars, Date.parse(currentTime), 10);
    expect(result.observations).toBe(10);
    expect(result.value).toBe(2);
    expect(result.averageVolume).toBe(500);
  });

  it("returns unknown rather than substituting daily RVOL when history is incomplete", () => {
    const bars = [
      makeBar("2026-10-29T13:35:00Z", 500),
      makeBar("2026-10-30T13:35:00Z", 1_000),
    ];
    const result = sameTimeRelativeVolume(bars, Date.parse("2026-10-30T13:35:00Z"), 10);
    expect(result.value).toBeNull();
    expect(result.observations).toBe(1);
    expect(result.reason).toContain("Needs 10 comparable prior sessions");
  });
});

describe("evaluateTradeGuard", () => {
  it("returns no data without sufficient one-minute history", () => {
    const result = evaluateTradeGuard({ bars: [] });
    expect(result.status).toBe("NO_DATA");
    expect(result.setup).toBe("NONE");
    expect(result.entry).toBeNull();
    expect(result.dataUncertain).toBe(false);
    expect(result.dataIncomplete).toBe(true);
  });

  it("keeps scanner daily RVOL separate from same-time-of-day RVOL", () => {
    const currentDay = "2026-10-30";
    const warmupBars = priorWeekdays(currentDay, 20).slice(0, 10)
      .map((day) => makeBar(day + "T13:00:00Z", 100));
    const comparableBars = priorWeekdays(currentDay, 10)
      .map((day) => makeBar(day + "T13:35:00Z", 500));
    const bars = [...warmupBars, ...comparableBars, makeBar(currentDay + "T13:35:00Z", 1_000)];
    const result = evaluateTradeGuard({ bars, scannerRow: scannerRow() });
    expect(result.metrics.relativeVolume).toBe(2);
    expect(result.metrics.scannerDailyRelativeVolume).toBe(12);
    expect(result.warnings.some((warning) => warning.includes("different calculation"))).toBe(true);
  });

  it("treats extreme same-time RVOL as a warning, not automatic data corruption", () => {
    const currentDay = "2026-10-30";
    const priorDays = priorWeekdays(currentDay, 10);
    const warmup = priorWeekdays(currentDay, 20).slice(0, 10)
      .map((day) => makeBar(day + "T13:00:00Z", 100));
    const comparison = priorDays.map((day) => makeBar(day + "T13:35:00Z", 500));
    const bars = [...warmup, ...comparison, makeBar(currentDay + "T13:35:00Z", 1_000_000)];
    const result = evaluateTradeGuard({ bars, scannerRow: scannerRow() });
    expect(result.metrics.relativeVolume).toBeGreaterThan(500);
    expect(result.dataUncertain).toBe(false);
    expect(result.dataIncomplete).toBe(false);
    expect(result.status).not.toBe("DATA_UNCERTAIN");
    expect(result.warnings.some((warning) => warning.includes("exceptionally high"))).toBe(true);
  });

  it("uses DATA_INCOMPLETE when critical eligibility inputs are missing", () => {
    const bars = Array.from({ length: 25 }, (_, index) =>
      makeBar("2026-10-30T13:" + String(index).padStart(2, "0") + ":00Z", 100));
    const result = evaluateTradeGuard({ bars });
    expect(result.status).toBe("DATA_INCOMPLETE");
    expect(result.dataUncertain).toBe(false);
    expect(result.dataIncomplete).toBe(true);
  });

  it("uses DATA_UNCERTAIN only for explicit recent OHLCV integrity problems", () => {
    const bars = Array.from({ length: 25 }, (_, index) =>
      makeBar("2026-10-30T13:" + String(index).padStart(2, "0") + ":00Z", 100));
    bars[bars.length - 1] = {
      ...bars[bars.length - 1],
      h: 4.8,
    };
    const result = evaluateTradeGuard({ bars });
    expect(result.status).toBe("DATA_UNCERTAIN");
    expect(result.dataUncertain).toBe(true);
    expect(result.reasons.some((reason) => reason.includes("internally inconsistent OHLC"))).toBe(true);
  });

  it("keeps empty-history tracking in a no-data state", () => {
    const tracker = new TradeGuardTracker();
    expect(tracker.evaluate({ bars: [] }).status).toBe("NO_DATA");
  });
});

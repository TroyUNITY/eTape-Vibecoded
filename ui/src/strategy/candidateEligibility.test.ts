import { describe, expect, it } from "vitest";
import type { Bar } from "../wire/contract";
import {
  DEFAULT_ROSS_MOMENTUM_CRITERIA,
  evaluateRossMomentumCandidate,
  type CandidateEligibilityInput,
} from "./candidateEligibility";

function makeBar(day: string, volume: number, timeframe: string, overrides: Partial<Bar> = {}): Bar {
  return {
    symbol: "US.TEST",
    timeframe,
    bucketStart: new Date(day + "T13:35:00Z").toISOString(),
    o: 5,
    h: 5.1,
    l: 4.9,
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

function minuteHistory(currentDay: string, priorVolume = 500, currentVolume = 1_000): Bar[] {
  const previous = priorWeekdays(currentDay, 10)
    .map((day) => makeBar(day, priorVolume, "1m"));
  previous.push(makeBar(currentDay, currentVolume, "1m"));
  return previous;
}

function dailyHistory(currentDay: string, count = 220, close = 5): Bar[] {
  const out: Bar[] = [];
  const day = new Date(currentDay + "T12:00:00Z");
  while (out.length < count) {
    day.setUTCDate(day.getUTCDate() - 1);
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    out.push(makeBar(day.toISOString().slice(0, 10), 100_000, "D", {
      o: close,
      h: close + 0.1,
      l: close - 0.1,
      c: close,
    }));
  }
  return out.reverse();
}

function eligibleInput(overrides: Partial<CandidateEligibilityInput> = {}): CandidateEligibilityInput {
  const currentDay = "2026-10-30";
  return {
    symbol: "US.TEST",
    price: 6,
    float: { shares: 5_000_000, source: "verified_free_float" },
    oneMinuteBars: minuteHistory(currentDay),
    asOfMs: Date.parse(currentDay + "T13:35:00Z"),
    dailyBars: dailyHistory(currentDay),
    dailyChart: { nearbyResistance: false },
    catalyst: "fundamental",
    ...overrides,
  };
}

describe("DEFAULT_ROSS_MOMENTUM_CRITERIA", () => {
  it("keeps the general momentum thresholds separate from Gap and Go preferences", () => {
    expect(DEFAULT_ROSS_MOMENTUM_CRITERIA.minPrice).toBe(1);
    expect(DEFAULT_ROSS_MOMENTUM_CRITERIA.maxPriceExclusive).toBe(20);
    expect(DEFAULT_ROSS_MOMENTUM_CRITERIA.maxFloatSharesExclusive).toBe(100_000_000);
    expect(DEFAULT_ROSS_MOMENTUM_CRITERIA.minSameTimeRelativeVolume).toBe(2);
  });
});

describe("evaluateRossMomentumCandidate", () => {
  it("marks a candidate eligible when every documented condition passes", () => {
    const result = evaluateRossMomentumCandidate(eligibleInput());
    expect(result.status).toBe("ELIGIBLE");
    expect(result.eligible).toBe(true);
    expect(result.metrics.sameTimeRelativeVolume).toBe(2);
    expect(result.metrics.ema20).not.toBeNull();
    expect(result.metrics.ema50).not.toBeNull();
    expect(result.metrics.ema200).not.toBeNull();
    expect(result.checks.every((item) => item.state === "pass")).toBe(true);
  });

  it("uses an inclusive $1 floor and an exclusive $20 ceiling", () => {
    const floorInput = eligibleInput({ price: 1, dailyBars: dailyHistory("2026-10-30", 220, 0.8) });
    expect(evaluateRossMomentumCandidate(floorInput).status).toBe("ELIGIBLE");
    const result = evaluateRossMomentumCandidate(eligibleInput({ price: 20 }));
    expect(result.status).toBe("REJECTED");
    expect(result.checks.find((item) => item.id === "price")?.state).toBe("fail");
  });

  it("requires float strictly below 100 million shares", () => {
    const result = evaluateRossMomentumCandidate(eligibleInput({
      float: { shares: 100_000_000, source: "verified_free_float" },
    }));
    expect(result.status).toBe("REJECTED");
    expect(result.checks.find((item) => item.id === "float")?.state).toBe("fail");
  });

  it("does not treat Moomoo outstanding shares as verified free float", () => {
    const result = evaluateRossMomentumCandidate(eligibleInput({
      float: { shares: 5_000_000, source: "moomoo_outstanding_shares" },
    }));
    expect(result.status).toBe("PENDING");
    expect(result.eligible).toBe(false);
    expect(result.checks.find((item) => item.id === "float")?.state).toBe("unknown");
    expect(result.warnings.some((warning) => warning.includes("Float is provisional"))).toBe(true);
  });

  it("returns pending rather than admitting a candidate when float is missing", () => {
    const result = evaluateRossMomentumCandidate(eligibleInput({ float: null }));
    expect(result.status).toBe("PENDING");
    expect(result.eligible).toBe(false);
    expect(result.checks.find((item) => item.id === "float")?.state).toBe("unknown");
  });

  it("requires at least 2x same-time relative volume", () => {
    const result = evaluateRossMomentumCandidate(eligibleInput({
      oneMinuteBars: minuteHistory("2026-10-30", 500, 999),
    }));
    expect(result.status).toBe("REJECTED");
    expect(result.metrics.sameTimeRelativeVolume).toBeLessThan(2);
  });

  it("does not substitute scanner daily relative volume when same-time history is missing", () => {
    const result = evaluateRossMomentumCandidate(eligibleInput({ oneMinuteBars: [] }));
    expect(result.status).toBe("PENDING");
    expect(result.metrics.sameTimeRelativeVolume).toBeNull();
    expect(result.checks.find((item) => item.id === "same-time-rvol")?.state).toBe("unknown");
  });

  it("keeps stale one-minute data pending even when same-time RVOL still passes", () => {
    const currentDay = "2026-10-30";
    const bars = minuteHistory(currentDay);
    for (const day of priorWeekdays(currentDay, 10)) {
      bars.push(makeBar(day, 0, "1m", {
        bucketStart: new Date(day + "T13:45:00Z").toISOString(),
      }));
    }
    const result = evaluateRossMomentumCandidate(eligibleInput({
      oneMinuteBars: bars,
      asOfMs: Date.parse(currentDay + "T13:45:00Z"),
    }));
    expect(result.metrics.sameTimeRelativeVolume).toBe(2);
    expect(result.status).toBe("PENDING");
    expect(result.metrics.latestOneMinuteBarAgeMs).toBe(10 * 60_000);
    expect(result.checks.find((item) => item.id === "intraday-data-freshness")?.state).toBe("unknown");
  });

  it("requires 200 completed daily candles for the 20/50/200 EMA trend check", () => {
    const result = evaluateRossMomentumCandidate(eligibleInput({
      dailyBars: dailyHistory("2026-10-30", 80),
    }));
    expect(result.status).toBe("PENDING");
    expect(result.checks.find((item) => item.id === "daily-trend")?.state).toBe("unknown");
  });

  it("rejects a price below one or more daily moving averages", () => {
    const result = evaluateRossMomentumCandidate(eligibleInput({ price: 4 }));
    expect(result.status).toBe("REJECTED");
    expect(result.checks.find((item) => item.id === "daily-trend")?.state).toBe("fail");
  });

  it("keeps nearby resistance unknown until that condition is assessed", () => {
    const result = evaluateRossMomentumCandidate(eligibleInput({
      dailyChart: { nearbyResistance: null },
    }));
    expect(result.status).toBe("PENDING");
    expect(result.eligible).toBe(false);
    expect(result.checks.find((item) => item.id === "overhead-resistance")?.state).toBe("unknown");
  });

  it("rejects a candidate with nearby overhead resistance", () => {
    const result = evaluateRossMomentumCandidate(eligibleInput({
      dailyChart: { nearbyResistance: true },
    }));
    expect(result.status).toBe("REJECTED");
    expect(result.checks.find((item) => item.id === "overhead-resistance")?.state).toBe("fail");
  });

  it("accepts a technical breakout as an alternative to a fundamental catalyst", () => {
    const result = evaluateRossMomentumCandidate(eligibleInput({ catalyst: "technical_breakout" }));
    expect(result.status).toBe("ELIGIBLE");
    expect(result.checks.find((item) => item.id === "catalyst")?.state).toBe("pass");
  });

  it("rejects a known absence of both a fundamental catalyst and a technical breakout", () => {
    const result = evaluateRossMomentumCandidate(eligibleInput({ catalyst: "none" }));
    expect(result.status).toBe("REJECTED");
    expect(result.checks.find((item) => item.id === "catalyst")?.state).toBe("fail");
  });

  it("keeps unknown catalyst evidence pending rather than assuming no catalyst", () => {
    const result = evaluateRossMomentumCandidate(eligibleInput({ catalyst: "unknown" }));
    expect(result.status).toBe("PENDING");
    expect(result.checks.find((item) => item.id === "catalyst")?.state).toBe("unknown");
  });

  it("does not let unknown data override a known failed criterion", () => {
    const result = evaluateRossMomentumCandidate(eligibleInput({
      price: 25,
      float: null,
      catalyst: "unknown",
    }));
    expect(result.status).toBe("REJECTED");
    expect(result.eligible).toBe(false);
  });
});

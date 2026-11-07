import { describe, expect, it } from "vitest";
import type { ScannerRow } from "../wire/contract";
import type { TradeGuardResult } from "./tradeGuard";
import {
  DEFAULT_STRATEGY_SCANNER_FILTERS,
  STRATEGY_SCANNER_MAX_CANDIDATES,
  StrategyScannerRuntime,
  classifyTradeGuardResult,
  matchesStrategyScannerFilters,
  readStrategyScannerFilters,
  strategyQualityLabel,
  strategyStatusLabel,
} from "./strategyScanner";

function guardResult(overrides: Partial<TradeGuardResult> = {}): TradeGuardResult {
  return {
    status: "NO_SETUP",
    setup: "NONE",
    headline: "No qualifying setup right now",
    symbol: "US.TEST",
    checks: [],
    reasons: [],
    warnings: [],
    entry: null,
    stop: null,
    target2R: null,
    maximumEntry: null,
    riskPerShare: null,
    nearestResistance: null,
    resistanceName: "",
    currentSetupReady: false,
    dataUncertain: false,
    dataIncomplete: false,
    stockPassed: true,
    metrics: {
      price: 5,
      eligibilityPrice: 5,
      dayChangePct: 12,
      floatShares: 5_000_000,
      relativeVolume: 8,
      relativeVolumeObservations: 10,
      scannerDailyRelativeVolume: 12,
      sessionVolume: 1_000_000,
      vwap: 4.9,
      ema9: 4.95,
      ema20: 4.8,
      atr14: 0.1,
      refreshedAt: null,
    },
    currentBar: undefined,
    barIndex: -1,
    ...overrides,
  } as TradeGuardResult;
}

const row = (symbol: string): ScannerRow => ({
  symbol,
  shortSellRestricted: false,
  changePct: 20,
  last: 5,
  floatShares: 5_000_000,
  volume: 1_000_000,
  sessionVolume: 1_000_000,
  turnover: 5_000_000,
  relativeVolume: 12,
  shortInterest: null,
  shortInterestAsOf: null,
});

describe("Strategy Scanner classification", () => {
  it("maps stock-qualified candidates with no pattern to Eligible", () => {
    const result = classifyTradeGuardResult(guardResult({ status: "NO_SETUP" }));
    expect(result.status).toBe("ELIGIBLE");
    expect(result.eligibility).toBe("eligible");
    expect(result.setupLabel).toBe("—");
    expect(result.quality).toBe("—");
  });

  it("maps a partially formed Micro/Curl structure to Developing", () => {
    const result = classifyTradeGuardResult(guardResult({
      status: "BLOCKED",
      setup: "MICRO",
      checks: [{ id: "pattern", label: "Pattern", state: "fail", detail: "Pullback is still forming." }],
    }));
    expect(result.status).toBe("DEVELOPING");
    expect(result.setupLabel).toBe("Micro Pullback");
    expect(result.quality).toBe("GOOD");
  });

  it("does not call a structurally valid pattern with a risk blocker Developing", () => {
    const result = classifyTradeGuardResult(guardResult({
      status: "BLOCKED",
      setup: "CURL",
      checks: [{ id: "pattern", label: "Pattern", state: "pass", detail: "Structure passed." }],
    }));
    expect(result.status).toBe("REJECTED");
    expect(result.setupLabel).toBe("Curl / Higher-Low");
  });

  it("maps data gaps and integrity problems to Unknown", () => {
    for (const status of ["NO_DATA", "DATA_INCOMPLETE", "DATA_UNCERTAIN"] as const) {
      const result = classifyTradeGuardResult(guardResult({ status, dataIncomplete: true }));
      expect(result.status).toBe("UNKNOWN");
      expect(result.eligibility).toBe("unknown");
    }
  });

  it("maps chart Watch/Trigger/2R lifecycle states without implying broker fills", () => {
    expect(classifyTradeGuardResult(guardResult({ status: "WATCH", setup: "MICRO" })).status).toBe("WATCH");
    expect(classifyTradeGuardResult(guardResult({ status: "TRIGGERED", setup: "MICRO" })).status).toBe("TRIGGERED");
    expect(classifyTradeGuardResult(guardResult({ status: "2R_HIT", setup: "MICRO" })).status).toBe("TRIGGERED");
    expect(strategyStatusLabel("TRIGGERED")).toBe("Triggered");
    expect(strategyQualityLabel("STRONG")).toBe("Strong");
  });

  it("maps filtered or stopped candidates to Rejected", () => {
    expect(classifyTradeGuardResult(guardResult({ status: "FILTERED", stockPassed: false })).status).toBe("REJECTED");
    expect(classifyTradeGuardResult(guardResult({ status: "STOPPED", setup: "CURL" })).status).toBe("REJECTED");
  });
});

describe("Strategy Scanner filters", () => {
  it("defaults safely and ignores unsupported persisted values", () => {
    expect(readStrategyScannerFilters({})).toEqual(DEFAULT_STRATEGY_SCANNER_FILTERS);
    expect(readStrategyScannerFilters({ strategyScannerFilters: { setup: "gap", status: "active", eligibility: "pass" } }))
      .toEqual(DEFAULT_STRATEGY_SCANNER_FILTERS);
  });

  it("filters setup, status and eligibility independently", () => {
    const developing = classifyTradeGuardResult(guardResult({
      status: "BLOCKED",
      setup: "CURL",
      checks: [{ id: "pattern", label: "Pattern", state: "fail", detail: "Higher-low base still forming." }],
    }));
    expect(matchesStrategyScannerFilters(developing, { setup: "curl", status: "developing", eligibility: "eligible" })).toBe(true);
    expect(matchesStrategyScannerFilters(developing, { setup: "micro", status: "all", eligibility: "all" })).toBe(false);
    expect(matchesStrategyScannerFilters(developing, { setup: "all", status: "watch", eligibility: "all" })).toBe(false);
  });
});

describe("StrategyScannerRuntime coverage", () => {
  it("limits analysis to the candidate window and labels missing one-minute history Unknown", () => {
    const runtime = new StrategyScannerRuntime();
    const bars = {
      getRev: () => 0,
      latestBar: () => undefined,
      tailSeries: () => [],
    };
    const stockDetail = { detailFor: () => undefined };
    const candidates = Array.from({ length: STRATEGY_SCANNER_MAX_CANDIDATES + 1 }, (_, i) => ({
      ...row("US.TEST" + i),
      isUnseen: false,
      isNewHit: false,
      muted: false,
    }));
    const evaluated = runtime.evaluate(candidates, { bars: bars as never, stockDetail: stockDetail as never }, "ready", Date.now());
    expect(evaluated.get("US.TEST0")?.status).toBe("UNKNOWN");
    expect(evaluated.get("US.TEST0")?.detail).toContain("No one-minute chart history");
    expect(evaluated.get("US.TEST30")?.status).toBe("UNKNOWN");
    expect(evaluated.get("US.TEST30")?.detail).toContain("Outside the current 30-candidate");
  });

  it("does not evaluate stale chart data or a delayed Scanner board", () => {
    const runtime = new StrategyScannerRuntime();
    const now = Date.now();
    const bars = {
      getRev: () => 1,
      latestBar: () => ({
        symbol: "US.TEST",
        timeframe: "1m",
        bucketStart: new Date(now - 10 * 60_000).toISOString(),
        o: 5, h: 5.1, l: 4.9, c: 5, v: 100, inProgress: false,
      }),
      tailSeries: () => [],
    };
    const stockDetail = { detailFor: () => undefined };
    const candidate = [{ ...row("US.TEST"), isUnseen: false, isNewHit: false, muted: false }];
    expect(runtime.evaluate(candidate, { bars: bars as never, stockDetail: stockDetail as never }, "ready", now)
      .get("US.TEST")?.detail).toContain("10 minutes old");
    expect(runtime.evaluate(candidate, { bars: bars as never, stockDetail: stockDetail as never }, "delayed", now)
      .get("US.TEST")?.detail).toContain("Scanner data is delayed");
  });
});

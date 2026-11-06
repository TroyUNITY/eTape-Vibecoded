import type { Bar, ScannerRow, ScannerRankPayload } from "../wire/contract";
import type { ScannerRowView } from "../data/ScannerStore";
import type { BarStore } from "../data/BarStore";
import type { StockDetailStore } from "../data/StockDetailStore";
import { TradeGuardTracker, type TradeGuardResult } from "./tradeGuard";

export type StrategySetupFilter = "all" | "micro" | "curl" | "none";
export type StrategyStatus = "ELIGIBLE" | "DEVELOPING" | "WATCH" | "TRIGGERED" | "REJECTED" | "UNKNOWN";
export type StrategyStatusFilter = "all" | "eligible" | "developing" | "watch" | "triggered" | "rejected" | "unknown";
export type StrategyEligibility = "eligible" | "rejected" | "unknown";
export type StrategyEligibilityFilter = "all" | StrategyEligibility;
export type StrategyQuality = "STRONG" | "GOOD" | "WEAK" | "—";

export interface StrategyScannerFilters {
  setup: StrategySetupFilter;
  status: StrategyStatusFilter;
  eligibility: StrategyEligibilityFilter;
}
export const DEFAULT_STRATEGY_SCANNER_FILTERS: StrategyScannerFilters = {
  setup: "all",
  status: "all",
  eligibility: "all",
};

export interface StrategyScannerRow {
  symbol: string;
  setup: "MICRO" | "CURL" | "NONE" | "UNKNOWN";
  setupLabel: string;
  status: StrategyStatus;
  quality: StrategyQuality;
  eligibility: StrategyEligibility;
  detail: string;
  reasons: string[];
  warnings: string[];
  entry: number | null;
  stop: number | null;
  target2R: number | null;
  result: TradeGuardResult | null;
}

export interface StrategyScannerStores {
  bars: Pick<BarStore, "getRev" | "tailSeries" | "latestBar">;
  stockDetail: Pick<StockDetailStore, "detailFor">;
}

export const STRATEGY_SCANNER_MAX_CANDIDATES = 30;
export const STRATEGY_SCANNER_BAR_LIMIT = 12_000;
export const STRATEGY_SCANNER_DAILY_BAR_LIMIT = 260;
export const STRATEGY_SCANNER_MAX_BAR_AGE_MS = 5 * 60_000;

const statusLabels: Record<StrategyStatus, string> = {
  ELIGIBLE: "Eligible",
  DEVELOPING: "Developing",
  WATCH: "Watch",
  TRIGGERED: "Triggered",
  REJECTED: "Rejected",
  UNKNOWN: "Unknown",
};
const qualityLabels: Record<StrategyQuality, string> = {
  STRONG: "Strong",
  GOOD: "Good",
  WEAK: "Weak",
  "—": "—",
};

export function strategyStatusLabel(status: StrategyStatus): string {
  return statusLabels[status];
}
export function strategyQualityLabel(quality: StrategyQuality): string {
  return qualityLabels[quality];
}

function guardSetupLabel(setup: "MICRO" | "CURL" | "NONE"): string {
  if (setup === "MICRO") return "Micro Pullback";
  if (setup === "CURL") return "Curl / Higher-Low";
  return "—";
}

function mapGuardStatus(result: TradeGuardResult): StrategyStatus {
  switch (result.status) {
    case "NO_DATA":
    case "DATA_UNCERTAIN":
    case "DATA_INCOMPLETE":
      return "UNKNOWN";
    case "FILTERED":
    case "STOPPED":
      return "REJECTED";
    case "NO_SETUP":
      return result.stockPassed ? "ELIGIBLE" : "REJECTED";
    case "WATCH":
      return "WATCH";
    case "TRIGGERED":
    case "2R_HIT":
      // These are chart-price events, not broker orders or fills.
      return "TRIGGERED";
    case "BLOCKED": {
      const pattern = result.checks.find((item) => item.id === "pattern");
      // A partially formed Micro/Curl structure is a developing candidate.
      // A structurally valid pattern blocked by risk, extension or resistance
      // is rejected rather than promoted to a watch setup.
      if (result.stockPassed && result.setup !== "NONE" && pattern?.state === "fail") {
        return "DEVELOPING";
      }
      return "REJECTED";
    }
    default:
      return "UNKNOWN";
  }
}

export function classifyTradeGuardResult(result: TradeGuardResult): StrategyScannerRow {
  const status = mapGuardStatus(result);
  const eligibility: StrategyEligibility = status === "UNKNOWN"
    ? "unknown"
    : result.stockPassed ? "eligible" : "rejected";
  const quality: StrategyQuality = status === "WATCH" || status === "TRIGGERED"
    ? "STRONG"
    : status === "DEVELOPING" ? "GOOD"
      : status === "REJECTED" ? "WEAK" : "—";
  return {
    symbol: result.symbol,
    setup: result.setup,
    setupLabel: guardSetupLabel(result.setup),
    status,
    quality,
    eligibility,
    detail: result.headline,
    reasons: result.reasons.slice(),
    warnings: result.warnings.slice(),
    entry: result.entry,
    stop: result.stop,
    target2R: result.target2R,
    result,
  };
}

export function unknownStrategyScannerRow(symbol: string, reason: string): StrategyScannerRow {
  return {
    symbol,
    setup: "UNKNOWN",
    setupLabel: "—",
    status: "UNKNOWN",
    quality: "—",
    eligibility: "unknown",
    detail: reason,
    reasons: [reason],
    warnings: [],
    entry: null,
    stop: null,
    target2R: null,
    result: null,
  };
}

function signatureFor(
  row: ScannerRow,
  stores: StrategyScannerStores,
  scannerStatus: ScannerRankPayload["status"] | null,
  nowMs: number,
): { signature: string; latestBar: Bar | undefined; ageMs: number } {
  const latestBar = stores.bars.latestBar(row.symbol, "1m");
  const latestMs = latestBar ? Date.parse(latestBar.bucketStart) : Number.NaN;
  const ageMs = Number.isFinite(latestMs) ? nowMs - latestMs : Number.POSITIVE_INFINITY;
  const freshnessMinute = Number.isFinite(ageMs) ? Math.floor(ageMs / 60_000) : -1;
  const detail = stores.stockDetail.detailFor(row.symbol);
  const signature = JSON.stringify([
    scannerStatus,
    stores.bars.getRev(row.symbol, "1m"),
    stores.bars.getRev(row.symbol, "D"),
    row.last,
    row.changePct,
    row.floatShares,
    row.sessionVolume,
    row.volume,
    row.relativeVolume,
    detail?.refreshedAt ?? "",
    detail?.lastClose ?? null,
    detail?.floatShares ?? null,
    detail?.price ?? null,
    latestBar?.bucketStart ?? "",
    freshnessMinute,
  ]);
  return { signature, latestBar, ageMs };
}

export class StrategyScannerRuntime {
  private readonly trackers = new Map<string, TradeGuardTracker>();
  private readonly cached = new Map<string, { signature: string; value: StrategyScannerRow; lastUsed: number }>();

  evaluate(
    rows: readonly ScannerRowView[],
    stores: StrategyScannerStores,
    scannerStatus: ScannerRankPayload["status"] | null,
    nowMs = Date.now(),
    maxCandidates = STRATEGY_SCANNER_MAX_CANDIDATES,
  ): Map<string, StrategyScannerRow> {
    const output = new Map<string, StrategyScannerRow>();
    const limited = Math.max(0, Math.floor(maxCandidates));
    rows.forEach((row, index) => {
      if (index >= limited) {
        output.set(row.symbol, unknownStrategyScannerRow(row.symbol,
          "Outside the current " + limited + "-candidate strategy analysis window."));
        return;
      }
      const state = signatureFor(row, stores, scannerStatus, nowMs);
      const previous = this.cached.get(row.symbol);
      if (previous?.signature === state.signature) {
        previous.lastUsed = nowMs;
        output.set(row.symbol, previous.value);
        return;
      }

      let value: StrategyScannerRow;
      if (scannerStatus !== "ready") {
        value = unknownStrategyScannerRow(row.symbol,
          scannerStatus === "delayed" ? "Scanner data is delayed; waiting for a fresh ranking snapshot."
            : scannerStatus === "paused" ? "Scanner is paused; strategy evaluation is suspended."
              : "Waiting for a ready Scanner snapshot.");
      } else if (!state.latestBar) {
        value = unknownStrategyScannerRow(row.symbol, "No one-minute chart history is available for this Scanner candidate.");
      } else if (!Number.isFinite(state.ageMs) || state.ageMs < -60_000) {
        value = unknownStrategyScannerRow(row.symbol, "The latest one-minute candle has an invalid or future timestamp.");
      } else if (state.ageMs > STRATEGY_SCANNER_MAX_BAR_AGE_MS) {
        value = unknownStrategyScannerRow(row.symbol,
          "The latest one-minute candle is " + Math.round(state.ageMs / 60_000) +
          " minutes old; waiting for current market data.");
      } else {
        const bars = stores.bars.tailSeries(row.symbol, "1m", STRATEGY_SCANNER_BAR_LIMIT);
        const dailyBars = stores.bars.tailSeries(row.symbol, "D", STRATEGY_SCANNER_DAILY_BAR_LIMIT);
        const detail = stores.stockDetail.detailFor(row.symbol);
        let tracker = this.trackers.get(row.symbol);
        if (!tracker) {
          tracker = new TradeGuardTracker();
          this.trackers.set(row.symbol, tracker);
        }
        const price = typeof row.last === "number" && Number.isFinite(row.last) && row.last > 0
          ? row.last
          : detail?.price && detail.price > 0 ? detail.price : undefined;
        const result = tracker.evaluate({
          bars,
          dailyBars,
          scannerRow: row,
          ...(detail ? { detail } : {}),
          ...(price !== undefined ? { lastPrice: price } : {}),
        });
        value = classifyTradeGuardResult(result);
      }
      this.cached.set(row.symbol, { signature: state.signature, value, lastUsed: nowMs });
      output.set(row.symbol, value);
    });

    // Keep lifecycle/cache memory bounded across a long sticky Scanner session.
    if (this.cached.size > 120) {
      const oldest = [...this.cached.entries()]
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
        .slice(0, this.cached.size - 120);
      for (const [symbol] of oldest) {
        this.cached.delete(symbol);
        this.trackers.delete(symbol);
      }
    }
    // Trackers for symbols no longer present in any of the current board rows
    // are naturally pruned by the same bounded cache policy.
    return output;
  }

  reset(): void {
    this.trackers.clear();
    this.cached.clear();
  }
}

export function readStrategyScannerFilters(settings: Record<string, unknown>): StrategyScannerFilters {
  const raw = settings.strategyScannerFilters as Partial<StrategyScannerFilters> | undefined;
  const setup: StrategySetupFilter = raw?.setup === "micro" || raw?.setup === "curl" || raw?.setup === "none"
    ? raw.setup : "all";
  const status: StrategyStatusFilter = raw?.status === "eligible" || raw?.status === "developing" ||
    raw?.status === "watch" || raw?.status === "triggered" || raw?.status === "rejected" || raw?.status === "unknown"
    ? raw.status : "all";
  const eligibility: StrategyEligibilityFilter = raw?.eligibility === "eligible" ||
    raw?.eligibility === "rejected" || raw?.eligibility === "unknown" ? raw.eligibility : "all";
  return { setup, status, eligibility };
}

export function matchesStrategyScannerFilters(
  row: StrategyScannerRow,
  filters: StrategyScannerFilters,
): boolean {
  if (filters.setup !== "all" && row.setup !== filters.setup.toUpperCase()) return false;
  if (filters.status !== "all" && row.status.toLowerCase() !== filters.status) return false;
  if (filters.eligibility !== "all" && row.eligibility !== filters.eligibility) return false;
  return true;
}

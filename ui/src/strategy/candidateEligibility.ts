import type { Bar } from "../wire/contract";
import { etParts } from "../render/chart/barBucket";
import { sameTimeRelativeVolume } from "./tradeGuard";

export type EligibilityCheckState = "pass" | "fail" | "unknown";
export type CandidateEligibilityStatus = "ELIGIBLE" | "REJECTED" | "PENDING";
export type CandidateCatalystEvidence =
  | "fundamental"
  | "technical_breakout"
  | "none"
  | "unknown";

export type CandidateFloatSource =
  | "verified_free_float"
  | "moomoo_outstanding_shares";

export interface CandidateFloatEvidence {
  shares: number | null;
  source: CandidateFloatSource;
}

export interface RossMomentumCriteria {
  /** Ross's small-account strategy decision: minimum price is inclusive. */
  minPrice: number;
  /** Ross's small-account strategy decision says under $20: this ceiling is exclusive. */
  maxPriceExclusive: number;
  /** General momentum-candidate criterion: float under 100 million shares. */
  maxFloatSharesExclusive: number;
  /** General momentum-candidate criterion: same-time relative volume >= 2x. */
  minSameTimeRelativeVolume: number;
  /** Existing Trade Guard comparison window; Warrior's guide does not prescribe a lookback count. */
  relativeVolumeSessions: number;
}

export const DEFAULT_ROSS_MOMENTUM_CRITERIA: RossMomentumCriteria = {
  minPrice: 1,
  maxPriceExclusive: 20,
  maxFloatSharesExclusive: 100_000_000,
  minSameTimeRelativeVolume: 2,
  relativeVolumeSessions: 10,
};

export interface CandidateDailyChartAssessment {
  /**
   * Nearby resistance is deliberately supplied as evidence rather than
   * inferred from an arbitrary percentage threshold. The Warrior material
   * names this condition but does not define a numeric proximity rule.
   */
  nearbyResistance: boolean | null;
}

export interface CandidateEligibilityInput {
  symbol: string;
  price: number | null;
  float: CandidateFloatEvidence | null;
  /** One-minute bars used for a same-time-of-day comparison. */
  oneMinuteBars: readonly Bar[];
  /** Unix epoch milliseconds representing the evaluation time. */
  asOfMs: number | null;
  /** Completed daily bars; the current ET date is excluded from moving averages. */
  dailyBars: readonly Bar[];
  dailyChart: CandidateDailyChartAssessment;
  catalyst: CandidateCatalystEvidence;
  criteria?: Partial<RossMomentumCriteria>;
}

export interface EligibilityCheck {
  id: string;
  label: string;
  state: EligibilityCheckState;
  detail: string;
}

export interface CandidateEligibilityResult {
  symbol: string;
  status: CandidateEligibilityStatus;
  eligible: boolean;
  checks: EligibilityCheck[];
  reasons: string[];
  warnings: string[];
  metrics: {
    price: number | null;
    floatShares: number | null;
    floatSource: CandidateFloatSource | null;
    sameTimeRelativeVolume: number | null;
    relativeVolumeObservations: number;
    ema20: number | null;
    ema50: number | null;
    ema200: number | null;
  };
}

interface DailyTrendResult {
  state: EligibilityCheckState;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  detail: string;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function etDateKey(ms: number): string {
  const p = etParts(ms);
  return String(p.y) + "-" + String(p.mo).padStart(2, "0") + "-" + String(p.d).padStart(2, "0");
}

function emaAtLast(values: readonly number[], period: number): number | null {
  if (values.length < period) return null;
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    value = alpha * values[i] + (1 - alpha) * value;
  }
  return Number.isFinite(value) ? value : null;
}

function dailyTrend(
  dailyBars: readonly Bar[],
  price: number | null,
  asOfMs: number | null,
): DailyTrendResult {
  if (!finite(price) || price <= 0 || !finite(asOfMs)) {
    return {
      state: "unknown", ema20: null, ema50: null, ema200: null,
      detail: "A current price and evaluation time are required for the daily-chart check.",
    };
  }

  const currentDay = etDateKey(asOfMs);
  const closesByDay = new Map<string, { ms: number; close: number }>();
  for (const bar of dailyBars) {
    const ms = Date.parse(bar.bucketStart);
    if (!Number.isFinite(ms) || etDateKey(ms) >= currentDay || bar.inProgress ||
      !finite(bar.c) || bar.c <= 0) continue;
    const key = etDateKey(ms);
    const previous = closesByDay.get(key);
    if (!previous || ms > previous.ms) closesByDay.set(key, { ms, close: bar.c });
  }

  const closes = [...closesByDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, item]) => item.close);
  const ema20 = emaAtLast(closes, 20);
  const ema50 = emaAtLast(closes, 50);
  const ema200 = emaAtLast(closes, 200);
  if (ema20 === null || ema50 === null || ema200 === null) {
    return {
      state: "unknown", ema20, ema50, ema200,
      detail: "Needs 200 completed daily candles to assess price against the 20-, 50- and 200-day EMAs; found " + closes.length + ".",
    };
  }

  const aboveAll = price > ema20 && price > ema50 && price > ema200;
  return {
    state: aboveAll ? "pass" : "fail",
    ema20,
    ema50,
    ema200,
    detail: "Price $" + price.toFixed(2) + (aboveAll ? " is above" : " is not above") +
      " EMA20 $" + ema20.toFixed(2) + ", EMA50 $" + ema50.toFixed(2) +
      " and EMA200 $" + ema200.toFixed(2) + ".",
  };
}

function unknownRelativeVolume(reason: string) {
  return {
    value: null,
    observations: 0,
    currentVolume: 0,
    averageVolume: null,
    reason,
  };
}

/**
 * Evaluates the general Ross-style momentum candidate criteria, not an
 * intraday chart setup. This is intentionally a pure function: it does not
 * mutate scanner membership, subscribe to symbols, or trigger orders.
 */
export function evaluateRossMomentumCandidate(
  input: CandidateEligibilityInput,
): CandidateEligibilityResult {
  const criteria = { ...DEFAULT_ROSS_MOMENTUM_CRITERIA, ...input.criteria };
  const checks: EligibilityCheck[] = [];
  const reasons: string[] = [];
  const warnings: string[] = [];

  const priceState: EligibilityCheckState = !finite(input.price) || input.price <= 0
    ? "unknown"
    : input.price >= criteria.minPrice && input.price < criteria.maxPriceExclusive ? "pass" : "fail";
  const priceDetail = priceState === "unknown"
    ? "Current price is unavailable."
    : "Price $" + input.price!.toFixed(2) + "; required $" + criteria.minPrice.toFixed(2) +
      " to below $" + criteria.maxPriceExclusive.toFixed(2) + ".";
  checks.push({ id: "price", label: "Price range", state: priceState, detail: priceDetail });

  let floatState: EligibilityCheckState = "unknown";
  let floatDetail = "Free-float data is unavailable.";
  const floatShares = input.float?.shares ?? null;
  const floatSource = input.float?.source ?? null;
  if (input.float && finite(floatShares) && floatShares > 0) {
    if (input.float.source === "verified_free_float") {
      floatState = floatShares < criteria.maxFloatSharesExclusive ? "pass" : "fail";
      floatDetail = "Verified free float " + (floatShares / 1_000_000).toFixed(2) +
        "M; required below " + (criteria.maxFloatSharesExclusive / 1_000_000).toFixed(0) + "M.";
    } else {
      floatDetail = "Moomoo outstanding shares are available (" + (floatShares / 1_000_000).toFixed(2) +
        "M), but the provider field is not documented as Ross's freely tradable float measure.";
      warnings.push("Float is provisional: Moomoo's OutstandingShares field is used by eTape as a circulating-share value, but its documentation does not establish that restricted shares are excluded in the same way as Ross's float definition.");
    }
  }
  checks.push({ id: "float", label: "Free float", state: floatState, detail: floatDetail });

  const relativeVolume = finite(input.asOfMs)
    ? sameTimeRelativeVolume([...input.oneMinuteBars], input.asOfMs, criteria.relativeVolumeSessions)
    : unknownRelativeVolume("Evaluation time is unavailable; same-time relative volume cannot be calculated.");
  const rvolValue = finite(relativeVolume.value) ? relativeVolume.value : null;
  const rvolState: EligibilityCheckState = rvolValue === null
    ? "unknown"
    : rvolValue >= criteria.minSameTimeRelativeVolume ? "pass" : "fail";
  const rvolDetail = rvolValue === null
    ? relativeVolume.reason || "Same-time relative volume is unavailable."
    : rvolValue.toFixed(2) + "x from " + relativeVolume.observations +
      " comparable prior sessions; required at least " + criteria.minSameTimeRelativeVolume.toFixed(2) + "x.";
  checks.push({ id: "same-time-rvol", label: "Same-time relative volume", state: rvolState, detail: rvolDetail });

  const trend = dailyTrend(input.dailyBars, input.price, input.asOfMs);
  checks.push({
    id: "daily-trend",
    label: "Daily chart above moving averages",
    state: trend.state,
    detail: trend.detail,
  });

  const resistanceState: EligibilityCheckState = input.dailyChart.nearbyResistance === null
    ? "unknown"
    : input.dailyChart.nearbyResistance ? "fail" : "pass";
  const resistanceDetail = input.dailyChart.nearbyResistance === null
    ? "Nearby overhead resistance has not been assessed."
    : input.dailyChart.nearbyResistance
      ? "Nearby overhead resistance is present."
      : "No nearby overhead resistance was identified.";
  checks.push({
    id: "overhead-resistance",
    label: "Nearby overhead resistance",
    state: resistanceState,
    detail: resistanceDetail,
  });

  const catalystState: EligibilityCheckState = input.catalyst === "unknown"
    ? "unknown"
    : input.catalyst === "none" ? "fail" : "pass";
  const catalystDetail = input.catalyst === "fundamental"
    ? "A fundamental/news catalyst has been identified."
    : input.catalyst === "technical_breakout"
      ? "A technical breakout has been identified."
      : input.catalyst === "none"
        ? "Neither a fundamental catalyst nor a technical breakout has been identified."
        : "Catalyst or technical-breakout evidence is unavailable.";
  checks.push({
    id: "catalyst",
    label: "Catalyst or technical breakout",
    state: catalystState,
    detail: catalystDetail,
  });

  for (const item of checks) {
    if (item.state === "fail") reasons.push(item.label + ": " + item.detail);
    else if (item.state === "unknown") reasons.push(item.label + ": " + item.detail);
  }

  const hasFailure = checks.some((item) => item.state === "fail");
  const hasUnknown = checks.some((item) => item.state === "unknown");
  const status: CandidateEligibilityStatus = hasFailure ? "REJECTED" : hasUnknown ? "PENDING" : "ELIGIBLE";

  return {
    symbol: input.symbol,
    status,
    eligible: status === "ELIGIBLE",
    checks,
    reasons,
    warnings,
    metrics: {
      price: finite(input.price) ? input.price : null,
      floatShares: finite(floatShares) ? floatShares : null,
      floatSource,
      sameTimeRelativeVolume: rvolValue,
      relativeVolumeObservations: relativeVolume.observations,
      ema20: trend.ema20,
      ema50: trend.ema50,
      ema200: trend.ema200,
    },
  };
}

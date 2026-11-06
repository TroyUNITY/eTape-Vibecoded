import type { Bar } from "../wire/contract";
import { etParts } from "../render/chart/barBucket";

export interface CandidateTechnicalCriteria {
  /** Number of completed daily sessions to inspect for overhead resistance. */
  resistanceLookbackDays: number;
  /** Number of daily candles required on each side to confirm a swing high. */
  resistancePivotDepth: number;
  /** eTape heuristic: an overhead level within this percentage is considered nearby. */
  nearbyResistancePct: number;
  /** Completed one-minute candles before the latest candle used as the breakout range. */
  breakoutLookbackBars: number;
  /** eTape heuristic: latest one-minute volume must be this multiple of the prior-bar average. */
  breakoutMinVolumeMultiple: number;
  /** Maximum age of the latest completed one-minute candle. */
  maxOneMinuteBarAgeMs: number;
}

export const DEFAULT_CANDIDATE_TECHNICAL_CRITERIA: CandidateTechnicalCriteria = {
  resistanceLookbackDays: 60,
  resistancePivotDepth: 2,
  nearbyResistancePct: 3,
  breakoutLookbackBars: 20,
  breakoutMinVolumeMultiple: 2,
  maxOneMinuteBarAgeMs: 5 * 60_000,
};

export interface CandidateResistanceAssessment {
  state: "pass" | "fail" | "unknown";
  nearby: boolean | null;
  levelPrice: number | null;
  distancePct: number | null;
  levelType: "daily_swing_high" | "prior_20_day_high" | null;
  observations: number;
  detail: string;
}

export interface CandidateBreakoutAssessment {
  detected: boolean | null;
  referenceHigh: number | null;
  triggerClose: number | null;
  volumeMultiple: number | null;
  barsAnalyzed: number;
  detail: string;
}

export interface CandidateTechnicalAnalysis {
  resistance: CandidateResistanceAssessment;
  breakout: CandidateBreakoutAssessment;
}

export interface CandidateTechnicalAnalysisInput {
  price: number | null;
  oneMinuteBars: readonly Bar[];
  dailyBars: readonly Bar[];
  asOfMs: number | null;
  criteria?: Partial<CandidateTechnicalCriteria>;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function etDateKey(ms: number): string {
  const p = etParts(ms);
  return String(p.y) + "-" + String(p.mo).padStart(2, "0") + "-" + String(p.d).padStart(2, "0");
}

function validOHLCV(bar: Bar): boolean {
  return [bar.o, bar.h, bar.l, bar.c, bar.v].every(Number.isFinite) &&
    bar.o > 0 && bar.h > 0 && bar.l > 0 && bar.c > 0 &&
    bar.h >= Math.max(bar.o, bar.c) &&
    bar.l <= Math.min(bar.o, bar.c) &&
    bar.h >= bar.l && bar.v >= 0;
}

function unknownResistance(detail: string, observations = 0): CandidateResistanceAssessment {
  return {
    state: "unknown",
    nearby: null,
    levelPrice: null,
    distancePct: null,
    levelType: null,
    observations,
    detail,
  };
}

function assessResistance(
  price: number | null,
  dailyBars: readonly Bar[],
  asOfMs: number | null,
  criteria: CandidateTechnicalCriteria,
): CandidateResistanceAssessment {
  if (!finite(price) || price <= 0 || !finite(asOfMs)) {
    return unknownResistance("A current price and evaluation time are required to assess daily resistance.");
  }

  const currentDay = etDateKey(asOfMs);
  const byDay = new Map<string, { ms: number; bar: Bar }>();
  for (const bar of dailyBars) {
    const ms = Date.parse(bar.bucketStart);
    if (bar.timeframe !== "D" || !Number.isFinite(ms) || etDateKey(ms) >= currentDay ||
      bar.inProgress || !validOHLCV(bar)) continue;
    const day = etDateKey(ms);
    const existing = byDay.get(day);
    if (!existing || ms > existing.ms) byDay.set(day, { ms, bar });
  }

  const completed = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-criteria.resistanceLookbackDays)
    .map(([, item]) => item.bar);

  const minimumHistory = Math.max(10, criteria.resistancePivotDepth * 2 + 1);
  if (completed.length < minimumHistory) {
    return unknownResistance(
      "Needs at least " + minimumHistory + " completed daily candles for resistance analysis; found " + completed.length + ".",
      completed.length,
    );
  }

  const levels: { price: number; type: "daily_swing_high" | "prior_20_day_high" }[] = [];
  const depth = criteria.resistancePivotDepth;
  for (let i = depth; i < completed.length - depth; i++) {
    const high = completed[i].h;
    let isPivot = true;
    for (let offset = 1; offset <= depth; offset++) {
      if (high <= completed[i - offset].h || high <= completed[i + offset].h) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) levels.push({ price: high, type: "daily_swing_high" });
  }

  const recentHighBars = completed.slice(-Math.min(20, completed.length));
  const prior20DayHigh = Math.max(...recentHighBars.map((bar) => bar.h));
  if (Number.isFinite(prior20DayHigh)) {
    levels.push({ price: prior20DayHigh, type: "prior_20_day_high" });
  }

  const unique = new Map<string, { price: number; type: "daily_swing_high" | "prior_20_day_high" }>();
  for (const level of levels) {
    const key = level.price.toFixed(6);
    const existing = unique.get(key);
    if (!existing || level.type === "prior_20_day_high") unique.set(key, level);
  }

  const overhead = [...unique.values()]
    .filter((level) => level.price > price)
    .sort((a, b) => a.price - b.price);

  if (overhead.length === 0) {
    return {
      state: "pass",
      nearby: false,
      levelPrice: null,
      distancePct: null,
      levelType: null,
      observations: completed.length,
      detail: "No overhead resistance level was found above $" + price.toFixed(2) +
        " in the latest " + completed.length + " completed daily candles.",
    };
  }

  const nearest = overhead[0];
  const distancePct = ((nearest.price - price) / price) * 100;
  const nearby = distancePct <= criteria.nearbyResistancePct;
  return {
    state: nearby ? "fail" : "pass",
    nearby,
    levelPrice: nearest.price,
    distancePct,
    levelType: nearest.type,
    observations: completed.length,
    detail: "Nearest overhead " + (nearest.type === "prior_20_day_high" ? "20-day high" : "confirmed daily swing high") +
      " is $" + nearest.price.toFixed(2) + " (" + distancePct.toFixed(2) + "% above price); eTape's nearby threshold is " +
      criteria.nearbyResistancePct.toFixed(1) + "%.",
  };
}

function unknownBreakout(detail: string, barsAnalyzed = 0): CandidateBreakoutAssessment {
  return {
    detected: null,
    referenceHigh: null,
    triggerClose: null,
    volumeMultiple: null,
    barsAnalyzed,
    detail,
  };
}

function assessIntradayBreakout(
  oneMinuteBars: readonly Bar[],
  asOfMs: number | null,
  criteria: CandidateTechnicalCriteria,
): CandidateBreakoutAssessment {
  if (!finite(asOfMs)) {
    return unknownBreakout("Evaluation time is unavailable; an intraday breakout cannot be assessed.");
  }

  const currentDay = etDateKey(asOfMs);
  const byBucket = new Map<string, { ms: number; bar: Bar }>();
  for (const bar of oneMinuteBars) {
    const ms = Date.parse(bar.bucketStart);
    if (bar.timeframe !== "1m" || !Number.isFinite(ms) || ms > asOfMs ||
      etDateKey(ms) !== currentDay || bar.inProgress || !validOHLCV(bar)) continue;
    const parts = etParts(ms);
    const minuteOfDay = parts.h * 60 + parts.mi;
    // Evaluate the US extended session (04:00–20:00 ET), excluding overnight prints.
    if (minuteOfDay < 4 * 60 || minuteOfDay >= 20 * 60) continue;
    const existing = byBucket.get(bar.bucketStart);
    if (!existing || ms > existing.ms) byBucket.set(bar.bucketStart, { ms, bar });
  }

  const sessionBars = [...byBucket.values()].sort((a, b) => a.ms - b.ms);
  if (sessionBars.length === 0) {
    return unknownBreakout("No completed one-minute candles are available for the current US extended session.");
  }

  const latest = sessionBars[sessionBars.length - 1];
  const ageMs = asOfMs - latest.ms;
  if (ageMs > criteria.maxOneMinuteBarAgeMs) {
    return unknownBreakout(
      "The latest completed one-minute candle is " + Math.ceil(ageMs / 1000) +
        " seconds old; breakout analysis requires a candle no more than " +
        Math.ceil(criteria.maxOneMinuteBarAgeMs / 1000) + " seconds old.",
      sessionBars.length,
    );
  }

  const prior = sessionBars.slice(-(criteria.breakoutLookbackBars + 1), -1);
  if (prior.length < criteria.breakoutLookbackBars) {
    return unknownBreakout(
      "Needs " + criteria.breakoutLookbackBars + " completed one-minute candles before the latest candle; found " + prior.length + ".",
      sessionBars.length,
    );
  }

  const referenceHigh = Math.max(...prior.map((bar) => bar.bar.h));
  const averageVolume = prior.reduce((sum, item) => sum + item.bar.v, 0) / prior.length;
  if (!(averageVolume > 0) || !Number.isFinite(referenceHigh)) {
    return unknownBreakout("The prior one-minute range has no usable reference high or average volume.", sessionBars.length);
  }

  const latestBar = latest.bar;
  const volumeMultiple = latestBar.v / averageVolume;
  const priceBreak = latestBar.c > referenceHigh;
  const volumeConfirmed = volumeMultiple >= criteria.breakoutMinVolumeMultiple;
  const detected = priceBreak && volumeConfirmed;

  let detail: string;
  if (detected) {
    detail = "Completed one-minute close $" + latestBar.c.toFixed(2) + " broke above the prior " +
      criteria.breakoutLookbackBars + "-bar high of $" + referenceHigh.toFixed(2) +
      " with " + volumeMultiple.toFixed(2) + "x the prior-bar average volume.";
  } else if (!priceBreak) {
    detail = "Latest completed one-minute close $" + latestBar.c.toFixed(2) +
      " has not closed above the prior " + criteria.breakoutLookbackBars +
      "-bar high of $" + referenceHigh.toFixed(2) + ".";
  } else {
    detail = "Price closed above the prior " + criteria.breakoutLookbackBars +
      "-bar high, but volume was " + volumeMultiple.toFixed(2) + "x; eTape requires " +
      criteria.breakoutMinVolumeMultiple.toFixed(1) + "x for confirmation.";
  }

  return {
    detected,
    referenceHigh,
    triggerClose: latestBar.c,
    volumeMultiple,
    barsAnalyzed: sessionBars.length,
    detail,
  };
}

/**
 * Produces transparent chart evidence for the Ross Candidates panel.
 *
 * These are eTape detection heuristics, not numeric rules prescribed by
 * Ross Cameron: "nearby" uses a 3% default band around daily resistance, and
 * a breakout requires a one-minute close above the prior 20-bar high with
 * at least 2x the preceding 20-bar average volume.
 */
export function analyzeCandidateTechnicalContext(
  input: CandidateTechnicalAnalysisInput,
): CandidateTechnicalAnalysis {
  const criteria = { ...DEFAULT_CANDIDATE_TECHNICAL_CRITERIA, ...input.criteria };
  return {
    resistance: assessResistance(input.price, input.dailyBars, input.asOfMs, criteria),
    breakout: assessIntradayBreakout(input.oneMinuteBars, input.asOfMs, criteria),
  };
}

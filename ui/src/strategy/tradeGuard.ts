import type { Bar, ScannerRow, StockDetailPayload } from "../wire/contract";
import { etParts } from "../render/chart/barBucket";

export type GuardCheckState = "pass" | "fail" | "unknown" | "warning";
export type GuardStatus =
  | "NO_DATA"
  | "DATA_UNCERTAIN"
  | "FILTERED"
  | "NO_SETUP"
  | "BLOCKED"
  | "WATCH"
  | "TRIGGERED"
  | "STOPPED"
  | "2R_HIT";
export type SetupType = "MICRO" | "CURL" | "NONE";

export interface GuardCheck {
  id: string;
  label: string;
  state: GuardCheckState;
  detail: string;
}

export interface RelativeVolumeResult {
  value: number | null;
  observations: number;
  currentVolume: number;
  averageVolume: number | null;
  reason: string;
}

export interface TradeGuardSettings {
  minPrice: number;
  maxPrice: number;
  maxFloatShares: number;
  minDayChange: number;
  minRelativeVolume: number;
  relativeVolumeSessions: number;
  minSessionVolume: number;
  impulseLookback: number;
  minImpulseATR: number;
  maxRetracement: number;
  curlLookback: number;
  maxCurlRangeATR: number;
  maxExtensionATR: number;
  maxRiskCents: number;
  plannedShares: number;
  paperRiskBudget: number;
  costBuffer: number;
  watchExpiryBars: number;
  includePriorDayHigh: boolean;
  includeDailyEMA200: boolean;
  includeHalfDollars: boolean;
  rearmMinBars: number;
}

export const DEFAULT_TRADE_GUARD_SETTINGS: TradeGuardSettings = {
  minPrice: 2,
  maxPrice: 18,
  maxFloatShares: 10_000_000,
  minDayChange: 10,
  minRelativeVolume: 5,
  relativeVolumeSessions: 10,
  minSessionVolume: 500_000,
  impulseLookback: 6,
  minImpulseATR: 1,
  maxRetracement: 50,
  curlLookback: 6,
  maxCurlRangeATR: 2.5,
  maxExtensionATR: 1.5,
  maxRiskCents: 20,
  plannedShares: 100,
  paperRiskBudget: 20,
  costBuffer: 0.02,
  watchExpiryBars: 6,
  includePriorDayHigh: true,
  includeDailyEMA200: true,
  includeHalfDollars: true,
  rearmMinBars: 3,
};

export interface TradeGuardInput {
  bars: Bar[];
  dailyBars?: Bar[];
  detail?: StockDetailPayload;
  scannerRow?: ScannerRow;
  lastPrice?: number;
  settings?: Partial<TradeGuardSettings>;
}

export interface TradeGuardResult {
  status: GuardStatus;
  setup: SetupType;
  headline: string;
  symbol: string;
  checks: GuardCheck[];
  reasons: string[];
  warnings: string[];
  entry: number | null;
  stop: number | null;
  target2R: number | null;
  maximumEntry: number | null;
  riskPerShare: number | null;
  nearestResistance: number | null;
  resistanceName: string;
  currentSetupReady: boolean;
  dataUncertain: boolean;
  stockPassed: boolean;
  metrics: {
    price: number | null;
    eligibilityPrice: number | null;
    dayChangePct: number | null;
    floatShares: number | null;
    relativeVolume: number | null;
    relativeVolumeObservations: number;
    scannerDailyRelativeVolume: number | null;
    sessionVolume: number;
    vwap: number | null;
    ema9: number | null;
    ema20: number | null;
    atr14: number | null;
    refreshedAt: string | null;
  };
  currentBar?: Bar;
  barIndex: number;
}

interface Candidate {
  type: Exclude<SetupType, "NONE">;
  trigger: number;
  stop: number;
  risk: number;
  target2R: number;
  structurePassed: boolean;
  notExtended: boolean;
  riskValid: boolean;
  details: string[];
}

interface Indicators {
  ema9: number[];
  ema20: number[];
  atr14: number[];
  vwap: number[];
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function barMs(bar: Bar): number {
  return Date.parse(bar.bucketStart);
}
function dateKey(ms: number): string {
  const p = etParts(ms);
  return String(p.y) + "-" + String(p.mo).padStart(2, "0") + "-" + String(p.d).padStart(2, "0");
}
function minuteOf(ms: number): number {
  const p = etParts(ms);
  return p.h * 60 + p.mi;
}
function fmt(value: number, digits = 2): string {
  return value.toFixed(digits);
}
function minimum(values: number[]): number {
  return values.length ? Math.min(...values) : Number.NaN;
}
function maximum(values: number[]): number {
  return values.length ? Math.max(...values) : Number.NaN;
}

export function sameTimeRelativeVolume(
  bars: Bar[],
  currentTimeMs: number,
  lookback = 10,
): RelativeVolumeResult {
  const currentDay = dateKey(currentTimeMs);
  const cutoffMinute = minuteOf(currentTimeMs);
  const sessions = new Map<string, { minute: number; volume: number }[]>();

  for (const bar of bars) {
    const ms = barMs(bar);
    if (!Number.isFinite(ms)) continue;
    const key = dateKey(ms);
    const rows = sessions.get(key) ?? [];
    rows.push({ minute: minuteOf(ms), volume: Math.max(0, bar.v) });
    sessions.set(key, rows);
  }

  const throughCutoff = (rows: { minute: number; volume: number }[]): number =>
    rows.reduce((sum, row) => sum + (row.minute <= cutoffMinute ? row.volume : 0), 0);

  const currentRows = sessions.get(currentDay) ?? [];
  const currentVolume = throughCutoff(currentRows);
  const priorSessions = [...sessions.entries()]
    .filter(([key, rows]) => key < currentDay && rows.some((row) => row.minute >= cutoffMinute))
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, lookback);

  if (priorSessions.length < lookback) {
    return {
      value: null,
      observations: priorSessions.length,
      currentVolume,
      averageVolume: null,
      reason: "Needs " + lookback + " comparable prior sessions; found " + priorSessions.length + ".",
    };
  }

  const samples = priorSessions.map(([, rows]) => throughCutoff(rows));
  const averageVolume = samples.reduce((sum, volume) => sum + volume, 0) / samples.length;
  if (!(averageVolume > 0)) {
    return {
      value: null,
      observations: samples.length,
      currentVolume,
      averageVolume,
      reason: "Comparable-session average volume is zero.",
    };
  }
  return {
    value: currentVolume / averageVolume,
    observations: samples.length,
    currentVolume,
    averageVolume,
    reason: "",
  };
}

function emaSeries(bars: Bar[], period: number): number[] {
  const out = Array<number>(bars.length).fill(Number.NaN);
  if (bars.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += bars[i].c;
  let value = seed / period;
  out[period - 1] = value;
  const alpha = 2 / (period + 1);
  for (let i = period; i < bars.length; i++) {
    value = alpha * bars[i].c + (1 - alpha) * value;
    out[i] = value;
  }
  return out;
}

function atrSeries(bars: Bar[], period = 14): number[] {
  const out = Array<number>(bars.length).fill(Number.NaN);
  if (bars.length < period) return out;
  const trueRanges = bars.map((bar, index) => {
    if (index === 0) return bar.h - bar.l;
    const previousClose = bars[index - 1].c;
    return Math.max(
      bar.h - bar.l,
      Math.abs(bar.h - previousClose),
      Math.abs(bar.l - previousClose),
    );
  });
  let value = trueRanges.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;
  out[period - 1] = value;
  for (let i = period; i < bars.length; i++) {
    value = ((value * (period - 1)) + trueRanges[i]) / period;
    out[i] = value;
  }
  return out;
}

function vwapSeries(bars: Bar[]): number[] {
  const out = Array<number>(bars.length).fill(Number.NaN);
  let day = "";
  let cumulativePV = 0;
  let cumulativeVolume = 0;
  for (let i = 0; i < bars.length; i++) {
    const key = dateKey(barMs(bars[i]));
    if (key !== day) {
      day = key;
      cumulativePV = 0;
      cumulativeVolume = 0;
    }
    const bar = bars[i];
    const typical = (bar.h + bar.l + bar.c) / 3;
    const volume = Math.max(0, bar.v);
    cumulativePV += typical * volume;
    cumulativeVolume += volume;
    if (cumulativeVolume > 0) out[i] = cumulativePV / cumulativeVolume;
  }
  return out;
}

function calculateIndicators(bars: Bar[]): Indicators {
  return {
    ema9: emaSeries(bars, 9),
    ema20: emaSeries(bars, 20),
    atr14: atrSeries(bars, 14),
    vwap: vwapSeries(bars),
  };
}

function pullbackBar(bars: Bar[], index: number): boolean {
  if (index <= 0 || index >= bars.length) return false;
  return bars[index].c < bars[index].o || bars[index].h <= bars[index - 1].h;
}

function microCandidate(
  bars: Bar[],
  ind: Indicators,
  settings: TradeGuardSettings,
  tick: number,
): Candidate | null {
  const lastIndex = bars.length - 1;
  const completed = bars.slice(0, -1);
  if (completed.length < settings.impulseLookback + 4 || lastIndex < 20) return null;

  const current = bars[lastIndex];
  const previousEma9 = ind.ema9[lastIndex - 1];
  const currentEma9 = ind.ema9[lastIndex];
  const currentEma20 = ind.ema20[lastIndex];
  const currentATR = ind.atr14[lastIndex];
  const currentVWAP = ind.vwap[lastIndex];
  const previousVWAP = ind.vwap[lastIndex - 1];
  if (![previousEma9, currentEma9, currentEma20, currentATR, currentVWAP, previousVWAP].every(Number.isFinite)) return null;

  const last = completed.length - 1;
  const pb1 = pullbackBar(completed, last);
  const pb2 = pullbackBar(completed, last - 1);
  const pb3 = pullbackBar(completed, last - 2);
  const pb4 = pullbackBar(completed, last - 3);
  let count = pb1 ? 1 : 0;
  if (pb1 && pb2) count = 2;
  if (pb1 && pb2 && pb3) count = 3;
  const lengthValid = count >= 1 && count <= 3 && !(count === 3 && pb4);
  if (count === 0) return null;

  const pullback = completed.slice(completed.length - count);
  const pullbackLow = minimum(pullback.map((bar) => bar.l));
  const poleIndex = last - count;
  if (poleIndex < settings.impulseLookback - 1) return null;
  const poleHigh = completed[poleIndex].h;
  const impulseStart = poleIndex - settings.impulseLookback + 1;
  const impulseLow = minimum(completed.slice(impulseStart, poleIndex + 1).map((bar) => bar.l));
  const waveSize = poleHigh - impulseLow;
  const retracementPct = waveSize > 0 ? ((poleHigh - pullbackLow) / waveSize) * 100 : Number.POSITIVE_INFINITY;
  const averagePullbackVolume = pullback.reduce((sum, bar) => sum + bar.v, 0) / count;
  const impulseVolume = completed[poleIndex].v;
  const trigger = completed[last].h + tick;
  const stop = pullbackLow - tick;
  const risk = trigger - stop;
  const target2R = trigger + 2 * risk;

  const strongImpulse = waveSize >= currentATR * settings.minImpulseATR;
  const shallowPullback = retracementPct <= settings.maxRetracement;
  const taperingVolume = averagePullbackVolume < impulseVolume;
  const trendAligned = current.c > currentVWAP && currentEma9 > currentEma20 && currentEma9 > ind.ema9[lastIndex - 1];
  const holdsVWAP = pullbackLow > previousVWAP;
  const holdsEMA9 = pullbackLow >= previousEma9 - currentATR * 0.15;
  const notExtended = trigger - previousEma9 <= currentATR * settings.maxExtensionATR;
  const riskValid = risk > 0 && risk * 100 <= settings.maxRiskCents;
  const structurePassed = lengthValid && strongImpulse && shallowPullback &&
    taperingVolume && trendAligned && holdsVWAP && holdsEMA9;

  return {
    type: "MICRO",
    trigger,
    stop,
    risk,
    target2R,
    structurePassed,
    notExtended,
    riskValid,
    details: [
      "Completed pullback bars: " + count + (lengthValid ? " (valid)." : " (invalid: 1–3 required)."),
      "Impulse: " + fmt(waveSize, 3) + " versus " + fmt(currentATR * settings.minImpulseATR, 3) + " minimum.",
      "Retracement: " + fmt(retracementPct, 1) + "% versus " + fmt(settings.maxRetracement, 1) + "% maximum.",
      taperingVolume ? "Pullback volume contracted versus the pole candle." : "Pullback volume did not contract.",
      holdsVWAP ? "Pullback low held above prior VWAP." : "Pullback low lost prior VWAP.",
      holdsEMA9 ? "Pullback low held near EMA9." : "Pullback low lost the EMA9 support allowance.",
    ],
  };
}

function curlCandidate(
  bars: Bar[],
  ind: Indicators,
  settings: TradeGuardSettings,
  tick: number,
): Candidate | null {
  const lastIndex = bars.length - 1;
  const completed = bars.slice(0, -1);
  if (completed.length < Math.max(settings.curlLookback, 3) || lastIndex < 20) return null;

  const last = completed[completed.length - 1];
  const previous = completed[completed.length - 2];
  const third = completed[completed.length - 3];
  const priorIndex = lastIndex - 1;
  const priorTwoIndex = lastIndex - 2;
  const previousVWAP = ind.vwap[priorIndex];
  const previousEma9 = ind.ema9[priorIndex];
  const previousEma20 = ind.ema20[priorIndex];
  const olderEma9 = ind.ema9[priorTwoIndex];
  const previousATR = ind.atr14[priorIndex];
  if (![previousVWAP, previousEma9, previousEma20, olderEma9, previousATR].every(Number.isFinite)) return null;

  const base = completed.slice(-settings.curlLookback);
  const baseHigh = maximum(base.map((bar) => bar.h));
  const baseLow = minimum(base.map((bar) => bar.l));
  const baseRange = baseHigh - baseLow;
  const higherLows = last.l > previous.l && previous.l >= third.l;
  const greenPressure = last.c > last.o && last.c >= previous.c;
  const trendAligned = last.c > previousVWAP && last.c > previousEma9 &&
    previousEma9 > previousEma20 && previousEma9 > olderEma9;
  const compactBase = baseRange > 0 && baseRange <= previousATR * settings.maxCurlRangeATR;
  const healthyVolume = last.v >= previous.v * 0.70;
  const trigger = last.h + tick;
  const stop = minimum(completed.slice(-3).map((bar) => bar.l)) - tick;
  const risk = trigger - stop;

  return {
    type: "CURL",
    trigger,
    stop,
    risk,
    target2R: trigger + 2 * risk,
    structurePassed: higherLows && greenPressure && trendAligned && compactBase && healthyVolume,
    notExtended: trigger - previousEma9 <= previousATR * settings.maxExtensionATR,
    riskValid: risk > 0 && risk * 100 <= settings.maxRiskCents,
    details: [
      higherLows ? "Three-candle higher-low structure is present." : "Higher-low structure is incomplete.",
      greenPressure ? "Latest completed candle shows green recovery pressure." : "Green recovery candle is missing.",
      trendAligned ? "VWAP and EMA trend are aligned." : "VWAP/EMA trend is not aligned.",
      "Base range: " + fmt(baseRange, 3) + " versus " + fmt(previousATR * settings.maxCurlRangeATR, 3) + " maximum.",
      healthyVolume ? "Recovery volume is adequate." : "Recovery volume is weak.",
    ],
  };
}

function check(id: string, label: string, passed: boolean | null, detail: string): GuardCheck {
  return {
    id,
    label,
    state: passed === null ? "unknown" : passed ? "pass" : "fail",
    detail,
  };
}

function noDataResult(symbol: string): TradeGuardResult {
  return {
    status: "NO_DATA",
    setup: "NONE",
    headline: "Waiting for one-minute market data",
    symbol,
    checks: [],
    reasons: ["Trade Guard needs one-minute bars. Keep a symbol-bearing chart or Trade Guard panel subscribed."],
    warnings: [],
    entry: null,
    stop: null,
    target2R: null,
    maximumEntry: null,
    riskPerShare: null,
    nearestResistance: null,
    resistanceName: "None",
    currentSetupReady: false,
    dataUncertain: true,
    stockPassed: false,
    metrics: {
      price: null,
      eligibilityPrice: null,
      dayChangePct: null,
      floatShares: null,
      relativeVolume: null,
      relativeVolumeObservations: 0,
      scannerDailyRelativeVolume: null,
      sessionVolume: 0,
      vwap: null,
      ema9: null,
      ema20: null,
      atr14: null,
      refreshedAt: null,
    },
    barIndex: -1,
  };
}

export function evaluateTradeGuard(input: TradeGuardInput): TradeGuardResult {
  const settings = { ...DEFAULT_TRADE_GUARD_SETTINGS, ...input.settings };
  const bars = input.bars
    .filter((bar) => Number.isFinite(barMs(bar)))
    .slice()
    .sort((a, b) => barMs(a) - barMs(b));
  const symbol = bars[0]?.symbol ?? input.detail?.symbol ?? "";
  if (bars.length < 21) return noDataResult(symbol);

  const currentIndex = bars.length - 1;
  const current = bars[currentIndex];
  const currentMs = barMs(current);
  const currentDay = dateKey(currentMs);
  const detailPrice = input.detail?.price;
  const price = finite(input.lastPrice) && input.lastPrice > 0
    ? input.lastPrice
    : finite(detailPrice) && detailPrice > 0 ? detailPrice : current.c;
  const tick = price < 1 ? 0.0001 : 0.01;
  const ind = calculateIndicators(bars);

  const micro = microCandidate(bars, ind, settings, tick);
  const curl = curlCandidate(bars, ind, settings, tick);
  const microUsable = !!micro && micro.structurePassed && micro.notExtended && micro.riskValid;
  const curlUsable = !!curl && curl.structurePassed && curl.notExtended && curl.riskValid;
  const candidate = microUsable ? micro : curlUsable ? curl
    : micro?.structurePassed ? micro : curl?.structurePassed ? curl : null;

  const eligibilityPrice = candidate?.trigger ?? price;
  const todayBars = bars.filter((bar) => dateKey(barMs(bar)) === currentDay);
  const sessionVolume = todayBars.reduce((sum, bar) => {
    const minute = minuteOf(barMs(bar));
    return sum + (minute >= 240 && minute < 1200 ? Math.max(0, bar.v) : 0);
  }, 0);
  const rvol = sameTimeRelativeVolume(bars, currentMs, settings.relativeVolumeSessions);
  const scannerDailyRVOL = finite(input.scannerRow?.relativeVolume) ? input.scannerRow.relativeVolume : null;

  const dailyBars = (input.dailyBars ?? [])
    .filter((bar) => Number.isFinite(barMs(bar)) && dateKey(barMs(bar)) < currentDay)
    .slice()
    .sort((a, b) => barMs(a) - barMs(b));
  const previousDaily = dailyBars[dailyBars.length - 1];
  const detailLastClose = input.detail?.lastClose;
  const previousClose = finite(detailLastClose) && detailLastClose > 0
    ? detailLastClose
    : previousDaily?.c ?? null;
  const detailChangePct = input.detail?.changePct;
  const scannerChangePct = input.scannerRow?.changePct;
  const dayChangePct = finite(detailChangePct) ? detailChangePct
    : previousClose !== null && previousClose > 0 ? ((price / previousClose) - 1) * 100
      : finite(scannerChangePct) ? scannerChangePct : null;
  const detailFloatShares = input.detail?.floatShares;
  const scannerFloatShares = input.scannerRow?.floatShares;
  const floatShares = finite(detailFloatShares) && detailFloatShares > 0
    ? detailFloatShares
    : finite(scannerFloatShares) && scannerFloatShares > 0 ? scannerFloatShares : null;

  const pricePassed = eligibilityPrice >= settings.minPrice && eligibilityPrice <= settings.maxPrice;
  const floatPassed = floatShares !== null && floatShares <= settings.maxFloatShares;
  const changePassed = dayChangePct !== null && dayChangePct >= settings.minDayChange;
  const rvolPassed = rvol.value !== null && rvol.value >= settings.minRelativeVolume;
  const activityPassed = sessionVolume >= settings.minSessionVolume;
  const floatSuspect = floatShares !== null && floatShares < 100_000;
  const rvolSuspect = rvol.value !== null &&
    (rvol.value > 500 || !(rvol.averageVolume && rvol.averageVolume > 0));
  const dataUncertain = floatShares === null || rvol.value === null || floatSuspect || rvolSuspect;
  const stockPassed = pricePassed && floatPassed && changePassed && rvolPassed && activityPassed;

  const entry = candidate?.trigger ?? null;
  const stop = candidate?.stop ?? null;
  const risk = candidate?.risk ?? null;
  const target2R = candidate?.target2R ?? null;

  let nearestResistance: number | null = null;
  let resistanceName = "None";
  const considerResistance = (level: number | null | undefined, name: string) => {
    if (candidate && finite(level) && level > candidate.trigger + tick &&
      (nearestResistance === null || level < nearestResistance)) {
      nearestResistance = level;
      resistanceName = name;
    }
  };

  const sessionHighs = bars.slice(0, -1).filter((bar) => {
    const ms = barMs(bar);
    const minute = minuteOf(ms);
    return dateKey(ms) === currentDay && minute >= 240 && minute < 1200;
  }).map((bar) => bar.h);
  const premarketHighs = bars.slice(0, -1).filter((bar) => {
    const ms = barMs(bar);
    const minute = minuteOf(ms);
    return dateKey(ms) === currentDay && minute >= 240 && minute < 570;
  }).map((bar) => bar.h);
  const sessionHigh = sessionHighs.length ? maximum(sessionHighs) : null;
  const premarketHigh = premarketHighs.length ? maximum(premarketHighs) : null;
  considerResistance(sessionHigh, "Prior session high");
  considerResistance(premarketHigh, "Premarket high");
  if (settings.includePriorDayHigh) considerResistance(previousDaily?.h ?? null, "Previous-day high");
  if (settings.includeDailyEMA200) considerResistance(input.detail?.ema200 ?? null, "Daily EMA200");

  const roomFor2R = candidate !== null && target2R !== null &&
    (nearestResistance === null || target2R <= nearestResistance + tick);
  const nextHalfOrWhole = entry === null ? null : (Math.floor(entry * 2) + 1) / 2;
  const softDollarBefore2R = settings.includeHalfDollars && nextHalfOrWhole !== null &&
    target2R !== null && nextHalfOrWhole < target2R - tick;
  const maximumRiskDistance = Math.min(
    settings.maxRiskCents / 100,
    settings.paperRiskBudget / settings.plannedShares - settings.costBuffer,
  );
  const riskEntryCeiling = stop === null ? null : stop + maximumRiskDistance;
  const resistanceEntryCeiling = nearestResistance !== null && stop !== null
    ? (nearestResistance + 2 * stop - 3 * settings.costBuffer) / 3
    : riskEntryCeiling;
  const maximumEntry = riskEntryCeiling === null
    ? null
    : Math.floor(Math.min(riskEntryCeiling, resistanceEntryCeiling ?? riskEntryCeiling) / tick) * tick;
  const entryWindowValid = maximumEntry !== null && entry !== null && maximumEntry >= entry;
  const noChase = maximumEntry !== null && price <= maximumEntry;
  const notExtended = candidate?.notExtended ?? false;
  const riskValid = candidate?.riskValid ?? false;
  const patternPassed = candidate !== null && notExtended;
  const currentSetupReady = patternPassed && stockPassed && !dataUncertain &&
    riskValid && roomFor2R && entryWindowValid && noChase;

  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!pricePassed) reasons.push("Proposed trigger price is outside the configured $" +
    fmt(settings.minPrice) + "–$" + fmt(settings.maxPrice) + " range.");
  if (floatShares === null) reasons.push("Free-float data is unavailable.");
  else if (!floatPassed) reasons.push("Float " + fmt(floatShares / 1_000_000, 2) +
    "M exceeds the " + fmt(settings.maxFloatShares / 1_000_000, 1) + "M limit.");
  if (dayChangePct === null) reasons.push("Gain from the previous close is unavailable.");
  else if (!changePassed) reasons.push("Daily gain " + fmt(dayChangePct, 1) +
    "% is below " + fmt(settings.minDayChange, 1) + "%.");
  if (rvol.value === null) reasons.push(rvol.reason || "Same-time relative volume is unavailable.");
  else if (!rvolPassed) reasons.push("Same-time RVOL " + fmt(rvol.value, 1) +
    "x is below " + fmt(settings.minRelativeVolume, 1) + "x.");
  if (!activityPassed) reasons.push("Session volume " + Math.round(sessionVolume).toLocaleString("en-US") +
    " is below " + Math.round(settings.minSessionVolume).toLocaleString("en-US") + ".");
  if (floatSuspect) reasons.push("Float is unusually small; verify its source before relying on it.");
  if (rvolSuspect) reasons.push("Relative-volume baseline looks suspicious.");

  if (candidate === null) {
    reasons.push("No qualifying Micro Pullback or Curl base is visible in the latest completed one-minute candles.");
  } else {
    reasons.push(...(!candidate.structurePassed ? candidate.details.filter((detail) =>
      detail.startsWith("Pullback") || detail.startsWith("Impulse") || detail.startsWith("Retracement") ||
      detail.startsWith("Three-candle") || detail.startsWith("Latest") || detail.startsWith("VWAP") ||
      detail.startsWith("Base") || detail.startsWith("Recovery") || detail.startsWith("Pullback low")
    ) : []));
    if (!notExtended) reasons.push("The proposed trigger is too far above EMA9; avoid chasing.");
    if (!riskValid) reasons.push("Structural risk " + fmt((risk ?? 0) * 100, 1) +
      "¢ exceeds the " + fmt(settings.maxRiskCents, 0) + "¢ limit.");
    if (!roomFor2R) reasons.push(resistanceName + " is before the proposed 2R target.");
    if (!entryWindowValid) reasons.push("No entry window remains after the risk and cost allowance.");
    else if (!noChase) reasons.push("Last price is above the maximum planned entry of $" + fmt(maximumEntry, 3) + ".");
  }

  if (dataUncertain) warnings.push("Critical eligibility data is incomplete or suspect. No new setup should be armed.");
  if (softDollarBefore2R && nextHalfOrWhole !== null) {
    warnings.push("Psychological level at $" + fmt(nextHalfOrWhole) + " is before 2R; treat it as a soft warning, not a hard blocker.");
  }
  if (scannerDailyRVOL !== null) {
    warnings.push("Scanner daily RVOL is " + fmt(scannerDailyRVOL, 1) +
      "x. This is a different calculation from same-time RVOL and is not used for the automatic eligibility gate.");
  }
  if (input.detail?.refreshedAt) {
    const ageMs = Date.now() - Date.parse(input.detail.refreshedAt);
    if (Number.isFinite(ageMs) && ageMs > 12 * 60 * 60 * 1000) {
      warnings.push("Float/fundamental details were last refreshed more than 12 hours ago.");
    }
  }
  const averageDollarVolume = bars.slice(Math.max(0, currentIndex - 10), currentIndex)
    .map((bar) => bar.v * ((bar.h + bar.l + bar.c) / 3));
  const recentAverageDollarVolume = averageDollarVolume.length
    ? averageDollarVolume.reduce((sum, value) => sum + value, 0) / averageDollarVolume.length
    : 0;
  const currentDollarVolume = current.v * ((current.h + current.l + current.c) / 3);
  if (recentAverageDollarVolume > 0 && currentDollarVolume > recentAverageDollarVolume * 1.5) {
    warnings.push("Current-bar dollar volume is increasing. This is context, not an entry signal.");
  }

  const status: GuardStatus = dataUncertain ? "DATA_UNCERTAIN"
    : !stockPassed ? "FILTERED"
      : candidate === null ? "NO_SETUP"
        : !currentSetupReady ? "BLOCKED" : current.h >= (entry ?? Number.POSITIVE_INFINITY) ? "TRIGGERED" : "WATCH";
  const headline = ({
    NO_DATA: "Waiting for one-minute market data",
    DATA_UNCERTAIN: "Data incomplete — no new entry permission",
    FILTERED: "Stock does not pass eligibility filters",
    NO_SETUP: "No qualifying setup right now",
    BLOCKED: "Setup detected, but one or more checks failed",
    WATCH: "Qualified setup — wait for its trigger",
    TRIGGERED: "Chart trigger crossed — verify manually",
    STOPPED: "Structural stop level was touched",
    "2R_HIT": "The 2R chart level was reached",
  } as Record<GuardStatus, string>)[status];

  const checks: GuardCheck[] = [
    check("price", "Price range", pricePassed, "Eligibility price $" + fmt(eligibilityPrice) +
      "; configured range $" + fmt(settings.minPrice) + "–$" + fmt(settings.maxPrice) + "."),
    check("float", "Free float", floatShares === null ? null : floatPassed, floatShares !== null
      ? fmt(floatShares / 1_000_000, 2) + "M shares; maximum " + fmt(settings.maxFloatShares / 1_000_000, 1) + "M."
      : "Moomoo or scanner float is unavailable."),
    check("change", "Gain from previous close", dayChangePct === null ? null : changePassed, dayChangePct !== null
      ? fmt(dayChangePct, 1) + "%; minimum " + fmt(settings.minDayChange, 1) + "%."
      : "Previous close or current change is unavailable."),
    check("rvol", "Same-time relative volume", rvol.value === null ? null : rvolPassed, rvol.value !== null
      ? fmt(rvol.value, 1) + "x from " + rvol.observations + " comparable sessions."
      : rvol.reason),
    check("session-volume", "Session activity", activityPassed, Math.round(sessionVolume).toLocaleString("en-US") +
      " shares; minimum " + Math.round(settings.minSessionVolume).toLocaleString("en-US") + "."),
    check("pattern", "Micro / Curl structure", candidate ? candidate.structurePassed : false,
      candidate ? candidate.type + ": " + candidate.details.join(" ") : "No current pattern qualified."),
    check("trend", "VWAP and EMA trend",
      finite(ind.vwap[currentIndex]) && finite(ind.ema9[currentIndex]) && finite(ind.ema20[currentIndex])
        ? price > ind.vwap[currentIndex] && ind.ema9[currentIndex] > ind.ema20[currentIndex]
        : null,
      finite(ind.vwap[currentIndex]) && finite(ind.ema9[currentIndex]) && finite(ind.ema20[currentIndex])
        ? "VWAP " + fmt(ind.vwap[currentIndex], 3) + "; EMA9 " + fmt(ind.ema9[currentIndex], 3) +
          "; EMA20 " + fmt(ind.ema20[currentIndex], 3) + "."
        : "VWAP/EMA history is still warming up."),
    check("extension", "Not extended from EMA9", candidate ? candidate.notExtended : null,
      candidate ? "Trigger-to-EMA9 distance " + fmt((candidate.trigger - ind.ema9[currentIndex - 1]) * 100, 1) + "¢."
        : "No active trigger level."),
    check("risk", "Structural risk", candidate ? candidate.riskValid : null,
      candidate ? fmt(candidate.risk * 100, 1) + "¢ per share; limit " + fmt(settings.maxRiskCents, 0) + "¢."
        : "No structural stop available."),
    check("resistance", "Room for 2R", candidate ? roomFor2R : null,
      candidate ? (nearestResistance === null
        ? "No higher resistance level found in available data."
        : resistanceName + " at $" + fmt(nearestResistance) + "; target $" + fmt(candidate.target2R) + ".")
        : "No target available."),
    check("entry", "Entry not chased", candidate ? entryWindowValid && noChase : null,
      candidate && maximumEntry !== null
        ? "Trigger $" + fmt(candidate.trigger, 3) + "; max entry $" + fmt(maximumEntry, 3) + "; last $" + fmt(price, 3) + "."
        : "No maximum-entry calculation available."),
  ];

  return {
    status,
    setup: candidate?.type ?? "NONE",
    headline,
    symbol,
    checks,
    reasons,
    warnings,
    entry,
    stop,
    target2R,
    maximumEntry,
    riskPerShare: risk,
    nearestResistance: nearestResistance ?? (settings.includeHalfDollars ? nextHalfOrWhole : null),
    resistanceName,
    currentSetupReady,
    dataUncertain,
    stockPassed,
    metrics: {
      price,
      eligibilityPrice,
      dayChangePct,
      floatShares,
      relativeVolume: rvol.value,
      relativeVolumeObservations: rvol.observations,
      scannerDailyRelativeVolume: scannerDailyRVOL,
      sessionVolume,
      vwap: finite(ind.vwap[currentIndex]) ? ind.vwap[currentIndex] : null,
      ema9: finite(ind.ema9[currentIndex]) ? ind.ema9[currentIndex] : null,
      ema20: finite(ind.ema20[currentIndex]) ? ind.ema20[currentIndex] : null,
      atr14: finite(ind.atr14[currentIndex]) ? ind.atr14[currentIndex] : null,
      refreshedAt: input.detail?.refreshedAt || null,
    },
    currentBar: current,
    barIndex: currentIndex,
  };
}

type LifecycleState = "IDLE" | "WATCH" | "ACTIVE" | "STOPPED" | "2R_HIT";
interface FrozenSetup {
  setup: Exclude<SetupType, "NONE">;
  entry: number;
  stop: number;
  target2R: number;
  maximumEntry: number;
  risk: number;
  resistance: number | null;
  resistanceName: string;
  createdBucket: string;
  triggeredBucket: string | null;
  completedBucket: string | null;
}

export class TradeGuardTracker {
  private symbol = "";
  private session = "";
  private state: LifecycleState = "IDLE";
  private frozen: FrozenSetup | null = null;

  reset(): void {
    this.symbol = "";
    this.session = "";
    this.state = "IDLE";
    this.frozen = null;
  }

  evaluate(input: TradeGuardInput): TradeGuardResult {
    const result = evaluateTradeGuard(input);
    if (!result.currentBar || result.barIndex < 0) return result;

    const current = result.currentBar;
    const today = dateKey(barMs(current));
    if (this.symbol !== result.symbol || this.session !== today) {
      this.symbol = result.symbol;
      this.session = today;
      this.state = "IDLE";
      this.frozen = null;
    }

    const indexOf = (bucket: string | null): number =>
      bucket === null ? -1 : input.bars.findIndex((bar) => bar.bucketStart === bucket);
    const currentIndex = result.barIndex;

    if (this.state === "WATCH" && this.frozen) {
      const createdIndex = indexOf(this.frozen.createdBucket);
      if (createdIndex < 0 || result.dataUncertain || !result.stockPassed ||
        current.l <= this.frozen.stop || current.o > this.frozen.maximumEntry ||
        currentIndex - createdIndex > (input.settings?.watchExpiryBars ?? DEFAULT_TRADE_GUARD_SETTINGS.watchExpiryBars)) {
        this.state = "IDLE";
        this.frozen = null;
      } else if (current.h >= this.frozen.entry && current.c <= this.frozen.maximumEntry) {
        this.state = "ACTIVE";
        this.frozen.triggeredBucket = current.bucketStart;
      }
    }

    if (this.state === "ACTIVE" && this.frozen) {
      if (current.l <= this.frozen.stop) {
        this.state = "STOPPED";
        this.frozen.completedBucket = current.bucketStart;
      } else {
        const triggeredIndex = indexOf(this.frozen.triggeredBucket);
        if (triggeredIndex >= 0 && currentIndex > triggeredIndex && current.h >= this.frozen.target2R) {
          this.state = "2R_HIT";
          this.frozen.completedBucket = current.bucketStart;
        }
      }
    }

    if ((this.state === "STOPPED" || this.state === "2R_HIT") && this.frozen) {
      const completedIndex = indexOf(this.frozen.completedBucket);
      const rearmBars = input.settings?.rearmMinBars ?? DEFAULT_TRADE_GUARD_SETTINGS.rearmMinBars;
      if (completedIndex >= 0 && currentIndex - completedIndex > rearmBars) {
        this.state = "IDLE";
        this.frozen = null;
      }
    }

    if (this.state === "IDLE" && result.currentSetupReady &&
      result.entry !== null && result.stop !== null && result.target2R !== null &&
      result.maximumEntry !== null && result.riskPerShare !== null) {
      this.frozen = {
        setup: result.setup === "NONE" ? "MICRO" : result.setup,
        entry: result.entry,
        stop: result.stop,
        target2R: result.target2R,
        maximumEntry: result.maximumEntry,
        risk: result.riskPerShare,
        resistance: result.nearestResistance,
        resistanceName: result.resistanceName,
        createdBucket: current.bucketStart,
        triggeredBucket: null,
        completedBucket: null,
      };
      this.state = "WATCH";

      if (current.l <= this.frozen.stop) {
        this.state = "IDLE";
        this.frozen = null;
      } else if (current.h >= this.frozen.entry && current.c <= this.frozen.maximumEntry) {
        this.state = "ACTIVE";
        this.frozen.triggeredBucket = current.bucketStart;
      }
    }

    if (this.frozen) {
      result.setup = this.frozen.setup;
      result.entry = this.frozen.entry;
      result.stop = this.frozen.stop;
      result.target2R = this.frozen.target2R;
      result.maximumEntry = this.frozen.maximumEntry;
      result.riskPerShare = this.frozen.risk;
      result.nearestResistance = this.frozen.resistance;
      result.resistanceName = this.frozen.resistanceName;
    }

    if (this.state === "WATCH") {
      result.status = "WATCH";
      result.headline = "Setup levels frozen — wait for the entry trigger";
      result.warnings.push("The proposed entry and structural stop are frozen. This is a chart plan, not an order.");
    } else if (this.state === "ACTIVE") {
      result.status = "TRIGGERED";
      result.headline = "Chart trigger crossed — simulated setup active";
      result.warnings.push("The chart trigger was touched. This does not confirm a broker order or fill.");
    } else if (this.state === "STOPPED") {
      result.status = "STOPPED";
      result.headline = "Structural stop level touched after the chart trigger";
      result.warnings.push("This is a chart-level simulation, not a broker-reported exit.");
    } else if (this.state === "2R_HIT") {
      result.status = "2R_HIT";
      result.headline = "The 2R chart level was reached";
      result.warnings.push("This is a simulated price-level event, not a broker-reported fill or realized profit.");
    }
    return result;
  }
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelProps } from "./registry";
import { useTheme } from "../ThemeProvider";
import type { Palette } from "../../render/palette";
import { evaluateRossMomentumCandidate, type CandidateEligibilityResult } from "../../strategy/candidateEligibility";
import type { MomentumScannerCandidate } from "../../data/ScannerStore";
import type { Bar, QueryCandidateHistoryResult } from "../../wire/contract";
import { MAX_CANDIDATE_MONITOR_SYMBOLS } from "../../wire/DemandRegistry";

const MAX_ANALYSIS_1M_BARS = 15_000;
const MAX_ANALYSIS_DAILY_BARS = 260;

interface RetainedCandidateRecord {
  symbol: string;
  retainedAt: string;
  lastSeenAt: string;
  snapshot: MomentumScannerCandidate;
}

interface EvaluatedCandidate {
  candidate: MomentumScannerCandidate;
  result: CandidateEligibilityResult;
  retained: RetainedCandidateRecord | null;
  currentlyDiscovered: boolean;
}

const RETAINED_CANDIDATES_SETTING = "rossRetainedCandidates";
const LIVE_MONITOR_SYMBOLS_SETTING = "rossLiveMonitorSymbols";
const MAX_RETAINED_CANDIDATES = 30;
const MOMENTUM_MODES = ["gainers", "most_active", "session_volume"] as const;
const SCANNER_SESSIONS = ["premarket", "rth", "afterhours", "overnight"] as const;

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isMomentumScannerCandidate(value: unknown): value is MomentumScannerCandidate {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.symbol === "string" && row.symbol.length > 0 && row.symbol.length <= 64 &&
    typeof row.shortSellRestricted === "boolean" &&
    isNullableNumber(row.changePct) && isNullableNumber(row.last) &&
    isNullableNumber(row.floatShares) && isNullableNumber(row.volume) &&
    isNullableNumber(row.sessionVolume) && isNullableNumber(row.turnover) &&
    isNullableNumber(row.relativeVolume) && isNullableNumber(row.shortInterest) &&
    (typeof row.shortInterestAsOf === "string" || row.shortInterestAsOf === null) &&
    typeof row.isUnseen === "boolean" && typeof row.isNewHit === "boolean" &&
    typeof row.muted === "boolean" &&
    Array.isArray(row.sourceModes) && row.sourceModes.every((mode) => MOMENTUM_MODES.includes(mode as typeof MOMENTUM_MODES[number])) &&
    Array.isArray(row.scannerIds) && row.scannerIds.every((id) => typeof id === "string" && id.length <= 256) &&
    typeof row.session === "string" && SCANNER_SESSIONS.includes(row.session as typeof SCANNER_SESSIONS[number]) &&
    (typeof row.refreshedAt === "string" || row.refreshedAt === null);
}

function readRetainedCandidates(value: unknown): RetainedCandidateRecord[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const records: RetainedCandidateRecord[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.symbol !== "string" || seen.has(record.symbol) ||
      typeof record.retainedAt !== "string" || typeof record.lastSeenAt !== "string" ||
      !isMomentumScannerCandidate(record.snapshot) || record.snapshot.symbol !== record.symbol) continue;
    seen.add(record.symbol);
    records.push({
      symbol: record.symbol,
      retainedAt: record.retainedAt,
      lastSeenAt: record.lastSeenAt,
      snapshot: record.snapshot,
    });
  }
  return records
    .sort((a, b) => Date.parse(b.retainedAt) - Date.parse(a.retainedAt))
    .slice(0, MAX_RETAINED_CANDIDATES);
}

function readLiveMonitorSymbols(value: unknown, retained: readonly RetainedCandidateRecord[]): string[] {
  if (!Array.isArray(value)) return [];
  const retainedSymbols = new Set(retained.map((item) => item.symbol));
  const unique = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length > 64 || !entry.startsWith("US.") ||
      !retainedSymbols.has(entry) || unique.has(entry)) continue;
    unique.add(entry);
    if (unique.size >= MAX_CANDIDATE_MONITOR_SYMBOLS) break;
  }
  return [...unique];
}

function mergeOneMinuteBars(archived: readonly Bar[], live: readonly Bar[], limit: number): Bar[] {
  const byBucket = new Map<string, Bar>();
  for (const bar of archived) byBucket.set(bar.bucketStart, bar);
  // Live BarStore values win over the historical archive when the same
  // minute is updated/finalized after monitoring is enabled.
  for (const bar of live) byBucket.set(bar.bucketStart, bar);
  return [...byBucket.values()]
    .sort((a, b) => a.bucketStart.localeCompare(b.bucketStart))
    .slice(-limit);
}

interface CandidateHistoryData {
  oneMinuteBars: Bar[];
  dailyBars: Bar[];
  error: string | null;
  loadedAtMs: number;
}

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function money(value: number | null): string {
  return value === null ? "—" : "$" + value.toFixed(value < 1 ? 4 : 2);
}

function shares(value: number | null): string {
  return value === null ? "—" : (value / 1_000_000).toFixed(2) + "M";
}

function statusColor(status: CandidateEligibilityResult["status"], palette: Palette): string {
  if (status === "ELIGIBLE") return palette.ok;
  if (status === "REJECTED") return palette.danger;
  return palette.accent;
}

function modeLabel(mode: MomentumScannerCandidate["sourceModes"][number]): string {
  if (mode === "gainers") return "Gainers";
  if (mode === "most_active") return "Most Active";
  return "Session Volume";
}

function checkColor(state: "pass" | "fail" | "unknown", palette: Palette): string {
  if (state === "pass") return palette.ok;
  if (state === "fail") return palette.danger;
  return palette.textMuted;
}


function chartOneMinuteCount(stores: PanelProps["stores"], symbol: string): string {
  return stores.bars.latestBar(symbol, "1m") ? "chart loaded" : "not loaded";
}

function chartDailyCount(stores: PanelProps["stores"], symbol: string): string {
  return stores.bars.latestBar(symbol, "D") ? "chart loaded" : "not loaded";
}

export function RossCandidatesPanel({ config, stores, commands, onConfigChange, demandRegistry }: PanelProps): JSX.Element {
  const { palette } = useTheme();
  const [revision, setRevision] = useState(1);
  const [historyBySymbol, setHistoryBySymbol] = useState<Record<string, CandidateHistoryData>>({});
  const [historyLoading, setHistoryLoading] = useState<Record<string, boolean>>({});
  const [retainedCandidates, setRetainedCandidates] = useState<RetainedCandidateRecord[]>(
    () => readRetainedCandidates(config.settings[RETAINED_CANDIDATES_SETTING]),
  );
  const [liveMonitorSymbols, setLiveMonitorSymbols] = useState<string[]>(
    () => readLiveMonitorSymbols(config.settings[LIVE_MONITOR_SYMBOLS_SETTING],
      readRetainedCandidates(config.settings[RETAINED_CANDIDATES_SETTING])),
  );
  const [monitorErrors, setMonitorErrors] = useState<Record<string, string>>({});
  const activeMonitorDemandIds = useRef(new Set<string>());

  const saveRetainedCandidates = useCallback((next: RetainedCandidateRecord[]) => {
    setRetainedCandidates(next);
    onConfigChange({ [RETAINED_CANDIDATES_SETTING]: next });
  }, [onConfigChange]);

  const saveLiveMonitorSymbols = useCallback((next: string[]) => {
    const normalized = readLiveMonitorSymbols(next, retainedCandidates);
    setLiveMonitorSymbols(normalized);
    onConfigChange({ [LIVE_MONITOR_SYMBOLS_SETTING]: normalized });
  }, [onConfigChange, retainedCandidates]);

  const startLiveMonitoring = useCallback((symbol: string) => {
    if (!demandRegistry) {
      setMonitorErrors((current) => ({ ...current, [symbol]: "Live monitoring is unavailable in this panel context." }));
      return;
    }
    if (!retainedCandidates.some((item) => item.symbol === symbol)) return;
    if (!symbol.startsWith("US.")) {
      setMonitorErrors((current) => ({ ...current, [symbol]: "Live one-minute monitoring currently supports US symbols only." }));
      return;
    }
    if (liveMonitorSymbols.includes(symbol)) return;
    if (liveMonitorSymbols.length >= MAX_CANDIDATE_MONITOR_SYMBOLS) {
      setMonitorErrors((current) => ({ ...current, [symbol]: `The live-monitor shortlist is limited to ${MAX_CANDIDATE_MONITOR_SYMBOLS} symbols.` }));
      return;
    }
    setMonitorErrors((current) => {
      const next = { ...current };
      delete next[symbol];
      return next;
    });
    saveLiveMonitorSymbols([...liveMonitorSymbols, symbol]);
  }, [demandRegistry, retainedCandidates, liveMonitorSymbols, saveLiveMonitorSymbols]);

  const stopLiveMonitoring = useCallback((symbol: string) => {
    saveLiveMonitorSymbols(liveMonitorSymbols.filter((item) => item !== symbol));
    setMonitorErrors((current) => {
      const next = { ...current };
      delete next[symbol];
      return next;
    });
  }, [liveMonitorSymbols, saveLiveMonitorSymbols]);

  const keepCandidate = useCallback((candidate: MomentumScannerCandidate) => {
    if (retainedCandidates.some((item) => item.symbol === candidate.symbol) ||
      retainedCandidates.length >= MAX_RETAINED_CANDIDATES) return;
    const now = new Date().toISOString();
    saveRetainedCandidates([{
      symbol: candidate.symbol,
      retainedAt: now,
      lastSeenAt: candidate.refreshedAt || now,
      snapshot: candidate,
    }, ...retainedCandidates]);
  }, [retainedCandidates, saveRetainedCandidates]);

  const removeRetainedCandidate = useCallback((symbol: string) => {
    if (!retainedCandidates.some((item) => item.symbol === symbol)) return;
    saveRetainedCandidates(retainedCandidates.filter((item) => item.symbol !== symbol));
    saveLiveMonitorSymbols(liveMonitorSymbols.filter((item) => item !== symbol));
  }, [retainedCandidates, liveMonitorSymbols, saveRetainedCandidates, saveLiveMonitorSymbols]);

  // Reconcile one demand per selected candidate. DemandRegistry keeps the
  // set reconnect-safe and releases every demand when this panel unmounts.
  useEffect(() => {
    if (!demandRegistry) return;
    const desired = new Map(liveMonitorSymbols.map((symbol) => [
      `ross-candidate:${config.id}:${symbol}`,
      symbol,
    ]));
    for (const demandId of [...activeMonitorDemandIds.current]) {
      if (desired.has(demandId)) continue;
      demandRegistry.release(demandId);
      activeMonitorDemandIds.current.delete(demandId);
    }
    for (const [demandId, symbol] of desired) {
      if (activeMonitorDemandIds.current.has(demandId)) continue;
      activeMonitorDemandIds.current.add(demandId);
      void demandRegistry.ensure(demandId, symbol, "candidate").then((ack) => {
        if (ack.status !== "accepted") {
          setMonitorErrors((current) => ({ ...current, [symbol]: ack.reason ?? "The engine rejected this live-monitor demand." }));
          return;
        }
        setMonitorErrors((current) => {
          const next = { ...current };
          delete next[symbol];
          return next;
        });
      }).catch((error: unknown) => {
        setMonitorErrors((current) => ({
          ...current,
          [symbol]: error instanceof Error ? error.message : "Live-monitor request failed.",
        }));
      });
    }
  }, [liveMonitorSymbols, config.id, demandRegistry]);

  useEffect(() => () => {
    if (!demandRegistry) return;
    for (const demandId of activeMonitorDemandIds.current) demandRegistry.release(demandId);
    activeMonitorDemandIds.current.clear();
  }, [demandRegistry]);

  // A retained candidate that is explicitly removed or automatically rejected
  // must not keep consuming a live-monitor slot.
  useEffect(() => {
    const retainedSymbols = new Set(retainedCandidates.map((item) => item.symbol));
    const next = liveMonitorSymbols.filter((symbol) => retainedSymbols.has(symbol));
    if (next.length !== liveMonitorSymbols.length) saveLiveMonitorSymbols(next);
  }, [retainedCandidates, liveMonitorSymbols, saveLiveMonitorSymbols]);

  // Scanner, quote, chart, fundamentals and news are independent stores.
  // Coalesce their updates so one burst only re-runs the candidate evaluator
  // once; a 30-second heartbeat also ages out stale one-minute data.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        setRevision((value) => value + 1);
      }, 250);
    };
    const off = [
      stores.scanner.subscribe(refresh),
      stores.quote.subscribe(refresh),
      stores.bars.subscribe(refresh),
      stores.stockDetail.subscribe(refresh),
      stores.news.subscribe(refresh),
    ];
    const heartbeat = setInterval(refresh, 30_000);
    return () => {
      off.forEach((unsubscribe) => unsubscribe());
      clearInterval(heartbeat);
      if (timer !== null) clearTimeout(timer);
    };
  }, [stores]);

  const loadArchivedHistory = async (symbol: string) => {
    if (historyLoading[symbol]) return;
    setHistoryLoading((current) => ({ ...current, [symbol]: true }));
    try {
      const raw = await commands.sendQuery("QueryCandidateHistory", { symbol });
      if (raw === null || typeof raw !== "object") throw new Error("The engine returned an invalid history response.");
      const response = raw as QueryCandidateHistoryResult;
      if (response.symbol !== symbol || !Array.isArray(response.oneMinuteBars) || !Array.isArray(response.dailyBars)) {
        throw new Error("The engine returned an incomplete history response.");
      }
      setHistoryBySymbol((current) => ({
        ...current,
        [symbol]: {
          oneMinuteBars: response.oneMinuteBars,
          dailyBars: response.dailyBars,
          error: response.error || null,
          loadedAtMs: Date.now(),
        },
      }));
    } catch (error) {
      setHistoryBySymbol((current) => ({
        ...current,
        [symbol]: {
          oneMinuteBars: current[symbol]?.oneMinuteBars ?? [],
          dailyBars: current[symbol]?.dailyBars ?? [],
          error: error instanceof Error ? error.message : "History query failed.",
          loadedAtMs: current[symbol]?.loadedAtMs ?? 0,
        },
      }));
    } finally {
      setHistoryLoading((current) => ({ ...current, [symbol]: false }));
    }
  };

  const evaluated = useMemo<EvaluatedCandidate[]>(() => {
    const asOfMs = Date.now();
    const liveCandidates = stores.scanner.momentumCandidates();
    const liveBySymbol = new Map(liveCandidates.map((candidate) => [candidate.symbol, candidate]));
    const retainedBySymbol = new Map(retainedCandidates.map((item) => [item.symbol, item]));
    const symbols = new Set([...liveBySymbol.keys(), ...retainedBySymbol.keys()]);

    return [...symbols].sort((a, b) => a.localeCompare(b)).map((symbol) => {
      const liveCandidate = liveBySymbol.get(symbol);
      const retained = retainedBySymbol.get(symbol) ?? null;
      const candidate = liveCandidate ?? retained!.snapshot;
      const currentlyDiscovered = liveCandidate !== undefined;
      const detail = stores.stockDetail.detailFor(symbol);
      const quote = stores.quote.get(symbol);
      const price = positive(quote?.last) ?? positive(candidate.last) ?? positive(detail?.price);
      const floatShares = positive(detail?.floatShares) ?? positive(candidate.floatShares);

      const latest1m = stores.bars.latestBar(symbol, "1m");
      const latestDaily = stores.bars.latestBar(symbol, "D");
      const chartOneMinuteBars = latest1m
        ? stores.bars.tailSeries(symbol, "1m", MAX_ANALYSIS_1M_BARS)
        : [];
      const chartDailyBars = latestDaily
        ? stores.bars.tailSeries(symbol, "D", MAX_ANALYSIS_DAILY_BARS)
        : [];
      const archived = historyBySymbol[symbol];
      const oneMinuteBars = archived?.oneMinuteBars.length
        ? archived.oneMinuteBars
        : chartOneMinuteBars;
      const dailyBars = archived?.dailyBars.length
        ? archived.dailyBars
        : chartDailyBars;
      const hasNewsCatalyst = stores.news.itemsFor(symbol).some(
        (item) => item.catalyst_score >= 50 && item.catalyst_category !== "other",
      );

      const result = evaluateRossMomentumCandidate({
        symbol,
        price,
        float: floatShares === null
          ? null
          : { shares: floatShares, source: "moomoo_outstanding_shares" },
        oneMinuteBars,
        asOfMs,
        dailyBars,
        // The source material does not define a numeric proximity threshold.
        // Keep this unknown until a defensible resistance assessment exists.
        dailyChart: { nearbyResistance: null },
        // No qualifying headline is not proof that no catalyst exists; a
        // technical-breakout detector has not yet been integrated.
        catalyst: hasNewsCatalyst ? "fundamental" : "unknown",
      });
      return { candidate, result, retained, currentlyDiscovered };
    });
  }, [revision, stores, historyBySymbol, retainedCandidates]);

  // An ELIGIBLE candidate is retained automatically. A previously retained
  // candidate survives temporary PENDING states (for example stale or missing
  // data), but is removed once a current scanner observation proves it REJECTED.
  // Last-seen row details are persisted with the panel settings so a candidate
  // remains visible after leaving all discovery boards and across app restarts.
  useEffect(() => {
    const nextBySymbol = new Map(retainedCandidates.map((item) => [item.symbol, item]));
    let changed = false;
    for (const item of evaluated) {
      const existing = nextBySymbol.get(item.candidate.symbol);
      if (existing) {
        if (item.currentlyDiscovered && item.result.status === "REJECTED") {
          nextBySymbol.delete(item.candidate.symbol);
          changed = true;
          continue;
        }
        if (item.currentlyDiscovered) {
          const lastSeenAt = item.candidate.refreshedAt || existing.lastSeenAt;
          if (lastSeenAt !== existing.lastSeenAt || JSON.stringify(existing.snapshot) !== JSON.stringify(item.candidate)) {
            nextBySymbol.set(item.candidate.symbol, { ...existing, lastSeenAt, snapshot: item.candidate });
            changed = true;
          }
        }
      } else if (item.result.status === "ELIGIBLE" && nextBySymbol.size < MAX_RETAINED_CANDIDATES) {
        const now = new Date().toISOString();
        nextBySymbol.set(item.candidate.symbol, {
          symbol: item.candidate.symbol,
          retainedAt: now,
          lastSeenAt: item.candidate.refreshedAt || now,
          snapshot: item.candidate,
        });
        changed = true;
      }
    }
    if (changed) {
      const next = [...nextBySymbol.values()].sort((a, b) => Date.parse(b.retainedAt) - Date.parse(a.retainedAt));
      saveRetainedCandidates(next);
    }
  }, [evaluated, retainedCandidates, saveRetainedCandidates]);

  const counts = useMemo(() => ({
    eligible: evaluated.filter((item) => item.result.status === "ELIGIBLE").length,
    pending: evaluated.filter((item) => item.result.status === "PENDING").length,
    rejected: evaluated.filter((item) => item.result.status === "REJECTED").length,
  }), [evaluated]);

  return (
    <div style={{ height: "100%", minHeight: 0, overflow: "auto", background: palette.bg, color: palette.text, fontSize: 12 }}>
      <div style={{ padding: "9px 10px", borderBottom: "1px solid " + palette.borderStrong }}>
        <div style={{ fontWeight: 700, letterSpacing: ".04em" }}>ROSS MOMENTUM CANDIDATES</div>
        <div style={{ color: palette.textMuted, marginTop: 4, fontSize: 10 }}>
          Combined discovery from active Gainers, Most Active and Session Volume Scanner panels
          <span style={{ marginLeft: 8, color: palette.text }}>· {retainedCandidates.length} retained</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 1, marginTop: 8, background: palette.border }}>
          {[
            { label: "TOTAL", value: evaluated.length, color: palette.text },
            { label: "ELIGIBLE", value: counts.eligible, color: palette.ok },
            { label: "PENDING", value: counts.pending, color: palette.accent },
            { label: "REJECTED", value: counts.rejected, color: palette.danger },
          ].map((item) => (
            <div key={item.label} style={{ background: palette.surface, padding: "6px 7px", minWidth: 0 }}>
              <div style={{ color: palette.textMuted, fontSize: 9, letterSpacing: ".05em" }}>{item.label}</div>
              <div className="mono" style={{ color: item.color, marginTop: 3, fontSize: 14, fontWeight: 700 }}>{item.value}</div>
            </div>
          ))}
        </div>
      </div>

      {evaluated.length === 0 ? (
        <div style={{ padding: 12, color: palette.textMuted, lineHeight: 1.5 }}>
          No candidates are available. Add or reactivate Scanner panels using Gainers, Most Active or Session Volume.
        </div>
      ) : (
        <div style={{ padding: "4px 8px 8px" }}>
          {evaluated.map(({ candidate, result, retained, currentlyDiscovered }) => (
            <details key={candidate.symbol} style={{ borderBottom: "1px solid " + palette.border }}>
              <summary style={{ display: "grid", gridTemplateColumns: "minmax(70px, 1fr) minmax(50px, auto) minmax(50px, auto) auto", alignItems: "center", gap: 8, padding: "9px 3px", cursor: "pointer", listStylePosition: "inside" }}>
                <span className="mono" style={{ fontWeight: 700, minWidth: 0 }}>{candidate.symbol}</span>
                <span className="mono" style={{ color: palette.textMuted, textAlign: "right" }}>
                  {money(result.metrics.price)}
                </span>
                <span className="mono" style={{ color: palette.textMuted, textAlign: "right" }}>
                  {result.metrics.sameTimeRelativeVolume === null ? "RVOL —" : result.metrics.sameTimeRelativeVolume.toFixed(2) + "x"}
                </span>
                <span className="mono" style={{ color: statusColor(result.status, palette), fontSize: 10, fontWeight: 700 }}>
                  {result.status}
                </span>
              </summary>
              <div style={{ padding: "0 4px 9px 18px" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 7 }}>
                  {candidate.sourceModes.map((mode) => (
                    <span key={mode} style={{ border: "1px solid " + palette.border, color: palette.textMuted, padding: "2px 5px", fontSize: 9 }}>
                      {modeLabel(mode)}
                    </span>
                  ))}
                  <span style={{ border: "1px solid " + (retained ? palette.ok : palette.border), color: retained ? palette.ok : palette.textMuted, padding: "2px 5px", fontSize: 9 }}>
                    {retained ? "RETAINED" : "DISCOVERY"}
                  </span>
                  {!currentlyDiscovered && (
                    <span style={{ color: palette.accent, padding: "2px 0", fontSize: 9 }}>
                      NOT IN CURRENT SCANNERS
                    </span>
                  )}
                </div>
                {retained && !currentlyDiscovered && (
                  <div style={{ color: palette.textMuted, fontSize: 9, marginBottom: 7 }}>
                    Last seen in a discovery scanner: {new Date(retained.lastSeenAt).toLocaleString()}
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginBottom: 8 }}>
                  <div><div style={{ color: palette.textMuted, fontSize: 9 }}>Moomoo OS proxy</div><div className="mono">{shares(result.metrics.floatShares)}</div></div>
                  <div><div style={{ color: palette.textMuted, fontSize: 9 }}>1m candles</div><div className="mono">{historyBySymbol[candidate.symbol]?.oneMinuteBars.length ?? chartOneMinuteCount(stores, candidate.symbol)}</div></div>
                  <div><div style={{ color: palette.textMuted, fontSize: 9 }}>Daily candles</div><div className="mono">{historyBySymbol[candidate.symbol]?.dailyBars.length ?? chartDailyCount(stores, candidate.symbol)}</div></div>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                  <button
                    type="button"
                    disabled={historyLoading[candidate.symbol] === true}
                    onClick={() => void loadArchivedHistory(candidate.symbol)}
                    style={{ border: "1px solid " + palette.borderStrong, background: palette.surface, color: palette.text, padding: "5px 8px", fontSize: 10, cursor: historyLoading[candidate.symbol] ? "wait" : "pointer", opacity: historyLoading[candidate.symbol] ? 0.6 : 1 }}
                  >
                    {historyLoading[candidate.symbol] ? "Loading archived bars…" : historyBySymbol[candidate.symbol] ? "Refresh archived bars" : "Load archived bars"}
                  </button>
                  {retained ? (
                    <button
                      type="button"
                      onClick={() => removeRetainedCandidate(candidate.symbol)}
                      style={{ border: "1px solid " + palette.borderStrong, background: palette.surface, color: palette.textMuted, padding: "5px 8px", fontSize: 10, cursor: "pointer" }}
                    >
                      Remove from shortlist
                    </button>
                  ) : result.status !== "REJECTED" ? (
                    <button
                      type="button"
                      disabled={retainedCandidates.length >= MAX_RETAINED_CANDIDATES}
                      onClick={() => keepCandidate(candidate)}
                      title={retainedCandidates.length >= MAX_RETAINED_CANDIDATES ? "The shortlist is full. Remove a retained symbol first." : "Keep this candidate when it leaves the discovery scanners."}
                      style={{ border: "1px solid " + palette.borderStrong, background: palette.surface, color: palette.text, padding: "5px 8px", fontSize: 10, cursor: retainedCandidates.length >= MAX_RETAINED_CANDIDATES ? "not-allowed" : "pointer", opacity: retainedCandidates.length >= MAX_RETAINED_CANDIDATES ? 0.5 : 1 }}
                    >
                      Keep on shortlist
                    </button>
                  ) : null}
                </div>
                {historyBySymbol[candidate.symbol]?.error && (
                  <div style={{ color: palette.accent, fontSize: 10, lineHeight: 1.4, marginBottom: 7 }}>
                    Archive notice: {historyBySymbol[candidate.symbol]!.error}
                  </div>
                )}
                <div style={{ color: palette.textMuted, fontSize: 9, letterSpacing: ".05em", marginBottom: 3 }}>ELIGIBILITY CHECKS</div>
                {result.checks.map((check) => (
                  <div key={check.id} style={{ display: "grid", gridTemplateColumns: "minmax(110px, .7fr) minmax(0, 1.5fr) auto", gap: 7, padding: "4px 0", borderTop: "1px solid " + palette.border, alignItems: "start" }}>
                    <span>{check.label}</span>
                    <span style={{ color: palette.textMuted, lineHeight: 1.35 }}>{check.detail}</span>
                    <span className="mono" style={{ color: checkColor(check.state, palette), fontSize: 9, fontWeight: 700 }}>
                      {check.state.toUpperCase()}
                    </span>
                  </div>
                ))}
                {result.warnings.map((warning, index) => (
                  <div key={index} style={{ color: palette.accent, fontSize: 10, lineHeight: 1.4, marginTop: 6 }}>{warning}</div>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}

      <div style={{ padding: "8px 10px", borderTop: "1px solid " + palette.borderStrong, color: palette.textMuted, fontSize: 10, lineHeight: 1.45 }}>
        Candidates can be kept manually on this panel's persistent shortlist; fully ELIGIBLE candidates are retained automatically. Retained candidates remain through PENDING data states and are removed automatically only when a current scanner observation proves REJECTED. This is retention, not yet continuous live monitoring: fresh one-minute subscriptions are a separate next stage. Moomoo OutstandingShares remains an unverified proxy, and nearby resistance and technical-breakout detection are not connected. This panel is informational and never places orders.
      </div>
    </div>
  );
}

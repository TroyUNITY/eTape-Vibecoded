import { useEffect, useMemo, useState } from "react";
import type { PanelProps } from "./registry";
import { useTheme } from "../ThemeProvider";
import type { Palette } from "../../render/palette";
import { evaluateRossMomentumCandidate, type CandidateEligibilityResult } from "../../strategy/candidateEligibility";
import type { MomentumScannerCandidate } from "../../data/ScannerStore";

const MAX_ANALYSIS_1M_BARS = 12_000;
const MAX_ANALYSIS_DAILY_BARS = 260;

interface EvaluatedCandidate {
  candidate: MomentumScannerCandidate;
  result: CandidateEligibilityResult;
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

export function RossCandidatesPanel({ stores }: PanelProps): JSX.Element {
  const { palette } = useTheme();
  const [revision, setRevision] = useState(0);

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
    setRevision((value) => value + 1);
    return () => {
      off.forEach((unsubscribe) => unsubscribe());
      clearInterval(heartbeat);
      if (timer !== null) clearTimeout(timer);
    };
  }, [stores]);

  const evaluated = useMemo<EvaluatedCandidate[]>(() => {
    const asOfMs = Date.now();
    return stores.scanner.momentumCandidates().map((candidate) => {
      const symbol = candidate.symbol;
      const detail = stores.stockDetail.detailFor(symbol);
      const quote = stores.quote.get(symbol);
      const price = positive(quote?.last) ?? positive(candidate.last) ?? positive(detail?.price);
      const floatShares = positive(detail?.floatShares) ?? positive(candidate.floatShares);

      const latest1m = stores.bars.latestBar(symbol, "1m");
      const latestDaily = stores.bars.latestBar(symbol, "D");
      const oneMinuteBars = latest1m
        ? stores.bars.tailSeries(symbol, "1m", MAX_ANALYSIS_1M_BARS)
        : [];
      const dailyBars = latestDaily
        ? stores.bars.tailSeries(symbol, "D", MAX_ANALYSIS_DAILY_BARS)
        : [];
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
      return { candidate, result };
    });
  }, [revision, stores]);

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
          {evaluated.map(({ candidate, result }) => (
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
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginBottom: 8 }}>
                  <div><div style={{ color: palette.textMuted, fontSize: 9 }}>Moomoo OS proxy</div><div className="mono">{shares(result.metrics.floatShares)}</div></div>
                  <div><div style={{ color: palette.textMuted, fontSize: 9 }}>1m candles</div><div className="mono">{stores.bars.latestBar(candidate.symbol, "1m") ? "loaded" : "not loaded"}</div></div>
                  <div><div style={{ color: palette.textMuted, fontSize: 9 }}>Daily candles</div><div className="mono">{stores.bars.latestBar(candidate.symbol, "D") ? "loaded" : "not loaded"}</div></div>
                </div>
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
        Moomoo OutstandingShares remains an unverified proxy, so it cannot pass the free-float check. Scanner archive warming does not yet populate the UI chart store for every candidate; missing one-minute or daily candles stay PENDING. Nearby resistance and technical-breakout detection are also not connected yet. This panel is informational and never places orders.
      </div>
    </div>
  );
}

import { useMemo, useRef, useSyncExternalStore } from "react";
import type { PanelProps } from "./registry";
import { useTheme } from "../ThemeProvider";
import type { Palette } from "../../render/palette";
import { TradeGuardTracker, type GuardCheck, type GuardStatus } from "../../strategy/tradeGuard";

function statusColor(status: GuardStatus, palette: Palette): string {
  if (status === "WATCH" || status === "TRIGGERED" || status === "2R_HIT") return palette.ok;
  if (status === "BLOCKED" || status === "FILTERED" || status === "STOPPED") return palette.danger;
  if (status === "DATA_UNCERTAIN") return palette.accent;
  return palette.textMuted;
}
function money(value: number | null): string {
  if (value === null) return "—";
  return "$" + value.toFixed(value < 1 ? 4 : 2);
}
function numberText(value: number | null, suffix = "", digits = 2): string {
  return value === null ? "—" : value.toFixed(digits) + suffix;
}
function CheckRow({ item, palette }: { item: GuardCheck; palette: Palette }): JSX.Element {
  const color = item.state === "pass" ? palette.ok
    : item.state === "fail" ? palette.danger
      : palette.textMuted;
  const label = item.state === "pass" ? "PASS" : item.state === "fail" ? "FAIL" : "UNKNOWN";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(112px, 1fr) auto", gap: 8, padding: "5px 8px", borderBottom: "1px solid " + palette.border }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ color: palette.text, fontSize: 11 }}>{item.label}</div>
        <div style={{ color: palette.textMuted, fontSize: 10, marginTop: 2, lineHeight: 1.35 }}>{item.detail}</div>
      </div>
      <div className="mono" style={{ color, fontSize: 10, alignSelf: "center", fontWeight: 700 }}>{label}</div>
    </div>
  );
}

export function TradeGuardPanel({ config, stores, linkGroups, group: groupProp, symbol: symbolProp }: PanelProps): JSX.Element {
  const { palette } = useTheme();
  const group = groupProp ?? config.group;
  const symbol = symbolProp ?? linkGroups.symbolFor(group) ??
    (typeof config.settings.symbol === "string" ? config.settings.symbol : "");

  const trackerRef = useRef(new TradeGuardTracker());
  const barsRev = useSyncExternalStore(
    (cb) => stores.bars.subscribe(cb),
    () => stores.bars.getRev(symbol, "1m"),
  );
  const dailyRev = useSyncExternalStore(
    (cb) => stores.bars.subscribe(cb),
    () => stores.bars.getRev(symbol, "D"),
  );
  const detailSnapshot = useSyncExternalStore(
    (cb) => stores.stockDetail.subscribe(cb),
    () => stores.stockDetail.getSnapshot(),
  );
  const quoteRev = useSyncExternalStore(
    (cb) => stores.quote.subscribe(cb),
    () => stores.quote.getRev(),
  );
  const scannerSnapshot = useSyncExternalStore(
    (cb) => stores.scanner.subscribe(cb),
    () => stores.scanner.getSnapshot(),
  );
  const newsSnapshot = useSyncExternalStore(
    (cb) => stores.news.subscribe(cb),
    () => stores.news.getSnapshot(),
  );

  const result = useMemo(() => {
    if (!symbol) return null;
    const scannerRows = Object.values(scannerSnapshot.sessions)
      .flatMap((view) => view.rows
        .filter((row) => row.symbol === symbol)
        .map((row) => ({ row, refreshedAt: view.refreshedAt })))
      .sort((a, b) => Date.parse(b.refreshedAt ?? "") - Date.parse(a.refreshedAt ?? ""));
    return trackerRef.current.evaluate({
      bars: stores.bars.allSeries(symbol, "1m"),
      dailyBars: stores.bars.allSeries(symbol, "D"),
      detail: stores.stockDetail.detailFor(symbol),
      scannerRow: scannerRows[0]?.row,
      lastPrice: stores.quote.get(symbol)?.last,
    });
  }, [symbol, barsRev, dailyRev, detailSnapshot, quoteRev, scannerSnapshot, stores]);

  const catalyst = useMemo(() => {
    if (!symbol) return undefined;
    return stores.news.itemsFor(symbol).find((item) => item.catalyst_score >= 50 && item.catalyst_category !== "other");
  }, [newsSnapshot, symbol, stores]);

  if (!symbol) {
    return (
      <div style={{ height: "100%", padding: 12, background: palette.bg, color: palette.textMuted, fontSize: 12 }}>
        No symbol focused. Link Trade Guard to a chart or another symbol-bearing panel.
      </div>
    );
  }
  if (!result) return <div style={{ padding: 12, color: palette.textMuted }}>Waiting for Trade Guard.</div>;

  const stateColor = statusColor(result.status, palette);
  const metrics = result.metrics;
  const levels = [
    { label: "Entry trigger", value: result.entry },
    { label: "Structural stop", value: result.stop },
    { label: "2R target", value: result.target2R },
    { label: "Maximum entry", value: result.maximumEntry },
    { label: "Nearest resistance", value: result.nearestResistance },
  ];
  const setupLabel = result.setup === "MICRO" ? "MICRO PULLBACK"
    : result.setup === "CURL" ? "CURL / HIGHER-LOW BASE" : "NO SETUP";
  const priceDetails = [
    { label: "LAST", value: money(metrics.price) },
    { label: "DAY CHANGE", value: numberText(metrics.dayChangePct, "%", 1) },
    { label: "FLOAT", value: metrics.floatShares === null ? "—" : numberText(metrics.floatShares / 1_000_000, "M", 2) },
    { label: "SAME-TIME RVOL", value: numberText(metrics.relativeVolume, "x", 1) },
    { label: "SESSION VOLUME", value: Math.round(metrics.sessionVolume).toLocaleString("en-US") },
    { label: "ATR(14)", value: money(metrics.atr14) },
  ];

  return (
    <div style={{ height: "100%", overflow: "auto", background: palette.bg, color: palette.text, fontSize: 12 }}>
      <div style={{ padding: "8px 10px", borderBottom: "1px solid " + palette.borderStrong }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div style={{ fontWeight: 700, letterSpacing: ".06em" }}>TRADE GUARD · {symbol}</div>
          <span className="mono" style={{ color: stateColor, border: "1px solid " + stateColor, padding: "2px 5px", fontSize: 10, fontWeight: 700 }}>
            {result.status}
          </span>
        </div>
        <div style={{ color: palette.textMuted, marginTop: 5, fontSize: 11 }}>{result.headline}</div>
        <div style={{ color: palette.accent, marginTop: 5, fontWeight: 700 }}>{setupLabel}</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 1, background: palette.border, borderBottom: "1px solid " + palette.border }}>
        {priceDetails.map((item) => (
          <div key={item.label} style={{ background: palette.surface, padding: "7px 8px", minWidth: 0 }}>
            <div style={{ color: palette.textMuted, fontSize: 9, letterSpacing: ".04em" }}>{item.label}</div>
            <div className="mono" style={{ color: palette.text, marginTop: 3, fontSize: 11 }}>{item.value}</div>
          </div>
        ))}
      </div>

      <div style={{ padding: "7px 8px 4px", color: palette.textMuted, fontSize: 10, letterSpacing: ".05em" }}>PROPOSED LEVELS · NOT ORDERS</div>
      {levels.map((level) => (
        <div key={level.label} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "4px 8px" }}>
          <span style={{ color: palette.textMuted }}>{level.label}</span>
          <span className="mono" style={{ color: level.value === null ? palette.textMuted : palette.text, fontWeight: level.label === "Entry trigger" ? 700 : 400 }}>
            {money(level.value)}
          </span>
        </div>
      ))}
      {result.riskPerShare !== null && (
        <div style={{ padding: "2px 8px 7px", color: palette.textMuted, fontSize: 10 }}>
          Structural risk: {money(result.riskPerShare)} per share · planned 2R
        </div>
      )}

      <div style={{ padding: "7px 8px 4px", borderTop: "1px solid " + palette.borderStrong, color: palette.textMuted, fontSize: 10, letterSpacing: ".05em" }}>
        ELIGIBILITY & SETUP CHECKS
      </div>
      {result.checks.map((item) => <CheckRow key={item.id} item={item} palette={palette} />)}

      {result.reasons.length > 0 && (
        <>
          <div style={{ padding: "8px 8px 4px", color: palette.danger, fontSize: 10, fontWeight: 700, letterSpacing: ".05em" }}>WHY IT IS NOT CLEAR</div>
          {result.reasons.map((reason, index) => (
            <div key={index} style={{ padding: "3px 8px", color: palette.text, fontSize: 11, lineHeight: 1.4 }}>• {reason}</div>
          ))}
        </>
      )}
      {result.warnings.length > 0 && (
        <>
          <div style={{ padding: "8px 8px 4px", color: palette.accent, fontSize: 10, fontWeight: 700, letterSpacing: ".05em" }}>WARNINGS & CONTEXT</div>
          {result.warnings.map((warning, index) => (
            <div key={index} style={{ padding: "3px 8px", color: palette.textMuted, fontSize: 11, lineHeight: 1.4 }}>• {warning}</div>
          ))}
        </>
      )}
      <div style={{ padding: "8px", borderTop: "1px solid " + palette.borderStrong, color: palette.textMuted, fontSize: 10, lineHeight: 1.4 }}>
        {catalyst
          ? "Catalyst context: " + catalyst.headline
          : "No high-scoring catalyst headline is available. Quantin's Pine script does not use news as a hard gate."}
        <br />
        Same-time RVOL requires 10 prior sessions in the stored one-minute history. Scanner daily RVOL is shown separately and is not substituted.
        <br />
        A trigger, stop or 2R event is calculated from chart prices only. Trade Guard never sends orders or represents broker fills.
      </div>
    </div>
  );
}

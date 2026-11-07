import { useEffect, useMemo, useRef, useState } from "react";
import type { PanelProps } from "./registry";
import { useTheme } from "../ThemeProvider";
import type { Palette } from "../../render/palette";
import { TradeGuardTracker, type GuardCheck, type GuardStatus } from "../../strategy/tradeGuard";

const ANALYSIS_COALESCE_MS = 5_000;
const MAX_ANALYSIS_1M_BARS = 12_000;
const MAX_ANALYSIS_DAILY_BARS = 260;

function statusColor(status: GuardStatus, palette: Palette): string {
  if (status === "WATCH" || status === "TRIGGERED" || status === "2R_HIT") return palette.ok;
  if (status === "BLOCKED" || status === "FILTERED" || status === "STOPPED") return palette.danger;
  if (status === "DATA_UNCERTAIN" || status === "DATA_INCOMPLETE") return palette.accent;
  return palette.textMuted;
}
function money(value: number | null): string {
  if (value === null) return "—";
  return "$" + value.toFixed(value < 1 ? 4 : 2);
}
function numberText(value: number | null, suffix = "", digits = 2): string {
  return value === null ? "—" : value.toFixed(digits) + suffix;
}
function catalystFor(stores: PanelProps["stores"], symbol: string) {
  return stores.news.itemsFor(symbol).find((item) => item.catalyst_score >= 50 && item.catalyst_category !== "other");
}
function catalystKey(stores: PanelProps["stores"], symbol: string): string {
  const item = catalystFor(stores, symbol);
  return item ? [item.id, item.headline, item.published_at, item.catalyst_score].join("|") : "";
}

// Coalesce bursts of selected-symbol data updates. Global store notifications
// are filtered by comparing the selected symbol's revision/object reference.
// A continuous stream can trigger at most one full strategy evaluation every
// two seconds; unrelated-symbol ticks do not schedule any Trade Guard work.
function useTradeGuardRevision(stores: PanelProps["stores"], symbol: string): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!symbol) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastOneMinuteRev = stores.bars.getRev(symbol, "1m");
    let lastDailyRev = stores.bars.getRev(symbol, "D");
    let lastQuote = stores.quote.get(symbol);
    let lastDetail = stores.stockDetail.detailFor(symbol);
    let lastScannerRow = stores.scanner.rowForSymbol(symbol);
    let lastCatalyst = catalystKey(stores, symbol);

    const schedule = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        setRevision((value) => value + 1);
      }, ANALYSIS_COALESCE_MS);
    };
    const onBars = () => {
      const oneMinuteRev = stores.bars.getRev(symbol, "1m");
      const dailyRev = stores.bars.getRev(symbol, "D");
      if (oneMinuteRev !== lastOneMinuteRev || dailyRev !== lastDailyRev) {
        lastOneMinuteRev = oneMinuteRev;
        lastDailyRev = dailyRev;
        schedule();
      }
    };
    const onQuote = () => {
      const quote = stores.quote.get(symbol);
      if (quote !== lastQuote) { lastQuote = quote; schedule(); }
    };
    const onDetail = () => {
      const detail = stores.stockDetail.detailFor(symbol);
      if (detail !== lastDetail) { lastDetail = detail; schedule(); }
    };
    const onScanner = () => {
      const row = stores.scanner.rowForSymbol(symbol);
      if (row !== lastScannerRow) { lastScannerRow = row; schedule(); }
    };
    const onNews = () => {
      const key = catalystKey(stores, symbol);
      if (key !== lastCatalyst) { lastCatalyst = key; schedule(); }
    };

    const offBars = stores.bars.subscribe(onBars);
    const offQuotes = stores.quote.subscribe(onQuote);
    const offDetails = stores.stockDetail.subscribe(onDetail);
    const offScanner = stores.scanner.subscribe(onScanner);
    const offNews = stores.news.subscribe(onNews);

    // Refresh immediately on mount or symbol switch; subsequent bursts are throttled.
    setRevision((value) => value + 1);

    return () => {
      offBars();
      offQuotes();
      offDetails();
      offScanner();
      offNews();
      if (timer !== null) clearTimeout(timer);
    };
  }, [stores, symbol]);
  return revision;
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
  const refreshRevision = useTradeGuardRevision(stores, symbol);

  const result = useMemo(() => {
    if (!symbol) return null;
    const detail = stores.stockDetail.detailFor(symbol);
    const scannerRow = stores.scanner.rowForSymbol(symbol);
    const lastPrice = stores.quote.get(symbol)?.last;
    return trackerRef.current.evaluate({
      bars: stores.bars.tailSeries(symbol, "1m", MAX_ANALYSIS_1M_BARS),
      dailyBars: stores.bars.tailSeries(symbol, "D", MAX_ANALYSIS_DAILY_BARS),
      ...(detail ? { detail } : {}),
      ...(scannerRow ? { scannerRow } : {}),
      ...(lastPrice !== undefined ? { lastPrice } : {}),
    });
  }, [symbol, refreshRevision, stores]);

  const catalyst = useMemo(() => symbol ? catalystFor(stores, symbol) : undefined,
    [symbol, refreshRevision, stores]);

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
        Trade Guard coalesces selected-symbol updates and recalculates at most once every five seconds during active updates. Analysis uses a bounded 12,000-bar one-minute history.
        <br />
        A trigger, stop or 2R event is calculated from chart prices only. Trade Guard never sends orders or represents broker fills.
      </div>
    </div>
  );
}

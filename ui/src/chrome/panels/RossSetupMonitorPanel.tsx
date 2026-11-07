import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { PanelProps } from "./registry";
import { useTheme } from "../ThemeProvider";
import { formatPrice, quoteDecimals } from "../../render/format";
import { formatCompactShares } from "../format";
import { MAX_STRATEGY_MONITOR_SYMBOLS } from "../../wire/DemandRegistry";

const WATCHED_SYMBOLS_SETTING = "rossSetupMonitorSymbols";
const FRESH_QUOTE_MS = 15_000;

type MonitorDemandState = "requesting" | "accepted" | "blocked" | "error";

function normalizeUsTicker(value: string): string | null {
  const raw = value.trim().toUpperCase();
  if (!raw || /^(HK|SH|SZ)\./.test(raw)) return null;
  const ticker = raw.startsWith("US.") ? raw.slice(3) : raw;
  // Accept ordinary US ticker symbols, including dotted/dashed share classes.
  if (!/^(?=.{1,15}$)[A-Z0-9]+(?:[.-][A-Z0-9]+)*$/.test(ticker)) return null;
  return "US." + ticker;
}

function readWatchedSymbols(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const symbol = normalizeUsTicker(entry);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
    if (symbols.length >= MAX_STRATEGY_MONITOR_SYMBOLS) break;
  }
  return symbols;
}

function ageMs(timestamp: string | undefined, now: number): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || parsed > now) return null;
  return now - parsed;
}

function ageLabel(value: number | null): string {
  if (value === null) return "time unavailable";
  if (value < 1_000) return "just now";
  return Math.floor(value / 1_000) + "s ago";
}

function bareSymbol(symbol: string): string {
  return symbol.startsWith("US.") ? symbol.slice(3) : symbol;
}

function demandId(panelId: string, symbol: string): string {
  return "ross-setup-monitor:" + panelId + ":" + symbol;
}

export function RossSetupMonitorPanel({ config, stores, onConfigChange, demandRegistry }: PanelProps): JSX.Element {
  const { palette } = useTheme();
  const [symbols, setSymbols] = useState<string[]>(
    () => readWatchedSymbols(
      config.settings[WATCHED_SYMBOLS_SETTING] ?? config.settings.rossLiveMonitorSymbols,
    ),
  );
  const [addValue, setAddValue] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [demandStates, setDemandStates] = useState<Record<string, { state: MonitorDemandState; detail: string | null }>>({});
  const [now, setNow] = useState(() => Date.now());
  const activeDemandIds = useRef(new Set<string>());

  const saveSymbols = useCallback((next: string[]) => {
    const normalized = readWatchedSymbols(next);
    setSymbols(normalized);
    onConfigChange({ [WATCHED_SYMBOLS_SETTING]: normalized });
  }, [onConfigChange]);

  const requestMonitoring = useCallback((symbol: string) => {
    if (!demandRegistry) {
      setDemandStates((current) => ({
        ...current,
        [symbol]: { state: "error", detail: "Live market-data monitoring is unavailable in this panel context." },
      }));
      return;
    }

    const id = demandId(config.id, symbol);
    activeDemandIds.current.add(id);
    setDemandStates((current) => ({
      ...current,
      [symbol]: { state: "requesting", detail: null },
    }));

    void demandRegistry.ensure(id, symbol, "strategy").then((ack) => {
      if (!activeDemandIds.current.has(id)) return;
      if (ack.status === "accepted") {
        // EnsureSymbol acknowledges the engine demand, not the provider's
        // asynchronous Qot_Sub admission. Actual feed arrival is shown below.
        setDemandStates((current) => ({
          ...current,
          [symbol]: { state: "accepted", detail: null },
        }));
      } else {
        setDemandStates((current) => ({
          ...current,
          [symbol]: { state: "blocked", detail: ack.reason ?? "The market-data demand was not accepted." },
        }));
      }
    }).catch((error: unknown) => {
      if (!activeDemandIds.current.has(id)) return;
      setDemandStates((current) => ({
        ...current,
        [symbol]: {
          state: "error",
          detail: error instanceof Error ? error.message : "The market-data request failed.",
        },
      }));
    });
  }, [config.id, demandRegistry]);

  useEffect(() => {
    if (!demandRegistry) return;
    const desired = new Set(symbols.map((symbol) => demandId(config.id, symbol)));

    for (const id of [...activeDemandIds.current]) {
      if (desired.has(id)) continue;
      demandRegistry.release(id);
      activeDemandIds.current.delete(id);
    }

    for (const symbol of symbols) {
      const id = demandId(config.id, symbol);
      if (!activeDemandIds.current.has(id)) requestMonitoring(symbol);
    }

    setDemandStates((current) => Object.fromEntries(
      Object.entries(current).filter(([symbol]) => symbols.includes(symbol)),
    ));
  }, [symbols, config.id, demandRegistry, requestMonitoring]);

  useEffect(() => () => {
    if (!demandRegistry) return;
    for (const id of activeDemandIds.current) demandRegistry.release(id);
    activeDemandIds.current.clear();
  }, [demandRegistry]);

  // Market-data stores drive each row. The two-second heartbeat only refreshes
  // timestamp labels; it never polls the provider or repeats market requests.
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const off = [
      stores.quote.subscribe(refresh),
      stores.bars.subscribe(refresh),
    ];
    const heartbeat = setInterval(refresh, 2_000);
    return () => {
      off.forEach((unsubscribe) => unsubscribe());
      clearInterval(heartbeat);
    };
  }, [stores]);

  const addSymbol = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const symbol = normalizeUsTicker(addValue);
    if (!symbol) {
      setAddError("Enter a valid US ticker symbol, such as AAPL or BRK.B.");
      return;
    }
    if (symbols.includes(symbol)) {
      setAddError(bareSymbol(symbol) + " is already being monitored.");
      return;
    }
    if (symbols.length >= MAX_STRATEGY_MONITOR_SYMBOLS) {
      setAddError("The monitor is limited to five unique US symbols.");
      return;
    }
    setAddError(null);
    setAddValue("");
    saveSymbols([...symbols, symbol]);
  };

  const removeSymbol = (symbol: string) => {
    setAddError(null);
    saveSymbols(symbols.filter((item) => item !== symbol));
  };

  const th = {
    padding: "5px 8px",
    textAlign: "left" as const,
    color: palette.textMuted,
    fontSize: 9,
    letterSpacing: ".05em",
    fontWeight: 600,
  };
  const cell = { padding: "8px", borderTop: "1px solid " + palette.border, verticalAlign: "middle" as const };
  const detail = { color: palette.textMuted, fontSize: 9, lineHeight: 1.5 };
  const lineLabel = { color: palette.textMuted, fontSize: 9, fontWeight: 700 as const, letterSpacing: ".03em" };

  return (
    <div style={{ height: "100%", minHeight: 0, overflow: "auto", background: palette.bg, color: palette.text, fontSize: 12 }}>
      <div style={{ padding: "9px 10px", borderBottom: "1px solid " + palette.borderStrong }}>
        <div style={{ fontWeight: 700, letterSpacing: ".04em" }}>ROSS SETUP MONITOR</div>
        <div style={{ color: palette.textMuted, marginTop: 4, fontSize: 10 }}>
          Manually selected US stocks · quotes, prints and 1m / derived 5m candles
          <span style={{ marginLeft: 8, color: palette.accent }}>· {symbols.length}/{MAX_STRATEGY_MONITOR_SYMBOLS} monitored</span>
        </div>
      </div>

      <form onSubmit={addSymbol} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderBottom: "1px solid " + palette.border }}>
        <input
          aria-label="add symbol to monitor"
          autoComplete="off"
          spellCheck={false}
          placeholder="Enter ticker (e.g. AAPL)"
          value={addValue}
          onChange={(event) => { setAddValue(event.target.value); if (addError) setAddError(null); }}
          disabled={symbols.length >= MAX_STRATEGY_MONITOR_SYMBOLS}
          style={{
            minWidth: 0,
            flex: 1,
            padding: "6px 8px",
            border: "1px solid " + palette.borderStrong,
            borderRadius: 3,
            background: palette.surface,
            color: palette.text,
            fontFamily: "monospace",
            fontSize: 11,
          }}
        />
        <button
          type="submit"
          disabled={!addValue.trim() || symbols.length >= MAX_STRATEGY_MONITOR_SYMBOLS}
          style={{
            border: "1px solid " + palette.borderStrong,
            borderRadius: 3,
            background: palette.surface,
            color: symbols.length >= MAX_STRATEGY_MONITOR_SYMBOLS ? palette.textMuted : palette.text,
            padding: "6px 10px",
            fontSize: 10,
            cursor: !addValue.trim() || symbols.length >= MAX_STRATEGY_MONITOR_SYMBOLS ? "not-allowed" : "pointer",
            opacity: !addValue.trim() || symbols.length >= MAX_STRATEGY_MONITOR_SYMBOLS ? 0.5 : 1,
          }}
        >
          Add
        </button>
      </form>

      {addError && (
        <div role="alert" style={{ padding: "6px 10px", color: palette.danger, fontSize: 10 }}>
          {addError}
        </div>
      )}

      {symbols.length === 0 ? (
        <div style={{ padding: 18, color: palette.textMuted, lineHeight: 1.6, textAlign: "center" }}>
          <div style={{ color: palette.text, fontWeight: 600, marginBottom: 5 }}>No stocks selected</div>
          Enter symbols you have identified in EdgeTick. eTape will request live quotes, trade prints and one-minute candles.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>SYMBOL / DEMAND</th>
              <th style={{ ...th, textAlign: "right" }}>LAST</th>
              <th style={th}>QUOTE / 10S PRINTS</th>
              <th style={th}>1M / 5M CANDLES</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {symbols.map((symbol) => {
              const quote = stores.quote.get(symbol);
              const latest10s = stores.bars.latestBar(symbol, "10s");
              const latest1m = stores.bars.latestBar(symbol, "1m");
              const latest5m = stores.bars.latestBar(symbol, "5m");
              const quoteAge = ageMs(quote?.ts, now);
              const tickBucketAge = ageMs(latest10s?.bucketStart, now);
              const quoteFresh = quoteAge !== null && quoteAge <= FRESH_QUOTE_MS;
              const price = quote && quote.last > 0 ? quote.last : null;
              const demand = demandStates[symbol];
              const demandState = demand?.state ?? "requesting";
              const demandLabel = demandState === "accepted" ? "ENGINE ACCEPTED"
                : demandState === "blocked" ? "BLOCKED"
                  : demandState === "error" ? "ERROR" : "REQUESTING";
              const demandColor = demandState === "blocked" || demandState === "error"
                ? palette.danger : demandState === "requesting" ? palette.accent : palette.textMuted;

              const renderCandle = (bar: typeof latest1m, timeframe: string) => (
                <div>
                  <div style={lineLabel}>{timeframe} · {bar?.inProgress ? "FORMING" : "CLOSED"}</div>
                  {bar ? (
                    <div style={detail}>
                      C {formatPrice(bar.c, quoteDecimals(bar.c, 2))} · {formatCompactShares(bar.v)} vol
                      <div>Bucket started {ageLabel(ageMs(bar.bucketStart, now))}</div>
                    </div>
                  ) : <div style={detail}>No {timeframe} candle yet</div>}
                </div>
              );

              return (
                <tr key={symbol}>
                  <td style={{ ...cell, minWidth: 86 }}>
                    <div style={{ fontFamily: "monospace", fontWeight: 700 }}>{bareSymbol(symbol)}</div>
                    <div className="mono" style={{ color: demandColor, fontSize: 8, fontWeight: 700, marginTop: 3 }}>{demandLabel}</div>
                    {demand?.detail && <div style={{ ...detail, color: palette.danger }}>{demand.detail}</div>}
                    {(demandState === "blocked" || demandState === "error") && (
                      <button
                        type="button"
                        onClick={() => requestMonitoring(symbol)}
                        style={{ marginTop: 4, border: "1px solid " + palette.border, background: palette.surface, color: palette.text, padding: "3px 6px", fontSize: 9, cursor: "pointer" }}
                      >
                        Retry
                      </button>
                    )}
                  </td>
                  <td className="mono" style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {price === null ? "—" : formatPrice(price, quoteDecimals(price, 2))}
                  </td>
                  <td style={{ ...cell, minWidth: 132 }}>
                    <div>
                      <div style={{ ...lineLabel, color: quoteFresh ? palette.ok : palette.textMuted }}>
                        QUOTE · {quoteAge === null ? (quote ? "TIME UNKNOWN" : "NO DATA") : quoteFresh ? "FRESH" : "STALE"}
                      </div>
                      <div style={detail}>{quote ? "Provider timestamp " + ageLabel(quoteAge) : "Waiting for quote"}</div>
                    </div>
                    <div style={{ marginTop: 6 }}>
                      <div style={lineLabel}>10S PRINTS{latest10s?.gap ? " · GAP" : ""}</div>
                      {latest10s ? (
                        <div style={detail}>
                          {formatCompactShares(latest10s.v)} vol · bucket {ageLabel(tickBucketAge)}
                          {latest10s.volumeOnly ? " · volume only" : ""}
                        </div>
                      ) : <div style={detail}>Waiting for trade prints</div>}
                    </div>
                  </td>
                  <td style={{ ...cell, minWidth: 144 }}>
                    {renderCandle(latest1m, "1M")}
                    <div style={{ marginTop: 6 }}>{renderCandle(latest5m, "5M")}</div>
                  </td>
                  <td style={{ ...cell, textAlign: "right" }}>
                    <button
                      type="button"
                      aria-label={"Remove " + bareSymbol(symbol) + " from monitor"}
                      onClick={() => removeSymbol(symbol)}
                      title={"Remove " + bareSymbol(symbol)}
                      style={{ border: "1px solid " + palette.border, borderRadius: 3, background: palette.surface, color: palette.textMuted, padding: "4px 7px", fontSize: 9, cursor: "pointer" }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div style={{ padding: "8px 10px", borderTop: "1px solid " + palette.borderStrong, color: palette.textMuted, fontSize: 10, lineHeight: 1.45 }}>
        The engine accepts each monitoring demand before OpenD finishes subscription admission, so “ENGINE ACCEPTED” is not proof of a live provider stream. Quote freshness uses the provider quote timestamp. The 10-second series is derived from Ticker trade prints; 1-minute candles come from K_1M, and 5-minute candles are aggregated from those 1-minute bars. Candle age is shown as bucket age, not as a last-update timestamp. Forming candles remain open until later market data proves the bucket has completed. The two-second refresh only updates display ages; it does not poll the provider. This panel is informational and never places orders.
      </div>
    </div>
  );
}

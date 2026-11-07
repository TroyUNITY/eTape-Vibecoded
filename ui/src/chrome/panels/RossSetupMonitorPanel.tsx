import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { PanelProps } from "./registry";
import { useTheme } from "../ThemeProvider";
import { formatPrice, quoteDecimals } from "../../render/format";
import { formatCompactShares } from "../format";
import { MAX_STRATEGY_MONITOR_SYMBOLS } from "../../wire/DemandRegistry";

const WATCHED_SYMBOLS_SETTING = "rossSetupMonitorSymbols";
const FRESH_QUOTE_MS = 15_000;
const FRESH_ONE_MINUTE_BAR_MS = 90_000;

type MonitorDemandState = "requesting" | "subscribed" | "blocked" | "error";

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
    () => readWatchedSymbols(config.settings[WATCHED_SYMBOLS_SETTING]),
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
        setDemandStates((current) => ({
          ...current,
          [symbol]: { state: "subscribed", detail: null },
        }));
      } else {
        setDemandStates((current) => ({
          ...current,
          [symbol]: { state: "blocked", detail: ack.reason ?? "The market-data request was not accepted." },
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

  // Quotes and bars drive the display. The two-second heartbeat only ages the
  // freshness labels; it does not poll the provider or repeat market requests.
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

  return (
    <div style={{ height: "100%", minHeight: 0, overflow: "auto", background: palette.bg, color: palette.text, fontSize: 12 }}>
      <div style={{ padding: "9px 10px", borderBottom: "1px solid " + palette.borderStrong }}>
        <div style={{ fontWeight: 700, letterSpacing: ".04em" }}>ROSS SETUP MONITOR</div>
        <div style={{ color: palette.textMuted, marginTop: 4, fontSize: 10 }}>
          Manually selected US stocks · live quotes and one-minute candles
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
          Enter symbols you have identified in EdgeTick. eTape will subscribe to their live quotes and one-minute candles.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>SYMBOL</th>
              <th style={{ ...th, textAlign: "right" }}>LAST</th>
              <th style={th}>MARKET DATA</th>
              <th style={th}>1M BAR</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {symbols.map((symbol) => {
              const quote = stores.quote.get(symbol);
              const latestBar = stores.bars.latestBar(symbol, "1m");
              const quoteAge = ageMs(quote?.ts, now);
              const barAge = ageMs(latestBar?.bucketStart, now);
              const freshQuote = quoteAge !== null && quoteAge <= FRESH_QUOTE_MS;
              const freshBar = barAge !== null && barAge <= FRESH_ONE_MINUTE_BAR_MS;
              const live = freshQuote || freshBar;
              const price = quote && quote.last > 0 ? quote.last : latestBar?.c ?? null;
              const demand = demandStates[symbol];
              const demandState = demand?.state ?? "requesting";
              const statusLabel = live ? "LIVE DATA"
                : demandState === "requesting" ? "REQUESTING"
                  : demandState === "blocked" ? "BLOCKED"
                    : demandState === "error" ? "ERROR"
                      : "WAITING FOR DATA";
              const statusColor = live ? palette.ok
                : demandState === "blocked" || demandState === "error" ? palette.danger
                  : demandState === "requesting" ? palette.accent : palette.textMuted;
              const lastUpdateAge = [quoteAge, barAge].filter((value): value is number => value !== null)
                .reduce<number | null>((best, value) => best === null ? value : Math.min(best, value), null);

              return (
                <tr key={symbol}>
                  <td style={{ ...cell, fontFamily: "monospace", fontWeight: 700 }}>{bareSymbol(symbol)}</td>
                  <td className="mono" style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {price === null ? "—" : formatPrice(price, quoteDecimals(price, 2))}
                  </td>
                  <td style={{ ...cell, minWidth: 118 }}>
                    <div className="mono" style={{ color: statusColor, fontSize: 9, fontWeight: 700 }}>{statusLabel}</div>
                    <div style={{ color: palette.textMuted, fontSize: 9, marginTop: 3 }}>
                      {live ? "Updated " + ageLabel(lastUpdateAge)
                        : demand?.detail ?? (demandState === "subscribed" ? "Waiting for first quote or candle." : "Requesting subscription.")}
                    </div>
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
                  <td style={{ ...cell, color: palette.textMuted, fontSize: 10 }}>
                    {latestBar
                      ? formatCompactShares(latestBar.v) + " vol · " + ageLabel(barAge)
                      : "Waiting"}
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
        Your manual symbol list is saved with this workspace. eTape requests live quotes, trade prints and one-minute candles for these symbols, and releases their subscriptions when they are removed or this panel closes. The two-second refresh only updates data-freshness labels; it does not poll the provider. Setup detection and trade plans will be added in the next stages. This panel is informational and never places orders.
      </div>
    </div>
  );
}

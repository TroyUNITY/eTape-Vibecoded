// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThemeProvider } from "../ThemeProvider";
import { makeStores } from "../../data/registry";
import { RossSetupMonitorPanel } from "./RossSetupMonitorPanel";
import type { PanelProps } from "./registry";
import type { PanelConfig } from "../workspace";

afterEach(() => cleanup());

function makeDemandRegistry() {
  return {
    ensure: vi.fn(async () => ({ kind: "ack" as const, corrId: "", status: "accepted" as const })),
    release: vi.fn(),
  };
}

function renderMonitor(options?: {
  settings?: Record<string, unknown>;
  onConfigChange?: (patch: Record<string, unknown>) => void;
  demandRegistry?: ReturnType<typeof makeDemandRegistry>;
}) {
  const stores = makeStores();
  const onConfigChange = options?.onConfigChange ?? vi.fn();
  const demandRegistry = options?.demandRegistry ?? makeDemandRegistry();
  const config: PanelConfig = {
    id: "p-ross",
    panelId: "ross-setup-monitor",
    group: null,
    settings: options?.settings ?? {},
  };
  const props = {
    config,
    stores,
    scheduler: {} as never,
    width: 500,
    height: 300,
    linkGroups: {} as never,
    commands: {
      sendCommand: async () => ({ kind: "ack", corrId: "", status: "accepted" }),
      sendQuery: async () => null,
    },
    onConfigChange,
    demandRegistry,
  } as unknown as PanelProps;
  const view = render(<ThemeProvider><RossSetupMonitorPanel {...props} /></ThemeProvider>);
  return { ...view, stores, onConfigChange, demandRegistry, config };
}

function applyBar(
  stores: ReturnType<typeof makeStores>,
  timeframe: string,
  bucketStart: string,
  values: Partial<{ o: number; h: number; l: number; c: number; v: number; inProgress: boolean; gap: boolean; volumeOnly: boolean }> = {},
) {
  stores.bars.apply({
    kind: "delta",
    topic: "md.bars",
    key: "US.AAPL:" + timeframe,
    payload: {
      symbol: "US.AAPL",
      timeframe,
      bucketStart,
      o: 123,
      h: 125,
      l: 122,
      c: 124,
      v: 1_200,
      inProgress: false,
      ...values,
    },
  } as never);
}

describe("RossSetupMonitorPanel", () => {
  it("normalizes a manually entered US ticker, persists it, and starts strategy monitoring", async () => {
    const onConfigChange = vi.fn();
    const demandRegistry = makeDemandRegistry();
    renderMonitor({ onConfigChange, demandRegistry });

    fireEvent.change(screen.getByRole("textbox", { name: "add symbol to monitor" }), {
      target: { value: "  aapl " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(onConfigChange).toHaveBeenCalledWith({ rossSetupMonitorSymbols: ["US.AAPL"] });
      expect(demandRegistry.ensure).toHaveBeenCalledWith(
        "ross-setup-monitor:p-ross:US.AAPL",
        "US.AAPL",
        "strategy",
      );
      expect(screen.getByText("AAPL")).toBeTruthy();
    });
    expect(screen.getByText("ENGINE ACCEPTED")).toBeTruthy();
  });

  it("restores saved symbols and releases their subscriptions when removed", async () => {
    const onConfigChange = vi.fn();
    const demandRegistry = makeDemandRegistry();
    renderMonitor({
      settings: { rossSetupMonitorSymbols: ["US.NVDA"] },
      onConfigChange,
      demandRegistry,
    });

    await waitFor(() => expect(demandRegistry.ensure).toHaveBeenCalledWith(
      "ross-setup-monitor:p-ross:US.NVDA",
      "US.NVDA",
      "strategy",
    ));
    fireEvent.click(screen.getByRole("button", { name: "Remove NVDA from monitor" }));

    await waitFor(() => {
      expect(onConfigChange).toHaveBeenCalledWith({ rossSetupMonitorSymbols: [] });
      expect(demandRegistry.release).toHaveBeenCalledWith("ross-setup-monitor:p-ross:US.NVDA");
    });
    expect(screen.queryByText("NVDA")).toBeNull();
  });

  it("rejects invalid and duplicate tickers and enforces five saved symbols", async () => {
    const onConfigChange = vi.fn();
    const demandRegistry = makeDemandRegistry();
    renderMonitor({ onConfigChange, demandRegistry });

    const input = screen.getByRole("textbox", { name: "add symbol to monitor" });
    fireEvent.change(input, { target: { value: "HK.00700" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert").textContent).toContain("valid US ticker");

    fireEvent.change(input, { target: { value: "AAPL" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByText("AAPL")).toBeTruthy());

    fireEvent.change(input, { target: { value: "aapl" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert").textContent).toContain("already being monitored");

    for (const ticker of ["MSFT", "NVDA", "CDT", "VSA"]) {
      fireEvent.change(input, { target: { value: ticker } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    }
    await waitFor(() => expect(screen.getByText(/5\/5 monitored/)).toBeTruthy());
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    const lastPatch = onConfigChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(lastPatch.rossSetupMonitorSymbols).toEqual([
      "US.AAPL", "US.MSFT", "US.NVDA", "US.CDT", "US.VSA",
    ]);
  });

  it("uses the provider quote timestamp for quote freshness and never infers live data from a 1m bucket", async () => {
    const demandRegistry = makeDemandRegistry();
    const view = renderMonitor({
      settings: { rossSetupMonitorSymbols: ["US.AAPL"] },
      demandRegistry,
    });

    await waitFor(() => expect(demandRegistry.ensure).toHaveBeenCalledTimes(1));
    const oldBucket = new Date(Date.now() - 30_000).toISOString();
    act(() => {
      view.stores.quote.apply({
        kind: "snapshot",
        topic: "md.quote",
        payload: {
          symbol: "US.AAPL",
          bid: 123.4,
          ask: 123.5,
          last: 123.45,
          ts: new Date(Date.now() - 60_000).toISOString(),
        },
      } as never);
      applyBar(view.stores, "1m", oldBucket, { inProgress: true });
    });

    expect(screen.getByText("123.45")).toBeTruthy();
    expect(screen.getByText(/QUOTE · STALE/)).toBeTruthy();
    expect(screen.getByText(/1M · FORMING/)).toBeTruthy();
    expect(screen.queryByText("LIVE DATA")).toBeNull();
  });

  it("shows ticker-derived 10s prints and separate 1m and 5m candle states", async () => {
    const demandRegistry = makeDemandRegistry();
    const view = renderMonitor({
      settings: { rossSetupMonitorSymbols: ["US.AAPL"] },
      demandRegistry,
    });

    await waitFor(() => expect(demandRegistry.ensure).toHaveBeenCalledTimes(1));
    const now = Date.now();
    act(() => {
      view.stores.quote.apply({
        kind: "snapshot",
        topic: "md.quote",
        payload: {
          symbol: "US.AAPL",
          bid: 123.4,
          ask: 123.5,
          last: 123.45,
          ts: new Date(now).toISOString(),
        },
      } as never);
      applyBar(view.stores, "10s", new Date(now - 5_000).toISOString(), { v: 250, inProgress: true, gap: true });
      applyBar(view.stores, "1m", new Date(now - 20_000).toISOString(), { inProgress: true });
      applyBar(view.stores, "5m", new Date(now - 120_000).toISOString(), { inProgress: false });
    });

    expect(screen.getByText(/10S PRINTS · GAP/)).toBeTruthy();
    expect(screen.getByText(/1M · FORMING/)).toBeTruthy();
    expect(screen.getByText(/5M · CLOSED/)).toBeTruthy();
    expect(screen.getByText(/250 vol/)).toBeTruthy();
    expect(screen.getByText("FRESH")).toBeTruthy();
  });

  it("releases all remaining demands on unmount", async () => {
    const demandRegistry = makeDemandRegistry();
    const view = renderMonitor({
      settings: { rossSetupMonitorSymbols: ["US.AAPL"] },
      demandRegistry,
    });

    await waitFor(() => expect(demandRegistry.ensure).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(demandRegistry.release).toHaveBeenCalledWith("ross-setup-monitor:p-ross:US.AAPL");
  });

  it("migrates symbols that were already explicitly live-monitored by the old panel", async () => {
    const demandRegistry = makeDemandRegistry();
    renderMonitor({
      settings: { rossLiveMonitorSymbols: ["US.CDT", "US.VSA", "US.CDT"] },
      demandRegistry,
    });

    expect(screen.getByText((_, element) =>
      element?.tagName.toLowerCase() === "span" &&
      element.textContent?.replace(/\s/g, "").includes("2/5monitored") === true
    )).toBeTruthy();
    await waitFor(() => {
      expect(demandRegistry.ensure).toHaveBeenCalledWith(
        "ross-setup-monitor:p-ross:US.CDT",
        "US.CDT",
        "strategy",
      );
      expect(demandRegistry.ensure).toHaveBeenCalledWith(
        "ross-setup-monitor:p-ross:US.VSA",
        "US.VSA",
        "strategy",
      );
    });
  });

  it("restores at most five valid, unique symbols from panel settings", async () => {
    const demandRegistry = makeDemandRegistry();
    renderMonitor({
      settings: {
        rossSetupMonitorSymbols: ["US.AAPL", "US.MSFT", "US.AAPL", "HK.00700", "US.NVDA", "US.CDT", "US.VSA", "US.TSLA"],
      },
      demandRegistry,
    });

    expect(screen.getByText(/5\/5 monitored/)).toBeTruthy();
    expect(screen.getByText("AAPL")).toBeTruthy();
    expect(screen.queryByText("TSLA")).toBeNull();
    await waitFor(() => expect(demandRegistry.ensure).toHaveBeenCalledTimes(5));
  });
});

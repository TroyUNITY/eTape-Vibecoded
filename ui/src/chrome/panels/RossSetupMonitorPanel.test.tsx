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
    panelId: "ross-candidates",
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
    await waitFor(() => expect(screen.getByText("5/5 monitored")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    const lastPatch = onConfigChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(lastPatch.rossSetupMonitorSymbols).toEqual([
      "US.AAPL", "US.MSFT", "US.NVDA", "US.CDT", "US.VSA",
    ]);
  });

  it("shows fresh quote data and releases all remaining demands on unmount", async () => {
    const demandRegistry = makeDemandRegistry();
    const view = renderMonitor({
      settings: { rossSetupMonitorSymbols: ["US.AAPL"] },
      demandRegistry,
    });

    await waitFor(() => expect(demandRegistry.ensure).toHaveBeenCalledTimes(1));
    act(() => view.stores.quote.apply({
      kind: "snapshot",
      topic: "md.quote",
      payload: {
        symbol: "US.AAPL",
        bid: 123.4,
        ask: 123.5,
        last: 123.45,
        ts: new Date().toISOString(),
      },
    } as never));

    await waitFor(() => {
      expect(screen.getByText("$123.45")).toBeTruthy();
      expect(screen.getByText("LIVE DATA")).toBeTruthy();
    });

    view.unmount();
    expect(demandRegistry.release).toHaveBeenCalledWith("ross-setup-monitor:p-ross:US.AAPL");
  });

  it("restores at most five valid, unique symbols from panel settings", async () => {
    const demandRegistry = makeDemandRegistry();
    renderMonitor({
      settings: {
        rossSetupMonitorSymbols: ["US.AAPL", "US.MSFT", "US.AAPL", "HK.00700", "US.NVDA", "US.CDT", "US.VSA", "US.TSLA"],
      },
      demandRegistry,
    });

    expect(screen.getByText("5/5 monitored")).toBeTruthy();
    expect(screen.getByText("AAPL")).toBeTruthy();
    expect(screen.queryByText("TSLA")).toBeNull();
    await waitFor(() => expect(demandRegistry.ensure).toHaveBeenCalledTimes(5));
  });
});

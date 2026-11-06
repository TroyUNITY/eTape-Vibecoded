// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThemeProvider } from "../ThemeProvider";
import { makeStores } from "../../data/registry";
import { RossCandidatesPanel } from "./RossCandidatesPanel";
import type { PanelProps } from "./registry";
import type { PanelConfig } from "../workspace";
import type { ScannerFilters, ScannerRankPayload } from "../../wire/contract";

afterEach(() => cleanup());

const filters: ScannerFilters = {
  mode: "gainers",
  minChangePct: 0,
  maxFloatShares: null,
  minVolume: 0,
  minSessionVolume: 0,
  minTurnover: 0,
  minRelativeVolume: 0,
  minPrice: 0,
  maxPrice: 0,
  floatUnit: "M",
  volumeUnit: "K",
  sessionVolumeUnit: "K",
};

describe("RossCandidatesPanel", () => {
  it("shows a scanner candidate as PENDING when only Moomoo float proxy and no chart history are available", async () => {
    const stores = makeStores();
    const config: PanelConfig = {
      id: "p-ross",
      panelId: "ross-candidates",
      group: null,
      settings: {},
    };
    const sendQuery = vi.fn(async () => ({
      symbol: "US.TEST",
      asOfMs: Date.now(),
      oneMinuteBars: [{
        symbol: "US.TEST", timeframe: "1m",
        bucketStart: new Date(Date.now() - 60_000).toISOString(),
        o: 5, h: 5.1, l: 4.9, c: 5, v: 1000, inProgress: false,
      }],
      dailyBars: [{
        symbol: "US.TEST", timeframe: "D",
        bucketStart: "2026-11-05T00:00:00.000Z",
        o: 4, h: 5.2, l: 3.9, c: 5, v: 100000, inProgress: false,
      }],
    }));
    const props = {
      config,
      stores,
      scheduler: {} as never,
      width: 500,
      height: 300,
      linkGroups: {} as never,
      commands: {
        sendCommand: async () => ({ status: "accepted" }),
        sendQuery,
      },
      onConfigChange: () => {},
    } as unknown as PanelProps;

    render(<ThemeProvider><RossCandidatesPanel {...props} /></ThemeProvider>);

    const payload: ScannerRankPayload = {
      scannerId: "main/scanner-a",
      session: "rth",
      refreshedAt: "2026-11-06T14:00:00.000Z",
      discoveryAt: "2026-11-06T14:00:00.000Z",
      status: "ready",
      filters,
      rows: [{
        symbol: "US.TEST",
        shortSellRestricted: false,
        changePct: 12,
        last: 5,
        floatShares: 8_000_000,
        volume: 1_000_000,
        sessionVolume: 500_000,
        turnover: null,
        relativeVolume: 4,
        shortInterest: null,
        shortInterestAsOf: null,
      }],
    };
    act(() => stores.scanner.apply({
      kind: "snapshot",
      topic: "scanner.rank",
      key: "main/scanner-a/rth",
      payload,
    }));

    await waitFor(() => {
      expect(screen.getByText("US.TEST")).toBeTruthy();
      expect(screen.getAllByText("PENDING").length).toBeGreaterThan(0);
    }, { timeout: 2_000 });

    expect(screen.getByText(/OutstandingShares remains an unverified proxy/)).toBeTruthy();

    fireEvent.click(screen.getByText("US.TEST"));
    const loadButton = screen.getByRole("button", { name: "Load archived bars" });
    fireEvent.click(loadButton);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh archived bars" })).toBeTruthy();
      expect(screen.getByText("1m candles").nextElementSibling?.textContent).toBe("1");
      expect(screen.getAllByText("PENDING").length).toBeGreaterThan(0);
    });
    expect(sendQuery).toHaveBeenCalledWith("QueryCandidateHistory", { symbol: "US.TEST" });
  });

  it("persists a manually retained candidate after it leaves discovery scanners", async () => {
    const stores = makeStores();
    const config: PanelConfig = {
      id: "p-ross-retention",
      panelId: "ross-candidates",
      group: null,
      settings: {},
    };
    const onConfigChange = vi.fn();
    const props = {
      config,
      stores,
      scheduler: {} as never,
      width: 500,
      height: 300,
      linkGroups: {} as never,
      commands: {
        sendCommand: async () => ({ status: "accepted" }),
        sendQuery: async () => ({ symbol: "US.RETAINED", oneMinuteBars: [], dailyBars: [] }),
      },
      onConfigChange,
    } as unknown as PanelProps;

    render(<ThemeProvider><RossCandidatesPanel {...props} /></ThemeProvider>);

    const payload: ScannerRankPayload = {
      scannerId: "main/scanner-retention",
      session: "rth",
      refreshedAt: "2026-11-06T14:10:00.000Z",
      discoveryAt: "2026-11-06T14:10:00.000Z",
      status: "ready",
      filters,
      rows: [{
        symbol: "US.RETAINED",
        shortSellRestricted: false,
        changePct: 8,
        last: 4.5,
        floatShares: 8_000_000,
        volume: 500_000,
        sessionVolume: 250_000,
        turnover: null,
        relativeVolume: 3,
        shortInterest: null,
        shortInterestAsOf: null,
      }],
    };
    act(() => stores.scanner.apply({
      kind: "snapshot",
      topic: "scanner.rank",
      key: "main/scanner-retention/rth",
      payload,
    }));

    await waitFor(() => expect(screen.getByText("US.RETAINED")).toBeTruthy());
    fireEvent.click(screen.getByText("US.RETAINED"));
    fireEvent.click(screen.getByRole("button", { name: "Keep on shortlist" }));
    await waitFor(() => {
      expect(onConfigChange).toHaveBeenCalled();
      expect(screen.getByText("RETAINED")).toBeTruthy();
    });

    const lastPatch = onConfigChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const savedRecords = lastPatch.rossRetainedCandidates as unknown[];
    expect(savedRecords).toHaveLength(1);

    act(() => stores.scanner.apply({
      kind: "delta",
      topic: "scanner.rank",
      key: "main/scanner-retention/rth",
      payload: { ...payload, refreshedAt: "2026-11-06T14:11:00.000Z", rows: [] },
    }));

    await waitFor(() => {
      expect(screen.getByText("US.RETAINED")).toBeTruthy();
      expect(screen.getByText("NOT IN CURRENT SCANNERS")).toBeTruthy();
    });

    cleanup();
    const restoredConfig: PanelConfig = {
      ...config,
      settings: { rossRetainedCandidates: savedRecords },
    };
    render(<ThemeProvider><RossCandidatesPanel {...{ ...props, config: restoredConfig }} /></ThemeProvider>);
    expect(screen.getByText("US.RETAINED")).toBeTruthy();
    fireEvent.click(screen.getByText("US.RETAINED"));
    expect(screen.getByText("NOT IN CURRENT SCANNERS")).toBeTruthy();
  });

  it("requests bounded live one-minute monitoring for a retained candidate and releases it on unmount", async () => {
    const stores = makeStores();
    const config: PanelConfig = {
      id: "p-ross-live",
      panelId: "ross-candidates",
      group: null,
      settings: {},
    };
    const onConfigChange = vi.fn();
    const demandRegistry = {
      ensure: vi.fn(async () => ({ kind: "ack", corrId: "", status: "accepted" as const })),
      release: vi.fn(),
    };
    const props = {
      config,
      stores,
      scheduler: {} as never,
      width: 500,
      height: 300,
      linkGroups: {} as never,
      commands: {
        sendCommand: async () => ({ status: "accepted" }),
        sendQuery: async () => ({ symbol: "US.LIVE", oneMinuteBars: [], dailyBars: [] }),
      },
      onConfigChange,
      demandRegistry,
    } as unknown as PanelProps;

    const view = render(<ThemeProvider><RossCandidatesPanel {...props} /></ThemeProvider>);
    const payload: ScannerRankPayload = {
      scannerId: "main/scanner-live",
      session: "rth",
      refreshedAt: "2026-11-06T14:20:00.000Z",
      discoveryAt: "2026-11-06T14:20:00.000Z",
      status: "ready",
      filters,
      rows: [{
        symbol: "US.LIVE",
        shortSellRestricted: false,
        changePct: 9,
        last: 6,
        floatShares: 7_000_000,
        volume: 700_000,
        sessionVolume: 350_000,
        turnover: null,
        relativeVolume: 3,
        shortInterest: null,
        shortInterestAsOf: null,
      }],
    };
    act(() => stores.scanner.apply({
      kind: "snapshot",
      topic: "scanner.rank",
      key: "main/scanner-live/rth",
      payload,
    }));

    await waitFor(() => expect(screen.getByText("US.LIVE")).toBeTruthy());
    fireEvent.click(screen.getByText("US.LIVE"));
    fireEvent.click(screen.getByRole("button", { name: "Keep on shortlist" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Monitor live (1m)" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Monitor live (1m)" }));
    await waitFor(() => {
      expect(demandRegistry.ensure).toHaveBeenCalledWith(
        "ross-candidate:p-ross-live:US.LIVE",
        "US.LIVE",
        "candidate",
      );
      expect(screen.getByRole("button", { name: "Stop live monitor" })).toBeTruthy();
    });

    const monitorPatch = onConfigChange.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((patch) => Array.isArray(patch.rossLiveMonitorSymbols));
    expect(monitorPatch?.rossLiveMonitorSymbols).toEqual(["US.LIVE"]);

    view.unmount();
    expect(demandRegistry.release).toHaveBeenCalledWith("ross-candidate:p-ross-live:US.LIVE");
  });
});

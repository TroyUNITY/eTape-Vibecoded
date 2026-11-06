// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
    const props = {
      config,
      stores,
      scheduler: {} as never,
      width: 500,
      height: 300,
      linkGroups: {} as never,
      commands: {
        sendCommand: async () => ({ status: "accepted" }),
        sendQuery: async () => ({}),
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
    expect(screen.queryByText("ELIGIBLE")).toBeNull();
  });
});

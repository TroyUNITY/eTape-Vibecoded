import { describe, expect, it } from "vitest";
import { FilteredBarStore } from "./FilteredBarStore";
import type { Bar } from "../wire/contract";

function bar(bucketStart: string, c: number): Bar {
  return { symbol: "TEST", timeframe: "1m", bucketStart, o: c, h: c, l: c, c, v: 100, inProgress: true,
    source: "tickstore", coverageComplete: false };
}

describe("FilteredBarStore", () => {
  it("keeps filtered bars separate and replaces only the requested interval", () => {
    const store = new FilteredBarStore();
    const a = Date.parse("2026-11-02T09:00:00.000Z");
    const b = Date.parse("2026-11-02T09:01:00.000Z");
    const c = Date.parse("2026-11-02T09:02:00.000Z");
    store.replaceWindow("TEST", "1m", [bar(new Date(a).toISOString(), 10), bar(new Date(b).toISOString(), 11)], a, c);
    store.replaceWindow("TEST", "1m", [bar(new Date(b).toISOString(), 12)], b, c);
    expect(store.series("TEST", "1m").map((x) => x.c)).toEqual([10, 12]);
    expect(store.latestBar("TEST", "1m")?.c).toBe(12);
    expect(store.getRev("TEST", "1m")).toBe(2);
  });

  it("preserves old rows when a partial provider response is merged", () => {
    const store = new FilteredBarStore();
    const from = Date.parse("2026-11-02T09:00:00.000Z");
    const to = from + 2 * 60_000;
    store.replaceWindow("TEST", "1m", [bar(new Date(from).toISOString(), 10), bar(new Date(from + 60_000).toISOString(), 11)], from, to);
    store.mergeWindow("TEST", "1m", [bar(new Date(from + 60_000).toISOString(), 12)], from, to);
    expect(store.series("TEST", "1m").map((x) => x.c)).toEqual([10, 12]);
  });

  it("removes stale bars when a window is re-queried with no eligible prints", () => {
    const store = new FilteredBarStore();
    const from = Date.parse("2026-11-02T09:00:00.000Z");
    const to = from + 60_000;
    store.replaceWindow("TEST", "1m", [bar(new Date(from).toISOString(), 10)], from, to);
    store.replaceWindow("TEST", "1m", [], from, to);
    expect(store.series("TEST", "1m")).toEqual([]);
  });
});

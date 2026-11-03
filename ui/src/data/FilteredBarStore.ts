import { PaintStore } from "./store";
import type { Bar } from "../wire/contract";

// Filtered candles live beside (never inside) the official Moomoo BarStore.
// Replacing a queried window also removes stale filtered bars from that window
// when the latest reconstruction legitimately returns no eligible prints.
export class FilteredBarStore extends PaintStore {
  private readonly series_ = new Map<string, Bar[]>();
  private readonly revs = new Map<string, number>();

  private key(symbol: string, timeframe: string): string { return `${symbol}:${timeframe}`; }

  private bump(k: string): void {
    this.revs.set(k, (this.revs.get(k) ?? 0) + 1);
    this.markDirty();
  }

  series(symbol: string, timeframe: string): Bar[] {
    return this.series_.get(this.key(symbol, timeframe)) ?? [];
  }

  latestBar(symbol: string, timeframe: string): Bar | undefined {
    return this.series(symbol, timeframe).at(-1);
  }

  getRev(symbol?: string, timeframe?: string): number {
    if (symbol === undefined || timeframe === undefined) return super.getRev();
    return this.revs.get(this.key(symbol, timeframe)) ?? 0;
  }

  replaceWindow(symbol: string, timeframe: string, bars: Bar[], fromMs: number, toMs: number): void {
    if (!symbol || !timeframe || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return;
    const k = this.key(symbol, timeframe);
    const byTime = new Map<string, Bar>();
    for (const bar of this.series_.get(k) ?? []) {
      const ms = Date.parse(bar.bucketStart);
      if (!Number.isFinite(ms) || ms < fromMs || ms >= toMs) byTime.set(bar.bucketStart, bar);
    }
    for (const bar of bars) {
      const ms = Date.parse(bar.bucketStart);
      if (Number.isFinite(ms) && ms >= fromMs && ms < toMs) byTime.set(bar.bucketStart, bar);
    }
    this.series_.set(k, [...byTime.values()].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)));
    this.bump(k);
  }

  // Add newly returned rows without deleting prior candles when one provider
  // failed. This keeps the last known-good interval until all sources recover.
  mergeWindow(symbol: string, timeframe: string, bars: Bar[], fromMs: number, toMs: number): void {
    if (!symbol || !timeframe || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return;
    const k = this.key(symbol, timeframe);
    const byTime = new Map<string, Bar>((this.series_.get(k) ?? []).map((bar) => [bar.bucketStart, bar]));
    for (const bar of bars) {
      const ms = Date.parse(bar.bucketStart);
      if (Number.isFinite(ms) && ms >= fromMs && ms < toMs) byTime.set(bar.bucketStart, bar);
    }
    this.series_.set(k, [...byTime.values()].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)));
    this.bump(k);
  }

  clear(symbol: string, timeframe: string): void {
    const k = this.key(symbol, timeframe);
    if (!this.series_.has(k)) return;
    this.series_.delete(k);
    this.bump(k);
  }
}

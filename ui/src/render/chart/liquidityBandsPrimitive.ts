
import type {
    IPrimitivePaneRenderer,
    IPrimitivePaneView,
    ISeriesApi,
    ISeriesPrimitive,
    SeriesAttachedParameter,
    Time,
  } from "lightweight-charts";
  import type { Book, BookLevel } from "../../wire/contract";
  
  type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];
  
  type Band = {
    side: "bid" | "ask";
    price: number;
    size: number;
  };
  
  function strongestNearby(
    levels: BookLevel[],
    side: Band["side"]
  ): Band[] {
    return levels
      .slice(0, 40)
      .filter((level) =>
        Number.isFinite(level.price) &&
        level.price > 0 &&
        Number.isFinite(level.size) &&
        level.size > 0
      )
      .sort((a, b) => b.size - a.size)
      .slice(0, 20)
      .map(({ price, size }) => ({ side, price, size }));
  }
  
  export class LiquidityBandsPrimitive
    implements ISeriesPrimitive<Time> {
  
    private series: ISeriesApi<"Candlestick"> | null = null;
    private requestUpdate: (() => void) | null = null;
    private book: Book | undefined;
    private enabled = false;
  
    attached(p: SeriesAttachedParameter<Time>): void {
      this.series = p.series as ISeriesApi<"Candlestick">;
      this.requestUpdate = p.requestUpdate;
    }
  
    detached(): void {
      this.series = null;
      this.requestUpdate = null;
    }
  
    setBook(book: Book | undefined, timeframe: string): void {
      const enabled = timeframe === "1m" || timeframe === "5m";
      if (book === this.book && enabled === this.enabled) return;
  
      this.book = book;
      this.enabled = enabled;
      this.requestUpdate?.();
    }
  
    paneViews(): readonly IPrimitivePaneView[] {
      return [{
        renderer: () => ({
          draw: (target: DrawTarget) => this.draw(target),
        }),
        zOrder: () => "bottom" as const,
      }];
    }
  
    private draw(target: DrawTarget): void {
      if (!this.enabled || !this.series || !this.book) return;
  
      const bands: Band[] = [
        ...strongestNearby(this.book.bids, "bid"),
        ...strongestNearby(this.book.asks, "ask"),
      ];
  
      const maxSize = Math.max(0, ...bands.map(b => b.size));
      if (maxSize === 0) return;
  
      target.useBitmapCoordinateSpace(({
        context: ctx,
        bitmapSize,
        horizontalPixelRatio: hr,
        verticalPixelRatio: vr,
      }) => {
        const maxWidth = Math.min(bitmapSize.width * 0.22, 180 * hr);
  
        ctx.save();
  
        for (const band of bands) {
          const coordinate =
            this.series!.priceToCoordinate(band.price);
  
          if (coordinate === null || !Number.isFinite(coordinate)) {
            continue;
          }
  
          const y = coordinate * vr;
          const h = 7 * vr;
  
          if (y < h / 2 || y > bitmapSize.height - h / 2) {
            continue;
          }
  
          const w = Math.max(
            10 * hr,
            maxWidth * band.size / maxSize
          );
  
          ctx.fillStyle = band.side === "bid"
            ? "rgba(50,205,50,0.38)"
            : "rgba(255,0,0,0.34)";
  
          ctx.fillRect(
            bitmapSize.width - w,
            y - h / 2,
            w,
            h
          );
        }
  
        ctx.restore();
      });
    }
  }
  
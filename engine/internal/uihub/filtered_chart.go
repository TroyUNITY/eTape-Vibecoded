package uihub

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"time"

	"github.com/earlisreal/eTape/engine/internal/hist/filteredbars"
	"github.com/earlisreal/eTape/engine/internal/hist/tradehistory"
	"github.com/earlisreal/eTape/engine/internal/uihub/wsmsg"
)

const maxFilteredChartWindow = 14 * 24 * time.Hour

func (q *queries) filteredChartWindow(ctx context.Context, raw json.RawMessage) wsmsg.QueryFilteredChartWindowResult {
	var args wsmsg.QueryFilteredChartWindowArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return filteredChartError(args, "invalid request")
	}
	args.Symbol = strings.ToUpper(strings.TrimSpace(args.Symbol))
	args.Timeframe = strings.TrimSpace(args.Timeframe)
	if args.Timeframe != "1m" && args.Timeframe != "5m" {
		return filteredChartError(args, "filtered candles are available only on 1m and 5m")
	}
	if args.Symbol == "" || args.FromMs <= 0 || args.ToMs <= args.FromMs {
		return filteredChartError(args, "symbol and a valid [from,to) range are required")
	}
	from := time.UnixMilli(args.FromMs).UTC()
	to := time.UnixMilli(args.ToMs).UTC()
	queryStarted := time.Now()
	if to.Sub(from) > maxFilteredChartWindow {
		return filteredChartError(args, "filtered chart range exceeds the 14-day safety limit")
	}
	if to.After(q.clk.Now().Add(time.Minute)) {
		return filteredChartError(args, "filtered chart range cannot extend more than one minute into the future")
	}
	if args.AnchorPrice != 0 && (math.IsNaN(args.AnchorPrice) || math.IsInf(args.AnchorPrice, 0) || args.AnchorPrice <= 0) {
		return filteredChartError(args, "anchor price must be finite and positive")
	}
	if q.filteredHistory == nil {
		return filteredChartError(args, "filtered trade history is unavailable; check Alpaca credentials and local TickStore")
	}

	var history tradehistory.Result
	var fetchErr error
	if args.LocalOnly {
		history, fetchErr = q.filteredHistory.FetchLocal(ctx, args.Symbol, from, to)
	} else {
		history, fetchErr = q.filteredHistory.Fetch(ctx, args.Symbol, from, to)
	}
	options := filteredbars.DefaultOptions()
	options.AnchorPrice = args.AnchorPrice
	options.AnchorTimeMs = args.AnchorTimeMs
	built, buildErr := filteredbars.Build(history, options)
	if buildErr != nil {
		result := filteredChartError(args, buildErr.Error())
		result.Diagnostics = filteredDiagnostics(history, nil, nil)
		if fetchErr != nil {
			result.Diagnostics.Errors = append(result.Diagnostics.Errors, fetchErr.Error())
		}
		return result
	}

	selected := built.OneMinute
	interval := int64(time.Minute / time.Millisecond)
	if args.Timeframe == "5m" {
		selected = built.FiveMinute
		interval = int64(5 * time.Minute / time.Millisecond)
	}
	bars := make([]wsmsg.Bar, 0, len(selected))
	for _, bar := range selected {
		bars = append(bars, wsmsg.Bar{
			Symbol: args.Symbol, Timeframe: args.Timeframe, BucketStart: isoMs(bar.BucketMs),
			O: bar.O, H: bar.H, L: bar.L, C: bar.C, V: bar.Volume,
			InProgress: bar.BucketMs+interval > q.clk.Now().UnixMilli(),
			VolumeOnly: bar.VolumeOnly, Source: string(bar.Source), CoverageComplete: bar.CoverageComplete,
		})
	}
	result := wsmsg.QueryFilteredChartWindowResult{
		Symbol: args.Symbol, Timeframe: args.Timeframe, FromMs: args.FromMs, ToMs: args.ToMs,
		Bars: bars, Diagnostics: filteredDiagnostics(history, built.Coverage, &built.Diagnostics),
	}
	if fetchErr != nil {
		// A source may fail while the other still provides useful bars. Keep
		// those bars visible but make the partial failure explicit to the UI.
		result.Diagnostics.Errors = append(result.Diagnostics.Errors, fetchErr.Error())
		if len(history.AlpacaTrades) == 0 && len(history.LocalPrints) == 0 {
			// Distinguish a genuine empty interval (no fetch error) from a query
			// where every configured provider failed. The UI can then preserve
			// the last known-good tail instead of clearing it on an outage.
			result.Error = "no trade-history source returned data: " + fetchErr.Error()
		}
	}
	// Log broad history windows, not the frequent live-tail refreshes. These
	// timings distinguish the local-only first paint from the Alpaca page walk.
	if to.Sub(from) > time.Hour {
		slog.Info("filtered chart history query completed",
			"symbol", args.Symbol, "timeframe", args.Timeframe, "localOnly", args.LocalOnly,
			"elapsed", time.Since(queryStarted), "bars", len(result.Bars),
			"localReports", history.Diagnostics.LocalUniqueCount,
			"alpacaReports", history.Diagnostics.AlpacaUniqueCount,
			"alpacaPages", history.Diagnostics.AlpacaPages, "error", fetchErr)
	}
	return result
}

func filteredChartError(args wsmsg.QueryFilteredChartWindowArgs, message string) wsmsg.QueryFilteredChartWindowResult {
	return wsmsg.QueryFilteredChartWindowResult{
		Symbol: args.Symbol, Timeframe: args.Timeframe, FromMs: args.FromMs, ToMs: args.ToMs,
		Bars: []wsmsg.Bar{}, Diagnostics: wsmsg.FilteredChartDiagnostics{
			LocalCoverageUnproven: true, LocalCoverageReasons: []string{"coverage_unavailable"}, Errors: []string{},
		}, Error: message,
	}
}

func filteredDiagnostics(history tradehistory.Result, coverage []filteredbars.MinuteCoverage, built *filteredbars.Diagnostics) wsmsg.FilteredChartDiagnostics {
	d := history.Diagnostics
	out := wsmsg.FilteredChartDiagnostics{
		AlpacaFeed: d.AlpacaFeed, AlpacaInputReports: int64(len(history.AlpacaTrades)),
		LocalInputReports: int64(len(history.LocalPrints)), LocalCoverageUnproven: true,
		LocalCoverageReasons: append([]string(nil), d.LocalCoverageReasons...),
		AlpacaRecencyClamped: d.AlpacaRecencyClamped, PotentialCrossFeedHits: d.PotentialCrossFeedHits,
		Errors: []string{},
	}
	for _, row := range d.Errors {
		out.Errors = append(out.Errors, fmt.Sprintf("%s: %s", row.Source, row.Error))
	}
	if built != nil {
		out.SelectedAlpacaReports = built.SelectedAlpacaReports
		out.SelectedLocalReports = built.SelectedLocalReports
		out.AlpacaLatencyRuleUnavailable = built.AlpacaLatencyRuleUnavailable
		out.AlpacaUnsupportedFeed = built.AlpacaUnsupportedFeed
		out.LocalCoverageUnproven = built.LocalCoverageUnproven
		out.LocalCoverageReasons = append(out.LocalCoverageReasons[:0], built.LocalCoverageReasons...)
	}
	for _, row := range coverage {
		out.CoverageMinutes++
		switch row.Source {
		case filteredbars.SourceAlpacaSIP:
			if row.Complete {
				out.CompleteAlpacaMinutes++
			}
		case filteredbars.SourceTickStore:
			out.TickStoreMinutes++
		case filteredbars.SourceAlpacaPartial:
			out.PartialAlpacaMinutes++
		default:
			out.EmptyMinutes++
		}
	}
	return out
}

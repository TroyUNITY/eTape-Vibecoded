package uihub

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/earlisreal/eTape/engine/internal/clock"
	"github.com/earlisreal/eTape/engine/internal/feed"
	"github.com/earlisreal/eTape/engine/internal/hist/tradehistory"
	"github.com/earlisreal/eTape/engine/internal/uihub/wsmsg"
)

type filteredHistoryStub struct {
	result      tradehistory.Result
	localResult tradehistory.Result
	err         error
	fetchCalls  *int
	localCalls  *int
}

func (s filteredHistoryStub) Fetch(_ context.Context, _ string, _, _ time.Time) (tradehistory.Result, error) {
	if s.fetchCalls != nil {
		(*s.fetchCalls)++
	}
	return s.result, s.err
}

func (s filteredHistoryStub) FetchLocal(_ context.Context, _ string, _, _ time.Time) (tradehistory.Result, error) {
	if s.localCalls != nil {
		(*s.localCalls)++
	}
	if s.localResult.Symbol != "" {
		return s.localResult, s.err
	}
	return s.result, s.err
}

func TestFilteredChartWindowBuildsRequestedTimeframe(t *testing.T) {
	from := time.Now().UTC().Truncate(5 * time.Minute).Add(-5 * time.Minute)
	to := from.Add(5 * time.Minute)
	prints := make([]feed.Tick, 0, 5)
	for minute := 0; minute < 5; minute++ {
		at := from.Add(time.Duration(minute)*time.Minute + time.Second)
		prints = append(prints, feed.Tick{
			Symbol: "US.TEST", Seq: int64(minute + 1), TsMs: at.UnixMilli(), RecvTsMs: at.Add(100 * time.Millisecond).UnixMilli(),
			Price: 10 + float64(minute), Volume: 100, Condition: feed.TradeConditionAutomaticMatch,
		})
	}
	q := &queries{
		clk: clock.System{},
		filteredHistory: filteredHistoryStub{result: tradehistory.Result{
			Symbol: "US.TEST", LocalPrints: prints,
			Diagnostics: tradehistory.Diagnostics{RequestedFrom: from, RequestedTo: to, LocalCoverageReasons: []string{"coverage_unproven"}},
		}},
	}

	for _, tc := range []struct {
		name      string
		timeframe string
		wantBars  int
	}{
		{name: "one minute", timeframe: "1m", wantBars: 5},
		{name: "five minute", timeframe: "5m", wantBars: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload, err := json.Marshal(wsmsg.QueryFilteredChartWindowArgs{
				Symbol: "TEST", Timeframe: tc.timeframe, FromMs: from.UnixMilli(), ToMs: to.UnixMilli(),
			})
			if err != nil {
				t.Fatal(err)
			}
			got := q.filteredChartWindow(context.Background(), payload)
			if got.Error != "" {
				t.Fatalf("query error: %s", got.Error)
			}
			if len(got.Bars) != tc.wantBars {
				t.Fatalf("bars = %d, want %d: %+v", len(got.Bars), tc.wantBars, got.Bars)
			}
			if !got.Diagnostics.LocalCoverageUnproven {
				t.Fatal("local TickStore candles were incorrectly reported as complete")
			}
			if got.Bars[0].Source != "tickstore" {
				t.Fatalf("source = %q, want tickstore", got.Bars[0].Source)
			}
		})
	}
}

func TestFilteredChartWindowLocalOnlySkipsAlpacaHistory(t *testing.T) {
	from := time.Now().UTC().Truncate(time.Minute).Add(-3 * time.Minute)
	to := from.Add(time.Minute)
	prints := []feed.Tick{{
		Symbol: "US.TEST", Seq: 1, TsMs: from.Add(time.Second).UnixMilli(),
		RecvTsMs: from.Add(1100 * time.Millisecond).UnixMilli(), Price: 10, Volume: 100,
		Condition: feed.TradeConditionAutomaticMatch,
	}}
	fetchCalls, localCalls := 0, 0
	q := &queries{
		clk: clock.System{},
		filteredHistory: filteredHistoryStub{
			result: tradehistory.Result{Symbol: "US.TEST"},
			localResult: tradehistory.Result{
				Symbol: "US.TEST", LocalPrints: prints,
				Diagnostics: tradehistory.Diagnostics{RequestedFrom: from, RequestedTo: to, LocalCoverageReasons: []string{"coverage_unproven"}},
			},
			fetchCalls: &fetchCalls, localCalls: &localCalls,
		},
	}
	payload, err := json.Marshal(wsmsg.QueryFilteredChartWindowArgs{
		Symbol: "TEST", Timeframe: "1m", FromMs: from.UnixMilli(), ToMs: to.UnixMilli(), LocalOnly: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	got := q.filteredChartWindow(context.Background(), payload)
	if got.Error != "" {
		t.Fatalf("local-only query error: %s", got.Error)
	}
	if fetchCalls != 0 || localCalls != 1 {
		t.Fatalf("fetch calls = %d, local calls = %d; want 0 and 1", fetchCalls, localCalls)
	}
	if len(got.Bars) != 1 || got.Bars[0].Source != "tickstore" || got.Diagnostics.AlpacaInputReports != 0 {
		t.Fatalf("unexpected local-only response: %+v", got)
	}
}

func TestFilteredChartWindowRejectsUnsupportedTimeframe(t *testing.T) {
	q := &queries{clk: clock.System{}}
	payload, err := json.Marshal(wsmsg.QueryFilteredChartWindowArgs{
		Symbol: "TEST", Timeframe: "15m", FromMs: time.Now().Add(-time.Hour).UnixMilli(), ToMs: time.Now().UnixMilli(),
	})
	if err != nil {
		t.Fatal(err)
	}
	got := q.filteredChartWindow(context.Background(), payload)
	if got.Error == "" {
		t.Fatal("expected unsupported timeframe error")
	}
}

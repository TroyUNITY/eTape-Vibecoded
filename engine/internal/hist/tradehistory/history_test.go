package tradehistory

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/earlisreal/eTape/engine/internal/feed"
	histalpaca "github.com/earlisreal/eTape/engine/internal/hist/alpaca"
	"github.com/earlisreal/eTape/engine/internal/tickstore"
)

type fakeAlpaca struct {
	batch histalpaca.TradeBatch
	err   error
	calls int
	sym   string
	from  time.Time
	to    time.Time
}

func (f *fakeAlpaca) HistoricalTrades(_ context.Context, symbol string, from, to time.Time) (histalpaca.TradeBatch, error) {
	f.calls++
	f.sym, f.from, f.to = symbol, from, to
	return f.batch, f.err
}

type fakeLocalReader struct {
	batch tickstore.TradeRead
	err   error
	calls int
	sym   string
	from  int64
	to    int64
}

func (f *fakeLocalReader) Read(_ context.Context, symbol string, from, to int64) (tickstore.TradeRead, error) {
	f.calls++
	f.sym, f.from, f.to = symbol, from, to
	return f.batch, f.err
}

func TestFetchReadsBothSourcesDeduplicatesWithinEachAndReportsOverlap(t *testing.T) {
	start := time.Date(2026, 11, 2, 14, 30, 0, 0, time.UTC)
	first := start.Add(time.Second)
	second := start.Add(2 * time.Second)
	trades := []histalpaca.Trade{
		{Timestamp: first, Exchange: "V", Price: 1.25, Size: 100, Conditions: []string{"@"}, ID: 11, Tape: "C"},
		{Timestamp: first, Exchange: "V", Price: 1.25, Size: 100, Conditions: []string{"@"}, ID: 11, Tape: "C"}, // page-boundary duplicate
		{Timestamp: second, Exchange: "Q", Price: 1.26, Size: 200, Conditions: []string{"@"}, ID: 12, Tape: "C"},
	}
	alpaca := &fakeAlpaca{batch: histalpaca.TradeBatch{
		Feed: "sip", RequestedFrom: start, RequestedTo: start.Add(time.Hour),
		EffectiveFrom: start, EffectiveTo: start.Add(time.Hour), Pages: 2, RawTradeCount: 3, IdentityConflictCount: 1, Trades: trades,
	}}
	localTick := feed.Tick{Symbol: "US.ABC", Seq: 1, TsMs: first.UnixMilli(), Price: 1.25, Volume: 100}
	local := &fakeLocalReader{batch: tickstore.ProfileRead{
		Prints:  []feed.Tick{localTick, localTick, {Symbol: "US.ABC", Seq: 2, TsMs: second.UnixMilli(), Price: 1.26, Volume: 200}},
		Reasons: []string{"coverage_unproven"}, AsOfMs: second.Add(time.Second).UnixMilli(), FirstPrintMs: first.UnixMilli(), LastPrintMs: second.UnixMilli(),
	}}

	service := New(alpaca, local)
	got, err := service.Fetch(context.Background(), " abc ", start, start.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if got.Symbol != "US.ABC" || alpaca.calls != 1 || local.calls != 1 || alpaca.sym != "US.ABC" || local.sym != "US.ABC" {
		t.Fatalf("source calls or canonical symbol: result=%+v alpaca=%+v local=%+v", got, alpaca, local)
	}
	if local.from != start.UnixMilli() || local.to != start.Add(time.Hour).UnixMilli() {
		t.Fatalf("TickStore query range = [%d,%d), want [%d,%d)", local.from, local.to, start.UnixMilli(), start.Add(time.Hour).UnixMilli())
	}
	if len(got.AlpacaTrades) != 2 || len(got.LocalPrints) != 2 {
		t.Fatalf("deduped result counts alpaca=%d local=%d", len(got.AlpacaTrades), len(got.LocalPrints))
	}
	d := got.Diagnostics
	if d.AlpacaRawCount != 3 || d.AlpacaUniqueCount != 2 || d.AlpacaDuplicateCount != 1 || d.AlpacaIdentityConflictCount != 1 || d.AlpacaPages != 2 {
		t.Fatalf("Alpaca diagnostics: %+v", d)
	}
	if d.LocalRawCount != 3 || d.LocalUniqueCount != 2 || d.LocalDuplicateCount != 1 || !d.LocalAsOf.Equal(time.UnixMilli(local.batch.AsOfMs).UTC()) {
		t.Fatalf("TickStore diagnostics: %+v", d)
	}
	if !d.Overlap || !d.OverlapFrom.Equal(first) || !d.OverlapTo.Equal(second) || d.PotentialCrossFeedHits != 2 {
		t.Fatalf("overlap diagnostics: %+v", d)
	}
	if len(d.LocalCoverageReasons) != 1 || d.LocalCoverageReasons[0] != "coverage_unproven" {
		t.Fatalf("local coverage caveats lost: %+v", d.LocalCoverageReasons)
	}
}

func TestFetchLocalDoesNotWaitForOrCallAlpaca(t *testing.T) {
	start := time.Date(2026, 11, 2, 14, 30, 0, 0, time.UTC)
	alpaca := &fakeAlpaca{batch: histalpaca.TradeBatch{Feed: "sip"}}
	local := &fakeLocalReader{batch: tickstore.TradeRead{
		Prints:  []feed.Tick{{Symbol: "US.ABC", Seq: 1, TsMs: start.UnixMilli(), Price: 1.25, Volume: 100}},
		Reasons: []string{"coverage_unproven"},
	}}
	service := New(alpaca, local)
	got, err := service.FetchLocal(context.Background(), "ABC", start, start.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if alpaca.calls != 0 {
		t.Fatalf("local-only fetch called Alpaca %d times", alpaca.calls)
	}
	if local.calls != 1 || len(got.LocalPrints) != 1 || len(got.AlpacaTrades) != 0 {
		t.Fatalf("unexpected local-only result: localCalls=%d result=%+v", local.calls, got)
	}
}

func TestDedupeAlpacaIncludesExchangeInTradeIdentity(t *testing.T) {
	at := time.Date(2026, 11, 2, 14, 30, 0, 0, time.UTC)
	trades := []histalpaca.Trade{
		{Timestamp: at, Exchange: "V", Price: 1.25, Size: 100, ID: 9},
		{Timestamp: at, Exchange: "Q", Price: 1.25, Size: 100, ID: 9},
	}
	if got := dedupeAlpaca(trades); len(got) != 2 {
		t.Fatalf("different exchange reports were merged: %+v", got)
	}
}

func TestDedupeAlpacaPreservesChangedReportWithSameID(t *testing.T) {
	at := time.Date(2026, 11, 2, 14, 30, 0, 0, time.UTC)
	trades := []histalpaca.Trade{
		{Timestamp: at, Exchange: "V", Price: 1.25, Size: 100, ID: 9},
		{Timestamp: at, Exchange: "V", Price: 1.26, Size: 100, ID: 9},
	}
	if got := dedupeAlpaca(trades); len(got) != 2 {
		t.Fatalf("changed report under same ID was dropped: %+v", got)
	}
}

func TestDedupeAlpacaKeepsReportsWithoutProviderIDs(t *testing.T) {
	at := time.Date(2026, 11, 2, 14, 30, 0, 0, time.UTC)
	trade := histalpaca.Trade{Timestamp: at, Exchange: "V", Price: 1.25, Size: 100}
	if got := dedupeAlpaca([]histalpaca.Trade{trade, trade}); len(got) != 2 {
		t.Fatalf("reports without provider IDs were merged: %+v", got)
	}
}

func TestFetchReturnsSuccessfulPartialSourceWithOtherSourceError(t *testing.T) {
	start := time.Date(2026, 11, 2, 14, 30, 0, 0, time.UTC)
	alpaca := &fakeAlpaca{err: errors.New("historical service unavailable")}
	local := &fakeLocalReader{batch: tickstore.ProfileRead{Prints: []feed.Tick{{Symbol: "US.ABC", TsMs: start.UnixMilli(), Seq: 1, Price: 1, Volume: 100}}}}
	got, err := New(alpaca, local).Fetch(context.Background(), "ABC", start, start.Add(time.Minute))
	if err == nil || len(got.LocalPrints) != 1 || len(got.AlpacaTrades) != 0 {
		t.Fatalf("partial result = %+v err=%v", got, err)
	}
	if len(got.Diagnostics.Errors) != 1 || got.Diagnostics.Errors[0].Source != "alpaca" {
		t.Fatalf("source error diagnostics = %+v", got.Diagnostics.Errors)
	}
}

func TestFetchRejectsInvalidSymbolAndRange(t *testing.T) {
	start := time.Date(2026, 11, 2, 14, 30, 0, 0, time.UTC)
	service := New(&fakeAlpaca{}, &fakeLocalReader{})
	if _, err := service.Fetch(context.Background(), "ABC/DEF", start, start.Add(time.Minute)); err == nil {
		t.Fatal("expected invalid symbol error")
	}
	if _, err := service.Fetch(context.Background(), "ABC", start, start); err == nil {
		t.Fatal("expected empty range error")
	}
}

func TestCeilUnixMilliPreservesExclusiveBounds(t *testing.T) {
	base := time.Date(2026, 11, 2, 14, 30, 0, 100_000_000, time.UTC)
	if got, want := ceilUnixMilli(base.Add(500*time.Microsecond)), base.UnixMilli()+1; got != want {
		t.Fatalf("ceil start = %d, want %d", got, want)
	}
	if got, want := ceilUnixMilli(base.Add(time.Millisecond)), base.UnixMilli()+1; got != want {
		t.Fatalf("exact-ms bound = %d, want %d", got, want)
	}
}

func TestFetchReadsCommittedTickStorePrints(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "ticks")
	archive, err := tickstore.Open(tickstore.Options{Directory: dir, MinFreeBytes: 1, FlushInterval: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := archive.Close(ctx); err != nil {
			t.Errorf("close TickStore: %v", err)
		}
	})

	at := time.Date(2026, 11, 2, 14, 30, 1, 0, time.UTC)
	tick := feed.Tick{Symbol: "US.ABC", Seq: 77, TsMs: at.UnixMilli(), Price: 1.23, Volume: 150, Condition: feed.TradeConditionAutomaticMatch}
	if !archive.Record(feed.Recording{
		Kind: "print", Symbol: tick.Symbol, TimeMs: tick.TsMs, Sequence: tick.Seq,
		Data: struct{ Normalized feed.Tick }{Normalized: tick},
	}) {
		t.Fatal("TickStore rejected print")
	}
	deadline := time.Now().Add(2 * time.Second)
	for archive.Stats().Committed == 0 {
		if time.Now().After(deadline) {
			t.Fatal("TickStore commit timed out")
		}
		time.Sleep(time.Millisecond)
	}

	reader := tickstore.NewTradeReader(dir, archive)
	got, err := New(nil, reader).Fetch(context.Background(), "ABC", at.Add(-time.Second), at.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if len(got.LocalPrints) != 1 || got.LocalPrints[0].Seq != tick.Seq || got.Diagnostics.LocalUniqueCount != 1 {
		t.Fatalf("TickStore result = %+v diagnostics=%+v", got.LocalPrints, got.Diagnostics)
	}
	if got.Diagnostics.LocalFirstPrint.IsZero() || got.Diagnostics.LocalLastPrint.IsZero() {
		t.Fatalf("TickStore time diagnostics missing: %+v", got.Diagnostics)
	}
}

func TestDedupeAlpacaPreservesUpdateStatusChanges(t *testing.T) {
	at := time.Date(2026, 11, 2, 14, 30, 0, 0, time.UTC)
	trades := []histalpaca.Trade{
		{Timestamp: at, Exchange: "V", Price: 1.25, Size: 100, Conditions: []string{"@"}, ID: 9, Tape: "C"},
		{Timestamp: at, Exchange: "V", Price: 1.25, Size: 100, Conditions: []string{"@"}, ID: 9, Tape: "C", Update: "canceled"},
	}
	if got := dedupeAlpaca(trades); len(got) != 2 {
		t.Fatalf("trade update status was lost during deduplication: %+v", got)
	}
}

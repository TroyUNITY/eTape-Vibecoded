package uihub

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/earlisreal/eTape/engine/internal/clock"
	"github.com/earlisreal/eTape/engine/internal/exec"
	"github.com/earlisreal/eTape/engine/internal/feed"
	"github.com/earlisreal/eTape/engine/internal/uihub/wsmsg"
)

type spyFills struct {
	rows []exec.FillRow
	err  error
	sym  string

	exportRowsMulti          []exec.ExportFillRow
	exportErr                error
	exportVenue              string
	exportFromMs, exportToMs int64
}

type spyEligiblePreview struct {
	symbol string
	value  exec.EligiblePrintPreview
}

func (s *spyEligiblePreview) PreviewEligiblePrint(_ context.Context, symbol string) exec.EligiblePrintPreview {
	s.symbol = symbol
	return s.value
}

func (s *spyFills) QueryFills(symbol string, _, _ int64) ([]exec.FillRow, error) {
	s.sym = symbol
	return s.rows, s.err
}

func (s *spyFills) ExportFills(_ context.Context, venue string, fromMs, toMs int64) ([]exec.ExportFillRow, error) {
	s.exportVenue, s.exportFromMs, s.exportToMs = venue, fromMs, toMs
	return s.exportRowsMulti, s.exportErr
}

type spyCandidateHistory struct {
	*spyFills
	oneMinute []feed.Bar
	daily     []feed.Bar
	oneErr    error
	dailyErr  error
	symbol    string
	oneLimit  int
	dayLimit  int
}

func (s *spyCandidateHistory) ReadRecentBars1m(symbol string, limit int) ([]feed.Bar, error) {
	s.symbol, s.oneLimit = symbol, limit
	return s.oneMinute, s.oneErr
}

func (s *spyCandidateHistory) ReadRecentDailyBars(symbol string, limit int) ([]feed.Bar, error) {
	s.symbol, s.dayLimit = symbol, limit
	return s.daily, s.dailyErr
}

func TestQueryCandidateHistoryReadsBoundedLocalArchive(t *testing.T) {
	now := time.Date(2026, 11, 6, 15, 0, 0, 0, time.UTC)
	archive := &spyCandidateHistory{
		spyFills:   &spyFills{},
		oneMinute:  []feed.Bar{{BucketMs: 1000, O: 1, H: 2, L: 0.5, C: 1.5, Volume: 1200}},
		daily:      []feed.Bar{{BucketMs: 2000, O: 2, H: 3, L: 1, C: 2.5, Volume: 25000}},
	}
	q := newQueries(archive, clock.NewFake(now))
	out := q.handleContext(context.Background(), "QueryCandidateHistory", json.RawMessage(`{"symbol":" us.test "}`))
	result, ok := out.(wsmsg.QueryCandidateHistoryResult)
	if !ok {
		t.Fatalf("expected wsmsg.QueryCandidateHistoryResult, got %T", out)
	}
	if result.Symbol != "US.TEST" || result.AsOfMs != now.UnixMilli() {
		t.Fatalf("query metadata = %+v", result)
	}
	if archive.symbol != "US.TEST" || archive.oneLimit != candidateHistoryOneMinuteLimit || archive.dayLimit != candidateHistoryDailyLimit {
		t.Fatalf("archive read was not normalized/bounded: %+v", archive)
	}
	if len(result.OneMinuteBars) != 1 || result.OneMinuteBars[0].Timeframe != "1m" ||
		result.OneMinuteBars[0].C != 1.5 || result.OneMinuteBars[0].InProgress {
		t.Fatalf("one-minute archive mapping = %+v", result.OneMinuteBars)
	}
	if len(result.DailyBars) != 1 || result.DailyBars[0].Timeframe != "D" ||
		result.DailyBars[0].C != 2.5 || result.DailyBars[0].InProgress {
		t.Fatalf("daily archive mapping = %+v", result.DailyBars)
	}
	if result.Error != "" {
		t.Fatalf("unexpected query error: %s", result.Error)
	}
}

func TestQueryCandidateHistoryReturnsPartialArchiveErrors(t *testing.T) {
	archive := &spyCandidateHistory{
		spyFills: &spyFills{},
		oneMinute: []feed.Bar{{BucketMs: 1000, C: 1}},
		dailyErr: errors.New("daily database unavailable"),
	}
	q := newQueries(archive, clock.NewFake(time.Now()))
	out := q.handle("QueryCandidateHistory", json.RawMessage(`{"symbol":"US.TEST"}`))
	result := out.(wsmsg.QueryCandidateHistoryResult)
	if len(result.OneMinuteBars) != 1 || len(result.DailyBars) != 0 ||
		!strings.Contains(result.Error, "daily database unavailable") {
		t.Fatalf("partial archive result = %+v", result)
	}
}

func TestQueryCandidateHistoryFailsClosedWithoutArchiveReader(t *testing.T) {
	q := newQueries(&spyFills{}, clock.NewFake(time.Now()))
	out := q.handle("QueryCandidateHistory", json.RawMessage(`{"symbol":"US.TEST"}`))
	result := out.(wsmsg.QueryCandidateHistoryResult)
	if result.Error == "" || len(result.OneMinuteBars) != 0 || len(result.DailyBars) != 0 {
		t.Fatalf("archive reader absence must be explicit: %+v", result)
	}
}

func TestQueryCandidateHistoryRejectsInvalidSymbol(t *testing.T) {
	archive := &spyCandidateHistory{spyFills: &spyFills{}}
	q := newQueries(archive, clock.NewFake(time.Now()))
	out := q.handle("QueryCandidateHistory", json.RawMessage(`{"symbol":"US. TEST"}`))
	result := out.(wsmsg.QueryCandidateHistoryResult)
	if result.Error == "" || archive.symbol != "" {
		t.Fatalf("invalid symbol reached archive reader: %+v", result)
	}
}

func TestQueryCandidateHistoryIsAsync(t *testing.T) {
	if !isAsyncQuery("QueryCandidateHistory") {
		t.Fatal("candidate history must run off the WebSocket reader")
	}
}

func TestQueryFillsReturnsFills(t *testing.T) {
	f := &spyFills{rows: []exec.FillRow{{OrderID: "ET1", Symbol: "US.AAPL", Side: "BUY", Qty: 100, Price: 3.47, TsMs: 5, Venue: "sim"}}}
	q := newQueries(f, clock.NewFake(time.Now()))
	out := q.handle("QueryFills", json.RawMessage(`{"symbol":"US.AAPL","fromMs":0,"toMs":9}`))
	fills, ok := out.([]wsmsg.Fill)
	if !ok || len(fills) != 1 {
		t.Fatalf("expected []wsmsg.Fill of len 1, got %T %v", out, out)
	}
	if fills[0].Side != wsmsg.SideBuy || fills[0].OrderID != "ET1" || f.sym != "US.AAPL" {
		t.Fatalf("fill map wrong: %+v (queried %q)", fills[0], f.sym)
	}
}

func TestQueryAppInfoReturnsVersion(t *testing.T) {
	q := newQueries(&spyFills{}, clock.NewFake(time.Now()))
	out := q.handle("QueryAppInfo", json.RawMessage(`{}`))
	info, ok := out.(wsmsg.AppInfo)
	if !ok || info.Version == "" {
		t.Fatalf("expected app info with version, got %T %+v", out, out)
	}
}

func TestQueryFillsEmptyOnError(t *testing.T) {
	q := newQueries(&spyFills{err: errors.New("boom")}, clock.NewFake(time.Now()))
	out := q.handle("QueryFills", json.RawMessage(`{"symbol":"X","fromMs":0,"toMs":1}`))
	b, _ := json.Marshal(out)
	if string(b) != "[]" {
		t.Fatalf("error must yield empty []wsmsg.Fill (never nil/hang); marshaled to %s", b)
	}
}

func TestQueryFillsMalformedArgsReturnsEmptySlice(t *testing.T) {
	q := newQueries(&spyFills{}, clock.NewFake(time.Now()))
	out := q.handle("QueryFills", json.RawMessage(`invalid-json`))
	b, _ := json.Marshal(out)
	if string(b) != "[]" {
		t.Fatalf("malformed args must yield empty []wsmsg.Fill (never nil/hang); marshaled to %s", b)
	}
}

func TestQueryUnknownReturnsEmptySlice(t *testing.T) {
	q := newQueries(&spyFills{}, clock.NewFake(time.Now()))
	out := q.handle("Nope", json.RawMessage(`{}`))
	b, _ := json.Marshal(out)
	if string(b) != "[]" {
		t.Fatalf("unknown query must resolve to []; marshaled to %s", b)
	}
}

func TestQueryStopLimitRouteIncludesOnlyTrustedEligiblePrint(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC))
	eligible := &spyEligiblePreview{value: exec.EligiblePrintPreview{Price: 101.25, TsMs: 1234, Trusted: true}}
	q := newQueries(&spyFills{}, clk)
	q.preview = eligible
	out := q.handleContext(context.Background(), "QueryStopLimitRoute", json.RawMessage(`{"tif":"DAY","session":"EXTENDED","symbol":"US.AAPL"}`))
	preview, ok := out.(wsmsg.StopLimitRoutePreview)
	if !ok || !preview.HasTrustedEligiblePrint || preview.LastEligiblePrice != 101.25 || preview.LastEligibleTsMs != 1234 || eligible.symbol != "US.AAPL" {
		t.Fatalf("trusted stop-limit preview = %T %+v (symbol %q)", out, out, eligible.symbol)
	}
	eligible.value.Trusted = false
	out = q.handleContext(context.Background(), "QueryStopLimitRoute", json.RawMessage(`{"tif":"DAY","session":"EXTENDED","symbol":"US.AAPL"}`))
	preview = out.(wsmsg.StopLimitRoutePreview)
	if preview.HasTrustedEligiblePrint || preview.LastEligiblePrice != 0 || preview.LastEligibleTsMs != 0 {
		t.Fatalf("untrusted print leaked into stop-limit preview: %+v", preview)
	}
}

func TestExportFillsReturnsCSV(t *testing.T) {
	f := &spyFills{exportRowsMulti: []exec.ExportFillRow{{FillID: 12, Symbol: "US.NVDA", Side: "BUY", Qty: 100, Price: 120.5, TsMs: 1789000000000, Venue: "sim"}}}
	clk := clock.NewFake(time.UnixMilli(1789000000000))
	q := newQueries(f, clk)
	out := q.handle("ExportFills", json.RawMessage(`{"venue":"sim","preset":"all"}`))
	res, ok := out.(wsmsg.ExportFillsResult)
	if !ok {
		t.Fatalf("expected wsmsg.ExportFillsResult, got %T %v", out, out)
	}
	if res.Count != 1 {
		t.Fatalf("Count = %d, want 1", res.Count)
	}
	if !strings.Contains(res.CSV, "datetime,symbol,action,price,shares,fees,externalId") {
		t.Fatalf("CSV missing header: %q", res.CSV)
	}
	if !strings.Contains(res.CSV, "etape:sim:12") {
		t.Fatalf("CSV missing mapped row: %q", res.CSV)
	}
	if f.exportVenue != "sim" {
		t.Fatalf("ExportFills called with venue %q, want %q", f.exportVenue, "sim")
	}
}

func TestExportFillsMalformedArgsReturnsEmptyResult(t *testing.T) {
	q := newQueries(&spyFills{}, clock.NewFake(time.Now()))
	out := q.handle("ExportFills", json.RawMessage(`invalid-json`))
	b, _ := json.Marshal(out)
	if string(b) != `{"csv":"","count":0}` {
		t.Fatalf("malformed args must yield empty ExportFillsResult (never nil/hang); marshaled to %s", b)
	}
}

func TestExportFillsEmptyOnStoreError(t *testing.T) {
	q := newQueries(&spyFills{exportErr: errors.New("boom")}, clock.NewFake(time.Now()))
	out := q.handle("ExportFills", json.RawMessage(`{"venue":"sim","preset":"all"}`))
	b, _ := json.Marshal(out)
	if string(b) != `{"csv":"","count":0}` {
		t.Fatalf("store error must yield empty ExportFillsResult; marshaled to %s", b)
	}
}

func TestExportFillsInvalidCustomRangeReturnsEmptyResult(t *testing.T) {
	q := newQueries(&spyFills{}, clock.NewFake(time.Now()))
	out := q.handle("ExportFills", json.RawMessage(`{"venue":"sim","preset":"custom","from":"2026-07-10","to":"2026-07-01"}`))
	b, _ := json.Marshal(out)
	if string(b) != `{"csv":"","count":0}` {
		t.Fatalf("invalid custom range (from after to) must yield empty ExportFillsResult; marshaled to %s", b)
	}
}

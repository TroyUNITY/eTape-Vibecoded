package alpaca

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/earlisreal/eTape/engine/internal/clock"
)

func TestHistoricalTradesPaginatesPreservesReportsAndClampsBasicSIP(t *testing.T) {
	now := time.Date(2026, 11, 2, 15, 0, 0, 0, time.UTC)
	firstAt := now.Add(-2 * time.Hour).Add(123 * time.Nanosecond)
	secondAt := firstAt.Add(time.Second)
	var requests int
	var gotStart, gotEnd string
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/stocks/ABC/trades", func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Header.Get("APCA-API-KEY-ID") != "KEY" || r.Header.Get("APCA-API-SECRET-KEY") != "SECRET" {
			t.Errorf("missing Alpaca auth headers")
		}
		if r.URL.Query().Get("feed") != "sip" || r.URL.Query().Get("limit") != "10000" || r.URL.Query().Get("sort") != "asc" {
			t.Errorf("unexpected query: %v", r.URL.Query())
		}
		gotStart, gotEnd = r.URL.Query().Get("start"), r.URL.Query().Get("end")
		if requests == 1 {
			if r.URL.Query().Get("page_token") != "" {
				t.Errorf("first page unexpectedly had token")
			}
			_, _ = w.Write([]byte(`{"trades":[{"t":"` + firstAt.Format(time.RFC3339Nano) + `","x":"V","p":1.2345,"s":100,"c":["@"],"i":11,"z":"C","u":"corrected"}],"next_page_token":"PAGE2"}`))
			return
		}
		if r.URL.Query().Get("page_token") != "PAGE2" {
			t.Errorf("page token = %q", r.URL.Query().Get("page_token"))
		}
		_, _ = w.Write([]byte(`{"trades":[{"t":"` + firstAt.Format(time.RFC3339Nano) + `","x":"V","p":1.2345,"s":100,"c":["@"],"i":11,"z":"C","u":"corrected"},{"t":"` + secondAt.Format(time.RFC3339Nano) + `","x":"Q","p":1.25,"s":200,"c":["I","@"],"i":12,"z":"C"}],"next_page_token":null}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := New(srv.URL, "KEY", "SECRET", "sip", clock.NewFake(now))
	from := now.Add(-3 * time.Hour)
	batch, err := c.HistoricalTrades(context.Background(), "US.ABC", from, now)
	if err != nil {
		t.Fatal(err)
	}
	if requests != 2 || batch.Pages != 2 || batch.RawTradeCount != 3 || batch.DuplicateCount != 1 || len(batch.Trades) != 2 {
		t.Fatalf("batch counts = requests:%d batch:%+v", requests, batch)
	}
	if !batch.RecencyClamped || !batch.EffectiveTo.Equal(now.Add(-basicSIPHistoryLag)) {
		t.Fatalf("SIP range not clamped safely: %+v", batch)
	}
	wantStart := from.Format(time.RFC3339Nano)
	wantEnd := now.Add(-basicSIPHistoryLag).Add(-time.Nanosecond).Format(time.RFC3339Nano)
	if gotStart != wantStart || gotEnd != wantEnd {
		t.Fatalf("range query start/end = %q / %q, want %q / %q", gotStart, gotEnd, wantStart, wantEnd)
	}
	if batch.Trades[0].ID != 11 || batch.Trades[0].Timestamp.Nanosecond() != 123 || batch.Trades[0].Update != "corrected" || batch.Trades[1].Conditions[0] != "I" || batch.Trades[1].Exchange != "Q" {
		t.Fatalf("trade reports lost precision/conditions: %+v", batch.Trades)
	}
}

func TestHistoricalTradesNoRequestWhenEntireRangeIsInsideBasicSIPDelay(t *testing.T) {
	now := time.Date(2026, 11, 2, 15, 0, 0, 0, time.UTC)
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests++ }))
	defer srv.Close()
	c := New(srv.URL, "K", "S", "sip", clock.NewFake(now))
	from := now.Add(-10 * time.Minute)
	batch, err := c.HistoricalTrades(context.Background(), "ABC", from, now)
	if err != nil || len(batch.Trades) != 0 || batch.Pages != 0 || requests != 0 {
		t.Fatalf("empty clamped range batch=%+v err=%v requests=%d", batch, err, requests)
	}
	if !batch.RecencyClamped || !batch.EffectiveTo.Equal(now.Add(-basicSIPHistoryLag)) {
		t.Fatalf("clamp diagnostics = %+v", batch)
	}
}

func TestHistoricalTradesIEXDoesNotApplySIPDelay(t *testing.T) {
	now := time.Date(2026, 11, 2, 15, 0, 0, 0, time.UTC)
	var gotEnd string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotEnd = r.URL.Query().Get("end")
		_, _ = w.Write([]byte(`{"trades":[],"next_page_token":""}`))
	}))
	defer srv.Close()
	c := New(srv.URL, "K", "S", "iex", clock.NewFake(now))
	batch, err := c.HistoricalTrades(context.Background(), "ABC", now.Add(-time.Hour), now)
	if err != nil || batch.RecencyClamped {
		t.Fatalf("IEX request unexpectedly SIP-clamped: %+v err=%v", batch, err)
	}
	if want := now.Add(-time.Nanosecond).Format(time.RFC3339Nano); gotEnd != want {
		t.Fatalf("IEX end = %q, want %q", gotEnd, want)
	}
}

func TestHistoricalTradesSurfacesHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"subscription does not permit querying SIP data"}`))
	}))
	defer srv.Close()
	now := time.Date(2026, 11, 2, 15, 0, 0, 0, time.UTC)
	c := New(srv.URL, "K", "S", "sip", clock.NewFake(now))
	_, err := c.HistoricalTrades(context.Background(), "ABC", now.Add(-time.Hour), now)
	if err == nil || !strings.Contains(err.Error(), "status=403") {
		t.Fatalf("expected surfaced 403, got %v", err)
	}
}

func TestHistoricalTradesKeepsSameIDFromDifferentExchanges(t *testing.T) {
	now := time.Date(2026, 11, 2, 15, 0, 0, 0, time.UTC)
	at := now.Add(-time.Hour)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"trades":[` +
			`{"t":"` + at.Format(time.RFC3339Nano) + `","x":"V","p":1.25,"s":100,"c":["@"],"i":7,"z":"C"},` +
			`{"t":"` + at.Format(time.RFC3339Nano) + `","x":"Q","p":1.25,"s":100,"c":["@"],"i":7,"z":"C"}` +
			`],"next_page_token":null}`))
	}))
	defer srv.Close()
	c := New(srv.URL, "K", "S", "sip", clock.NewFake(now))
	batch, err := c.HistoricalTrades(context.Background(), "ABC", at.Add(-time.Minute), at.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Trades) != 2 || batch.DuplicateCount != 0 {
		t.Fatalf("same exchange-local ID was conflated: %+v", batch)
	}
}

func TestHistoricalTradesPreservesChangedPayloadUnderSameTradeID(t *testing.T) {
	now := time.Date(2026, 11, 2, 15, 0, 0, 0, time.UTC)
	at := now.Add(-time.Hour)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"trades":[` +
			`{"t":"` + at.Format(time.RFC3339Nano) + `","x":"V","p":1.25,"s":100,"c":["@"],"i":7,"z":"C"},` +
			`{"t":"` + at.Format(time.RFC3339Nano) + `","x":"V","p":1.26,"s":100,"c":["C"],"i":7,"z":"C"},` +
			`{"t":"` + at.Format(time.RFC3339Nano) + `","x":"V","p":1.26,"s":100,"c":["C"],"i":7,"z":"C"}` +
			`],"next_page_token":null}`))
	}))
	defer srv.Close()
	c := New(srv.URL, "K", "S", "sip", clock.NewFake(now))
	batch, err := c.HistoricalTrades(context.Background(), "ABC", at.Add(-time.Minute), at.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Trades) != 2 || batch.IdentityConflictCount != 1 || batch.DuplicateCount != 1 {
		t.Fatalf("changed provider report was not retained/diagnosed: %+v", batch)
	}
}

func TestHistoricalTradesDoesNotGuessIdentityWhenTradeIDIsMissing(t *testing.T) {
	now := time.Date(2026, 11, 2, 15, 0, 0, 0, time.UTC)
	at := now.Add(-time.Hour)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"trades":[` +
			`{"t":"` + at.Format(time.RFC3339Nano) + `","x":"V","p":1.25,"s":100,"c":["@"],"z":"C"},` +
			`{"t":"` + at.Format(time.RFC3339Nano) + `","x":"V","p":1.25,"s":100,"c":["@"],"z":"C"}` +
			`],"next_page_token":null}`))
	}))
	defer srv.Close()
	c := New(srv.URL, "K", "S", "sip", clock.NewFake(now))
	batch, err := c.HistoricalTrades(context.Background(), "ABC", at.Add(-time.Minute), at.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Trades) != 2 || batch.DuplicateCount != 0 {
		t.Fatalf("reports without IDs were merged: %+v", batch)
	}
}

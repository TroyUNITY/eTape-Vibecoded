package filteredbars

import (
	"testing"
	"time"

	"github.com/earlisreal/eTape/engine/internal/feed"
	histalpaca "github.com/earlisreal/eTape/engine/internal/hist/alpaca"
	"github.com/earlisreal/eTape/engine/internal/hist/tradehistory"
)

func testRange() (time.Time, time.Time) {
	from := time.Date(2026, 11, 2, 14, 30, 0, 0, time.UTC)
	return from, from.Add(5 * time.Minute)
}

func localPrint(at time.Time, seq int64, price float64, size int64, condition feed.TradeReportCondition, delay time.Duration) feed.Tick {
	return feed.Tick{
		Symbol: "US.TEST", Seq: seq, TsMs: at.UnixMilli(), RecvTsMs: at.Add(delay).UnixMilli(),
		Price: price, Volume: size, Condition: condition,
	}
}

func historyWithLocal(from, to time.Time, ticks ...feed.Tick) tradehistory.Result {
	return tradehistory.Result{
		Symbol: "US.TEST", LocalPrints: ticks,
		Diagnostics: tradehistory.Diagnostics{RequestedFrom: from, RequestedTo: to, LocalCoverageReasons: []string{"coverage_unproven"}},
	}
}

func historyWithAlpaca(from, to, effectiveFrom, effectiveTo time.Time, trades ...histalpaca.Trade) tradehistory.Result {
	return tradehistory.Result{
		Symbol: "US.TEST", AlpacaTrades: trades,
		Diagnostics: tradehistory.Diagnostics{
			RequestedFrom: from, RequestedTo: to, AlpacaFeed: "sip",
			AlpacaEffectiveFrom: effectiveFrom, AlpacaEffectiveTo: effectiveTo,
			LocalCoverageReasons: []string{},
		},
	}
}

func alpacaTrade(at time.Time, id int64, price float64, size int64, tape string, conditions ...string) histalpaca.Trade {
	return histalpaca.Trade{Timestamp: at, ID: id, Price: price, Size: size, Tape: tape, Conditions: conditions}
}

func TestLocalPriceFiltersRetainConditionEligibleVolume(t *testing.T) {
	from, _ := testRange()
	to := from.Add(2 * time.Minute)
	trades := []feed.Tick{
		localPrint(from.Add(time.Second), 1, 9.90, 50, feed.TradeConditionAutomaticMatch, 100*time.Millisecond),
		localPrint(from.Add(10*time.Second), 2, 3.50, 150, feed.TradeConditionAutomaticMatch, 100*time.Millisecond),
		localPrint(from.Add(20*time.Second), 3, 8.00, 200, feed.TradeConditionAutomaticMatch, 20*time.Second),
		localPrint(from.Add(30*time.Second), 4, 7.00, 50, feed.TradeConditionOddLot, 100*time.Millisecond),
		localPrint(from.Add(time.Minute+10*time.Second), 5, 3.60, 100, feed.TradeConditionAutomaticMatch, 100*time.Millisecond),
	}

	got, err := Build(historyWithLocal(from, to, trades...), DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.OneMinute) != 2 {
		t.Fatalf("1m bars = %d, want 2: %+v", len(got.OneMinute), got.OneMinute)
	}
	first := got.OneMinute[0]
	if first.O != 3.50 || first.H != 3.50 || first.L != 3.50 || first.C != 3.50 {
		t.Fatalf("small/late prints affected OHLC: %+v", first)
	}
	if first.Volume != 450 || first.VolumeTradeCount != 4 || first.PriceTradeCount != 1 {
		t.Fatalf("volume did not retain filtered reports: %+v", first)
	}
	if got.Diagnostics.LocalSmallPriceReports != 1 || got.Diagnostics.LocalLateReports != 1 {
		t.Fatalf("filter diagnostics = %+v", got.Diagnostics)
	}
	if !got.Diagnostics.LocalCoverageUnproven || got.Coverage[0].Complete {
		t.Fatalf("local evidence was incorrectly marked complete: %+v", got)
	}
}

func TestPriorReferencePriceDoesNotInferFirstOfDayFromRangeStart(t *testing.T) {
	from, _ := testRange()
	to := from.Add(time.Minute)
	tick := localPrint(from.Add(20*time.Second), 1, 11, 200, feed.TradeConditionPriorReferencePrice, 100*time.Millisecond)
	options := DefaultOptions()
	options.AnchorPrice = 10
	options.AnchorTimeMs = from.Add(-time.Second).UnixMilli()
	got, err := Build(historyWithLocal(from, to, tick), options)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.OneMinute) != 1 {
		t.Fatalf("1m bars = %d, want 1", len(got.OneMinute))
	}
	bar := got.OneMinute[0]
	if bar.O != 10 || bar.H != 11 || bar.L != 10 || bar.C != 10 {
		t.Fatalf("range-scoped prior-reference report changed the close: %+v", bar)
	}
	if got.Diagnostics.LocalFirstOfDayLastUnverifiable != 1 {
		t.Fatalf("first-of-day diagnostic = %+v", got.Diagnostics)
	}
}

func TestAlpacaConditionsAndTradeUpdatesAreApplied(t *testing.T) {
	from, _ := testRange()
	to := from.Add(time.Minute)
	trades := []histalpaca.Trade{
		alpacaTrade(from.Add(time.Second), 1, 10.00, 1_000, "C", "@"),
		alpacaTrade(from.Add(2*time.Second), 2, 99.00, 300, "C", "@", "I"), // odd lot flag: volume only
		alpacaTrade(from.Add(3*time.Second), 3, 12.00, 50, "C", "@"),       // under 100: volume only
		{Timestamp: from.Add(4 * time.Second), ID: 4, Price: 200, Size: 900, Tape: "C", Conditions: []string{"@"}, Update: "canceled"},
		{Timestamp: from.Add(5 * time.Second), ID: 5, Price: 201, Size: 800, Tape: "C", Conditions: []string{"@"}, Update: "incorrect"},
		{Timestamp: from.Add(6 * time.Second), ID: 6, Price: 10.20, Size: 100, Tape: "C", Conditions: []string{"@"}, Update: "corrected"},
		alpacaTrade(from.Add(7*time.Second), 7, 300, 100, "C", "M"), // official close: no minute-bar update
		alpacaTrade(from.Add(8*time.Second), 8, 400, 100, "C", "?"), // unknown condition fails closed
	}
	input := historyWithAlpaca(from, to, from, to, trades...)
	got, err := Build(input, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.OneMinute) != 1 {
		t.Fatalf("1m bars = %d, want 1", len(got.OneMinute))
	}
	bar := got.OneMinute[0]
	if bar.O != 10 || bar.H != 10.20 || bar.L != 10 || bar.C != 10.20 {
		t.Fatalf("Alpaca condition/update price filter = %+v", bar)
	}
	if bar.Volume != 1_450 || bar.VolumeTradeCount != 4 || bar.PriceTradeCount != 2 {
		t.Fatalf("Alpaca volume handling = %+v", bar)
	}
	d := got.Diagnostics
	if d.AlpacaCanceledOrIncorrect != 2 || d.AlpacaUnknownConditions != 1 || d.AlpacaConditionExcluded != 1 || d.AlpacaSmallPriceReports != 1 {
		t.Fatalf("Alpaca diagnostics = %+v", d)
	}
	if !bar.CoverageComplete || !got.Diagnostics.AlpacaLatencyRuleUnavailable {
		t.Fatalf("coverage/latency caveats = %+v", got)
	}
}

func TestSourcePrecedenceAvoidsCrossFeedDoubleCounting(t *testing.T) {
	from, _ := testRange()
	to := from.Add(3 * time.Minute)
	alpacaTradeOne := alpacaTrade(from.Add(10*time.Second), 1, 10, 100, "C", "@")
	local := []feed.Tick{
		localPrint(from.Add(20*time.Second), 2, 99, 1_000, feed.TradeConditionAutomaticMatch, 100*time.Millisecond),
		localPrint(from.Add(time.Minute+10*time.Second), 3, 11, 1_000, feed.TradeConditionAutomaticMatch, 100*time.Millisecond),
	}
	input := historyWithAlpaca(from, to, from, from.Add(time.Minute), alpacaTradeOne)
	input.LocalPrints = local
	input.Diagnostics.LocalCoverageReasons = []string{"coverage_unproven"}

	got, err := Build(input, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.OneMinute) != 2 {
		t.Fatalf("bars = %+v", got.OneMinute)
	}
	if got.OneMinute[0].Source != SourceAlpacaSIP || got.OneMinute[0].Volume != 100 || got.OneMinute[0].H != 10 {
		t.Fatalf("full Alpaca minute did not take precedence: %+v", got.OneMinute[0])
	}
	if got.OneMinute[1].Source != SourceTickStore || got.OneMinute[1].Volume != 1_000 || got.OneMinute[1].C != 11 {
		t.Fatalf("local fallback minute was not used: %+v", got.OneMinute[1])
	}
	if got.Diagnostics.SelectedAlpacaReports != 1 || got.Diagnostics.SelectedLocalReports != 1 {
		t.Fatalf("source-selection diagnostics = %+v", got.Diagnostics)
	}
}

func TestFiveMinuteBarsFoldTheSelectedOneMinuteBars(t *testing.T) {
	from, _ := testRange()
	to := from.Add(5 * time.Minute)
	trades := make([]histalpaca.Trade, 0, 5)
	for i := int64(0); i < 5; i++ {
		trades = append(trades, alpacaTrade(from.Add(time.Duration(i)*time.Minute+time.Second), i+1, 10+float64(i), 100, "C", "@"))
	}
	got, err := Build(historyWithAlpaca(from, to, from, to, trades...), DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.OneMinute) != 5 || len(got.FiveMinute) != 1 {
		t.Fatalf("1m=%d 5m=%d", len(got.OneMinute), len(got.FiveMinute))
	}
	bar := got.FiveMinute[0]
	if bar.O != 10 || bar.H != 14 || bar.L != 10 || bar.C != 14 || bar.Volume != 500 {
		t.Fatalf("5m fold = %+v", bar)
	}
	if bar.Source != SourceAlpacaSIP || !bar.CoverageComplete {
		t.Fatalf("5m source/coverage = %+v", bar)
	}
}

func TestVolumeOnlyMinuteUsesPriorTrustedPriceAnchor(t *testing.T) {
	from, _ := testRange()
	to := from.Add(2 * time.Minute)
	trades := []feed.Tick{
		localPrint(from.Add(time.Second), 1, 10, 100, feed.TradeConditionAutomaticMatch, 100*time.Millisecond),
		localPrint(from.Add(time.Minute+time.Second), 2, 99, 50, feed.TradeConditionOddLot, 100*time.Millisecond),
	}
	got, err := Build(historyWithLocal(from, to, trades...), DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.OneMinute) != 2 {
		t.Fatalf("bars = %+v", got.OneMinute)
	}
	bar := got.OneMinute[1]
	if !bar.VolumeOnly || bar.Volume != 50 || bar.O != 10 || bar.H != 10 || bar.L != 10 || bar.C != 10 {
		t.Fatalf("volume-only bar = %+v", bar)
	}
}

func TestAlpacaTapeSpecificConditionRulesFailClosed(t *testing.T) {
	cases := []struct {
		code, tape                       string
		wantPrice, wantVolume, wantKnown bool
	}{
		{" ", "A", true, true, true},
		{"@", "C", true, true, true},
		{"B", "A", false, true, true},
		{"B", "C", true, true, true},
		{"I", "C", false, true, true},
		{"T", "C", true, true, true}, // Alpaca SIP minute-bar T condition is price-forming.
		{"?", "C", false, false, false},
		{"@", "N", false, false, false},
	}
	for _, tc := range cases {
		p, v, known := alpacaEligibility([]string{tc.code}, tc.tape)
		if p != tc.wantPrice || v != tc.wantVolume || known != tc.wantKnown {
			t.Errorf("condition %q tape %q = (%v,%v,%v), want (%v,%v,%v)", tc.code, tc.tape, p, v, known, tc.wantPrice, tc.wantVolume, tc.wantKnown)
		}
	}
}

func TestAlpacaNonSIPFeedIsNotGivenSIPSemantics(t *testing.T) {
	from, _ := testRange()
	to := from.Add(time.Minute)
	input := historyWithAlpaca(from, to, from, to, alpacaTrade(from.Add(time.Second), 1, 10, 100, "C", "@"))
	input.Diagnostics.AlpacaFeed = "iex"
	got, err := Build(input, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.OneMinute) != 0 || !got.Diagnostics.AlpacaUnsupportedFeed {
		t.Fatalf("non-SIP feed was incorrectly treated as SIP: %+v", got)
	}
}

func TestBuildUsesNanosecondAlpacaRangeBoundaries(t *testing.T) {
	from, _ := testRange()
	from = from.Add(500 * time.Nanosecond)
	to := from.Add(time.Minute)
	before := from.Add(-time.Nanosecond)
	inside := from.Add(time.Second)
	trades := []histalpaca.Trade{
		alpacaTrade(before, 1, 99, 100, "C", "@"),
		alpacaTrade(inside, 2, 10, 100, "C", "@"),
	}
	got, err := Build(historyWithAlpaca(from, to, from, to, trades...), DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.OneMinute) != 1 || got.OneMinute[0].O != 10 || got.OneMinute[0].C != 10 || got.OneMinute[0].ReportCount != 1 {
		t.Fatalf("trade outside precise [from,to) leaked into bar: %+v", got)
	}
}

func TestZeroSizeLocalReportIsInvalidNotVolume(t *testing.T) {
	from, _ := testRange()
	to := from.Add(time.Minute)
	ticks := []feed.Tick{localPrint(from.Add(time.Second), 1, 10, 0, feed.TradeConditionAutomaticMatch, 100*time.Millisecond)}
	got, err := Build(historyWithLocal(from, to, ticks...), DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.OneMinute) != 0 || got.Diagnostics.LocalInvalidReports != 1 {
		t.Fatalf("zero-size report was counted: %+v", got)
	}
}

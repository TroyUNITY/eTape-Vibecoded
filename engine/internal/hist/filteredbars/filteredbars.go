// Package filteredbars reconstructs optional chart-only 1m and 5m candles
// from individual Alpaca SIP trades and locally archived OpenD prints.
// It never mutates the official Moomoo K-line series or execution prices.
package filteredbars

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/earlisreal/eTape/engine/internal/feed"
	histalpaca "github.com/earlisreal/eTape/engine/internal/hist/alpaca"
	"github.com/earlisreal/eTape/engine/internal/hist/tradehistory"
	"github.com/earlisreal/eTape/engine/internal/md"
)

const (
	MinuteMillis     int64 = 60_000
	FiveMinuteMillis int64 = 5 * MinuteMillis
)

// Source identifies the single provider selected for a minute. Alpaca and
// OpenD reports are never concatenated inside one minute because their IDs
// and timestamp precision are not interchangeable.
type Source string

const (
	SourceNone          Source = "none"
	SourceAlpacaSIP     Source = "alpaca_sip"
	SourceTickStore     Source = "tickstore"
	SourceAlpacaPartial Source = "alpaca_partial"
	SourceMixed         Source = "mixed"
)

// Options controls the price-forming filters. Volume eligibility is separate:
// small and late reports may still contribute volume when their condition
// permits it.
type Options struct {
	MinimumPriceSize  int64
	MaxLocalReportAge time.Duration
	AnchorPrice       float64
	AnchorTimeMs      int64
}

func DefaultOptions() Options {
	return Options{MinimumPriceSize: 100, MaxLocalReportAge: 20 * time.Second}
}

// Bar is a reconstructed candle. Volume is the sum of all volume-eligible
// reports, not only the reports admitted to OHLC. PriceTradeCount and
// VolumeTradeCount preserve that distinction for diagnostics and tooltips.
type Bar struct {
	BucketMs         int64   `json:"bucketMs"`
	O                float64 `json:"o"`
	H                float64 `json:"h"`
	L                float64 `json:"l"`
	C                float64 `json:"c"`
	Volume           int64   `json:"volume"`
	PriceTradeCount  int64   `json:"priceTradeCount"`
	VolumeTradeCount int64   `json:"volumeTradeCount"`
	ReportCount      int64   `json:"reportCount"`
	VolumeOnly       bool    `json:"volumeOnly,omitempty"`
	Source           Source  `json:"source"`
	CoverageComplete bool    `json:"coverageComplete"`
}

// MinuteCoverage describes the source decision even when a minute had no
// eligible reports and therefore emitted no candle.
type MinuteCoverage struct {
	BucketMs    int64  `json:"bucketMs"`
	Source      Source `json:"source"`
	Complete    bool   `json:"complete"` // true only for a successful, fully-covered Alpaca minute
	ReportCount int64  `json:"reportCount"`
	Emitted     bool   `json:"emitted"`
}

// Diagnostics counts the records which were considered and the filters that
// affected price/volume. Local coverage remains unproven unless TickStore can
// provide explicit continuous-capture evidence in a future stage.
type Diagnostics struct {
	AlpacaInputReports                 int64    `json:"alpacaInputReports"`
	LocalInputReports                  int64    `json:"localInputReports"`
	SelectedAlpacaReports              int64    `json:"selectedAlpacaReports"`
	SelectedLocalReports               int64    `json:"selectedLocalReports"`
	AlpacaCanceledOrIncorrect          int64    `json:"alpacaCanceledOrIncorrect"`
	AlpacaUnknownUpdates               int64    `json:"alpacaUnknownUpdates"`
	AlpacaUnknownConditions            int64    `json:"alpacaUnknownConditions"`
	AlpacaConditionExcluded            int64    `json:"alpacaConditionExcluded"`
	AlpacaSmallPriceReports            int64    `json:"alpacaSmallPriceReports"`
	LocalConditionExcluded             int64    `json:"localConditionExcluded"`
	LocalSmallPriceReports             int64    `json:"localSmallPriceReports"`
	LocalLateReports                   int64    `json:"localLateReports"`
	LocalReceiptTimeUnknown            int64    `json:"localReceiptTimeUnknown"`
	LocalFirstOfDayLastUnverifiable    int64    `json:"localFirstOfDayLastUnverifiable"`
	LocalInvalidReports                int64    `json:"localInvalidReports"`
	VolumeOnlyBars                     int64    `json:"volumeOnlyBars"`
	VolumeOnlyBarsWithoutAnchor        int64    `json:"volumeOnlyBarsWithoutAnchor"`
	RangeOnlyBarsWithoutAnchor         int64    `json:"rangeOnlyBarsWithoutAnchor"`
	BarsSuppressedWithoutTrustedAnchor int64    `json:"barsSuppressedWithoutTrustedAnchor"`
	AlpacaFeed                         string   `json:"alpacaFeed,omitempty"`
	AlpacaEffectiveFromMs              int64    `json:"alpacaEffectiveFromMs,omitempty"`
	AlpacaEffectiveToMs                int64    `json:"alpacaEffectiveToMs,omitempty"`
	AlpacaUnsupportedFeed              bool     `json:"alpacaUnsupportedFeed"`
	AlpacaLatencyRuleUnavailable       bool     `json:"alpacaLatencyRuleUnavailable"`
	LocalCoverageUnproven              bool     `json:"localCoverageUnproven"`
	LocalCoverageReasons               []string `json:"localCoverageReasons"`
	AlpacaRecencyClamped               bool     `json:"alpacaRecencyClamped"`
}

type Result struct {
	Symbol      string           `json:"symbol"`
	OneMinute   []Bar            `json:"oneMinute"`
	FiveMinute  []Bar            `json:"fiveMinute"`
	Coverage    []MinuteCoverage `json:"coverage"`
	Diagnostics Diagnostics      `json:"diagnostics"`
}

type report struct {
	tsMs           int64
	tsNano         int64
	recvMs         int64
	seq            int64
	price          float64
	size           int64
	update         string
	conditionKnown bool
	rangeEligible  bool
	lastEligible   bool
	volumeEligible bool
}

type minuteInput struct {
	source   Source
	complete bool
	reports  []report
}

// Build selects one source per minute, reconstructs 1m OHLCV, then folds the
// resulting minute bars into 5m candles. A minute fully covered by a successful
// Alpaca query uses SIP exclusively; outside that interval, captured TickStore
// prints are preferred. Partial Alpaca rows are used only when no local rows
// exist for that minute and are explicitly tagged as partial.
func Build(history tradehistory.Result, options Options) (Result, error) {
	if strings.TrimSpace(history.Symbol) == "" {
		return Result{}, errors.New("filtered bars: symbol is required")
	}
	from, to := history.Diagnostics.RequestedFrom, history.Diagnostics.RequestedTo
	if from.IsZero() || to.IsZero() || !to.After(from) {
		return Result{}, errors.New("filtered bars: a valid requested time range is required")
	}
	if options.MinimumPriceSize <= 0 {
		options.MinimumPriceSize = DefaultOptions().MinimumPriceSize
	}
	if options.MaxLocalReportAge <= 0 {
		options.MaxLocalReportAge = DefaultOptions().MaxLocalReportAge
	}

	localCoverageReasons := append([]string(nil), history.Diagnostics.LocalCoverageReasons...)
	if len(localCoverageReasons) == 0 {
		localCoverageReasons = append(localCoverageReasons, "local_continuity_not_proven")
	}
	result := Result{
		Symbol:     history.Symbol,
		OneMinute:  []Bar{},
		FiveMinute: []Bar{},
		Coverage:   []MinuteCoverage{},
		Diagnostics: Diagnostics{
			AlpacaInputReports:    int64(len(history.AlpacaTrades)),
			LocalInputReports:     int64(len(history.LocalPrints)),
			LocalCoverageUnproven: true,
			LocalCoverageReasons:  localCoverageReasons,
			AlpacaFeed:            strings.ToLower(strings.TrimSpace(history.Diagnostics.AlpacaFeed)),
			AlpacaRecencyClamped:  history.Diagnostics.AlpacaRecencyClamped,
		},
	}
	if !history.Diagnostics.AlpacaEffectiveFrom.IsZero() {
		result.Diagnostics.AlpacaEffectiveFromMs = history.Diagnostics.AlpacaEffectiveFrom.UnixMilli()
	}
	if !history.Diagnostics.AlpacaEffectiveTo.IsZero() {
		result.Diagnostics.AlpacaEffectiveToMs = history.Diagnostics.AlpacaEffectiveTo.UnixMilli()
	}

	// Stamp raw archived OpenD reports with the live condition policy. TickStore
	// captures normalized prints before this pass. A range-scoped read cannot
	// prove first-of-business-day state, so that special last-sale status is
	// intentionally not inferred from the first report in the requested range.
	for _, tick := range history.LocalPrints {
		if tick.Condition == feed.TradeConditionPriorReferencePrice {
			result.Diagnostics.LocalFirstOfDayLastUnverifiable++
		}
	}
	localTicks := md.StampHistoricalTradeEligibility(history.LocalPrints)
	localByMinute := make(map[int64][]feed.Tick)
	for _, tick := range localTicks {
		tradeTime := time.UnixMilli(tick.TsMs)
		if tradeTime.Before(from) || !tradeTime.Before(to) {
			continue
		}
		bucket := minuteStart(tick.TsMs)
		localByMinute[bucket] = append(localByMinute[bucket], tick)
	}

	alpacaSIP := strings.EqualFold(strings.TrimSpace(history.Diagnostics.AlpacaFeed), "sip")
	if history.Diagnostics.AlpacaFeed != "" && !alpacaSIP && len(history.AlpacaTrades) > 0 {
		result.Diagnostics.AlpacaUnsupportedFeed = true
	}
	alpacaByMinute := make(map[int64][]histalpaca.Trade)
	for _, trade := range history.AlpacaTrades {
		if !alpacaSIP {
			continue
		}
		if trade.Timestamp.Before(from) || !trade.Timestamp.Before(to) {
			continue
		}
		ts := trade.Timestamp.UnixMilli()
		bucket := minuteStart(ts)
		alpacaByMinute[bucket] = append(alpacaByMinute[bucket], trade)
	}

	alpacaFailed := hasSourceError(history.Diagnostics.Errors, "alpaca")
	alpacaHealthy := alpacaSIP && !alpacaFailed &&
		!history.Diagnostics.AlpacaEffectiveFrom.IsZero() &&
		history.Diagnostics.AlpacaEffectiveTo.After(history.Diagnostics.AlpacaEffectiveFrom)
	result.Diagnostics.AlpacaLatencyRuleUnavailable = history.Diagnostics.AlpacaFeed != ""

	lastTrustedPrice, lastTrustedMs := options.AnchorPrice, options.AnchorTimeMs
	if !finitePositive(lastTrustedPrice) || (lastTrustedMs > 0 && time.UnixMilli(lastTrustedMs).After(from)) {
		lastTrustedPrice, lastTrustedMs = 0, 0
	}

	for bucket := minuteStart(from.UnixMilli()); time.UnixMilli(bucket).Before(to); bucket += MinuteMillis {
		localRows := localByMinute[bucket]
		alpacaRows := alpacaByMinute[bucket]
		minuteStartTime := time.UnixMilli(bucket)
		minuteEndTime := minuteStartTime.Add(time.Minute)
		alpacaComplete := alpacaHealthy &&
			!minuteStartTime.Before(history.Diagnostics.AlpacaEffectiveFrom) &&
			!minuteEndTime.After(history.Diagnostics.AlpacaEffectiveTo)

		input := minuteInput{source: SourceNone}
		coverage := MinuteCoverage{BucketMs: bucket, Source: SourceNone}
		switch {
		case alpacaComplete:
			input.source, input.complete = SourceAlpacaSIP, true
			input.reports = make([]report, 0, len(alpacaRows))
			for _, trade := range alpacaRows {
				input.reports = append(input.reports, reportFromAlpaca(trade))
			}
			result.Diagnostics.SelectedAlpacaReports += int64(len(alpacaRows))
		case len(localRows) > 0:
			input.source = SourceTickStore
			input.reports = make([]report, 0, len(localRows))
			for _, tick := range localRows {
				input.reports = append(input.reports, reportFromLocal(tick))
			}
			result.Diagnostics.SelectedLocalReports += int64(len(localRows))
		case len(alpacaRows) > 0:
			input.source = SourceAlpacaPartial
			input.reports = make([]report, 0, len(alpacaRows))
			for _, trade := range alpacaRows {
				input.reports = append(input.reports, reportFromAlpaca(trade))
			}
			result.Diagnostics.SelectedAlpacaReports += int64(len(alpacaRows))
		}

		coverage.Source = input.source
		coverage.Complete = input.complete
		coverage.ReportCount = int64(len(input.reports))
		if input.source != SourceNone {
			bar, emitted, nextPrice, nextPriceMs, err := buildMinute(bucket, input, lastTrustedPrice, lastTrustedMs, options, &result.Diagnostics)
			if err != nil {
				return Result{}, err
			}
			lastTrustedPrice, lastTrustedMs = nextPrice, nextPriceMs
			if emitted {
				result.OneMinute = append(result.OneMinute, bar)
				coverage.Emitted = true
				if bar.VolumeOnly {
					result.Diagnostics.VolumeOnlyBars++
				}
			}
		}
		result.Coverage = append(result.Coverage, coverage)
	}

	five, err := foldFiveMinute(result.OneMinute, result.Coverage)
	if err != nil {
		return Result{}, err
	}
	result.FiveMinute = five
	return result, nil
}

func reportFromLocal(tick feed.Tick) report {
	recvMs := tick.RecvTsMs
	if recvMs <= 0 {
		recvMs = tick.SourceRef().ReceiptMs
	}
	return report{
		tsMs: tick.TsMs, tsNano: tick.TsMs * int64(time.Millisecond), recvMs: recvMs,
		seq: tick.Seq, price: tick.Price, size: tick.Volume,
		rangeEligible: tick.RangeEligible, lastEligible: tick.LastEligible,
		volumeEligible: tick.VolumeEligible, conditionKnown: true,
	}
}

func reportFromAlpaca(trade histalpaca.Trade) report {
	priceAllowed, volumeAllowed, known := alpacaEligibility(trade.Conditions, trade.Tape)
	return report{
		tsMs: trade.Timestamp.UnixMilli(), tsNano: trade.Timestamp.UnixNano(),
		seq: trade.ID, price: trade.Price, size: trade.Size, update: strings.ToLower(strings.TrimSpace(trade.Update)),
		conditionKnown: known, rangeEligible: priceAllowed, lastEligible: priceAllowed, volumeEligible: volumeAllowed,
	}
}

func buildMinute(bucket int64, input minuteInput, anchorPrice float64, anchorMs int64, options Options, diagnostics *Diagnostics) (Bar, bool, float64, int64, error) {
	reports := append([]report(nil), input.reports...)
	sort.SliceStable(reports, func(i, j int) bool {
		if reports[i].tsNano == reports[j].tsNano {
			return reports[i].seq < reports[j].seq
		}
		return reports[i].tsNano < reports[j].tsNano
	})

	bar := Bar{BucketMs: bucket, Source: input.source, CoverageComplete: input.complete}
	hasRange, hasLast := false, false
	var rangeHigh, rangeLow, firstLast, last float64
	var volume, priceCount, volumeCount, reportCount int64
	trustedPrice, trustedMs := anchorPrice, anchorMs
	anchorAtMinuteStart := anchorPrice
	if anchorMs > 0 && anchorMs >= bucket {
		anchorAtMinuteStart = 0
	}

	for _, r := range reports {
		reportCount++
		if input.source != SourceTickStore {
			switch r.update {
			case "", "corrected":
			case "canceled", "incorrect":
				diagnostics.AlpacaCanceledOrIncorrect++
				continue
			default:
				diagnostics.AlpacaUnknownUpdates++
				continue
			}
			if !r.conditionKnown {
				diagnostics.AlpacaUnknownConditions++
				continue
			}
		}
		if r.size <= 0 || !finitePositive(r.price) {
			if input.source == SourceTickStore {
				diagnostics.LocalInvalidReports++
			}
			continue
		}

		rangeAllowed, lastAllowed := r.rangeEligible, r.lastEligible
		if input.source == SourceTickStore {
			// TickStore normally preserves OpenD's provider receive timestamp in
			// RecvTsMs. SourceRef.ReceiptMs is only a live-delivery fallback.
			// If neither exists, keep the print but make the uncertainty visible.
			if r.recvMs <= 0 {
				diagnostics.LocalReceiptTimeUnknown++
			} else if r.recvMs-r.tsMs >= options.MaxLocalReportAge.Milliseconds() {
				rangeAllowed, lastAllowed = false, false
				diagnostics.LocalLateReports++
			}
		}

		if (rangeAllowed || lastAllowed) && r.size < options.MinimumPriceSize {
			rangeAllowed, lastAllowed = false, false
			if input.source == SourceTickStore {
				diagnostics.LocalSmallPriceReports++
			} else {
				diagnostics.AlpacaSmallPriceReports++
			}
		}
		if input.source == SourceTickStore && !rangeAllowed && !lastAllowed && !r.volumeEligible {
			diagnostics.LocalConditionExcluded++
		}
		if input.source != SourceTickStore && !r.rangeEligible && !r.volumeEligible {
			// Alpaca unknown/cancelled reports were counted by the dedicated
			// policy diagnostics before this stage; regular excluded conditions
			// are tracked separately from unknown flags.
			diagnostics.AlpacaConditionExcluded++
		}

		if rangeAllowed {
			if !hasRange {
				rangeHigh, rangeLow, hasRange = r.price, r.price, true
			} else {
				if r.price > rangeHigh {
					rangeHigh = r.price
				}
				if r.price < rangeLow {
					rangeLow = r.price
				}
			}
		}
		if lastAllowed {
			if !hasLast {
				firstLast, hasLast = r.price, true
			}
			last = r.price
			trustedPrice, trustedMs = r.price, r.tsMs
		}
		if r.volumeEligible {
			if r.size > math.MaxInt64-volume {
				return Bar{}, false, anchorPrice, anchorMs, fmt.Errorf("filtered bars: volume overflow in minute %d", bucket)
			}
			volume += r.size
			volumeCount++
		}
		if rangeAllowed || lastAllowed {
			priceCount++
		}
	}

	bar.Volume, bar.PriceTradeCount, bar.VolumeTradeCount, bar.ReportCount = volume, priceCount, volumeCount, reportCount
	anchorAvailable := finitePositive(anchorAtMinuteStart)
	if hasLast {
		bar.O, bar.C = firstLast, last
		bar.H, bar.L = firstLast, firstLast
	} else if anchorAvailable {
		bar.O, bar.H, bar.L, bar.C = anchorAtMinuteStart, anchorAtMinuteStart, anchorAtMinuteStart, anchorAtMinuteStart
	} else {
		// A range-only trade can change H/L, but it cannot establish open/close.
		// Without a prior trusted anchor, emitting a fabricated OHLC candle would
		// be misleading.
		if hasRange || volumeCount > 0 {
			diagnostics.BarsSuppressedWithoutTrustedAnchor++
			if hasRange && !hasLast {
				diagnostics.RangeOnlyBarsWithoutAnchor++
			}
			if volumeCount > 0 && !hasRange {
				diagnostics.VolumeOnlyBarsWithoutAnchor++
			}
		}
		return Bar{}, false, trustedPrice, trustedMs, nil
	}
	if hasRange {
		if rangeHigh > bar.H {
			bar.H = rangeHigh
		}
		if rangeLow < bar.L {
			bar.L = rangeLow
		}
	}
	bar.VolumeOnly = volumeCount > 0 && !hasRange && !hasLast
	return bar, true, trustedPrice, trustedMs, nil
}

func foldFiveMinute(oneMinute []Bar, coverage []MinuteCoverage) ([]Bar, error) {
	byBucket := make(map[int64][]Bar)
	for _, bar := range oneMinute {
		bucket := bar.BucketMs - bar.BucketMs%FiveMinuteMillis
		byBucket[bucket] = append(byBucket[bucket], bar)
	}
	coverageByBucket := make(map[int64][]MinuteCoverage)
	for _, minute := range coverage {
		bucket := minute.BucketMs - minute.BucketMs%FiveMinuteMillis
		coverageByBucket[bucket] = append(coverageByBucket[bucket], minute)
	}
	buckets := make([]int64, 0, len(byBucket))
	for bucket := range byBucket {
		buckets = append(buckets, bucket)
	}
	sort.Slice(buckets, func(i, j int) bool { return buckets[i] < buckets[j] })
	out := make([]Bar, 0, len(buckets))
	for _, bucket := range buckets {
		members := byBucket[bucket]
		sort.Slice(members, func(i, j int) bool { return members[i].BucketMs < members[j].BucketMs })
		fold := Bar{BucketMs: bucket, Source: SourceNone}
		sources := make(map[Source]struct{})
		for i, member := range members {
			if i == 0 {
				fold.O = member.O
				fold.C = member.C
				fold.H = member.H
				fold.L = member.L
			} else {
				fold.C = member.C
				if member.H > fold.H {
					fold.H = member.H
				}
				if member.L < fold.L {
					fold.L = member.L
				}
			}
			if member.Volume > math.MaxInt64-fold.Volume {
				return nil, fmt.Errorf("filtered bars: volume overflow in 5m bucket %d", bucket)
			}
			fold.Volume += member.Volume
			fold.PriceTradeCount += member.PriceTradeCount
			fold.VolumeTradeCount += member.VolumeTradeCount
			fold.ReportCount += member.ReportCount
			sources[member.Source] = struct{}{}
		}
		fold.VolumeOnly = fold.VolumeTradeCount > 0 && fold.PriceTradeCount == 0
		fold.CoverageComplete = true
		coverageRows := coverageByBucket[bucket]
		complete := 0
		for _, row := range coverageRows {
			if row.Complete {
				complete++
			} else {
				fold.CoverageComplete = false
			}
		}
		if len(coverageRows) != 5 || complete != 5 {
			fold.CoverageComplete = false
		}
		if len(sources) == 1 {
			for source := range sources {
				fold.Source = source
			}
		} else if len(sources) > 1 {
			fold.Source = SourceMixed
		}
		out = append(out, fold)
	}
	return out, nil
}

func hasSourceError(errorsIn []tradehistory.SourceError, source string) bool {
	for _, item := range errorsIn {
		if strings.EqualFold(item.Source, source) {
			return true
		}
	}
	return false
}

func minuteStart(ms int64) int64    { return time.UnixMilli(ms).Truncate(time.Minute).UnixMilli() }
func finitePositive(v float64) bool { return v > 0 && !math.IsNaN(v) && !math.IsInf(v, 0) }

// alpacaEligibility applies Alpaca's documented SIP minute-bar condition rules.
// All flags must permit price/volume (the strictest condition wins). Unknown
// condition/tape combinations fail closed rather than guessing across tapes.
func alpacaEligibility(conditions []string, tape string) (price, volume, known bool) {
	if len(conditions) == 0 {
		return false, false, false
	}
	price, volume, known = true, true, true
	tape = strings.ToUpper(strings.TrimSpace(tape))
	for _, code := range conditions {
		p, v, ok := alpacaCondition(code, tape)
		if !ok {
			return false, false, false
		}
		price = price && p
		volume = volume && v
	}
	return price, volume, known
}

func alpacaCondition(code, tape string) (price, volume, known bool) {
	allow := func(tapes string) bool { return len(tape) == 1 && strings.Contains(tapes, tape) }
	switch code {
	case "", " ": // Regular sale on CTS tapes A/B.
		return allow("AB"), allow("AB"), allow("AB")
	case "@": // Regular sale on UTP/OTC tapes C/O.
		return allow("CO"), allow("CO"), allow("CO")
	case "A":
		return true, true, tape == "C" // Acquisition
	case "B": // Average price on A/B; bunched trade on C.
		if tape == "C" {
			return true, true, true
		}
		return false, true, tape == "A" || tape == "B"
	case "C":
		return false, true, allow("ABCO") // Cash sale
	case "D":
		return true, true, tape == "C" // Distribution
	case "E":
		return true, true, allow("AB") // Automatic execution
	case "F":
		return true, true, allow("ABC") // Intermarket sweep
	case "G":
		return false, true, tape == "C" // Bunched sold, minute bars
	case "H":
		return false, true, allow("ABC") // Price variation
	case "I":
		return false, true, allow("ABCO") // Odd lot
	case "K":
		return true, true, allow("ABC") // Rule 127/155
	case "L":
		return true, true, allow("ABC") // Sold last
	case "M":
		return false, false, allow("ABC") // Market-center official close
	case "N":
		return false, true, allow("ABCO") // Next day
	case "O":
		return true, true, allow("ABC") // Market-center opening
	case "P":
		return false, true, allow("ABCO") // Prior reference price, minute bar
	case "Q":
		return false, false, allow("ABC") // Market-center official open
	case "R":
		return false, true, allow("ABCO") // Seller
	case "T": // Extended Hours Trade updates SIP minute bars.
		return allow("ABCO"), allow("ABCO"), allow("ABCO")
	case "U":
		return false, true, allow("ABCO") // Extended trading hours
	case "V":
		return false, true, allow("ABC") // Contingent
	case "W":
		return false, true, allow("CO") // Average price on OTC/Nasdaq
	case "X":
		return true, true, allow("ABC") // Cross trade
	case "Y":
		return true, true, tape == "C" // Yellow-flag regular
	case "Z":
		return false, true, allow("ABC") // Sold out of sequence, minute bar
	case "4":
		return false, true, allow("ABC") // Derivatively priced, minute bar
	case "5":
		return true, true, allow("ABC") // Market-center reopening
	case "6":
		return true, true, allow("ABC") // Market-center closing
	case "7":
		return false, true, allow("ABC") // Qualified contingent
	case "9":
		return false, false, allow("ABC") // Corrected consolidated close, minute bar
	default:
		return false, false, false
	}
}

// Package tradehistory loads individual trade reports from Alpaca and the
// local TickStore without conflating the providers' condition taxonomies or
// pretending their trade identities are interchangeable.
package tradehistory

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/earlisreal/eTape/engine/internal/feed"
	histalpaca "github.com/earlisreal/eTape/engine/internal/hist/alpaca"
	"github.com/earlisreal/eTape/engine/internal/session"
	"github.com/earlisreal/eTape/engine/internal/tickstore"
)

// AlpacaFetcher is the read-only individual-trade capability of the Alpaca
// historical data client.
type AlpacaFetcher interface {
	HistoricalTrades(context.Context, string, time.Time, time.Time) (histalpaca.TradeBatch, error)
}

// LocalReader reads normalized Reported Prints retained by TickStore.
type LocalReader interface {
	Read(context.Context, string, int64, int64) (tickstore.TradeRead, error)
}

// Service reads independent provider histories for the same requested range.
// A caller may supply either source; errors are returned alongside any
// successful partial result so a caller never has to discard useful evidence.
type Service struct {
	alpaca AlpacaFetcher
	local  LocalReader
}

// New creates a trade-history service over whichever read-only sources are
// available. At least one source must be non-nil before Fetch is called.
func New(alpaca AlpacaFetcher, local LocalReader) *Service {
	return &Service{alpaca: alpaca, local: local}
}

// SourceError identifies a provider that failed while the other source may
// still have returned usable evidence.
type SourceError struct {
	Source string
	Error  string
}

// Diagnostics is deliberately explicit about provider windows, row counts,
// local archive caveats and overlap. CandidateMatches is informational only:
// it does not remove rows because Alpaca and OpenD do not share a stable trade
// identifier or equivalent timestamp precision.
type Diagnostics struct {
	Symbol                      string
	RequestedFrom               time.Time
	RequestedTo                 time.Time
	AlpacaFeed                  string
	AlpacaEffectiveFrom         time.Time
	AlpacaEffectiveTo           time.Time
	AlpacaRecencyClamped        bool
	AlpacaPages                 int
	AlpacaRawCount              int
	AlpacaUniqueCount           int
	AlpacaDuplicateCount        int
	AlpacaIdentityConflictCount int
	AlpacaFirstTrade            time.Time
	AlpacaLastTrade             time.Time
	LocalAsOf                   time.Time
	LocalRawCount               int
	LocalUniqueCount            int
	LocalDuplicateCount         int
	LocalFirstPrint             time.Time
	LocalLastPrint              time.Time
	LocalCoverageReasons        []string
	Overlap                     bool
	OverlapFrom                 time.Time
	OverlapTo                   time.Time
	PotentialCrossFeedHits      int
	Errors                      []SourceError
}

// Result retains the two provider streams independently for Stage 2. Do not
// append LocalPrints and AlpacaTrades together before a time-bucket/source-
// precedence policy has decided how to treat intervals with incomplete local
// capture. Cross-provider candidate matches are reported, not silently
// discarded.
type Result struct {
	Symbol       string
	AlpacaTrades []histalpaca.Trade
	LocalPrints  []feed.Tick
	Diagnostics  Diagnostics
}

// Fetch loads [from, to) from both sources. The local query covers the full
// range, including the newest minutes; the Alpaca client applies its Basic
// SIP recency clamp and reports the shortened effective range.
func (s *Service) Fetch(ctx context.Context, symbol string, from, to time.Time) (Result, error) {
	return s.fetch(ctx, symbol, from, to, true)
}

// FetchLocal reads only the local TickStore archive. It is used for the first
// filtered-chart paint so a provider startup cooldown or a large Alpaca page
// walk cannot delay candles already captured on this machine.
func (s *Service) FetchLocal(ctx context.Context, symbol string, from, to time.Time) (Result, error) {
	return s.fetch(ctx, symbol, from, to, false)
}

func (s *Service) fetch(ctx context.Context, symbol string, from, to time.Time, includeAlpaca bool) (Result, error) {
	result := Result{
		AlpacaTrades: []histalpaca.Trade{},
		LocalPrints:  []feed.Tick{},
		Diagnostics: Diagnostics{
			RequestedFrom:        from,
			RequestedTo:          to,
			LocalCoverageReasons: []string{},
			Errors:               []SourceError{},
		},
	}
	canonical, err := canonicalSymbol(symbol)
	if err != nil {
		return result, err
	}
	if !to.After(from) {
		return result, errors.New("trade history: end must be after start")
	}
	result.Symbol = canonical
	result.Diagnostics.Symbol = canonical
	if s == nil || (s.local == nil && (!includeAlpaca || s.alpaca == nil)) {
		return result, errors.New("trade history: no requested history sources configured")
	}

	var wg sync.WaitGroup
	var alpacaBatch histalpaca.TradeBatch
	var localBatch tickstore.TradeRead
	var alpacaErr, localErr error
	if includeAlpaca && s.alpaca != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			alpacaBatch, alpacaErr = s.alpaca.HistoricalTrades(ctx, canonical, from, to)
		}()
	}
	if s.local != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			localBatch, localErr = s.local.Read(ctx, canonical, ceilUnixMilli(from), ceilUnixMilli(to))
		}()
	}
	wg.Wait()

	if includeAlpaca && s.alpaca != nil {
		result.AlpacaTrades = dedupeAlpaca(alpacaBatch.Trades)
		result.Diagnostics.AlpacaFeed = alpacaBatch.Feed
		result.Diagnostics.AlpacaEffectiveFrom = alpacaBatch.EffectiveFrom
		result.Diagnostics.AlpacaEffectiveTo = alpacaBatch.EffectiveTo
		result.Diagnostics.AlpacaRecencyClamped = alpacaBatch.RecencyClamped
		result.Diagnostics.AlpacaPages = alpacaBatch.Pages
		result.Diagnostics.AlpacaRawCount = alpacaBatch.RawTradeCount
		result.Diagnostics.AlpacaUniqueCount = len(result.AlpacaTrades)
		result.Diagnostics.AlpacaDuplicateCount = alpacaBatch.DuplicateCount + (len(alpacaBatch.Trades) - len(result.AlpacaTrades))
		result.Diagnostics.AlpacaIdentityConflictCount = alpacaBatch.IdentityConflictCount
		if len(result.AlpacaTrades) > 0 {
			result.Diagnostics.AlpacaFirstTrade = result.AlpacaTrades[0].Timestamp
			result.Diagnostics.AlpacaLastTrade = result.AlpacaTrades[len(result.AlpacaTrades)-1].Timestamp
		}
		if alpacaErr != nil {
			result.Diagnostics.Errors = append(result.Diagnostics.Errors, SourceError{Source: "alpaca", Error: alpacaErr.Error()})
		}
	}
	if s.local != nil {
		result.LocalPrints = dedupeLocal(localBatch.Prints)
		result.Diagnostics.LocalRawCount = len(localBatch.Prints)
		result.Diagnostics.LocalUniqueCount = len(result.LocalPrints)
		result.Diagnostics.LocalDuplicateCount = len(localBatch.Prints) - len(result.LocalPrints)
		result.Diagnostics.LocalCoverageReasons = append([]string(nil), localBatch.Reasons...)
		if localBatch.AsOfMs > 0 {
			result.Diagnostics.LocalAsOf = time.UnixMilli(localBatch.AsOfMs).UTC()
		}
		if len(result.LocalPrints) > 0 {
			result.Diagnostics.LocalFirstPrint = time.UnixMilli(result.LocalPrints[0].TsMs).UTC()
			result.Diagnostics.LocalLastPrint = time.UnixMilli(result.LocalPrints[len(result.LocalPrints)-1].TsMs).UTC()
		}
		if localErr != nil {
			result.Diagnostics.Errors = append(result.Diagnostics.Errors, SourceError{Source: "tickstore", Error: localErr.Error()})
		}
	}

	result.Diagnostics.Overlap, result.Diagnostics.OverlapFrom, result.Diagnostics.OverlapTo = overlapWindow(
		result.Diagnostics.AlpacaFirstTrade, result.Diagnostics.AlpacaLastTrade,
		result.Diagnostics.LocalFirstPrint, result.Diagnostics.LocalLastPrint,
	)
	result.Diagnostics.PotentialCrossFeedHits = countPotentialMatches(result.AlpacaTrades, result.LocalPrints)

	var failures []error
	if alpacaErr != nil {
		failures = append(failures, fmt.Errorf("alpaca history: %w", alpacaErr))
	}
	if localErr != nil {
		failures = append(failures, fmt.Errorf("tickstore history: %w", localErr))
	}
	return result, errors.Join(failures...)
}

func canonicalSymbol(symbol string) (string, error) {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	symbol = strings.TrimPrefix(symbol, "US.")
	if symbol == "" {
		return "", errors.New("trade history: symbol is required")
	}
	for _, r := range symbol {
		if !(r >= 'A' && r <= 'Z') && !(r >= '0' && r <= '9') && r != '.' && r != '-' {
			return "", fmt.Errorf("trade history: invalid symbol %q", symbol)
		}
	}
	return "US." + symbol, nil
}

func ceilUnixMilli(t time.Time) int64 {
	ms := t.UnixMilli()
	if t.Nanosecond()%int(time.Millisecond) != 0 {
		ms++
	}
	return ms
}

func dedupeAlpaca(in []histalpaca.Trade) []histalpaca.Trade {
	out := make([]histalpaca.Trade, 0, len(in))
	seen := make(map[string]struct{}, len(in))
	for _, trade := range in {
		trade.Conditions = append([]string(nil), trade.Conditions...)
		if trade.ID == 0 {
			// Without a stable provider ID, even byte-identical reports may
			// represent separate executions; keep them distinct.
			out = append(out, trade)
			continue
		}
		key := alpacaIdentity(trade)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, trade)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Timestamp.Equal(out[j].Timestamp) {
			return out[i].ID < out[j].ID
		}
		return out[i].Timestamp.Before(out[j].Timestamp)
	})
	return out
}

func alpacaIdentity(t histalpaca.Trade) string {
	return fmt.Sprintf("%d/%s/%d/%g/%d/%v/%s/%s", t.Timestamp.UnixNano(), t.Exchange, t.ID, t.Price, t.Size, t.Conditions, t.Tape, t.Update)
}

func dedupeLocal(in []feed.Tick) []feed.Tick {
	out := make([]feed.Tick, 0, len(in))
	seen := make(map[localIdentity]struct{}, len(in))
	for _, tick := range in {
		if tick.Seq != 0 {
			key := localIdentity{Day: session.DayMs(tick.TsMs), Seq: tick.Seq}
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
		}
		out = append(out, tick)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].TsMs == out[j].TsMs {
			return out[i].Seq < out[j].Seq
		}
		return out[i].TsMs < out[j].TsMs
	})
	return out
}

type localIdentity struct {
	Day int64
	Seq int64
}

func overlapWindow(aFirst, aLast, localFirst, localLast time.Time) (bool, time.Time, time.Time) {
	if aFirst.IsZero() || aLast.IsZero() || localFirst.IsZero() || localLast.IsZero() {
		return false, time.Time{}, time.Time{}
	}
	start := aFirst
	if localFirst.After(start) {
		start = localFirst
	}
	end := aLast
	if localLast.Before(end) {
		end = localLast
	}
	if end.Before(start) {
		return false, time.Time{}, time.Time{}
	}
	return true, start, end
}

type matchIdentity struct {
	TimestampMs int64
	PriceMicros int64
	Size        int64
}

func countPotentialMatches(alpaca []histalpaca.Trade, local []feed.Tick) int {
	localCounts := make(map[matchIdentity]int, len(local))
	for _, tick := range local {
		key := matchIdentity{TimestampMs: tick.TsMs, PriceMicros: int64(math.Round(tick.Price * 1_000_000)), Size: tick.Volume}
		localCounts[key]++
	}
	matches := 0
	for _, trade := range alpaca {
		key := matchIdentity{TimestampMs: trade.Timestamp.UnixMilli(), PriceMicros: int64(math.Round(trade.Price * 1_000_000)), Size: trade.Size}
		if localCounts[key] > 0 {
			localCounts[key]--
			matches++
		}
	}
	return matches
}

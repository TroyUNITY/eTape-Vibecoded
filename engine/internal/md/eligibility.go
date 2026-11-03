package md

import (
	"sort"
	"time"

	"github.com/earlisreal/eTape/engine/internal/feed"
	"github.com/earlisreal/eTape/engine/internal/session"
)

type lastEligibilityMode uint8

const (
	lastNever lastEligibilityMode = iota
	lastAlways
	lastFirstBusinessDay
	lastCutoff
)

type conditionPolicy struct {
	rangeEligible  bool
	lastMode       lastEligibilityMode
	volumeEligible bool
	extendedOnly   bool
}

func conditionPolicyFor(c feed.TradeReportCondition) conditionPolicy {
	switch c {
	case feed.TradeConditionAutomaticMatch,
		feed.TradeConditionIntermarketSweep,
		feed.TradeConditionAuction,
		feed.TradeConditionBunchedTrade,
		feed.TradeConditionRule127Or155,
		feed.TradeConditionMarketCenterOpening,
		feed.TradeConditionReopeningPrice,
		feed.TradeConditionClosingPrice:
		return conditionPolicy{rangeEligible: true, lastMode: lastAlways, volumeEligible: true}
	case feed.TradeConditionOddLot, feed.TradeConditionOddLotIntermarketSweep,
		feed.TradeConditionCashSale, feed.TradeConditionPriceVariation,
		feed.TradeConditionNextDaySettlement, feed.TradeConditionSeller,
		feed.TradeConditionContingent, feed.TradeConditionAveragePrice:
		return conditionPolicy{volumeEligible: true}
	case feed.TradeConditionBunchedSold, feed.TradeConditionPriorReferencePrice,
		feed.TradeConditionOTCSold, feed.TradeConditionDerivativelyPriced:
		return conditionPolicy{rangeEligible: true, lastMode: lastFirstBusinessDay, volumeEligible: true}
	case feed.TradeConditionDelayed:
		return conditionPolicy{rangeEligible: true, lastMode: lastCutoff, volumeEligible: true}
	case feed.TradeConditionMarketCenterOfficialClose, feed.TradeConditionMarketCenterOfficialOpen,
		feed.TradeConditionNonAutomaticMatch, feed.TradeConditionSameBrokerAutomaticMatch,
		feed.TradeConditionSameBrokerNonAutomaticMatch, feed.TradeConditionOverseas,
		feed.TradeConditionUnknown:
		return conditionPolicy{}
	case feed.TradeConditionCorrectedComprehensiveLatePrice:
		return conditionPolicy{rangeEligible: true, lastMode: lastAlways}
	case feed.TradeConditionLate, feed.TradeConditionFormT, feed.TradeConditionExtendedHours:
		return conditionPolicy{rangeEligible: true, lastMode: lastAlways, volumeEligible: true, extendedOnly: true}
	default:
		return conditionPolicy{}
	}
}

// eligibilityState is intentionally bounded to one symbol/day. The core is
// the only writer, so replay and live delivery use the same state transition.
type eligibilityState struct {
	day           int64
	lastSeenToday bool
}

func (s *eligibilityState) stamp(t feed.Tick) feed.Tick {
	day := session.DayMs(t.TsMs)
	if day != s.day {
		s.day = day
		s.lastSeenToday = false
	}

	p := conditionPolicyFor(t.Condition)
	extended := isExtendedSession(t.TsMs)
	priceAllowed := !p.extendedOnly || extended
	t.RangeEligible = p.rangeEligible && priceAllowed && t.Price > 0
	t.VolumeEligible = p.volumeEligible
	switch p.lastMode {
	case lastAlways:
		t.LastEligible = priceAllowed && t.Price > 0
	case lastFirstBusinessDay:
		t.LastEligible = !s.lastSeenToday && session.IsTradingDay(time.UnixMilli(t.TsMs)) && t.Price > 0
	case lastCutoff:
		t.LastEligible = t.Price > 0 && beforeLastSaleCutoff(t.TsMs)
	default:
		t.LastEligible = false
	}
	if t.LastEligible {
		s.lastSeenToday = true
	}
	return t
}

func isExtendedSession(tsMs int64) bool {
	switch session.PhaseAt(time.UnixMilli(tsMs)) {
	case session.PreMarket, session.PostMarket, session.Overnight:
		return true
	default:
		return false
	}
}

// UTP's last-sale control message follows the scheduled consolidated close;
// the repository calendar supplies the early-close-aware 90-second control
// window. Reports after it may remain visible and volume eligible, but cannot
// move consolidated last.
func beforeLastSaleCutoff(tsMs int64) bool {
	et := time.UnixMilli(tsMs).In(session.Loc())
	s := session.Schedule(et)
	return s.TradingDay && !et.After(s.Close.Add(90*time.Second))
}

// StampHistoricalTradeEligibility replays the live condition policy over a
// historical slice of raw normalized prints. The returned copy is sorted by
// exchange timestamp/sequence; the caller's slice is not mutated. The
// first-business-day-only last-sale rule is deliberately fail-closed because
// a range-scoped TickStore read cannot prove that it contains the day's first
// qualifying report. Its range and volume eligibility are still preserved.
func StampHistoricalTradeEligibility(ticks []feed.Tick) []feed.Tick {
	out := append([]feed.Tick(nil), ticks...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].TsMs == out[j].TsMs {
			return out[i].Seq < out[j].Seq
		}
		return out[i].TsMs < out[j].TsMs
	})
	states := make(map[string]*eligibilityState)
	for i := range out {
		state := states[out[i].Symbol]
		if state == nil {
			state = &eligibilityState{}
			states[out[i].Symbol] = state
		}
		policy := conditionPolicyFor(out[i].Condition)
		out[i] = state.stamp(out[i])
		if policy.lastMode == lastFirstBusinessDay {
			// A range-scoped archive read cannot prove that this is the first
			// qualifying report of the business day. Keep its range/volume
			// treatment, but do not let a mid-session query manufacture a new
			// first-of-day close.
			out[i].LastEligible = false
		}
	}
	return out
}

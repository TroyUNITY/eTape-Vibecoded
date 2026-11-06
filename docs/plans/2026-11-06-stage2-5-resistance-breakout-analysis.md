# Stage 2.5 — Candidate Resistance and Breakout Analysis

Date: 2026-11-06  
Branch: \`stage2-5-technical-analysis\`  
Depends on: Stage 2.4 bounded live one-minute monitoring

## Objective

Connect the existing Ross Candidates eligibility checks to two pieces of chart evidence that were previously left unknown:

1. Nearby overhead resistance, derived from completed daily candles.
2. A technical breakout, derived from completed one-minute candles and volume.

This stage adds descriptive technical analysis to candidate selection. It does not change scanner discovery, retention, live-monitor capacity, Trade Guard, or order behaviour.

## Resistance assessment

File: \`ui/src/strategy/candidateTechnicalAnalysis.ts\`

- Only completed daily candles before the current ET calendar date are considered. Current-day and in-progress daily candles are excluded.
- The detector examines up to the latest 60 completed daily sessions.
- It identifies confirmed daily swing highs using two candles on either side, and also includes the prior 20-day high as a resistance level.
- It selects the nearest resistance level at or above the current price.
- A level within 3% above the current price is marked as nearby and fails the existing no-nearby-resistance eligibility check.
- No overhead level above the current price, or a nearest level more than 3% away, passes that check.
- Fewer than 20 completed daily candles, invalid price/time, or otherwise insufficient evidence leaves the check unknown/PENDING.

The Warrior material names nearby resistance but does not prescribe a numeric proximity threshold or a particular swing-high algorithm. The 60-session search, two-candle pivot confirmation, 20-day high, and 3% proximity band are therefore explicit eTape implementation heuristics, not rules attributed to Ross Cameron.

## Intraday breakout assessment

The detector uses completed one-minute candles from the current ET calendar day and the US extended session (04:00–20:00 ET).

A breakout is confirmed only when both conditions are true:

1. The latest completed one-minute candle closes above the highest high of the previous 20 completed one-minute candles.
2. The latest candle's volume is at least 2.0 times the average volume of those preceding 20 candles.

A wick above the reference high without a close above it is not a breakout. A price close above the reference high without the volume confirmation is also not confirmed.

The latest completed candle must be no more than five minutes old. Missing, stale, or insufficient current-session history returns unknown rather than a negative breakout result. Earlier sessions are never combined to fill the current-session lookback.

The 20-bar lookback and 2.0x volume confirmation are eTape implementation heuristics. They are not thresholds specified by the supplied Warrior material.

## Candidate eligibility integration

- A qualifying fundamental/news catalyst continues to satisfy the catalyst check.
- When no qualifying fundamental catalyst has been identified, a confirmed technical breakout can satisfy the catalyst check.
- When current-session data is sufficient and no breakout is confirmed, the breakout evidence is explicitly negative, but the overall catalyst check remains unknown because absence of a qualifying headline is not proof that no fundamental catalyst exists.
- When current-session data is missing, stale, or insufficient, the breakout evidence and overall catalyst check remain unknown/PENDING.
- Nearby resistance is now populated from the daily resistance assessment. The eligibility evaluator remains fail-closed when resistance evidence is unknown.
- The panel displays the nearest resistance price and distance, plus the breakout state, reference high, close and volume multiple in the detector's explanatory detail.

The separate same-time-relative-volume eligibility rule remains unchanged. The intraday breakout's last-bar volume confirmation is not a substitute for the candidate's same-time RVOL calculation.

## Data and safety boundaries

- Uses the archived and live bars already available to the panel. It adds no provider, API key, database query, subscription profile, or subscription demand.
- Daily resistance and intraday breakout analysis do not create chart subscriptions.
- The existing five-minute freshness check continues to govern current one-minute data freshness.
- Moomoo OutstandingShares remains unverified and cannot satisfy free float.
- No orders are submitted. No Trade Guard or risk settings are changed.
- Missing and stale data remains unknown rather than being promoted to a pass.

## Validation

Unit tests cover:

- Nearby resistance from completed daily candles.
- No overhead resistance when price is above assessed levels.
- Unknown resistance with insufficient daily history.
- Exclusion of current-day and in-progress daily candles.
- Breakout close above the preceding 20-bar high with at least 2x average volume.
- Rejection of a price-only break without volume confirmation.
- Rejection of a wick that did not close above resistance.
- Unknown breakout when the latest completed candle is stale.
- No cross-session aggregation to manufacture the current-session lookback.

The Ross Candidates panel test verifies that both technical-analysis sections render for a candidate whose archived history is incomplete.

## Follow-on work

- Review the 3% resistance band, 20-bar breakout range and 2.0x volume confirmation against observed paper-trading examples before treating them as final strategy rules.
- Add user-visible configurability only after those thresholds have been reviewed.
- Investigate an approved, licensed free-float source. The Moomoo outstanding-share proxy remains pending.
- Consider richer chart structure (multiple resistance zones, volume profile, consolidation and pullback quality) as separate work rather than silently expanding this initial detector.


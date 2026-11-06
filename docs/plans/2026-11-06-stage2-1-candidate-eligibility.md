# Stage 2.1 — Ross Momentum Candidate Eligibility

Status: evaluator and unit tests added; scanner integration is not part of this change.

## Scope

Stage 2.1 establishes a deterministic, independently testable answer to one question:

> Does this candidate meet the general stock-selection criteria described in the Warrior Trading momentum material?

It does not identify chart setups, create or remove scanner subscriptions, retain candidates, or submit orders. Those behaviours belong to later stages.

## Initial profile

The default profile deliberately follows the general momentum-candidate criteria rather than combining them with every Gap and Go preference.

| Check | Default rule | Source / interpretation |
|---|---:|---|
| Price | $1.00 inclusive to below $20.00 | Technical Analysis Series, “Strategy Decision” small-account stock-selection section |
| Float | Strictly below 100 million shares | Day Trading Guide, Chapter 5.2 “Momentum” |
| Relative volume | At least 2× at the same time of day | Day Trading Guide, Chapter 5.2 “Momentum” |
| Daily trend | Price above EMA20, EMA50 and EMA200 | The momentum guide requires a strong daily chart above moving averages; the Technical Analysis Gap and Go discussion identifies the 20/50/200 EMAs |
| Overhead resistance | No nearby resistance | Day Trading Guide, Chapter 5.2 “Momentum” |
| Catalyst | Fundamental catalyst or technical breakout | Day Trading Guide, Chapter 5.2 “Momentum”; it explicitly notes that momentum can also occur without a fundamental catalyst and calls this a technical breakout |

The $1–below-$20 price range is Ross's stated small-account preference, not a universal rule for every strategy. The more restrictive Gap and Go preferences (including a 5% minimum gap, 20% preferred gap, float up to 50 million, and a $1.50–$10 preferred price range) are intentionally not applied to this general momentum profile.

The general profile also has no hard minimum percentage gap or session-volume floor: those are not part of the four general momentum-candidate criteria in Chapter 5.2. The candidate discovery sources can therefore remain broader, provided the candidate passes the eligibility checks above.

## Evaluator contract

File: `ui/src/strategy/candidateEligibility.ts`

The pure function `evaluateRossMomentumCandidate` receives:

- Current price.
- Float evidence, including its source.
- One-minute bars and an evaluation timestamp.
- Completed daily bars.
- An explicit assessment of nearby resistance.
- Explicit catalyst evidence: fundamental, technical breakout, none, or unknown.

It requires the latest one-minute candle to be no more than five minutes old (aligned with the existing Strategy Scanner prototype). Stale or missing intraday candles produce an unknown freshness check.\n\nIt returns per-condition checks, reasons, warnings, metrics and one of three statuses:

| Status | Meaning | Eligible for active monitoring? |
|---|---|---|
| `ELIGIBLE` | Every required check passed | Yes |
| `REJECTED` | At least one known criterion failed | No |
| `PENDING` | No known failure, but one or more required inputs are unknown | No |

A known failure takes precedence over unknown checks. Missing data never counts as a pass.

### Relative volume

The evaluator reuses Trade Guard's `sameTimeRelativeVolume` function. The default comparison window is 10 prior sessions, matching the existing Trade Guard default. The Warrior material specifies the same-time-of-day comparison and the 2× threshold, but does not prescribe a lookback count; the 10-session window is therefore an implementation default, not a claimed Ross rule.

The Scanner's daily REL VOL field is not substituted. That field is a daily-volume-to-daily-average calculation and is not time-of-day adjusted.

### Daily chart

The evaluator calculates EMA20, EMA50 and EMA200 from completed daily candles only. It requires 200 daily observations; otherwise the trend check is unknown. The current ET trading date is excluded to avoid using a partial daily candle.

Nearby resistance is an explicit input. The Warrior material names nearby resistance as a criterion but does not provide a numeric distance threshold, so this stage does not invent one. Until a reliable resistance assessment is supplied, the check remains unknown and the candidate stays pending.

### Float provenance

The current eTape `StockDetailPayload.floatShares` is sourced from Moomoo's `OutstandingShares` snapshot field. The provider documentation describes this as outstanding shares, but does not establish that it exactly matches Ross's definition of freely tradable float after excluding restricted insider/employee holdings.

For that reason, the evaluator only passes the float criterion when the input is explicitly marked `verified_free_float`. A value marked `moomoo_outstanding_shares` is returned as a pending check with a warning; it is not silently treated as verified float. This keeps data provenance visible and prevents an uncertain proxy from admitting a candidate.

## Tests

File: `ui/src/strategy/candidateEligibility.test.ts`

Coverage includes:

- A fully qualifying candidate.
- Inclusive/exclusive price and float boundaries.
- Missing and proxy float data.
- Same-time relative volume at and below 2×.
- Missing comparable intraday history.
- Insufficient daily history.
- Daily EMA trend failure.
- Nearby resistance present or unassessed.
- Fundamental and technical-breakout catalyst paths.
- Unknown catalyst evidence and known failures taking precedence.

## Deliberately deferred

- Combining Gainers, Most Active and Session Volume rows into a ranked candidate set.
- The monitoring pool, retention rules and capacity limits.
- A provider-backed verified free-float source or a user-approved policy for using Moomoo's outstanding-share value as a proxy.
- Automatic news-to-catalyst mapping and an automated nearby-resistance detector.
- Multi-stock chart-data warming and Trade Guard evaluation.
- Scanner columns, alerts and notifications.

Those are follow-on tasks. This first increment keeps the decision logic small enough to test before it is connected to the live scanner.

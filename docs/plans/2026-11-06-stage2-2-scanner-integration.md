# Stage 2.2 — Scanner Candidate Integration

Date: 2026-11-06
Branch: `filtered-development`

## Objective

Connect the Stage 2.1 Ross-style momentum eligibility evaluator to eTape's existing scanner discovery without changing Trade Guard, scanner ranking/filtering, subscriptions, or order behaviour.

## Delivered

- Added `ScannerStore.momentumCandidates()`.
  - Combines the freshest active Gainers, Most Active, and Session Volume board from each Scanner panel.
  - Deduplicates symbols while retaining all discovery modes and Scanner panel IDs.
  - Uses the newest available row when the same symbol appears on multiple boards.
  - Excludes Losers boards.
  - Includes delayed boards when they still have rows.
- Added the **Ross Candidates** panel to the panel catalogue.
  - Displays the merged candidate set, source boards, eligibility status, key metrics, and per-check reasoning.
  - Re-evaluates from the existing quote, bar, fundamentals, and news stores.
  - Does not submit orders, mutate scanner membership, or request new market-data subscriptions.
- Connected the Stage 2.1 evaluator to candidate rows.
  - The current quote is preferred, then the scanner row price, then Stock Info price.
  - Moomoo `OutstandingShares` from either scanner rows or Stock Info is always labelled and passed as `moomoo_outstanding_shares`, never as verified free float.
  - The existing Stock Info catalyst heuristic (score at least 50 and category not `other`) can establish a fundamental catalyst.
  - No matching headline remains `unknown`, not `none`, because a technical-breakout detector is not implemented.
  - Nearby resistance remains `null` / unknown; no unsupported proximity threshold is invented.
  - Same-time RVOL is calculated only from one-minute candles using the Stage 2.1 evaluator. The Scanner's daily REL VOL field is not substituted.

## Data availability boundary

The scanner's current subscription pool admits up to 30 symbols and warms their history in the local archive. However, `WarmArchive` explicitly does not seed or publish those candles into `md.Core` / the UI `BarStore`. Watch-tier scanner subscriptions also do not request a continuous one-minute K-line subscription.

Consequently, the panel can evaluate a symbol only to the extent the relevant quote and candles are already present in the UI stores (for example, after the symbol has been focused in a chart). Missing/stale one-minute data and missing completed daily history remain unknown and therefore produce `PENDING`, unless another known criterion has already failed. The panel does not claim to have evaluated every scanner candidate fully.

This is intentional fail-closed behaviour, not an implementation error. A separate bounded candidate-analysis data path is required before all scanner candidates can be assessed continuously without opening charts or consuming excessive market-data/history quota.

## Free-float provider decision

Moomoo's `OutstandingShares` remains an unverified proxy and cannot satisfy the free-float criterion.

Financial Modeling Prep (FMP) is the current preferred provider to investigate for production use because its Share Float endpoint documents both `freeFloat` and `floatShares`, returns `outstandingShares`, and includes a source filing URL. At the time of this plan, FMP lists the US-exchange Company Share Float & Liquidity dataset on its Starter plan. FMP's terms also state that displaying or redistributing sourced data requires a separate Data Display and Licensing Agreement. The application must not display FMP data until the appropriate terms are confirmed.

Intrinio is an alternative with an explicit public-float definition (outstanding shares less restricted holdings) and filing-based data, but its individual plan is substantially more expensive and may be less current between SEC filings.

No provider key, paid subscription, licensing agreement, or provider adapter has been configured in this stage. Until an approved source returns a current, attributable free-float value, float remains unknown and cannot produce an eligibility pass.

## Explicitly not delivered

- A server-side analysis path that reads archived daily and intraday history for every pooled candidate.
- Continuous one-minute K-line coverage for the scanner pool.
- An FMP or Intrinio API adapter, API-key storage, source validation, or licensing integration.
- A technical-breakout detector.
- An automatic nearby-resistance assessment.
- A new eligibility persistence/grace-period mechanism beyond the existing Scanner board's trading-cycle stickiness.
- Changes to Trade Guard, Scanner filters, backend Scanner ranking, pool limits, market-data subscriptions, or order workflows.

## Validation

- Scanner aggregation tests cover source merging, symbol deduplication, newest-row selection, Losers exclusion, freshest-session selection, and delayed-board handling.
- Ross Candidates panel tests assert that Moomoo-only float evidence and absent chart history remain pending.
- Full UI lint, test, and build validation must pass in CI before this stage is considered complete.

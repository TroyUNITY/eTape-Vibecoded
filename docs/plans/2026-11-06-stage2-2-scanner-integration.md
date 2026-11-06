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
- Added an asynchronous, per-symbol `QueryCandidateHistory` read of the local archive.
  - Reads at most the latest 15,000 one-minute bars and 260 daily bars for one requested symbol.
  - The Ross Candidates panel requests this history only after the operator expands a candidate and clicks **Load archived bars**.
  - The result is kept in the panel's local state and used by the evaluator; it is not inserted into the chart BarStore.
  - The query does not fetch from a new external provider, create chart demands, or start live K-line subscriptions.
  - Two query slots bound concurrent archive reads.
  - Does not submit orders or mutate scanner membership.
- Connected the Stage 2.1 evaluator to candidate rows.
  - The current quote is preferred, then the scanner row price, then Stock Info price.
  - Moomoo `OutstandingShares` from either scanner rows or Stock Info is always labelled and passed as `moomoo_outstanding_shares`, never as verified free float.
  - The existing Stock Info catalyst heuristic (score at least 50 and category not `other`) can establish a fundamental catalyst.
  - No matching headline remains `unknown`, not `none`, because a technical-breakout detector is not implemented.
  - Nearby resistance remains `null` / unknown; no unsupported proximity threshold is invented.
  - Same-time RVOL is calculated only from one-minute candles using the Stage 2.1 evaluator. The Scanner's daily REL VOL field is not substituted.

## Data availability boundary

The scanner's current subscription pool admits up to 30 symbols and warms their history in the local archive. However, `WarmArchive` explicitly does not seed or publish those candles into `md.Core` / the UI `BarStore`. Watch-tier scanner subscriptions also do not request a continuous one-minute K-line subscription.

The panel can now request already-archived one-minute and daily history on demand for an expanded candidate, without opening a chart or changing subscriptions. Missing archive ranges remain missing; the query does not silently backfill them. One-minute bars in the local archive may also be stale, because this query is a historical read and not a live K-line subscription. The evaluator's five-minute freshness rule therefore remains in force: stale or missing bars stay unknown and produce `PENDING`, unless another known criterion has already failed.

This is intentional fail-closed behaviour. Continuous intraday freshness for a candidate subset remains a separate follow-up decision; it should use explicit bounded demand rather than subscribe to every discovery row.

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
- Candidate-level sticky retention is not implemented yet: when a symbol disappears from all three selected discovery boards, it leaves this view. Preserving previously qualified candidates independently of the current rankings remains a follow-up requirement.
- Changes to Trade Guard, Scanner filters, backend Scanner ranking, pool limits, market-data subscriptions, or order workflows.

## Validation

- Scanner aggregation tests cover source merging, symbol deduplication, newest-row selection, Losers exclusion, freshest-session selection, and delayed-board handling.
- UI tests cover pending status with Moomoo-only float evidence and the on-demand history action.
- UIHub tests cover bounded archive reads, symbol normalization, partial archive failures, missing archive capability, and asynchronous query routing.
- The new history-query request/result DTOs are generated from `wsmsg/payloads.go` and included in the `gen-ts-check` contract drift gate.
- Full UI lint, test, and build validation plus engine tests and contract-drift validation must pass in CI before this stage is considered complete.

## First-run operator checklist

1. Enable Scanner panels in Gainers, Most Active, and Session Volume modes.
2. Add the **Ross Candidates** panel. Confirm duplicate symbols appear once with all discovery-source labels.
3. Expand a candidate and click **Load archived bars**. The panel should update its history counts and eligibility checks. If the newest archived one-minute bar is stale, the freshness check should remain unknown; loading history is not a live subscription.
4. Confirm Moomoo-only share figures remain `PENDING` for free float, even when the share count is below 100 million.
5. Confirm the panel does not alter Scanner filters, start chart subscriptions, or submit orders.

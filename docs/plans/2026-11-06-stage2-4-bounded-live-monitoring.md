# Stage 2.4 — Bounded Live One-Minute Candidate Monitoring

Date: 2026-11-06
Branch: `stage2-4-bounded-live-monitoring`
Depends on: Stage 2.3 candidate retention

## Objective

Give a small, explicitly selected subset of retained Ross momentum candidates fresh one-minute market data so the eligibility evaluator can use current intraday bars even after a symbol leaves the discovery scanners.

## Operator behaviour

- Live monitoring is enabled per retained candidate with **Monitor live (1m)** in the Ross Candidates panel.
- Only US symbols are eligible for this candidate-monitor demand profile.
- Stop an active request with **Stop live monitor**. Removing a candidate from the retained shortlist also removes its live-monitor selection.
- The selected-symbol list is persisted in the owning panel's workspace settings and is re-established when the panel mounts after a restart.
- A panel releases its active monitoring demands when it unmounts. The existing DemandRegistry re-announces live demands after WebSocket reconnects.
- The UI DemandRegistry enforces a maximum of five unique candidate symbols per WebSocket connection. Multiple Ross Candidates panels in the same connection can share a monitored symbol without consuming duplicate unique-symbol slots. In-flight requests reserve capacity to prevent concurrent clicks from exceeding the cap.
- The engine's subscription manager remains authoritative for actual provider admission and quota. It can delay or starve a request under provider quota pressure. An accepted EnsureSymbol acknowledgement means the demand was registered; it does not prove that the provider has activated the K-line subscription.

## Demand design

The new `candidate` EnsureSymbol profile uses the existing feed demand/subscription machinery:

- `SubTicker` plus `SubKL1m`.
- `WantsHistory: true` so the selected symbol can warm its local archive.
- `BackgroundSeed: true` so candidate history seeding uses the existing background seed lane rather than delaying interactive chart preparation.
- `Focused: false` and no `SubBook`, `SubQuote`, or daily K-line demand. A candidate monitor does not pin a symbol under subscription quota pressure.
- The profile rejects non-US symbols.

The existing OpenD subscription manager already unions overlapping demands by symbol, deduplicates subtype subscriptions, prioritizes ordinary and focused demands over background work, respects configured quota, and applies provider minimum-hold/hysteresis rules. Stage 2.4 adds no parallel subscription manager.

## Analysis data behaviour

- The panel continues to request archived history only when the operator expands a candidate and selects **Load archived bars**.
- When evaluating a candidate, archived one-minute bars and live BarStore one-minute bars are merged by bucket timestamp. Live values win for a matching bucket so an old archive snapshot cannot overwrite a newer in-progress/finalized bar.
- The analysis tail is bounded at 15,000 one-minute bars and 260 daily bars.
- The existing five-minute one-minute-bar freshness requirement remains unchanged. The panel shows **LIVE 1M REQUESTED** until a sufficiently recent bar actually reaches the BarStore; it shows **LIVE 1M FRESH** only after the freshness check passes.
- A missing, delayed, or quota-starved feed remains unknown/PENDING. The UI does not treat a registered demand as proof of fresh data.

## Scope and safety boundary

This is a bounded data-monitoring feature for candidate evaluation only. It does not submit orders, modify Trade Guard, change scanner filters or rankings, or subscribe every discovery result. There is no new provider or API key. Free float, automatic resistance assessment, and technical-breakout detection remain separate incomplete criteria.

The cap of five unique symbols is per WebSocket connection. Actual provider subscription capacity can be lower because other eTape panels and application features share the provider's subscription quota.

## Validation

- Go command tests verify candidate profile mapping, US-only gating, and exact requested subtypes/priority flags.
- DemandRegistry tests verify five unique symbols, duplicate-symbol deduplication, release of capacity, and reservation while acknowledgements are pending.
- Ross Candidates panel tests verify selection persistence, candidate demand creation, receipt of a fresh one-minute bar, and demand release on unmount.
- Existing Stage 2.1 eligibility, Stage 2.2 scanner aggregation/archive query, and Stage 2.3 retention tests remain in the strategy test project.
- Full Go test/race/vet/lint/contract checks and UI lint/test/build should be rerun in CI. Existing unrelated tape golden-image comparisons and the LadderPanel timing issue are tracked separately.

## Operator checklist

1. Open Ross Candidates and add a candidate to the persistent shortlist.
2. Expand that retained candidate and select **Monitor live (1m)**.
3. Confirm the UI first shows **LIVE 1M REQUESTED**. Do not treat this as live-data confirmation.
4. Confirm that a fresh one-minute bar arrives and the label changes to **LIVE 1M FRESH**. The freshness eligibility check should also pass while the bar remains within the existing five-minute window.
5. Select **Stop live monitor** and confirm the live-monitor count falls and the demand is released.
6. Select up to five distinct US symbols. A sixth unique symbol on the same WebSocket connection must be blocked even when another Ross Candidates panel makes the request.
7. Close the panel and confirm its demands are released; reopen it and confirm persisted selections are requested again.
8. Repeat with provider quota pressure or a delayed feed. The UI should retain the request/error information and must not claim fresh data until a current bar arrives.

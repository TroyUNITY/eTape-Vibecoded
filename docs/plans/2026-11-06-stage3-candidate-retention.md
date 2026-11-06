# Stage 3 — Persistent Ross Candidate Retention

Date: 2026-11-06
Branch: `stage3-candidate-retention`
Base: `filtered-development`

## Objective

Keep useful momentum candidates visible after they leave the active Gainers, Most Active, and Session Volume discovery boards. Retention is a shortlist/lifecycle feature; it does not itself start new market-data subscriptions.

## Behaviour

- A trader can manually add any non-REJECTED candidate to the Ross Candidates panel's shortlist.
- A candidate that reaches `ELIGIBLE` is added automatically, provided the shortlist has capacity.
- The shortlist is capped at 30 symbols to keep the retained set bounded.
- Retained entries are persisted in the owning Ross Candidates panel's workspace settings. They therefore survive panel re-renders, workspace saves, and app restarts.
- While a retained symbol is still present in a discovery scanner, its latest row snapshot and last-seen timestamp are refreshed.
- If a currently discovered retained symbol becomes `REJECTED`, it is automatically removed from the shortlist.
- A retained candidate in `PENDING` is not removed. Missing or stale data must not be mistaken for a confirmed failure.
- If a retained symbol disappears from all discovery boards, its last-known scanner row remains visible and is marked as not currently in the scanners. It can be removed manually.
- The shortlist is specific to each Ross Candidates panel instance.

## Important boundary

This stage preserves and displays the last-known candidate information; it does not guarantee live monitoring after a symbol leaves the scanner pool. Existing quote or bar data may be stale, and the eligibility evaluator continues to fail closed to `PENDING` when required fresh evidence is unavailable. Bounded live one-minute monitoring for a retained subset remains a separate next stage.

No external data provider, API key, new scanner subscription, Trade Guard behaviour, or order workflow is changed. This panel remains informational and does not place orders.

## Validation

- Panel tests cover manual retention, persistence through the panel settings patch, and continued visibility after the candidate leaves discovery scanners.
- Existing Stage 2.1 eligibility and Stage 2.2 scanner aggregation/history tests remain part of the strategy Vitest project.
- CI must still complete the UI strategy tests, full test suite, lint/build, engine tests, Go lint, and TypeScript contract drift checks. Known unrelated LadderPanel timeout and existing Go formatting lint issue are tracked separately from this feature.

## Operator checks

1. Add the Ross Candidates panel and activate Gainers, Most Active, and/or Session Volume scanners.
2. Expand a candidate that is not `REJECTED` and select **Keep on shortlist**.
3. Remove the symbol from the discovery scanners (or let it fall out of their rankings). It should remain in Ross Candidates with `RETAINED` and `NOT IN CURRENT SCANNERS` labels.
4. Restart or reload the workspace. The retained symbol should still be present.
5. Confirm a retained symbol remains during `PENDING` data states, but is removed after a current scanner observation establishes `REJECTED`.
6. Confirm that no live market-data subscription is created solely by retaining a candidate.

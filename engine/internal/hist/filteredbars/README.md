# Filtered candle reconstruction (Stage 2)

`filteredbars.Build` converts the Stage 1 `tradehistory.Result` into independent
1-minute candles and 5-minute candles folded exclusively from those 1-minute
candles. It does not replace or modify Moomoo's official K-lines, indicators,
last-price marks, chart callbacks, or execution state. Chart wiring is Stage 3.

## Price and volume rules

- A report can update filtered OHLC only when the provider condition permits
  price formation and the report size is at least 100 shares.
- OpenD prints received 20 seconds or more after their exchange timestamp are
  excluded from OHLC. The report remains volume-eligible when its existing
  OpenD condition policy allows volume. If receipt time is unavailable, the
  print is retained and the uncertainty is counted in diagnostics.
- The OpenD prior-reference-price condition has a first-of-business-day-only
  last-sale rule. A range-scoped archive read cannot prove it contains the
  first qualifying print of that day, so historical reconstruction does not
  infer `LastEligible` from the first print in the requested range. The number
  of such reports is exposed in `localFirstOfDayLastUnverifiable`.
- Alpaca reports use the tape-specific SIP minute-bar condition table. For
  multiple conditions the strictest rule wins. Unknown tape/condition pairs
  fail closed. Alpaca historical trade reports do not include a separate
  provider-receipt timestamp, so the 20-second latency rule cannot be applied
  to that source; this is surfaced in diagnostics.
- Alpaca `canceled` and `incorrect` updates are excluded. `corrected` reports
  are evaluated as the corrected execution. Unrecognized update values fail
  closed and are counted.
- The 100-share and 20-second checks affect price formation only. Condition-
  eligible volume remains in the bar, including sub-100 and late reports.
- Volume-only bars use the last trusted price from a prior eligible report or
  an optional anchor supplied by the caller. If no prior anchor exists, a
  volume-only bucket is not emitted rather than inventing an OHLC price.

## Source selection and coverage

Alpaca and OpenD do not share a stable execution ID or equivalent timestamp
precision. The builder therefore never merges the providers' reports inside a
minute. A complete minute fully inside a successful Alpaca query uses Alpaca
SIP exclusively. Outside that range, a minute with local prints uses TickStore.
If the Alpaca query was partial/failed and no local print exists, returned
Alpaca rows may be shown as `alpaca_partial`; those bars are explicitly marked
as incomplete. Local TickStore minutes are always coverage-unproven at this
stage. Empty gaps are not filled with Moomoo K-lines or synthetic candles.

Each minute has a coverage record, even when no candle was emitted. Five-minute
candles are folded from the selected one-minute bars; source mixing and
incomplete coverage remain visible in the result.

## Alpaca SIP rules

The implementation follows Alpaca's documented stock minute-bar condition
rules, including tape-specific differences such as `B` (average price on A/B,
bunched trade on C), and treats multiple flags using the strictest rule. It is
not an attempt to recreate every exchange/SIP correction workflow or Warrior
Trading's ADF exclusion. The historical Alpaca `u` update marker is preserved
and canceled/incorrect entries are excluded. OpenD's normalized TickStore
record currently has no exchange/ADF venue field. Applying an ADF exclusion
only to Alpaca minutes would make the same filter behave differently depending
on which provider supplied a minute, so ADF exclusion is deliberately left
out until venue attribution is available consistently.

Tests: `go test ./internal/hist/filteredbars ./internal/hist/alpaca ./internal/hist/tradehistory ./internal/md`.

# Historical Trade History

`tradehistory.Service` loads individual Alpaca trade reports and retained
OpenD Reported Prints for one `[from, to)` interval. Alpaca and TickStore are
queried independently; a successful source result is retained even when the
other source fails, and the returned error identifies the failed source.

Alpaca trade reports keep their original timestamp, exchange code, price,
share size, report-condition strings, trade ID, and tape. The service does not
translate Alpaca conditions into OpenD's condition enum. Those taxonomies are
not interchangeable and Stage 2 owns the explicit eligibility mapping.
The historical trade payload has an exchange timestamp but no independent
provider-receipt timestamp. A later filter therefore cannot reliably infer
whether an Alpaca report arrived more than 20 seconds late; that rule can only
be applied to sources that actually retain receipt chronology.

The Alpaca client requests SIP and clamps its historical end to `now - 16m`.
Alpaca documents a 15-minute SIP recency restriction for users without
real-time SIP access; the extra minute is a safety margin. The request is
paged at 10,000 reports/page, uses the existing Alpaca request limiter and
durable cooldown, and preserves the effective end in `TradeBatch` diagnostics.

Local history is read through TickStore's committed normalized-print reader.
Its coverage reasons remain visible; `coverage_unproven` is not treated as a
continuous-capture guarantee. Repeated local sequence identities and exact
repeated Alpaca reports with a stable trade ID are removed within their own
source. Reports without a trade ID remain distinct because identical payloads
can still be separate executions. Changed Alpaca payloads under the same
exchange-scoped trade ID are retained and reported in
`AlpacaIdentityConflictCount` for correction-aware consumers. Cross-provider
matching is counted as `PotentialCrossFeedHits` for diagnosis only; it does not
remove reports because OpenD and Alpaca do not expose a shared stable trade ID
or equivalent timestamp precision. Stage 2 must decide source precedence for
overlapping intervals rather than concatenate both streams and double count.

The result intentionally returns `AlpacaTrades` and `LocalPrints` separately.
This package is backend groundwork for filtered-candle reconstruction; it does
not change the displayed chart, execution marks, or official Moomoo K-lines.

Typical use is to construct one service with the existing historical Alpaca
client and `tickstore.NewTradeReader(<ticks-directory>, recorder)`, then call
`Fetch(ctx, symbol, from, to)`. A caller should inspect `Diagnostics` and retain
the two returned source slices independently until a later stage selects
complete time intervals and applies trade-condition rules.

Tests: `go test ./internal/hist/alpaca ./internal/hist/tradehistory`.

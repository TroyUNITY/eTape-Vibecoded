package alpaca

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const (
	// basicSIPHistoryLag includes a one-minute safety margin over Alpaca's
	// documented 15-minute Basic-plan SIP historical-data boundary.
	basicSIPHistoryLag = 16 * time.Minute
	tradePageSize      = 10_000
	maxTradePages      = 100
	maxTradeBodyBytes  = 32 << 20
)

// Trade is an unmodified Alpaca trade report. Conditions and exchange are
// retained as provider values; they are deliberately not mapped to OpenD's
// condition taxonomy here because the providers' condition codes differ.
type Trade struct {
	Timestamp  time.Time `json:"t"`
	Exchange   string    `json:"x"`
	Price      float64   `json:"p"`
	Size       int64     `json:"s"`
	Conditions []string  `json:"c"`
	ID         int64     `json:"i"`
	Tape       string    `json:"z"`
	Update     string    `json:"u,omitempty"`
}

// TradeBatch describes both the requested range and the range the provider
// was actually allowed to serve. EffectiveTo is exclusive, matching the
// history-service and TickStore interval convention [from, to).
type TradeBatch struct {
	Trades                []Trade
	Feed                  string
	RequestedFrom         time.Time
	RequestedTo           time.Time
	EffectiveFrom         time.Time
	EffectiveTo           time.Time
	Pages                 int
	RawTradeCount         int
	DuplicateCount        int
	IdentityConflictCount int
	RecencyClamped        bool
}

type tradesResponse struct {
	Trades        []Trade `json:"trades"`
	NextPageToken string  `json:"next_page_token"`
}

// HistoricalTrades fetches individual trades from Alpaca's historical stock
// trades endpoint. The interval is [from, to). For SIP, the end is clamped to
// now−16 minutes so a Basic subscription never requests the restricted most
// recent 15 minutes. Every page is fetched using the existing rate limiter,
// durable restart cooldown, and API-budget accounting shared with bars.
func (c *Client) HistoricalTrades(ctx context.Context, symbol string, from, to time.Time) (TradeBatch, error) {
	batch := TradeBatch{
		Feed:          c.feed,
		RequestedFrom: from,
		RequestedTo:   to,
		EffectiveFrom: from,
		EffectiveTo:   to,
		Trades:        []Trade{},
	}
	if strings.TrimSpace(symbol) == "" || !to.After(from) {
		return batch, errors.New("alpaca trades: symbol and a non-empty time range are required")
	}
	if c.feed == "sip" {
		cutoff := c.clk.Now().Add(-basicSIPHistoryLag)
		if batch.EffectiveTo.After(cutoff) {
			batch.EffectiveTo = cutoff
			batch.RecencyClamped = true
		}
	}
	if !batch.EffectiveTo.After(batch.EffectiveFrom) {
		return batch, nil
	}
	if err := c.waitStartup(ctx); err != nil {
		return batch, err
	}

	sym := strings.TrimPrefix(strings.TrimSpace(symbol), "US.")
	pageToken := ""
	seenTokens := make(map[string]struct{})
	seen := make(map[string]map[string]struct{})
	for page := 0; page < maxTradePages; page++ {
		if err := ctx.Err(); err != nil {
			return batch, err
		}
		q := url.Values{}
		q.Set("start", batch.EffectiveFrom.UTC().Format(time.RFC3339Nano))
		// Alpaca treats end as inclusive; subtract one nanosecond to preserve
		// this method's [from, to) contract.
		q.Set("end", batch.EffectiveTo.Add(-time.Nanosecond).UTC().Format(time.RFC3339Nano))
		q.Set("feed", c.feed)
		q.Set("limit", fmt.Sprint(tradePageSize))
		q.Set("sort", "asc")
		if pageToken != "" {
			q.Set("page_token", pageToken)
		}
		if err := c.bucket.Take(ctx); err != nil {
			return batch, err
		}
		reqURL := c.base + "/v2/stocks/" + url.PathEscape(sym) + "/trades?" + q.Encode()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
		if err != nil {
			return batch, err
		}
		req.Header.Set("APCA-API-KEY-ID", c.keyID)
		req.Header.Set("APCA-API-SECRET-KEY", c.secret)
		if c.cooldown != nil {
			if err := c.cooldown.Record(); err != nil {
				return batch, err
			}
		}
		resp, err := c.hc.Do(req)
		if err != nil {
			return batch, err
		}
		budget := alpacaResponseBudget(resp.Header, resp.StatusCode, c.clk.Now())
		if budget.remaining >= 0 && !budget.resetAt.IsZero() {
			c.bucket.ObserveBudget(budget.remaining, budget.resetAt)
		}
		if !budget.deferUntil.IsZero() {
			c.bucket.DeferUntil(budget.deferUntil)
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxTradeBodyBytes+1))
		closeErr := resp.Body.Close()
		if readErr != nil {
			return batch, fmt.Errorf("alpaca trades: read response: %w", readErr)
		}
		if len(body) > maxTradeBodyBytes {
			return batch, fmt.Errorf("alpaca trades: response exceeded %d bytes", maxTradeBodyBytes)
		}
		if c.cooldown != nil && !budget.deferUntil.IsZero() {
			if err := c.cooldown.DeferUntil(budget.deferUntil); err != nil {
				return batch, err
			}
		}
		if resp.StatusCode >= 400 {
			if closeErr != nil {
				return batch, fmt.Errorf("alpaca trades: status=%d body=%s (close: %v)", resp.StatusCode, body, closeErr)
			}
			return batch, fmt.Errorf("alpaca trades: status=%d body=%s", resp.StatusCode, body)
		}
		if closeErr != nil {
			return batch, fmt.Errorf("alpaca trades: close response: %w", closeErr)
		}
		var pageData tradesResponse
		if err := json.Unmarshal(body, &pageData); err != nil {
			return batch, fmt.Errorf("alpaca trades decode: %w", err)
		}
		batch.Pages++
		batch.RawTradeCount += len(pageData.Trades)
		for _, trade := range pageData.Trades {
			if trade.Timestamp.Before(batch.EffectiveFrom) || !trade.Timestamp.Before(batch.EffectiveTo) {
				continue
			}
			trade.Conditions = append([]string(nil), trade.Conditions...)
			if trade.ID == 0 {
				// Without a provider trade ID, identical payloads can still be
				// separate executions. Preserve them rather than guess at identity.
				batch.Trades = append(batch.Trades, trade)
				continue
			}
			identity := alpacaTradePrimaryKey(trade)
			fingerprint := alpacaTradeKey(trade)
			reports, identitySeen := seen[identity]
			if _, duplicate := reports[fingerprint]; duplicate {
				batch.DuplicateCount++
				continue
			}
			if identitySeen {
				// Preserve conflicting payloads under the same provider identity:
				// they may represent correction/cancellation evidence and must be
				// interpreted by a later policy rather than silently discarded.
				batch.IdentityConflictCount++
			} else {
				reports = make(map[string]struct{})
				seen[identity] = reports
			}
			reports[fingerprint] = struct{}{}
			batch.Trades = append(batch.Trades, trade)
		}
		if pageData.NextPageToken == "" {
			break
		}
		if _, exists := seenTokens[pageData.NextPageToken]; exists {
			return batch, errors.New("alpaca trades: provider repeated a pagination token")
		}
		seenTokens[pageData.NextPageToken] = struct{}{}
		if page == maxTradePages-1 {
			return batch, fmt.Errorf("alpaca trades: pagination exceeded %d pages", maxTradePages)
		}
		pageToken = pageData.NextPageToken
	}
	sort.SliceStable(batch.Trades, func(i, j int) bool {
		if batch.Trades[i].Timestamp.Equal(batch.Trades[j].Timestamp) {
			return batch.Trades[i].ID < batch.Trades[j].ID
		}
		return batch.Trades[i].Timestamp.Before(batch.Trades[j].Timestamp)
	})
	return batch, nil
}

func alpacaTradePrimaryKey(t Trade) string {
	return fmt.Sprintf("%d/%s/%d", t.Timestamp.UnixNano(), t.Exchange, t.ID)
}

// alpacaTradeKey includes the entire report payload. Exact repeated reports
// can be deduplicated while changed payloads under one exchange trade ID are
// retained and surfaced as identity conflicts for correction-aware consumers.
func alpacaTradeKey(t Trade) string {
	return fmt.Sprintf("%d/%s/%d/%g/%d/%s/%s/%s", t.Timestamp.UnixNano(), t.Exchange, t.ID, t.Price, t.Size, strings.Join(t.Conditions, ","), t.Tape, t.Update)
}

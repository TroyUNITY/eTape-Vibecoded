import type { AckMsg } from "./contract";
import type { ConnState } from "./WsClient";

export type DemandProfile = "chart" | "watch" | "focused" | "interest" | "candidate";

// Candidate monitoring is deliberately bounded at the UI demand boundary.
// The provider quota manager still has final authority over actual admission.
export const MAX_CANDIDATE_MONITOR_SYMBOLS = 5;

interface DemandClient {
  sendCommand(name: string, args: unknown): Promise<AckMsg>;
  onState(cb: (s: ConnState) => void): void;
}

const ACCEPTED: AckMsg = { kind: "ack", corrId: "", status: "accepted" };
const CANDIDATE_LIMIT_BLOCKED: AckMsg = {
  kind: "ack",
  corrId: "",
  status: "blocked",
  reason: `live candidate monitoring is limited to ${MAX_CANDIDATE_MONITOR_SYMBOLS} unique symbols`,
};

// DemandRegistry drives per-panel EnsureSymbol/ReleaseSymbol commands and keeps
// the UI as the source of truth for what's on screen: engine demand state is
// in-memory, so on reconnect (WS drop or engine restart) we re-announce every
// live demand. Owned by App.tsx alongside LinkGroups; one instance per client
// connection (demands are connection-scoped engine-side, so multi-window needs
// no coordination).
//
// reannounce() awaits an injected `reannounceGate` before re-sending, so a
// reconnect that lands on a *different* session mode (live/demo) doesn't
// re-assert demands from the old mode's symbol universe (see
// chrome/reannounceGate.ts). The default gate resolves immediately,
// preserving today's unconditional-reannounce behavior for any caller that
// doesn't pass one.
export class DemandRegistry {
  private readonly live = new Map<string, { symbol: string; profile: DemandProfile }>();
  // Per-panel monotonic epoch + in-flight marker, guarding against a
  // release() racing an ensure() that hasn't resolved yet (panel closed
  // between mount and the EnsureSymbol round-trip). release() bumps the
  // epoch so a since-invalidated ensure can't resurrect a `live` entry for a
  // panel that no longer exists, and consults `pending` (not just `live`) so
  // it still sends ReleaseSymbol for a demand the engine may already be
  // processing — otherwise the ack lands, `live` gets a phantom entry, and
  // reannounce() re-asserts it forever (a permanent quota leak).
  private readonly epoch = new Map<string, number>();
  private readonly pending = new Set<string>();
  private readonly pendingDemand = new Map<string, { symbol: string; profile: DemandProfile }>();

  constructor(
    private readonly client: DemandClient,
    private readonly reannounceGate: () => Promise<void> = () => Promise.resolve(),
  ) {
    this.client.onState((s) => {
      if (s === "open") void this.reannounce();
    });
  }

  // ensure subscribes a panel's symbol. Returns the ack so a gated commit path
  // can revert on rejection. An unchanged symbol+profile is a no-op that
  // resolves accepted (the engine ensure is an idempotent upsert anyway).
  async ensure(panelId: string, symbol: string, profile: DemandProfile): Promise<AckMsg> {
    const cur = this.live.get(panelId);
    if (cur && cur.symbol === symbol && cur.profile === profile) return ACCEPTED;
    if (profile === "candidate" && !this.withinCandidateMonitorLimit(panelId, symbol)) {
      return CANDIDATE_LIMIT_BLOCKED;
    }
    const myEpoch = (this.epoch.get(panelId) ?? 0) + 1;
    this.epoch.set(panelId, myEpoch);
    this.pending.add(panelId);
    this.pendingDemand.set(panelId, { symbol, profile });
    try {
      const ack = await this.client.sendCommand("EnsureSymbol", { demandId: panelId, symbol, profile });
      // Only commit to `live` if no release() (or newer ensure()) has bumped
      // the epoch since this call started — otherwise this ack belongs to a
      // demand that's since been torn down and must not resurrect it.
      if (ack.status === "accepted" && this.epoch.get(panelId) === myEpoch) this.live.set(panelId, { symbol, profile });
      return ack;
    } finally {
      // Guard the same way: if a newer ensure() for this panel is still
      // in-flight, don't clear its reservation or pending marker.
      if (this.epoch.get(panelId) === myEpoch) {
        this.pending.delete(panelId);
        this.pendingDemand.delete(panelId);
      }
    }
  }

  private withinCandidateMonitorLimit(panelId: string, symbol: string): boolean {
    const otherSymbols = new Set<string>();
    for (const [id, demand] of this.live) {
      if (id !== panelId && demand.profile === "candidate") otherSymbols.add(demand.symbol);
    }
    for (const [id, demand] of this.pendingDemand) {
      if (id !== panelId && demand.profile === "candidate") otherSymbols.add(demand.symbol);
    }
    // The same symbol may be monitored by two Ross Candidates panels without
    // consuming two unique-symbol slots. Replacing this panel's own candidate
    // demand also reuses its existing slot.
    return otherSymbols.has(symbol) || otherSymbols.size < MAX_CANDIDATE_MONITOR_SYMBOLS;
  }

  release(panelId: string): void {
    const wasLive = this.live.has(panelId);
    const wasPending = this.pending.has(panelId);
    if (!wasLive && !wasPending) return; // never ensured at all — genuine no-op
    this.epoch.set(panelId, (this.epoch.get(panelId) ?? 0) + 1); // invalidate any in-flight ensure
    this.live.delete(panelId);
    this.pending.delete(panelId);
    this.pendingDemand.delete(panelId);
    void this.client.sendCommand("ReleaseSymbol", { demandId: panelId });
  }

  private async reannounce(): Promise<void> {
    await this.reannounceGate();
    for (const [panelId, { symbol, profile }] of this.live) {
      void this.client.sendCommand("EnsureSymbol", { demandId: panelId, symbol, profile });
    }
  }
}

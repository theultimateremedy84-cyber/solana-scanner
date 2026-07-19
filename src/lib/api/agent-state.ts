// =============================================================================
// agent-state.ts  —  v2
//
// In-memory singleton for agent runtime state. Now tracks:
//   - Open circuit breakers per category
//   - Last metric snapshots (for before/after comparison)
//   - Fix cooldown timestamps per category
//   - Verification results from post-fix checks
// =============================================================================

export type AgentStatus = "idle" | "running" | "error";

export interface DetectedIssue {
  id: string;
  severity: "critical" | "warning" | "info";
  category:
    | "failed_jobs"
    | "stalled_pipeline"
    | "pipeline_stall"
    | "enrichment_backlog"
    | "helius_budget"
    | "data_integrity"
    | "alert_spike"
    | "alert_storm"
    | "websocket_down"
    | "websocket_instability"
    | "scheduler_failures"
    | "price_feed_failure"
    | "combined_failure";
  title: string;
  description: string;
  metric: string | null;
  value: string | null;
  fixable: boolean;
  fixChain?: string[];          // ordered list of fix actions to apply
  detectedAt: string;
}

export interface AppliedFix {
  issueId: string;
  action: string;
  description: string;
  githubCommitUrl: string | null;
  success: boolean;
  error: string | null;
  metricBefore?: string | null;
  metricAfter?: string | null;
  improved?: boolean | null;
  circuitOpened?: boolean;
  skippedReason?: string | null;   // "cooldown" | "circuit_open" | null
}

export interface VerificationResult {
  category: string;
  metricKey: string;
  before: string;
  after: string;
  improved: boolean;
  checkedAt: string;
}

interface Store {
  status: AgentStatus;
  startedAt: Date;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  issueCount: number;
  totalFixesApplied: number;
  totalFixesSkipped: number;
  currentIssues: DetectedIssue[];
  monitorTimer: ReturnType<typeof setTimeout> | null;
  intervalMinutes: number;
  monitoringEnabled: boolean;
  openCircuits: string[];                          // categories with open circuit
  lastMetricSnapshot: Record<string, string>;      // category → metric value at last check
  lastVerifications: VerificationResult[];         // most-recent post-fix checks
  fixCooldowns: Record<string, number>;            // category → Date.now() of last fix attempt
}

const store: Store = {
  status: "idle",
  startedAt: new Date(),
  lastRunAt: null,
  nextRunAt: null,
  lastError: null,
  issueCount: 0,
  totalFixesApplied: 0,
  totalFixesSkipped: 0,
  currentIssues: [],
  monitorTimer: null,
  intervalMinutes: 5,
  monitoringEnabled: true,
  openCircuits: [],
  lastMetricSnapshot: {},
  lastVerifications: [],
  fixCooldowns: {},
};

export const agentState = {
  get(): Omit<Store, "monitorTimer"> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { monitorTimer: _, ...rest } = store;
    return rest;
  },

  snapshot() {
    return {
      status:              store.status,
      lastRunAt:           store.lastRunAt,
      nextRunAt:           store.nextRunAt,
      lastError:           store.lastError,
      issueCount:          store.issueCount,
      totalFixesApplied:   store.totalFixesApplied,
      totalFixesSkipped:   store.totalFixesSkipped,
      uptime:              Math.floor((Date.now() - store.startedAt.getTime()) / 1000),
      monitoringEnabled:   store.monitoringEnabled,
      intervalMinutes:     store.intervalMinutes,
      openCircuits:        store.openCircuits,
      lastVerifications:   store.lastVerifications.slice(0, 10),
    };
  },

  setStatus(s: AgentStatus) { store.status = s; },
  setLastError(e: string | null) { store.lastError = e; },

  setCurrentIssues(issues: DetectedIssue[]) {
    store.currentIssues = issues;
    store.issueCount = issues.length;
  },

  currentIssues() { return store.currentIssues; },

  recordRun(fixesApplied: number, fixesSkipped = 0) {
    store.lastRunAt = new Date().toISOString();
    store.totalFixesApplied += fixesApplied;
    store.totalFixesSkipped += fixesSkipped;
    store.status = "idle";
    store.lastError = null;
  },

  updateSchedule(enabled: boolean, minutes: number) {
    store.monitoringEnabled = enabled;
    store.intervalMinutes = minutes;
  },

  scheduleNext(runFn: () => Promise<void>, minutes: number) {
    if (store.monitorTimer) clearTimeout(store.monitorTimer);
    store.nextRunAt = new Date(Date.now() + minutes * 60_000).toISOString();
    store.monitorTimer = setTimeout(async () => {
      if (!store.monitoringEnabled || store.status === "running") return;
      try {
        await runFn();
      } catch (err) {
        console.error("[agent] Scheduled run failed:", err);
      }
      agentState.scheduleNext(runFn, store.intervalMinutes);
    }, minutes * 60_000);
  },

  isRunning() { return store.status === "running"; },
  getUptime() { return Math.floor((Date.now() - store.startedAt.getTime()) / 1000); },

  // ── Circuit breakers ────────────────────────────────────────────────────────
  setOpenCircuits(circuits: string[]) { store.openCircuits = circuits; },

  // ── Metric snapshots ────────────────────────────────────────────────────────
  setMetricSnapshot(category: string, value: string) {
    store.lastMetricSnapshot[category] = value;
  },
  getMetricSnapshot(category: string): string | null {
    return store.lastMetricSnapshot[category] ?? null;
  },

  // ── Verification results ────────────────────────────────────────────────────
  addVerification(v: VerificationResult) {
    store.lastVerifications.unshift(v);
    if (store.lastVerifications.length > 20) store.lastVerifications.pop();
  },

  // ── Fix cooldowns (in-memory backup; Supabase is authoritative) ──────────────
  markFixApplied(category: string) {
    store.fixCooldowns[category] = Date.now();
  },
  isOnCooldown(category: string, cooldownMinutes: number): boolean {
    const last = store.fixCooldowns[category];
    if (!last) return false;
    return Date.now() - last < cooldownMinutes * 60_000;
  },
};

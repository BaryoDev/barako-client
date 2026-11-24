import { randomBytes } from "node:crypto";

export const PLAN_TTL_MS = 10 * 60 * 1000;
export const MAX_PLANS = 20;
/** One to 64 base64url characters. A token from randomBytes(24) is 32. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type PlanAction = "create_entry" | "update_entry" | "change_status" | "rollback_entry" | "erase_entry";
export const PLAN_ACTIONS: readonly PlanAction[] = ["create_entry", "update_entry", "change_status", "rollback_entry", "erase_entry"];
export const WRITE_ACTIONS: readonly PlanAction[] = ["create_entry", "update_entry", "change_status"];
export const DESTRUCTIVE_ACTIONS: readonly PlanAction[] = ["rollback_entry", "erase_entry"];

/** What the entry looked like when it was planned. Compared again at apply. */
export interface Fingerprint {
  version: number | undefined;
  etag: string | undefined;
  status: string | undefined;
}

export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.version === b.version && a.etag === b.etag && a.status === b.status;
}

interface Base {
  token: string;
  /** Milliseconds since the epoch. The plan is expired when now >= expiresAt. */
  expiresAt: number;
  /** The entry id, or the content type name for a create. */
  target: string;
}

export type Plan = Base &
  (
    | { action: "create_entry"; input: { contentType: string; data: Record<string, unknown>; publish: boolean }; idempotencyKey: string }
    | { action: "update_entry"; data: Record<string, unknown>; version: number; fingerprint: Fingerprint }
    | { action: "change_status"; to: "published" | "draft" | "archived"; fingerprint: Fingerprint }
    | { action: "rollback_entry"; versionId: string; fingerprint: Fingerprint }
    | { action: "erase_entry"; fingerprint: Fingerprint }
  );

/** The plans that are waiting for an apply. In memory only, one store per session. */
export class PlanStore {
  private readonly plans = new Map<string, Plan>();

  constructor(private readonly now: () => Date) {}

  /** A new token and its expiry. Nothing is stored until commit. */
  issue(): { token: string; expiresAt: number } {
    return { token: randomBytes(24).toString("base64url"), expiresAt: this.now().getTime() + PLAN_TTL_MS };
  }

  /** Stores a plan. Expired plans are dropped first. A plan past the limit drops the oldest. */
  commit(plan: Plan): void {
    this.purge();
    while (this.plans.size >= MAX_PLANS) {
      const oldest = this.plans.keys().next();
      if (oldest.done) break;
      this.plans.delete(oldest.value);
    }
    this.plans.set(plan.token, plan);
  }

  /** Finds a plan and removes it, whatever happens next. An unknown, used or expired token gives undefined. */
  take(token: string): Plan | undefined {
    this.purge();
    const plan = this.plans.get(token);
    this.plans.delete(token);
    return plan;
  }

  get size(): number {
    this.purge();
    return this.plans.size;
  }

  private purge(): void {
    const t = this.now().getTime();
    for (const [token, plan] of this.plans) {
      if (t >= plan.expiresAt) this.plans.delete(token);
    }
  }
}

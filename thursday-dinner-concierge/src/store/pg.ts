// Postgres store. The database enforces the safety rules (db/schema.sql); this file only maps rows.
// Every call is one statement, so it is atomic on its own; session settings (role, user, clock) are
// applied per call by the driver.
import { spawnSync } from "node:child_process";
import type { Proposal, Role, Venue } from "../domain/types.ts";
import { StoreError } from "./store.ts";
import type { BookingRow, Memory, PaymentRow, Store, VenueFact } from "./store.ts";

export interface Session { role?: "ande_agent" | "ande_approver"; userId?: string; companyId?: string; now?: string }
export interface Driver { query(sql: string, params: unknown[], session: Session): Promise<Record<string, any>[]> }

/** Production driver over node-postgres: BEGIN; SET LOCAL ROLE; set_config(...); query; COMMIT. */
export async function pgDriver(connectionString: string): Promise<Driver & { end(): Promise<void> }> {
  const { default: pg } = await import("pg" as string);
  const pool = new pg.Pool({ connectionString });
  return {
    async query(sql, params, s) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        if (s.role) await c.query(`SET LOCAL ROLE ${s.role}`);
        await c.query("SELECT set_config('app.user_id', $1, true), set_config('app.company_id', $2, true), set_config('app.now', $3, true)",
          [s.userId ?? "", s.companyId ?? "", s.now ?? ""]);
        const r = await c.query(sql, params);
        await c.query("COMMIT");
        return r.rows;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    end: () => pool.end(),
  };
}

/** Test driver over the psql CLI (psql 16 \bind), so the store is tested on real Postgres with no npm packages. */
export function psqlDriver(args: string[]): Driver {
  // psql meta-command arguments use C-style escapes inside single quotes.
  const lit = (v: string) => `'${v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/'/g, "\\'")}'`;
  return {
    async query(sql, params, s) {
      const trimmed = sql.trim().replace(/;$/, "");
      const head = trimmed.slice(0, 6).toUpperCase();
      const returns = /\bRETURNING\b/i.test(trimmed);
      const wrapped = head === "SELECT" || head.startsWith("WITH")
        ? `SELECT coalesce(json_agg(t), '[]')::jsonb::text FROM (${trimmed}) t`
        : returns ? `WITH t AS (${trimmed}) SELECT coalesce(json_agg(t), '[]')::jsonb::text FROM t` : trimmed;
      const bind = params.map((p) => (p === null || p === undefined ? "''" : lit(typeof p === "object" ? JSON.stringify(p) : String(p)))).join(" ");
      const script = [
        "BEGIN;",
        s.role ? `SET LOCAL ROLE ${s.role};` : "",
        `SELECT set_config('app.user_id', ${lit(s.userId ?? "")}, true), set_config('app.company_id', ${lit(s.companyId ?? "")}, true), set_config('app.now', ${lit(s.now ?? "")}, true) \\g /dev/null`,
        `${wrapped} \\bind ${bind} \\g`,
        "COMMIT;",
      ].join("\n");
      const r = spawnSync("psql", [...args, "-X", "-At", "-q", "-v", "ON_ERROR_STOP=1"], { input: script, encoding: "utf8" });
      if (r.status !== 0) throw new Error((r.stderr || r.stdout).replace(/^psql:<stdin>:\d+: /gm, "").trim());
      const out = r.stdout.trim().split("\n").filter((l) => l.startsWith("["));
      return out.length ? JSON.parse(out[out.length - 1]) : [];
    },
  };
}

/** Map a Postgres error message to the same codes the memory store throws. */
function mapError(e: unknown): never {
  const m = e instanceof Error ? e.message : String(e);
  const code =
    /cannot approve its own/.test(m) ? "agent_cannot_approve"
    : /is not required/.test(m) ? "role_not_required"
    : /not pending|duplicate key value violates unique constraint "approvals_pkey"/.test(m) ? "not_pending"
    : /needs an approved/.test(m) ? "not_approved"
    : /must replace a confirmed|must target a confirmed/.test(m) ? "mismatch"
    : /not the payee on file/.test(m) ? "payee_mismatch"
    : /exceeds the approved amount/.test(m) ? "over_amount"
    : /conflicting key value violates exclusion constraint/.test(m) ? "double_booked"
    : /does not match|must be for a confirmed/.test(m) ? "mismatch"
    : /expired/.test(m) ? "expired"
    : /permission denied|row-level security/.test(m) ? "forbidden"
    : "unknown";
  throw new StoreError(code, m.split("\n")[0]);
}

function toProposal(r: Record<string, any>): Proposal {
  return {
    id: r.id, runId: r.run_id, kind: r.kind, actorId: r.actor_id, principalId: r.principal_id, venueId: r.venue_id,
    roomId: r.room_id, startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(),
    partySize: r.party_size, amountCents: Number(r.amount_cents), payeeId: r.payee_id, requiredRoles: r.required_roles,
    approvedRoles: r.approved_roles, status: r.status, summary: r.summary, expiresAt: new Date(r.expires_at).toISOString(), replacesBookingId: r.replaces_booking_id,
  };
}

export class PgStore implements Store {
  private now = "";
  private db: Driver;
  constructor(db: Driver) { this.db = db; }

  setNow(iso: string) { this.now = iso; }

  private q(sql: string, params: unknown[] = [], s: Session = {}) {
    return this.db.query(sql, params, { role: "ande_agent", now: this.now, ...s }).catch(mapError);
  }

  async init(venues: Venue[]) {
    for (const v of venues) {
      await this.db.query("INSERT INTO venues (id, name, payee_id, data) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (id) DO NOTHING",
        [v.id, v.name, v.payeeId, JSON.stringify(v)], {});
      for (const r of v.rooms) {
        await this.db.query("INSERT INTO rooms (id, venue_id, private, listed_capacity) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
          [r.id, v.id, r.private, r.listedCapacity], {});
      }
    }
  }

  async createRun(run: { id: string; actorId: string; principalId: string; requestText: string }) {
    await this.q("INSERT INTO runs (id, actor_id, principal_id, request_text) VALUES ($1, $2, $3, $4)",
      [run.id, run.actorId, run.principalId, run.requestText]);
  }

  async appendStep(runId: string, agent: string, kind: string, detail: Record<string, unknown>) {
    await this.q(`INSERT INTO run_steps (run_id, seq, agent, kind, detail)
      SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4::jsonb FROM run_steps WHERE run_id = $1`, [runId, agent, kind, JSON.stringify(detail)]);
  }

  async steps(runId: string) {
    const rows = await this.q("SELECT seq, agent, kind, detail FROM run_steps WHERE run_id = $1 ORDER BY seq", [runId]);
    return rows.map((r) => ({ seq: r.seq, agent: r.agent, kind: r.kind, detail: r.detail }));
  }

  async findToolCall(key: string) {
    const rows = await this.q("SELECT output FROM tool_calls WHERE idempotency_key = $1", [key]);
    return rows[0] ? { output: rows[0].output } : null;
  }

  async saveToolCall(c: { key: string; runId: string; tool: string; actorId: string; principalId: string; input: unknown; output: unknown }) {
    await this.q(`INSERT INTO tool_calls (idempotency_key, run_id, tool, actor_id, principal_id, input, output)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb) ON CONFLICT (idempotency_key) DO NOTHING`,
      [c.key, c.runId, c.tool, c.actorId, c.principalId, JSON.stringify(c.input ?? null), JSON.stringify(c.output ?? null)]);
  }

  async createProposal(p: Proposal) {
    await this.q(`INSERT INTO proposals (id, run_id, kind, actor_id, principal_id, venue_id, room_id, starts_at, ends_at,
        party_size, amount_cents, payee_id, required_roles, summary, expires_at, replaces_booking_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, nullif($12, ''), string_to_array($13, ','), $14, $15, nullif($16, ''))`,
      [p.id, p.runId, p.kind, p.actorId, p.principalId, p.venueId, p.roomId, p.startsAt, p.endsAt, p.partySize,
        p.amountCents, p.payeeId ?? "", p.requiredRoles.join(","), p.summary, p.expiresAt, p.replacesBookingId ?? ""]);
  }

  async getProposal(id: string) {
    const rows = await this.q("SELECT * FROM proposals WHERE id = $1", [id]);
    return rows[0] ? toProposal(rows[0]) : null;
  }

  async decide(proposalId: string, userId: string, role: Role, decision: "approve" | "reject") {
    await this.db.query("INSERT INTO approvals (proposal_id, role, user_id, decision) VALUES ($1, $2, $3, $4)",
      [proposalId, role, userId, decision], { role: "ande_approver", now: this.now }).catch(mapError);
    const p = await this.getProposal(proposalId);
    if (!p) throw new StoreError("unknown", `no proposal ${proposalId}`);
    return p;
  }

  async book(b: BookingRow) {
    await this.q(`INSERT INTO bookings (id, proposal_id, venue_id, room_id, during, party_size)
      VALUES ($1, $2, $3, $4, tstzrange($5::timestamptz, $6::timestamptz), $7)`,
      [b.id, b.proposalId, b.venueId, b.roomId, b.startsAt, b.endsAt, b.partySize]);
  }

  async getBooking(id: string) {
    const rows = await this.q("SELECT id, proposal_id, venue_id, room_id, lower(during) AS s, upper(during) AS e, party_size, status FROM bookings WHERE id = $1", [id]);
    const r = rows[0];
    return r ? { id: r.id, proposalId: r.proposal_id, venueId: r.venue_id, roomId: r.room_id, startsAt: new Date(r.s).toISOString(), endsAt: new Date(r.e).toISOString(), partySize: r.party_size, status: r.status } : null;
  }

  async amend(proposalId: string, newBookingId: string) {
    await this.q("SELECT amend_booking($1, $2) AS id", [proposalId, newBookingId]);
  }

  async cancel(proposalId: string) {
    await this.q("SELECT cancel_booking($1) AS id", [proposalId]);
  }

  async pay(p: PaymentRow) {
    // A retry with the same idempotency key inserts nothing, so the trigger never runs twice.
    await this.q(`INSERT INTO payments (id, idempotency_key, proposal_id, booking_id, payee_id, amount_cents)
      SELECT $1, $2, $3, $4, $5, $6 WHERE NOT EXISTS (SELECT 1 FROM payments WHERE idempotency_key = $2)`,
      [p.id, p.idempotencyKey, p.proposalId, p.bookingId, p.payeeId, p.amountCents]);
  }

  async addFact(f: VenueFact) {
    await this.q(`INSERT INTO venue_facts (venue_id, room_id, kind, value, confidence, source_message_id)
      VALUES ($1, nullif($2, ''), $3, $4::jsonb, $5, $6)`, [f.venueId, f.roomId ?? "", f.kind, JSON.stringify(f.value), f.confidence, f.sourceMessageId]);
  }

  async facts(venueId: string) {
    const rows = await this.q("SELECT * FROM venue_facts WHERE venue_id = $1 ORDER BY observed_at", [venueId]);
    return rows.map((r) => ({ venueId: r.venue_id, roomId: r.room_id, kind: r.kind, value: r.value, confidence: r.confidence, sourceMessageId: r.source_message_id }));
  }

  async remember(m: Memory) {
    await this.q("INSERT INTO memories (company_id, scope, owner_user_id, subject, fact, source) VALUES ($1, $2, $3, $4, $5, $6)",
      [m.companyId, m.scope, m.ownerUserId, m.subject, m.fact, m.source], { userId: m.ownerUserId, companyId: m.companyId });
  }

  async recall(companyId: string, userId: string) {
    // No WHERE on scope or owner: row-level security decides what this user may see.
    const rows = await this.q("SELECT company_id, scope, owner_user_id, subject, fact, source FROM memories ORDER BY id", [], { userId, companyId });
    return rows.map((r) => ({ companyId: r.company_id, scope: r.scope, ownerUserId: r.owner_user_id, subject: r.subject, fact: r.fact, source: r.source }));
  }

  async audit(runId: string | null, actorId: string, action: string, detail: Record<string, unknown>) {
    await this.q("INSERT INTO audit_log (run_id, actor_id, action, detail) VALUES (nullif($1, ''), $2, $3, $4::jsonb)", [runId ?? "", actorId, action, JSON.stringify(detail)]);
  }

  async auditLog(runId: string) {
    const rows = await this.q("SELECT actor_id, action, detail FROM audit_log WHERE run_id = $1 ORDER BY id", [runId]);
    return rows.map((r) => ({ actorId: r.actor_id, action: r.action, detail: r.detail }));
  }
}

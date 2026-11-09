import { spawnSync } from "node:child_process";
import { buildVenues } from "../data/seed.ts";
import type { Proposal } from "../src/domain/types.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { PgStore, psqlDriver } from "../src/store/pg.ts";
import type { Store } from "../src/store/store.ts";

/** Stores under test. Postgres joins when ANDE_PSQL holds psql connection flags, e.g. "-h /var/tmp -p 5544 -U postgres". */
export function storeFactories(): [string, () => Promise<Store>][] {
  const out: [string, () => Promise<Store>][] = [["memory", async () => {
    const s = new MemoryStore();
    await s.init(buildVenues());
    return s;
  }]];
  const flags = process.env.ANDE_PSQL;
  if (flags) {
    const base = flags.split(/\s+/).filter(Boolean);
    let n = 0;
    out.push(["postgres", async () => {
      const db = `ande_test_${process.pid}_${n++}`;
      const run = (a: string[], input?: string) => {
        const r = spawnSync("psql", [...base, "-X", "-q", "-v", "ON_ERROR_STOP=1", ...a], { input, encoding: "utf8" });
        if (r.status !== 0) throw new Error(r.stderr);
      };
      run(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${db}`]);
      run(["-d", "postgres", "-c", `CREATE DATABASE ${db}`]);
      run(["-d", db, "-f", new URL("../db/schema.sql", import.meta.url).pathname]);
      const s = new PgStore(psqlDriver([...base, "-d", db]));
      await s.init(buildVenues());
      return s;
    }]);
  }
  return out;
}

export function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: "prop_1", runId: "run_1", kind: "book", actorId: "usr_priya", principalId: "usr_dana",
    venueId: "ven_02", roomId: "ven_02_pdr", startsAt: "2026-11-12T23:30:00.000Z", endsAt: "2026-11-13T02:30:00.000Z",
    partySize: 12, amountCents: 180_000, payeeId: null, requiredRoles: ["booker"], approvedRoles: [], status: "pending",
    summary: "Dinner for 12", expiresAt: "2026-11-11T00:00:00.000Z", ...over,
  };
}

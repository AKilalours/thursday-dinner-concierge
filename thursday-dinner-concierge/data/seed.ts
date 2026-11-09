// Fictional supply and customers. Every venue, company and person here is invented.
import type { Company, User, Venue } from "../src/domain/types.ts";

const NEIGHBORHOODS = ["Flatiron", "Midtown", "Tribeca", "West Village", "SoHo", "Chelsea", "Financial District", "Williamsburg"];
const CUISINES = ["italian", "steakhouse", "japanese", "new american", "french", "mediterranean", "korean", "seafood"];
const NAMES = [
  "Larkspur Table", "The Copper Fig", "Osteria Lumen", "Halden & Vine", "Kiso House", "Marrow & Ash", "Bistro Ondine",
  "The Gilded Pear", "Saltworks Oyster Room", "Ember Lane", "Casa Verbena", "Juniper Hall", "Nakamura Counter",
  "The Brass Lantern", "Olea Kitchen", "Seoul Garden Room", "Harbor & Rye", "Maison Clement", "Twelve Pines",
  "The Velvet Ledger", "Fenwick Chophouse", "Aster & Thyme", "Lantern Row", "Piazza Notte", "The Quiet Owl",
  "Driftwood Social", "Cedar & Salt", "Rue Margaux", "Hollow Oak Tavern", "Sora Omakase",
];

/** Deterministic pseudo-random numbers so the world is identical on every machine. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function money(dollars: number): number {
  return Math.round(dollars) * 100;
}

export function buildVenues(seed = 7): Venue[] {
  const r = rng(seed);
  return NAMES.map((name, i) => {
    const id = `ven_${String(i + 1).padStart(2, "0")}`;
    const perHead = 60 + Math.floor(r() * 160); // $60-$220 a head at dinner
    const bigRoom = 10 + Math.floor(r() * 30);
    const weekdayMin = money(perHead * bigRoom * (0.6 + r() * 0.3));
    const weekendMin = Math.round(weekdayMin * 1.4);
    const rooms = [
      { id: `${id}_main`, name: "Main dining room", private: false, listedCapacity: 60, minSpendCents: [0, 0, 0, 0, 0, 0, 0] },
      {
        id: `${id}_pdr`, name: i % 3 === 0 ? "The Library" : i % 3 === 1 ? "Wine Cellar" : "Chef's Room",
        private: true, listedCapacity: bigRoom,
        minSpendCents: [weekendMin, weekdayMin, weekdayMin, weekdayMin, weekdayMin, weekendMin, weekendMin],
      },
    ];
    if (i % 4 === 0) {
      rooms.push({
        id: `${id}_pdr2`, name: "Garden Room", private: true, listedCapacity: Math.max(8, bigRoom - 8),
        minSpendCents: rooms[1].minSpendCents.map((c) => Math.round(c * 0.6)),
      });
    }
    return {
      id, name,
      neighborhood: NEIGHBORHOODS[i % NEIGHBORHOODS.length],
      cuisine: CUISINES[(i * 3) % CUISINES.length],
      perHeadCents: money(perHead),
      preferredRatePct: i % 3 === 1 ? 12 + (i % 4) : 0, // about a third are partners with 12-15% corporate rates
      rooms,
      email: `events@${name.toLowerCase().replace(/[^a-z]+/g, "")}.example`,
      payeeId: `payee_${id}`,
      depositPct: [0, 20, 25, 30, 50][i % 5],
      contractRequired: i % 2 === 0,
      cancellationHours: [24, 48, 72][i % 3],
      closedDays: i % 6 === 0 ? [1] : [],
    };
  });
}

export const COMPANY: Company = {
  id: "co_northwind",
  name: "Northwind Labs",
  officeNeighborhood: "Flatiron",
  policy: {
    perHeadCapCents: { client_dinner: 25_000, team_dinner: 12_000, client_lunch: 9_000, happy_hour: 6_000 },
    managerApprovalAboveCents: 250_000,
    financeApprovalDepositAbovePct: 50,
    minLeadHours: 24,
    blockedVenueIds: ["ven_20"],
  },
};

export const USERS: User[] = [
  { id: "usr_priya", name: "Priya Raman", companyId: COMPANY.id, roles: ["booker"], actsFor: ["usr_dana"], phone: "+15550100001" },
  { id: "usr_dana", name: "Dana Whitfield", companyId: COMPANY.id, roles: ["booker"], actsFor: [], phone: "+15550100002" },
  { id: "usr_marcus", name: "Marcus Lee", companyId: COMPANY.id, roles: ["manager"], actsFor: [], phone: null },
  { id: "usr_jordan", name: "Jordan Kim", companyId: COMPANY.id, roles: ["finance"], actsFor: [], phone: null },
  { id: "usr_sam", name: "Sam Ortiz", companyId: COMPANY.id, roles: ["booker"], actsFor: [], phone: null },
];

export function user(id: string): User {
  const u = USERS.find((x) => x.id === id);
  if (!u) throw new Error(`unknown user ${id}`);
  return u;
}

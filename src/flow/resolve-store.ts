// Turn a store *name* into the two things a run actually needs: the Redo team
// id and a merchant JWT. The operator gives a name because that is what they
// have after a call; nobody reads a 24-hex id off a URL.
//
// Ambiguity here is an input error, not a judgement call. Writing flows into
// the wrong merchant's account is the one mistake in this pipeline that cannot
// be undone from the outside, so a name that matches two stores stops the run
// before anything is created.
//
//   npx tsx src/flow/resolve-store.ts "Bailey's Blossoms"

import { execFileSync } from "node:child_process";

const ADMIN_BASE = process.env.REDO_ADMIN_BASE ?? "https://admin-server.getredo.com";
const KEYCHAIN_SERVICE = "redo-admin-jwt";

export interface Team {
  _id: string;
  name: string;
  storeUrl?: string;
}

export class StoreResolutionError extends Error {
  constructor(message: string, readonly candidates: Team[] = []) {
    super(message);
    this.name = "StoreResolutionError";
  }
}

/** The org-wide admin token. Read on demand and never held longer than a call. */
function adminToken(): string {
  const fromEnv = process.env.REDO_ADMIN_TOKEN;
  if (fromEnv) return fromEnv.trim();
  try {
    return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8",
    }).trim();
  } catch {
    throw new StoreResolutionError(
      `no admin token — run \`jwt-bandit setup\` (stores it in the "${KEYCHAIN_SERVICE}" keychain item) or set REDO_ADMIN_TOKEN`,
    );
  }
}

export async function searchTeams(name: string, limit = 25): Promise<Team[]> {
  const url = `${ADMIN_BASE}/teams?search=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${adminToken()}`, "X-Page-Size": String(limit) },
  });
  if (res.status === 401 || res.status === 403) {
    throw new StoreResolutionError("admin token rejected — re-run `jwt-bandit setup`");
  }
  if (!res.ok) {
    throw new StoreResolutionError(`team search failed: HTTP ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  return Array.isArray(body) ? body : (body?.teams ?? []);
}

const normalize = (s: string) => s.trim().toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ");

/**
 * Exactly one store, or an error naming the alternatives. An exact
 * case-insensitive name match beats any number of fuzzy ones — searching
 * "Bailey" returns four stores, and one of them is called Bailey.
 */
export function pickTeam(name: string, candidates: Team[]): Team {
  if (candidates.length === 0) {
    throw new StoreResolutionError(`no Redo store matches "${name}"`);
  }
  const exact = candidates.filter((t) => normalize(t.name ?? "") === normalize(name));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new StoreResolutionError(
      `"${name}" matches ${exact.length} stores with that exact name — pass the team id instead`,
      exact,
    );
  }
  if (candidates.length === 1) return candidates[0];
  throw new StoreResolutionError(
    `"${name}" matches ${candidates.length} stores and none exactly — ` +
      `re-run with the full name or the team id: ` +
      candidates.map((t) => `${t.name} (${t._id})`).join("; "),
    candidates,
  );
}

/** Mint a merchant session for the team. The token is returned, never logged. */
export function mintJwt(teamId: string): string {
  try {
    return execFileSync("jwt-bandit", [teamId], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new StoreResolutionError(
      `jwt-bandit could not mint a session for ${teamId} — check it is installed (\`npm link\` in the jwt-bandit repo) and the admin token is current`,
    );
  }
}

export interface ResolvedStore {
  teamId: string;
  name: string;
  storeUrl?: string;
  jwt: string;
}

/** Name in, everything a run needs out. */
export async function resolveStore(name: string): Promise<ResolvedStore> {
  const team = /^[0-9a-f]{24}$/.test(name.trim())
    ? { _id: name.trim(), name: name.trim() }
    : pickTeam(name, await searchTeams(name));
  return { teamId: team._id, name: team.name, storeUrl: team.storeUrl, jwt: mintJwt(team._id) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const name = process.argv.slice(2).join(" ");
  if (!name) {
    console.error('usage: npx tsx src/flow/resolve-store.ts "<store name>"');
    process.exit(1);
  }
  resolveStore(name)
    .then((s) => {
      console.log(`${s.name}  ${s.teamId}${s.storeUrl ? `  ${s.storeUrl}` : ""}`);
      console.log("jwt minted (not printed) — export it with:");
      console.log(`  REDO_JWT="$(jwt-bandit ${s.teamId})"`);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}

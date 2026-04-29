// Persistence layer with two backends:
//   - Postgres (prod, default)
//   - In-memory (Render PR previews — IS_PULL_REQUEST=true)
//
// Both expose the same async surface so the route handlers don't care which is active.
import pkg from "pg";
const { Pool } = pkg;

export const IS_PREVIEW = process.env.IS_PULL_REQUEST === "true";
export const STORE_KIND = IS_PREVIEW ? "memory (preview)" : "postgres (prod)";

export function makeStore() {
  if (IS_PREVIEW || !process.env.DATABASE_URL) return makeMemoryStore();
  return makePgStore(process.env.DATABASE_URL);
}

// ── In-memory store ────────────────────────────────────────
function makeMemoryStore() {
  const map = new Map(); // email → row
  let nextId = 1;
  return {
    kind: "memory",
    async init() {},
    async health() { return { ok: true, db: "memory" }; },
    async addSignup({ email, name, source, ip, userAgent }) {
      const existing = map.get(email);
      if (existing) return { id: existing.id, isNew: false };
      const row = {
        id: nextId++,
        email,
        name: name ?? null,
        source: source ?? null,
        ip: ip ?? null,
        user_agent: userAgent ?? null,
        created_at: new Date().toISOString(),
      };
      map.set(email, row);
      return { id: row.id, isNew: true };
    },
    async listSignups(limit = 1000) {
      return [...map.values()]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit)
        .map(({ ip, user_agent, ...pub }) => pub); // omit IP/UA from list response
    },
    async count() { return map.size; },
  };
}

// ── Postgres store ─────────────────────────────────────────
function makePgStore(connStr) {
  const pool = new Pool({
    connectionString: connStr,
    ssl: connStr.includes("render.com") ? { rejectUnauthorized: false } : undefined,
  });
  return {
    kind: "postgres",
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS waitlist (
          id          SERIAL PRIMARY KEY,
          email       TEXT NOT NULL,
          name        TEXT,
          source      TEXT,
          ip          TEXT,
          user_agent  TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT  waitlist_email_unique UNIQUE (email)
        );
      `);
      // Idempotent migration: add name column if missing (for older schemas)
      await pool.query(`ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS name TEXT;`);
      await pool.query(`CREATE INDEX IF NOT EXISTS waitlist_created_idx ON waitlist (created_at DESC);`);
    },
    async health() {
      const { rows } = await pool.query("SELECT 1 AS ok");
      return { ok: true, db: rows[0].ok === 1 ? "postgres" : "unknown" };
    },
    async addSignup({ email, name, source, ip, userAgent }) {
      const { rows } = await pool.query(
        `INSERT INTO waitlist (email, name, source, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO UPDATE
           SET name = COALESCE(EXCLUDED.name, waitlist.name)
         RETURNING id, (xmax = 0) AS is_new`,
        [email, name ?? null, source ?? null, ip, userAgent],
      );
      return { id: rows[0].id, isNew: rows[0].is_new };
    },
    async listSignups(limit = 1000) {
      const { rows } = await pool.query(
        `SELECT id, email, name, source, created_at FROM waitlist ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      return rows;
    },
    async count() {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM waitlist`);
      return rows[0].count;
    },
  };
}

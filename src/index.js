// Waitlist API for gomagnet.ai. Express + Postgres on Render.
import express from "express";
import cors from "cors";
import pkg from "pg";
import { z } from "zod";

const { Pool } = pkg;
const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// ── DB ──────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com") ? { rejectUnauthorized: false } : undefined,
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS waitlist (
      id          SERIAL PRIMARY KEY,
      email       TEXT NOT NULL,
      source      TEXT,
      ip          TEXT,
      user_agent  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT  waitlist_email_unique UNIQUE (email)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS waitlist_created_idx ON waitlist (created_at DESC);`);
  console.log("[migrate] schema ready");
}

// ── Middleware ──────────────────────────────────────────────
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || "https://gomagnet.ai,https://www.gomagnet.ai").split(",").map((s) => s.trim());
app.use(
  cors({
    origin: (origin, cb) => {
      // Allow same-origin (no Origin header) + listed origins + any *.onrender.com preview
      if (!origin) return cb(null, true);
      if (ALLOW_ORIGINS.includes(origin)) return cb(null, true);
      if (/\.onrender\.com$/.test(new URL(origin).hostname)) return cb(null, true);
      if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked: ${origin}`));
    },
  }),
);
app.use(express.json({ limit: "16kb" }));

// Trust Render's proxy so req.ip reflects the real client.
app.set("trust proxy", true);

// ── Naive in-memory rate limit: 5 req / IP / minute ─────────
const buckets = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const bucket = buckets.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + 60_000; }
  bucket.count++;
  buckets.set(ip, bucket);
  if (bucket.count > 5) return res.status(429).json({ error: "Too many requests, slow down." });
  next();
}

// ── Validation ──────────────────────────────────────────────
const SignupSchema = z.object({
  email:  z.string().email().max(254).transform((v) => v.trim().toLowerCase()),
  source: z.string().max(64).optional(),
});

// ── Routes ──────────────────────────────────────────────────
app.get("/api/health", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, db: rows[0].ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/api/waitlist", rateLimit, async (req, res) => {
  const parsed = SignupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid email" });
  const { email, source } = parsed.data;
  const ua = (req.headers["user-agent"] || "").toString().slice(0, 500);
  const ip = req.ip || null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO waitlist (email, source, ip, user_agent)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id, email, created_at`,
      [email, source ?? null, ip, ua],
    );
    res.json({ ok: true, message: "You're on the list!", id: rows[0].id });
  } catch (e) {
    console.error("[waitlist] insert failed", e);
    res.status(500).json({ error: "Could not save signup. Please try again." });
  }
});

// Admin: list signups. Simple bearer token from env.
app.get("/api/waitlist", async (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { rows } = await pool.query(
      `SELECT id, email, source, created_at FROM waitlist ORDER BY created_at DESC LIMIT 1000`,
    );
    res.json({ count: rows.length, signups: rows });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/waitlist/count", async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM waitlist`);
    res.json({ count: rows[0].count });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Boot ────────────────────────────────────────────────────
(async () => {
  if (process.env.DATABASE_URL) {
    try { await migrate(); }
    catch (e) { console.error("[migrate] failed", e); process.exit(1); }
  } else {
    console.warn("[boot] DATABASE_URL not set — running without DB; calls will fail");
  }
  app.listen(PORT, () => console.log(`[boot] waitlist api listening on :${PORT}`));
})();

// Waitlist API for gomagnet.ai. Express + Postgres on Render.
// On Render PR previews (IS_PULL_REQUEST=true) the store auto-falls-back to in-memory
// so previews can't touch prod data.
import express from "express";
import { z } from "zod";
import { makeStore, IS_PREVIEW, STORE_KIND } from "./store.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const store = makeStore();
app.set("trust proxy", true);

// ── CORS — hand-rolled so Express 5 handles preflight on all paths ──
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || "https://gomagnet.ai,https://www.gomagnet.ai")
  .split(",")
  .map((s) => s.trim());

function isAllowed(origin) {
  if (!origin) return false;
  if (ALLOW_ORIGINS.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    if (/\.onrender\.com$/.test(host)) return true;
    if (/^localhost$/.test(host)) return true;
  } catch {}
  return false;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.use(express.json({ limit: "16kb" }));

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

const SignupSchema = z.object({
  email: z.string().email().max(254).transform((v) => v.trim().toLowerCase()),
  name: z.string().min(1).max(120).optional().transform((v) => v?.trim() || undefined),
  source: z.string().max(64).optional(),
});

// ── Routes ──────────────────────────────────────────────────
app.get("/api/health", async (_req, res) => {
  try {
    const h = await store.health();
    res.json({ ok: true, ...h, mode: IS_PREVIEW ? "preview" : "prod" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/api/waitlist", rateLimit, async (req, res) => {
  const parsed = SignupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid email" });
  const { email, name, source } = parsed.data;
  const ua = (req.headers["user-agent"] || "").toString().slice(0, 500);
  const ip = req.ip || null;
  try {
    const { id, isNew } = await store.addSignup({ email, name, source, ip, userAgent: ua });
    res.json({
      ok: true,
      message: isNew ? "You're on the list!" : "You're already on the list.",
      id,
      preview: IS_PREVIEW || undefined,
    });
  } catch (e) {
    console.error("[waitlist] insert failed", e);
    res.status(500).json({ error: "Could not save signup. Please try again." });
  }
});

app.get("/api/waitlist", async (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  try {
    const signups = await store.listSignups(1000);
    res.json({ count: signups.length, signups, mode: IS_PREVIEW ? "preview" : "prod" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/waitlist/count", async (_req, res) => {
  try {
    const count = await store.count();
    res.json({ count, mode: IS_PREVIEW ? "preview" : "prod" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Boot ────────────────────────────────────────────────────
(async () => {
  console.log(`[boot] store: ${STORE_KIND}`);
  try { await store.init(); console.log("[boot] store ready"); }
  catch (e) { console.error("[boot] store init failed", e); process.exit(1); }
  app.listen(PORT, () => console.log(`[boot] waitlist api listening on :${PORT}`));
})();

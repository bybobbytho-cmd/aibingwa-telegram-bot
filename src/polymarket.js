import fs from "fs/promises";
import path from "path";

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

const DATA_DIR = "./data";
const JOURNAL_PATH = path.join(DATA_DIR, "journal.log");

// --------------------
// Journal (progress log)
// --------------------
export async function appendJournal(line) {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const ts = new Date().toISOString();
    await fs.appendFile(JOURNAL_PATH, `${ts} ${line}\n`, "utf8");
  } catch {
    // If FS fails on Railway (rare), at least don’t crash the bot.
  }
}

export async function tailJournal(n = 30) {
  try {
    const txt = await fs.readFile(JOURNAL_PATH, "utf8");
    const lines = txt.trim().split("\n").filter(Boolean);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

// --------------------
// HTTP util
// --------------------
async function fetchJson(url, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} for ${url}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }

    return data;
  } finally {
    clearTimeout(t);
  }
}

// --------------------
// Gamma: event by slug
// --------------------
async function gammaEventBySlug(slug) {
  const url = `${GAMMA_BASE}/events/slug/${encodeURIComponent(slug)}`;
  try {
    const data = await fetchJson(url);
    // Gamma sometimes returns an object, sometimes an array. Normalize.
    if (Array.isArray(data)) return data[0] ?? null;
    return data ?? null;
  } catch (e) {
    // 404 = slug not indexed or not existing
    if (e?.status === 404) return null;
    throw e;
  }
}

// --------------------
// CLOB: midpoints
// --------------------
async function clobMidpoints(tokenIds) {
  const ids = tokenIds.filter(Boolean);
  if (!ids.length) return {};
  const url =
    `${CLOB_BASE}/midpoints?` +
    new URLSearchParams({ token_ids: ids.join(",") }).toString();
  const data = await fetchJson(url);
  return data && typeof data === "object" ? data : {};
}

// --------------------
// Helpers
// --------------------
function safeParseArray(maybeJson) {
  if (Array.isArray(maybeJson)) return maybeJson;
  if (typeof maybeJson === "string") {
    try {
      const v = JSON.parse(maybeJson);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  return [];
}

function secondsForInterval(interval) {
  if (interval === "5m") return 300;
  if (interval === "15m") return 900;
  if (interval === "60m") return 3600;
  return null;
}

function assetSlugNames(asset) {
  // We try both short + long, because naming varies.
  if (asset === "btc") return ["btc", "bitcoin"];
  if (asset === "eth") return ["eth", "ethereum"];
  if (asset === "sol") return ["sol", "solana"];
  if (asset === "xrp") return ["xrp", "ripple"];
  return [asset];
}

function computeWindowStart(nowSec, stepSec) {
  return Math.floor(nowSec / stepSec) * stepSec;
}

// --------------------
// Main: Up/Down resolver (WORKING METHOD)
// Gamma event-by-slug -> token ids -> CLOB midpoints
// --------------------
export async function resolveUpDown({ asset, interval }) {
  const step = secondsForInterval(interval);
  if (!step) {
    return { found: false, triedSlugs: [], lastError: "unsupported interval" };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const ws = computeWindowStart(nowSec, step);

  // Robust: try multiple windows because indexing can lag or be ahead.
  // Order matters: start near “now”, then walk out.
  const offsets = [0, -1, +1, -2, +2, -3, +3, -4, +4, -5, +5];
  const tsCandidates = offsets.map((k) => ws + k * step);

  const names = assetSlugNames(asset);

  const tried = [];
  let lastError = null;

  for (const ts of tsCandidates) {
    for (const name of names) {
      const slug = `${name}-updown-${interval}-${ts}`;
      tried.push(slug);

      const ev = await gammaEventBySlug(slug);
      if (!ev) {
        lastError = "404 slug not found";
        continue;
      }

      const title = ev?.title || ev?.question || "Up/Down";
      const markets = Array.isArray(ev?.markets) ? ev.markets : [];
      const m0 = markets[0] ?? null;

      const tokenIds = safeParseArray(m0?.clobTokenIds);
      if (tokenIds.length < 2) {
        lastError = "event found but missing clobTokenIds";
        continue;
      }

      const upTokenId = tokenIds[0];
      const downTokenId = tokenIds[1];

      const mids = await clobMidpoints([upTokenId, downTokenId]);

      const upMid = mids?.[upTokenId] != null ? Number(mids[upTokenId]) : null;
      const downMid = mids?.[downTokenId] != null ? Number(mids[downTokenId]) : null;

      return {
        found: true,
        slug,
        title,
        upTokenId,
        downTokenId,
        upMid,
        downMid,
        triedSlugs: tried.slice(-6),
        lastError: null,
      };
    }
  }

  return {
    found: false,
    triedSlugs: tried.slice(-6),
    lastError,
  };
}

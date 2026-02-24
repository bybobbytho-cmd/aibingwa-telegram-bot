// src/polymarket.js
// Read-only Polymarket market discovery via Gamma API.
// No auth required.

const GAMMA_BASE = "https://gamma-api.polymarket.com";

export async function searchMarkets(query, limit = 5) {
  const q = encodeURIComponent(query);
  const url = `${GAMMA_BASE}/markets?search=${q}&limit=${limit}`;

  const res = await fetch(url, {
    headers: { "accept": "application/json" },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Gamma API error ${res.status}: ${txt}`);
  }

  const data = await res.json();

  // Gamma returns an array of markets
  // We normalize into a simple list for Telegram display
  return (data || []).slice(0, limit).map((m) => ({
    id: m.id,
    question: m.question,
    slug: m.slug,
    active: m.active,
    volume: m.volume,
    liquidity: m.liquidity,
    // Sometimes “outcomes” or “outcomePrices” exist depending on endpoint.
    outcomes: m.outcomes,
    outcomePrices: m.outcomePrices,
  }));
}

export function formatMarkets(markets) {
  if (!markets?.length) return "No markets found.";

  return markets
    .map((m, idx) => {
      const prices = Array.isArray(m.outcomePrices)
        ? m.outcomePrices.join(", ")
        : (m.outcomePrices ? String(m.outcomePrices) : "N/A");

      return [
        `#${idx + 1}`,
        `Q: ${m.question || "N/A"}`,
        `Active: ${m.active ? "Yes" : "No"}`,
        `Volume: ${m.volume ?? "N/A"}`,
        `Liquidity: ${m.liquidity ?? "N/A"}`,
        `Slug: ${m.slug || "N/A"}`,
        `Prices: ${prices}`,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

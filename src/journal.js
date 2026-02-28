import fs from "fs";

const JOURNAL_PATH = "./journal.jsonl"; // writes inside container; still useful even if not persistent
const mem = []; // in-memory tail

function safeWrite(line) {
  try {
    fs.appendFileSync(JOURNAL_PATH, line + "\n", "utf8");
  } catch {
    // If file system is restricted, console logging still captures it in Railway logs
  }
}

export function journal(entry) {
  const row = {
    ts: new Date().toISOString(),
    ...entry,
  };

  mem.unshift(row);
  if (mem.length > 200) mem.pop();

  const line = JSON.stringify(row);
  safeWrite(line);
  console.log("[JOURNAL]", line);
}

export function tailJournalText(n = 20) {
  const rows = mem.slice(0, n);

  if (!rows.length) {
    return "*Journal is empty.*\nRun /updownbtc5m then /log";
  }

  const lines = rows.map((r) => {
    const head = `• \`${r.ts}\` *${r.event || "event"}*`;
    const bits = [];

    if (r.asset) bits.push(`asset=${r.asset}`);
    if (r.interval) bits.push(`interval=${r.interval}`);
    if (r.slug) bits.push(`slug=${r.slug}`);
    if (r.level) bits.push(`level=${r.level}`);
    if (typeof r.upMid === "number") bits.push(`up=${Math.round(r.upMid * 100)}¢`);
    if (typeof r.downMid === "number") bits.push(`down=${Math.round(r.downMid * 100)}¢`);
    if (r.error) bits.push(`error=${String(r.error).slice(0, 80)}`);

    return `${head}\n  ${bits.join(" | ")}`;
  });

  return ["📓 *AIBINGWA Journal (latest)*", "", ...lines].join("\n");
}

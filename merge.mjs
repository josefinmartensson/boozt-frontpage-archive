// Folds docs/data/partial-*.json (written by capture.mjs) into docs/data/index.json and removes the partials.
// Optional: RETENTION_DAYS=90 deletes screenshots older than that.
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DOCS = path.join(ROOT, "docs");
const DATA = path.join(DOCS, "data");
const INDEX = path.join(DATA, "index.json");

let index = [];
try { index = JSON.parse(await fs.readFile(INDEX, "utf8")); } catch {}

const key = r => r.file || `${r.date} ${r.time} ${r.cc} ${r.dept} ${r.device}`;
const byKey = new Map(index.map(r => [key(r), r]));
let added = 0;
for (const f of (await fs.readdir(DATA).catch(() => [])).filter(f => f.startsWith("partial-") && f.endsWith(".json"))) {
  const rows = JSON.parse(await fs.readFile(path.join(DATA, f), "utf8"));
  for (const r of rows) { byKey.set(key(r), r); added++; }
  await fs.rm(path.join(DATA, f));
}
index = [...byKey.values()];

const keep = Number(process.env.RETENTION_DAYS || 0);
if (keep > 0) {
  const cutoff = new Date(Date.now() - keep * 864e5).toISOString().slice(0, 10);
  for (const folder of ["shots", "emails"])
    for (const d of await fs.readdir(path.join(DOCS, folder)).catch(() => [])) if (d < cutoff) await fs.rm(path.join(DOCS, folder, d), { recursive: true, force: true });
  index = index.filter(r => r.date >= cutoff);
}

index.sort((a, b) => `${a.date} ${a.time} ${a.cc}`.localeCompare(`${b.date} ${b.time} ${b.cc}`));
await fs.mkdir(DATA, { recursive: true });
await fs.writeFile(INDEX, JSON.stringify(index));
console.log(`Merged ${added} rows. Index now has ${index.length} snapshots.`);

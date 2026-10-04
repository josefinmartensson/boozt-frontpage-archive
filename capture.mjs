// Captures Boozt department frontpages for all markets, desktop and mobile.
// Runs on GitHub Actions at 08:00 and 16:00 Europe/Copenhagen. No local machine needed.
// Usage: node capture.mjs            (normal run, only acts in the 08:00 / 16:00 window)
//        FORCE=1 node capture.mjs    (run now, slot = nearest of 08:00 / 16:00)
//        ONLY=se node capture.mjs    (limit to some markets, comma separated)
//        node capture.mjs --discover (print discovered department URLs per market and exit)
import { chromium, devices } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DOCS = path.join(ROOT, "docs");
const INDEX = path.join(DOCS, "data", "index.json");
const URLS_CACHE = path.join(ROOT, "urls.json");
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, "markets.json"), "utf8"));
const DEPTS = ["women", "men", "kids", "home", "beauty", "sport-women", "sport-men", "sport-kids"];
const only = process.env.ONLY?.split(",").map(s => s.trim());
const discoverOnly = process.argv.includes("--discover");

// Current date and hour in Copenhagen
const parts = Object.fromEntries(
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map(p => [p.type, p.value])
);
const date = `${parts.year}-${parts.month}-${parts.day}`;
const hour = Number(parts.hour);
let time = hour >= 8 && hour < 12 ? "08:00" : hour >= 16 && hour < 20 ? "16:00" : null;
if (!time && process.env.FORCE) time = hour < 12 ? "08:00" : "16:00";
if (!time && !discoverOnly) { console.log(`Hour ${hour} Copenhagen is outside the capture window. Exiting.`); process.exit(0); }

let index = [];
try { index = JSON.parse(await fs.readFile(INDEX, "utf8")); } catch {}
if (!discoverOnly && !process.env.FORCE && index.some(r => r.date === date && r.time === time)) {
  console.log(`Slot ${date} ${time} already captured. Exiting.`); process.exit(0);
}

let cache = {};
try { cache = JSON.parse(await fs.readFile(URLS_CACHE, "utf8")); } catch {}

const browser = await chromium.launch();
const results = [], failures = [];

async function dismissCookies(page) {
  for (const sel of ["#didomi-notice-agree-button", "button:has-text('Accept')", "button:has-text('Acceptera')", "button:has-text('Accepter')", "button:has-text('Alle akzeptieren')"]) {
    try { await page.locator(sel).first().click({ timeout: 1500 }); return; } catch {}
  }
}

// Find department URLs from the market homepage navigation.
// Order in the main nav on Boozt: women, men, kids, (sport), beauty, home. Sport has no own link in every market,
// so it is taken from a link under the women section that ends in /sport. Check urls.json after the first run.
async function discover(m) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(m.home, { waitUntil: "domcontentloaded", timeout: 45000 });
    await dismissCookies(page);
    await page.waitForTimeout(2000);
    const hrefs = await page.evaluate(() => [...document.querySelectorAll("header a[href], nav a[href]")].map(a => a.href));
    const base = new URL(page.url());
    const segs = base.pathname.split("/").filter(Boolean); // [cc, lang]
    const skip = /(customer|kund|service|help|support|kontakt|hilfe|klant|aide|pomoc|favorit|shopcart|my-lists|club)/i;
    const top = [];
    for (const h of hrefs) {
      const u = new URL(h, base);
      const p = u.pathname.split("/").filter(Boolean);
      if (u.host !== base.host || p[0] !== segs[0] || p[1] !== segs[1] || p.length !== 3 || skip.test(u.pathname)) continue;
      if (!top.includes(u.origin + u.pathname)) top.push(u.origin + u.pathname);
    }
    const [women, men, kids, beauty, home] = top;
    const sportLinks = [...new Set(hrefs.map(h => { const u = new URL(h, base); return u.origin + u.pathname; }))]
      .filter(u => /\/sport(\/|$)/i.test(new URL(u).pathname));
    const under = d => d && sportLinks.find(u => new URL(u).pathname.startsWith(new URL(d).pathname + "/"));
    const sw = under(women), sk = under(kids);
    // Men's sport sits outside the men's section in Sweden (/man/sport), so take the first sport link that is not women or kids.
    const sm = under(men) || sportLinks.find(u => u !== sw && u !== sk);
    return { women, men, kids, beauty, home, "sport-women": sw, "sport-men": sm, "sport-kids": sk };
  } finally { await ctx.close(); }
}

for (const m of cfg.markets) {
  if (only && !only.includes(m.cc)) continue;
  let depts = { ...(m.depts || {}), ...(cache[m.cc] || {}) };
  if (DEPTS.some(d => !depts[d])) {
    try {
      const found = await discover(m);
      for (const d of DEPTS) depts[d] = depts[d] || found[d];
      cache[m.cc] = Object.fromEntries(Object.entries(depts).filter(([, v]) => v));
    } catch (e) { failures.push(`${m.cc} discover: ${e.message}`); }
  }
  m.resolved = depts;
  if (discoverOnly) console.log(m.cc, JSON.stringify(depts, null, 2));
}
await fs.writeFile(URLS_CACHE, JSON.stringify(cache, null, 2));
if (discoverOnly) { await browser.close(); process.exit(0); }

const jobs = [];
for (const m of cfg.markets) {
  if (only && !only.includes(m.cc)) continue;
  for (const dept of DEPTS) {
    const url = m.resolved?.[dept];
    if (!url) { failures.push(`${m.cc} ${dept}: no URL found`); continue; }
    for (const device of ["desktop", "mobile"]) jobs.push({ cc: m.cc, dept, device, url });
  }
}

const outDir = path.join(DOCS, "shots", date, time.replace(":", ""));
await fs.mkdir(outDir, { recursive: true });

async function capture(job) {
  const opts = job.device === "mobile"
    ? { ...devices["iPhone 13"] }
    : { viewport: { width: 1440, height: 900 } };
  const ctx = await browser.newContext({ ...opts, locale: "en-GB" });
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (resp && resp.status() >= 400) throw new Error(`HTTP ${resp.status()}`);
    await dismissCookies(page);
    await page.waitForTimeout(1500);
    const h = job.device === "mobile" ? 2600 : 2400;
    await page.setViewportSize({ width: opts.viewport.width, height: h });
    for (let y = 0; y < h; y += 600) { await page.evaluate(v => window.scrollTo(0, v), y); await page.waitForTimeout(250); }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(800);
    const file = `${job.cc}-${job.dept}-${job.device}.jpg`;
    await page.screenshot({ path: path.join(outDir, file), type: "jpeg", quality: 65 });
    results.push({ date, time, cc: job.cc, dept: job.dept, device: job.device, file: `shots/${date}/${time.replace(":", "")}/${file}`, source: page.url() });
  } finally { await ctx.close(); }
}

const queue = [...jobs];
// Slow and polite: two workers, a pause between pages, and retries with a growing wait when the site answers 429.
const sleep = ms => new Promise(r => setTimeout(r, ms));
await Promise.all(Array.from({ length: 2 }, async () => {
  while (queue.length) {
    const job = queue.shift();
    let lastErr;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try { await capture(job); lastErr = null; break; }
      catch (e) { lastErr = e; await sleep(/429|503/.test(e.message) ? 20000 * attempt : 5000); }
    }
    if (lastErr) failures.push(`${job.cc} ${job.dept} ${job.device}: ${lastErr.message}`);
    await sleep(4000);
  }
}));
await browser.close();

index = index.filter(r => !(r.date === date && r.time === time && results.some(n => n.cc === r.cc && n.dept === r.dept && n.device === r.device))).concat(results);
await fs.mkdir(path.dirname(INDEX), { recursive: true });
await fs.writeFile(INDEX, JSON.stringify(index));

// Optional retention: RETENTION_DAYS=90 deletes older screenshots to keep the repo small.
const keep = Number(process.env.RETENTION_DAYS || 0);
if (keep > 0) {
  const cutoff = new Date(Date.now() - keep * 864e5).toISOString().slice(0, 10);
  for (const d of await fs.readdir(path.join(DOCS, "shots")).catch(() => [])) if (d < cutoff) await fs.rm(path.join(DOCS, "shots", d), { recursive: true, force: true });
  index = index.filter(r => r.date >= cutoff);
  await fs.writeFile(INDEX, JSON.stringify(index));
}

console.log(`Saved ${results.length} of ${jobs.length} screenshots for ${date} ${time}.`);
if (failures.length) console.log("Problems:\n" + failures.join("\n"));

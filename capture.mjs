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
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, "markets.json"), "utf8"));
let competitors = {};
try { competitors = JSON.parse(await fs.readFile(path.join(ROOT, "competitors.json"), "utf8")); } catch {}
const DEPTS = ["women", "men", "kids", "home", "beauty", "sport-women", "sport-men", "sport-kids"];
const only = process.env.ONLY?.trim() ? process.env.ONLY.split(",").map(s => s.trim()).filter(Boolean) : undefined;
const discoverOnly = process.argv.includes("--discover");
// On GitHub Actions each market runs as its own job and writes a partial file; merge.mjs folds them into index.json.
// Discovered URLs are cached per market so parallel jobs never write the same file.
const tag = only ? only.join("-") : "all";
const URLS_CACHE = path.join(DOCS, "data", "urls", `${tag}.json`);
const PARTIAL = path.join(DOCS, "data", `partial-${tag}.json`);

// Current date and hour in Copenhagen
const parts = Object.fromEntries(
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map(p => [p.type, p.value])
);
const date = `${parts.year}-${parts.month}-${parts.day}`;
const hour = Number(parts.hour);
// GitHub often starts scheduled runs late, sometimes by hours, so the slot is simply the nearest one:
// anything before 12:00 Copenhagen counts as 08:00, anything after as 16:00.
const time = hour < 12 ? "08:00" : "16:00";

let index = [];
try { index = JSON.parse(await fs.readFile(INDEX, "utf8")); } catch {}
if (!discoverOnly && !process.env.FORCE && index.some(r => r.date === date && r.time === time && (!only || only.includes(r.cc)))) {
  console.log(`Slot ${date} ${time} already captured. Exiting.`); process.exit(0);
}

let cache = {};
try { cache = JSON.parse(await fs.readFile(URLS_CACHE, "utf8")); } catch {}

const browser = await chromium.launch();
const results = [], failures = [];

async function dismissCookies(page) {
  for (const sel of ["#didomi-notice-agree-button", "#onetrust-accept-btn-handler", "#uc-btn-accept-banner", "button:has-text('Accept all')", "button:has-text('Accept')", "button:has-text('Acceptera')", "button:has-text('Godkänn')", "button:has-text('Accepter')", "button:has-text('Alle akzeptieren')", "button:has-text('Hyväksy')", "button:has-text('Godta')"]) {
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
    // Load the start page. If the site answers 429 or the menu is missing, wait and try again.
    let hrefs = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      const resp = await page.goto(m.home, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
      if (resp && resp.status() < 400) {
        await dismissCookies(page);
        await page.waitForTimeout(2500);
        hrefs = await page.evaluate(() => [...document.querySelectorAll("header a[href], nav a[href]")].map(a => a.href));
        if (hrefs.length > 20) break;
      }
      await new Promise(r => setTimeout(r, 30000 * attempt));
    }
    if (hrefs.length <= 20) throw new Error("menu not found (page blocked or changed)");
    const base = new URL(page.url());
    const segs = base.pathname.split("/").filter(Boolean); // [cc, lang]
    const skip = /(customer|kund|service|help|support|kontakt|hilfe|klant|aide|pomoc|favorit|shopcart|my-lists|club|brands-a-z)/i;
    const top = [];
    for (const h of hrefs) {
      const u = new URL(h, base);
      const p = u.pathname.split("/").filter(Boolean);
      if (u.host !== base.host || p[0] !== segs[0] || p[1] !== segs[1] || p.length !== 3 || skip.test(u.pathname)) continue;
      if (!top.includes(u.origin + u.pathname)) top.push(u.origin + u.pathname);
    }
    // Main menu order is women, men, kids, (beauty), home. Beauty always has the slug "beauty" and is missing in some markets.
    const beauty = top.find(u => /\/beauty$/.test(u)) || false;
    const [women, men, kids, home] = top.filter(u => u !== beauty);
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
  // Pinned URLs in markets.json win over the cache. A value of false means "this market has no such page".
  let depts = { ...(cache[m.cc] || {}), ...(m.depts || {}) };
  if (DEPTS.some(d => depts[d] === undefined || depts[d] === null)) {
    try {
      const found = await discover(m);
      for (const d of DEPTS) if (depts[d] === undefined || depts[d] === null) depts[d] = found[d];
      cache[m.cc] = Object.fromEntries(Object.entries(depts).filter(([, v]) => v));
    } catch (e) { failures.push(`${m.cc} discover: ${e.message}`); }
    await new Promise(r => setTimeout(r, 10000));
  }
  m.resolved = depts;
  if (discoverOnly) console.log(m.cc, JSON.stringify(depts, null, 2));
}
await fs.mkdir(path.dirname(URLS_CACHE), { recursive: true });
await fs.writeFile(URLS_CACHE, JSON.stringify(cache, null, 2));
if (discoverOnly) { await browser.close(); process.exit(0); }

const jobs = [];
for (const m of cfg.markets) {
  if (only && !only.includes(m.cc)) continue;
  for (const dept of DEPTS) {
    const url = m.resolved?.[dept];
    if (url === false) continue; // market has no such department
    if (!url) { failures.push(`${m.cc} ${dept}: no URL found`); continue; }
    for (const device of ["desktop", "mobile"]) jobs.push({ cc: m.cc, dept, device, url });
  }
  // Competitors for this market, from competitors.json
  for (const c of (Array.isArray(competitors[m.cc]) ? competitors[m.cc] : [])) {
    if (!c?.url || !c?.name) continue;
    const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    jobs.push({ cc: m.cc, dept: "competitor", name: c.name, slug, device: "mobile", url: c.url }); // mobile only, so all competitors fit side by side
  }
}

const outDir = path.join(DOCS, "shots", date, time.replace(":", ""));
await fs.mkdir(outDir, { recursive: true });

// Image quality. QUALITY is JPEG quality 1-100 (default 85). SCALE is desktop sharpness: 1 = normal, 2 = retina
// (about four times the file size). Mobile already uses the phone's own 3x scale.
const QUALITY = Number(process.env.QUALITY || 85);
const SCALE = Number(process.env.SCALE || 1);

async function capture(job) {
  const opts = job.device === "mobile"
    ? { ...devices["iPhone 13"] }
    : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: SCALE };
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
    const file = job.slug ? `${job.cc}-comp-${job.slug}-${job.device}.jpg` : `${job.cc}-${job.dept}-${job.device}.jpg`;
    await page.screenshot({ path: path.join(outDir, file), type: "jpeg", quality: QUALITY });
    const row = { date, time, cc: job.cc, dept: job.dept, device: job.device, file: `shots/${date}/${time.replace(":", "")}/${file}`, source: page.url() };
    if (job.name) row.name = job.name;
    results.push(row);
  } finally { await ctx.close(); }
}

const queue = [...jobs];
const failedJobs = [];
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
    if (lastErr) failedJobs.push({ job, msg: lastErr.message });
    await sleep(4000);
  }
}));

// Second pass: wait a few minutes so the rate limit resets, then try the failed pages one at a time.
if (failedJobs.length) {
  console.log(`Retrying ${failedJobs.length} failed pages after a pause.`);
  await sleep(180000);
  for (const { job, msg } of failedJobs) {
    let err = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { await capture(job); err = null; break; }
      catch (e) { err = e; await sleep(60000 * attempt); }
    }
    if (err) failures.push(`${job.cc} ${job.name || job.dept} ${job.device}: ${err.message}`);
    await sleep(10000);
  }
}
await browser.close();

// Results go to a partial file. Run `node merge.mjs` to fold partials into docs/data/index.json.
await fs.mkdir(path.dirname(PARTIAL), { recursive: true });
await fs.writeFile(PARTIAL, JSON.stringify(results));

console.log(`Saved ${results.length} of ${jobs.length} screenshots for ${date} ${time}.`);
if (failures.length) console.log("Problems:\n" + failures.join("\n"));

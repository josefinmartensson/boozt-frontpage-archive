// Reads new Boozt newsletters from a dedicated Gmail inbox and saves each one as an image.
// Needs two secrets: GMAIL_USER (the address) and GMAIL_APP_PASSWORD (an app password, not the normal password).
// Market is taken from the plus tag in the To address (archive+se@gmail.com -> se). If there is no tag,
// the first boozt.com/<cc>/ link in the email decides. Processed emails are marked as read in Gmail.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DOCS = path.join(ROOT, "docs");
const PARTIAL = path.join(DOCS, "data", "partial-emails.json");
const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
if (!user || !pass) { console.log("GMAIL_USER or GMAIL_APP_PASSWORD missing. Skipping emails."); process.exit(0); }
const MARKETS = ["se", "dk", "no", "fi", "de", "nl", "at", "fr", "pl", "ch", "lt", "lv", "ee", "is", "fo"];
const QUALITY = Number(process.env.QUALITY || 85);
const MAX_AGE_DAYS = Number(process.env.EMAIL_MAX_AGE_DAYS || 7);

const cph = d => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};

function marketOf(parsed, html) {
  const tos = [parsed.to, parsed.cc, parsed.bcc].flatMap(a => a?.value || []).map(a => a.address || "");
  for (const a of tos) { const m = a.match(/\+([a-z]{2})@/i); if (m && MARKETS.includes(m[1].toLowerCase())) return m[1].toLowerCase(); }
  const m = html.match(/boozt\.com\/([a-z]{2})\//i);
  if (m && MARKETS.includes(m[1].toLowerCase())) return m[1].toLowerCase();
  return "xx";
}

const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user, pass }, logger: false });
await client.connect();
const lock = await client.getMailboxLock("INBOX");
const results = [], failures = [];
let browser;
try {
  const since = new Date(Date.now() - MAX_AGE_DAYS * 864e5);
  const uids = await client.search({ seen: false, since }, { uid: true });
  console.log(`${uids.length} unread emails since ${since.toISOString().slice(0, 10)}.`);
  if (uids.length) browser = await chromium.launch();
  for (const uid of uids) {
    try {
      const msg = await client.fetchOne(uid, { source: true }, { uid: true });
      const parsed = await simpleParser(msg.source);
      const from = (parsed.from?.value?.[0]?.address || "").toLowerCase();
      if (!/boozt/.test(from)) { continue; } // leave non-Boozt mail unread and untouched
      const html = parsed.html || `<pre style="font:14px sans-serif;white-space:pre-wrap">${(parsed.text || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</pre>`;
      const cc = marketOf(parsed, html);
      const { date, time } = cph(parsed.date || new Date());
      const dir = path.join(DOCS, "emails", date);
      await fs.mkdir(dir, { recursive: true });
      const file = `${cc}-${time.replace(":", "")}-${uid}.jpg`;
      const ctx = await browser.newContext({ viewport: { width: 700, height: 1000 }, deviceScaleFactor: 1.5 });
      const page = await ctx.newPage();
      try {
        await page.setContent(html, { waitUntil: "load", timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(2500);
        await page.screenshot({ path: path.join(dir, file), type: "jpeg", quality: QUALITY, fullPage: true });
      } finally { await ctx.close(); }
      results.push({ date, time, cc, dept: "newsletter", device: "email", file: `emails/${date}/${file}`, subject: parsed.subject || "", from });
      await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
    } catch (e) { failures.push(`uid ${uid}: ${e.message}`); }
  }
} finally {
  lock.release();
  await client.logout().catch(() => {});
  if (browser) await browser.close();
}

await fs.mkdir(path.dirname(PARTIAL), { recursive: true });
await fs.writeFile(PARTIAL, JSON.stringify(results));
console.log(`Saved ${results.length} newsletters.`);
if (failures.length) console.log("Problems:\n" + failures.join("\n"));

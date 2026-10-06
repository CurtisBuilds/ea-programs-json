// Nightly website check (Kurt 2026-10-06).
// Opens every city page on eapickleball.com, elevationathletics.ca and eabadminton.com
// in a real browser, reads every program card, and compares it with the programs.json
// the page itself loaded. Writes checks/site-check.json (read by the app's Website Sync
// screen) and checks/site-check.md (the alert text). Never clicks Register.
//
// Runs in the PUBLIC ea-programs-json repo (free Actions minutes).
// Source copy: ea-operations/ops/site-check/.
import { chromium } from "playwright";
import fs from "node:fs";
import { extractCards, pageTextProblems, normUrl, expectedRows, comparePage } from "./site-check-core.mjs";

const FEED = "https://curtisbuilds.github.io/ea-programs-json/data/programs.json";
const OUT_DIR = process.env.OUT_DIR || "checks";
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
const started = new Date();

const getJson = async (url) => {
  const r = await fetch(`${url}?nocache=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
};

const feed = await getJson(FEED);
const rows = expectedRows(feed, today);
const pages = new Map();
for (const r of rows) {
  const u = normUrl(r.URL);
  if (!pages.has(u)) pages.set(u, []);
  pages.get(u).push(r);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, userAgent: "EA-site-check (+nightly; read-only)" });
const results = [];
const problems = [];

async function readPage(url, nExpected) {
  const page = await ctx.newPage();
  let pageFeed = null;
  page.on("response", async (res) => {
    if (/\/data\/programs\.json/.test(res.url()) && res.ok()) { try { pageFeed = await res.json(); } catch { /* ignore */ } }
  });
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    const status = resp ? resp.status() : 0;
    // Cards are drawn by the theme after it loads programs.json.
    const deadline = Date.now() + 20000;
    let cards = [];
    while (Date.now() < deadline) {
      await page.waitForTimeout(700);
      cards = await page.evaluate(extractCards);
      if (cards.length >= nExpected && nExpected > 0) break;
    }
    await page.waitForTimeout(800);
    cards = await page.evaluate(extractCards);
    const text = await page.evaluate(pageTextProblems);
    return { status, finalUrl: page.url(), cards, text, pageFeed };
  } finally {
    await page.close();
  }
}

for (const [u, expected] of pages) {
  const url = `https://${u}/`;
  let res = null, err = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      res = await readPage(url, expected.length);
      if (res.status < 400 && (res.cards.length > 0 || expected.length === 0)) break;
    } catch (e) { err = String(e?.message || e); res = null; }
  }
  if (!res) {
    problems.push({ severity: "high", page: u, program: null, title: null, field: "page", expected: "loads", shown: err || "failed" });
    results.push({ page: u, expected: expected.length, cards: 0, error: err });
    continue;
  }
  // Compare against the exact feed the page used, when we caught it (avoids
  // false alarms if a publish lands mid-run).
  const source = Array.isArray(res.pageFeed) ? expectedRows(res.pageFeed, today).filter((r) => normUrl(r.URL) === u) : expected;
  const found = comparePage(source, res.cards).map((p) => ({ ...p, page: u }));
  if (res.status >= 400) found.push({ severity: "high", page: u, program: null, title: null, field: "page", expected: "HTTP 200", shown: `HTTP ${res.status}` });
  for (const t of res.text) found.push({ severity: "medium", page: u, program: null, title: null, field: "page text", expected: "no broken text", shown: t });
  problems.push(...found);
  results.push({ page: u, expected: source.length, cards: res.cards.length, problems: found.length });
}
await browser.close();

// Publish health: the feed workflow should have succeeded in the last 2 hours.
try {
  const runs = JSON.parse(process.env.FEED_RUNS || "[]");
  const ok = runs.filter((r) => r.conclusion === "success").map((r) => new Date(r.createdAt));
  const last = ok.length ? new Date(Math.max(...ok)) : null;
  if (runs.length && (!last || Date.now() - last.getTime() > 2 * 3600_000)) {
    problems.push({ severity: "high", page: null, program: null, title: null, field: "publishing",
      expected: "feed published in the last 2 hours", shown: last ? `last success ${last.toISOString()}` : "no recent success" });
  }
} catch { /* gh not available — skip */ }

const high = problems.filter((p) => p.severity === "high").length;
const medium = problems.length - high;
const summary = {
  ran_at: started.toISOString(),
  finished_at: new Date().toISOString(),
  feed_rows: feed.length,
  pages_checked: results.length,
  cards_expected: results.reduce((n, r) => n + r.expected, 0),
  cards_seen: results.reduce((n, r) => n + r.cards, 0),
  high, medium,
  problems: problems.slice(0, 500),
  pages: results,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(`${OUT_DIR}/site-check.json`, JSON.stringify(summary, null, 2));

const line = (p) => `| ${p.severity} | ${p.page ?? ""} | ${p.program ?? ""} | ${(p.title ?? "").replace(/\|/g, "/")} | ${p.field} | ${String(p.expected).replace(/\|/g, "/")} | ${String(p.shown).replace(/\|/g, "/")} |`;
const md = [
  `**Website check ${today}:** ${summary.pages_checked} pages, ${summary.cards_seen}/${summary.cards_expected} cards. ${high} high, ${medium} medium.`,
  "",
  problems.length ? "| Severity | Page | Program | Title | Field | Should be | Website shows |\n|---|---|---|---|---|---|---|\n" + problems.slice(0, 60).map(line).join("\n") : "No problems found.",
  problems.length > 60 ? `\n…and ${problems.length - 60} more in checks/site-check.json.` : "",
].join("\n");
fs.writeFileSync(`${OUT_DIR}/site-check.md`, md);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `high=${high}\nmedium=${medium}\n`);
console.log(md);

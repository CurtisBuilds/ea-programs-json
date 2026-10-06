// Nightly website check — shared logic (Kurt 2026-10-06).
// Plain JS with no imports so the same code runs in Node (site-check.mjs) and can be
// pasted into a browser console for testing.

/** Runs INSIDE the web page. Reads every program card the theme rendered. */
export function extractCards() {
  const isCard = (a) => /\bSessions?\s·/.test(a.innerText || "");
  return [...document.querySelectorAll("article")].filter(isCard).map((a) => {
    const h = a.querySelector("h3");
    const p = [...a.querySelectorAll("p")].find((x) => /\bSessions?\s·/.test(x.innerText));
    const leaves = [...a.querySelectorAll("span,div")].filter((e) => e.children.length === 0);
    const badges = leaves.filter((e) => e.tagName === "SPAN").map((e) => e.innerText.trim()).filter(Boolean);
    const price = leaves.map((e) => e.innerText.trim()).find((t) => /^(\$\s?[\d,]+(\.\d+)?|TBD|Free)$/i.test(t)) ?? null;
    const link = [...a.querySelectorAll("a")].find((l) => /register|waitlist/i.test(l.innerText));
    return {
      title: h ? h.innerText.trim() : "",
      details: p ? p.innerText.trim() : "",
      badges,
      price,
      button: link ? link.innerText.trim() : null,
      href: link ? link.href : null,
    };
  });
}

/** Runs INSIDE the web page: obvious rendering breakage. */
export function pageTextProblems() {
  const t = document.body ? document.body.innerText : "";
  const bad = [];
  for (const [re, label] of [[/\$\s?NaN/, "$NaN"], [/\bundefined\b/, "undefined"], [/Invalid Date/, "Invalid Date"], [/\$\s?null\b/, "$null"]]) {
    if (re.test(t)) bad.push(label);
  }
  return bad;
}

// ---------------------------------------------------------------------------
export const normUrl = (u) => {
  if (!u) return "";
  let s = String(u).trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  s = s.split("#")[0];
  const [path, query] = s.split("?");
  return (path.replace(/\/+$/, "").toLowerCase()) + (query ? "?" + query : "");
};
export const normTitle = (t) =>
  String(t ?? "").toLowerCase().replace(/[‒-―−]/g, "-").replace(/\s*-\s*/g, "-").replace(/\s+/g, " ").trim();
const normTime = (t) => String(t ?? "").toLowerCase().replace(/[‒-―]/g, "-").replace(/\s+/g, "");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (iso) => { const [, m, d] = String(iso).split("-").map(Number); return m ? `${MON[m - 1]} ${d}` : ""; };
const money = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** Parse "10 Sessions · Mondays · Sep 14 - Nov 23 · 7:00 - 8:00 PM · Venue". */
export function parseDetails(s) {
  const parts = String(s).split("·").map((x) => x.trim());
  const sessions = Number((parts[0] || "").match(/(\d+)/)?.[1] ?? NaN);
  const dateIdx = parts.findIndex((x) => /^[A-Z][a-z]{2} \d{1,2}\s*[-–]\s*[A-Z][a-z]{2} \d{1,2}$/.test(x));
  const timeIdx = parts.findIndex((x) => /\d{1,2}:\d{2}.*(AM|PM)/i.test(x));
  const [from, to] = dateIdx >= 0 ? parts[dateIdx].split(/\s*[-–]\s*/) : [null, null];
  return {
    sessions: Number.isFinite(sessions) ? sessions : null,
    day: parts[1] ?? null,
    from, to,
    time: timeIdx >= 0 ? parts[timeIdx] : null,
    venue: parts.length > 0 && timeIdx >= 0 ? parts.slice(timeIdx + 1).join(" · ") : null,
  };
}

/** Rows the website should show on a page: has a register button and hasn't ended. */
export function expectedRows(feed, today) {
  return feed.filter((r) => r.RegisterLink && r.URL && (!r["End Date"] || r["End Date"] >= today) && r.is_cancelled !== true);
}

/**
 * Compare what a page shows against the feed rows meant for it.
 * Returns problems: { severity: "high"|"medium", program, title, field, expected, shown }.
 */
export function comparePage(rows, cards) {
  const problems = [];
  const left = cards.map((c) => ({ ...c, d: parseDetails(c.details), used: false }));
  const add = (severity, r, field, expected, shown) =>
    problems.push({ severity, program: r?.ProgramID ?? null, title: r?.Title ?? null, field, expected, shown });

  for (const r of rows) {
    const key = normTitle(r.Title);
    const cands = left.filter((c) => !c.used && normTitle(c.title) === key);
    // Same title can appear more than once (two time slots, or a fall block and a
    // Nov–Dec block). Pick the card that matches the most: time, day, start date, link.
    const score = (c) =>
      (normTime(c.d.time) === normTime(r.Time) ? 4 : 0) + (c.d.day === r.Day ? 2 : 0) +
      (c.d.from && r["Start Date"] && c.d.from === shortDate(r["Start Date"]) ? 3 : 0) +
      (c.href && r.RegisterLink && normUrl(c.href).startsWith(normUrl(r.RegisterLink)) ? 3 : 0);
    const card = cands.sort((a, b) => score(b) - score(a))[0];
    if (!card) { add("high", r, "card", "shown on this page", "missing"); continue; }
    card.used = true;

    // price: what checkout charges today (updated_price) else the program price
    const want = r.updated_price ?? r.TotalPrice ?? r.StaticPriceText;
    const wantN = money(want), shownN = money(card.price);
    if (wantN !== null) {
      if (shownN === null || Math.abs(shownN - wantN) > 0.005) add("high", r, "price", `$${wantN.toFixed(2)}`, card.price ?? "(none)");
    } else if (want && card.price && String(want).trim().toLowerCase() !== card.price.toLowerCase()) {
      add("medium", r, "price", String(want), card.price);
    }

    // full / button
    const full = r.is_full === true;
    const showsFull = card.badges.some((b) => /^full$/i.test(b)) || /waitlist/i.test(card.button || "");
    if (full !== showsFull) add("high", r, "full", full ? "Full / Join Waitlist" : "Register", card.button ?? "(no button)");
    if (!card.button) add("high", r, "button", "Register or Join Waitlist", "(no button)");
    if (!full && card.href && r.RegisterLink && normUrl(card.href) !== normUrl(r.RegisterLink) && !normUrl(card.href).startsWith(normUrl(r.RegisterLink))) {
      add("high", r, "register link", r.RegisterLink, card.href);
    }

    // schedule
    if (card.d.day && r.Day && card.d.day !== r.Day) add("medium", r, "day", r.Day, card.d.day);
    if (card.d.time && r.Time && normTime(card.d.time) !== normTime(r.Time)) add("medium", r, "time", r.Time, card.d.time);
    if (r["Start Date"] && card.d.from && card.d.from !== shortDate(r["Start Date"])) add("medium", r, "start date", shortDate(r["Start Date"]), card.d.from);
    if (r["End Date"] && card.d.to && card.d.to !== shortDate(r["End Date"])) add("medium", r, "end date", shortDate(r["End Date"]), card.d.to);
    const n = r.SessionDates ? String(r.SessionDates).split(",").filter(Boolean).length : null;
    if (n !== null && card.d.sessions !== null && card.d.sessions !== n) add("medium", r, "sessions", String(n), String(card.d.sessions));
  }
  for (const c of left.filter((c) => !c.used)) {
    problems.push({ severity: "medium", program: null, title: c.title, field: "card", expected: "not in the feed for this page", shown: "shown" });
  }
  return problems;
}

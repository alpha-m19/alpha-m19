import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const OUT = process.env.OUT || "dist/activity.svg";
const RAMP = ["#ff5a4e", "#d7262b", "#a3181d", "#6e1014", "#484f58"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SANS = "'Segoe UI',Ubuntu,'Helvetica Neue',Arial,sans-serif";
const MONO = "Consolas,'SFMono-Regular',Menlo,'DejaVu Sans Mono',monospace";

const QUERY = `query($login: String!) {
  user(login: $login) {
    repositories(ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC, first: 100) {
      totalCount
      nodes {
        stargazerCount
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name } }
        }
      }
    }
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

async function fetchUser() {
  if (process.env.MOCK) return JSON.parse(readFileSync(process.env.MOCK, "utf8"));
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-activity",
    },
    body: JSON.stringify({ query: QUERY, variables: { login: process.env.USERNAME } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json));
  return json.data.user;
}

// The public profile calendar includes private-repo counts when "Private contributions" is enabled; the API token does not.
async function fetchPublicCalendar(login) {
  const html = process.env.MOCK_HTML
    ? readFileSync(process.env.MOCK_HTML, "utf8")
    : await (await fetch(`https://github.com/users/${login}/contributions`, { headers: { "User-Agent": "profile-activity" } })).text();
  const dateById = {};
  for (const m of html.matchAll(/<td[^>]*data-date="([\d-]+)"[^>]*id="([^"]+)"/g)) dateById[m[2]] = m[1];
  const byDate = {};
  for (const m of html.matchAll(/<tool-tip[^>]*for="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)) {
    const date = dateById[m[1]];
    if (!date) continue;
    const c = /^([\d,]+) contribution/.exec(m[2]);
    byDate[date] = c ? +c[1].replace(/,/g, "") : 0;
  }
  const dates = Object.keys(byDate).sort();
  if (dates.length < 300) return null;
  const weeks = [];
  for (const date of dates) {
    if (!weeks.length || new Date(`${date}T00:00:00Z`).getUTCDay() === 0) weeks.push({ contributionDays: [] });
    weeks[weeks.length - 1].contributionDays.push({ date, contributionCount: byDate[date] });
  }
  return { totalContributions: dates.reduce((a, d) => a + byDate[d], 0), weeks };
}

function streaks(days) {
  let best = 0, run = 0;
  for (const d of days) {
    run = d.contributionCount > 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  let i = days.length - 1;
  if (i >= 0 && days[i].contributionCount === 0) i--; // today may still be empty
  let current = 0;
  while (i >= 0 && days[i].contributionCount > 0) { current++; i--; }
  return { current, best };
}

function topLanguages(repos, limit = 5) {
  const sizes = new Map();
  for (const r of repos) for (const e of r.languages.edges)
    sizes.set(e.node.name, (sizes.get(e.node.name) || 0) + e.size);
  const total = [...sizes.values()].reduce((a, b) => a + b, 0);
  if (!total) return [];
  const sorted = [...sizes].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, limit - 1);
  const rest = sorted.slice(limit - 1).reduce((a, [, s]) => a + s, 0);
  if (rest) top.push(["Other", rest]);
  return top.map(([name, size]) => ({ name, pct: (size / total) * 100 }));
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const n = (v) => +v.toFixed(1);
const fadeIn = (delay) => `<animate attributeName="opacity" from="0" to="1" begin="${delay}s" dur=".6s" fill="freeze"/>`;
const monthYear = (iso) => { const [y, m] = iso.split("-"); return `${MONTHS[+m - 1]} ${y}`; };

// One heartbeat (P, QRS, T) per active week; amplitude grows with that week's contributions.
function pulsePath(counts, x0, width, base, minA, maxA) {
  const step = width / counts.length;
  const max = Math.max(...counts);
  const d = [`M${x0} ${base}`];
  let peak = null;
  counts.forEach((c, i) => {
    const x = x0 + i * step;
    if (!c) { d.push(`L${n(x + step)} ${base}`); return; }
    const a = minA + (maxA - minA) * Math.sqrt(c / max);
    const at = (f) => n(x + step * f);
    d.push(
      `L${at(0.12)} ${base}`,
      `Q${at(0.22)} ${n(base - a * 0.16)} ${at(0.32)} ${base}`,
      `L${at(0.4)} ${n(base + a * 0.1)}`,
      `L${at(0.5)} ${n(base - a)}`,
      `L${at(0.6)} ${n(base + a * 0.28)}`,
      `L${at(0.68)} ${base}`,
      `Q${at(0.82)} ${n(base - a * 0.24)} ${at(0.94)} ${base}`,
      `L${n(x + step)} ${base}`,
    );
    if (!peak || c > peak.c) peak = { c, x: x + step * 0.5, y: base - a };
  });
  return { d: d.join(" "), peak };
}

function hud(p, title, { first, last, total, current, best, repos, stars }, W, PAD) {
  p.push(`<g><circle cx="${PAD + 5}" cy="45" r="5" fill="#ff5a4e"><animate attributeName="opacity" values="1;.2;1" dur="1.2s" repeatCount="indefinite"/></circle>`
    + `<text x="${PAD + 18}" y="50" font-family="${MONO}" font-size="13" letter-spacing="3" fill="#e5262d">${title}</text></g>`);
  p.push(`<text x="${W - PAD}" y="50" text-anchor="end" font-family="${MONO}" font-size="13" fill="#8b949e">${monthYear(first)} – ${monthYear(last)}</text>`);
  const stats = [
    ["CONTRIBUTIONS", total, "", true],
    ["CURRENT STREAK", current, current === 1 ? " day" : " days"],
    ["BEST STREAK", best, best === 1 ? " day" : " days"],
    ["PUBLIC REPOS", repos, stars ? ` · ${stars}★` : ""],
  ];
  const colW = (W - PAD * 2) / stats.length;
  stats.forEach(([label, value, unit, accent], i) => {
    const x = PAD + colW * i;
    p.push(`<g opacity="0">${fadeIn(0.1 * i)}`
      + `<text x="${x}" y="96" font-family="${MONO}" font-size="12" letter-spacing="2" fill="#8b949e">${label}</text>`
      + `<text x="${x}" y="136" font-family="${SANS}" font-size="36" font-weight="700" fill="${accent ? "#ff5a4e" : "#e6edf3"}">${esc(value)}<tspan font-size="17" font-weight="400" fill="#8b949e">${esc(unit)}</tspan></text></g>`);
  });
}

function monthMarks(weeks) {
  const marks = [];
  let prev = -1, lastLabel = -4;
  weeks.forEach((w, i) => {
    const date = w.contributionDays[0].date;
    const month = +date.slice(5, 7);
    const isNew = i === 0 ? +date.slice(8) <= 14 : month !== prev;
    prev = month;
    if (!isNew || i - lastLabel < 3 || i > weeks.length - 3) return;
    lastLabel = i;
    marks.push({ i, label: MONTHS[month - 1].toUpperCase() });
  });
  return marks;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function renderSkyline({ weeks, total, current, best, repos, stars }) {
  const W = 1200, PAD = 60, CW = W - PAD * 2, GROUND = 350, SKY = 168, H = 400;
  const counts = weeks.map((w) => w.contributionDays.reduce((a, d) => a + d.contributionCount, 0));
  const max = Math.max(...counts, 1);
  const step = CW / weeks.length, BW = step - 3;
  const first = weeks[0].contributionDays[0].date;
  const lastDays = weeks[weeks.length - 1].contributionDays;
  const last = lastDays[lastDays.length - 1].date;
  const rand = rng(419);
  const p = [];

  hud(p, "LIVE // SKYLINE", { first, last, total, current, best, repos, stars }, W, PAD);

  // sky: stars and a red moon
  const starEls = [];
  for (let i = 0; i < 46; i++) {
    const x = n(PAD + rand() * CW), y = n(SKY + rand() * 90), r = n(0.6 + rand() * 1.1);
    const tw = rand() < 0.35 ? `<animate attributeName="opacity" values=".9;.2;.9" dur="${n(2 + rand() * 3)}s" begin="${n(rand() * 3)}s" repeatCount="indefinite"/>` : "";
    starEls.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="#e6edf3" opacity=".7">${tw}</circle>`);
  }
  p.push(`<g>${starEls.join("")}</g>`);
  p.push(`<circle cx="190" cy="214" r="46" fill="#ff5a4e" opacity=".12" filter="url(#moonglow)"/>`
    + `<circle cx="190" cy="214" r="24" fill="url(#moon)"/>`);

  // distant silhouette so quiet weeks still read as a city
  const far = [`M${PAD} ${GROUND}`];
  for (let i = 0; i < weeks.length; i++) {
    const h = n(18 + rand() * 52);
    far.push(`V${GROUND - h} H${n(PAD + (i + 1) * step)}`);
  }
  far.push(`V${GROUND} Z`);
  p.push(`<path d="${far.join(" ")}" fill="#11151c"/>`);

  let peak = null;
  counts.forEach((c, i) => {
    if (!c) return;
    const t = Math.sqrt(c / max);
    const h = n(34 + (GROUND - SKY - 20 - 34) * t);
    const x = n(PAD + i * step + 1.5);
    if (!peak || c > peak.c) peak = { c, x: x + BW / 2, y: GROUND - h };
    const win = [];
    for (let wy = -h + 8; wy < -8; wy += 9) {
      for (const wx of [3.5, BW - 7]) {
        const lit = rand() < 0.22 + 0.6 * t;
        const flick = lit && rand() < 0.08 ? `<animate attributeName="opacity" values="1;.25;1;1" dur="${n(3 + rand() * 4)}s" repeatCount="indefinite"/>` : "";
        win.push(`<rect x="${n(wx)}" y="${n(wy)}" width="3.5" height="4" fill="${lit ? (rand() < 0.3 ? "#ffb3ad" : "#ff5a4e") : "#1f242c"}">${flick}</rect>`);
      }
    }
    const rise = `<animateTransform attributeName="transform" type="scale" from="1 0" to="1 1" begin="${n(0.3 + i * 0.03)}s" dur=".9s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".2 .8 .2 1"/>`;
    p.push(`<g transform="translate(${x} ${GROUND})"><g transform="scale(1 0)">${rise}`
      + `<rect x="0" y="${-h}" width="${n(BW)}" height="${h}" fill="url(#tower)"/>`
      + `<rect x="0" y="${-h}" width="${n(BW)}" height="2" fill="#ff5a4e" opacity="${n(0.35 + 0.65 * t)}"/>`
      + win.join("") + `</g></g>`);
  });

  if (peak) {
    const ax = n(peak.x), top = n(peak.y - 22), right = peak.x < W - 220;
    p.push(`<g opacity="0">${fadeIn(2.2)}`
      + `<line x1="${ax}" y1="${n(peak.y)}" x2="${ax}" y2="${top}" stroke="#8b949e" stroke-width="1.5"/>`
      + `<circle cx="${ax}" cy="${top}" r="3" fill="#ff5a4e"><animate attributeName="opacity" values="1;.15;1" dur="1.4s" repeatCount="indefinite"/></circle>`
      + `<text x="${n(right ? ax + 12 : ax - 12)}" y="${n(top + 4)}" text-anchor="${right ? "start" : "end"}" font-family="${MONO}" font-size="12" fill="#e6edf3">PEAK · ${peak.c}/wk</text></g>`);
  }

  p.push(`<rect x="${PAD}" y="${GROUND}" width="${CW}" height="2" fill="#30363d"/>`);
  for (const m of monthMarks(weeks)) {
    p.push(`<text x="${n(PAD + m.i * step)}" y="${GROUND + 26}" font-family="${MONO}" font-size="12" fill="#8b949e">${m.label}</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d1117"/><stop offset=".7" stop-color="#130b10"/><stop offset="1" stop-color="#1f0b0e"/></linearGradient>
<linearGradient id="tower" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#232a33"/><stop offset="1" stop-color="#161b22"/></linearGradient>
<radialGradient id="moon" cx="40%" cy="40%" r="60%"><stop offset="0" stop-color="#ff8a80"/><stop offset="1" stop-color="#b3141b"/></radialGradient>
<filter id="moonglow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="14"/></filter>
<clipPath id="card"><rect width="${W}" height="${H}" rx="16"/></clipPath>
</defs>
<g clip-path="url(#card)"><rect width="${W}" height="${H}" fill="url(#sky)"/></g>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="16" fill="none" stroke="#21262d"/>
${p.join("\n")}
</svg>
`;
}

function render({ weeks, total, current, best, repos, stars, langs }) {
  const W = 1200, PAD = 60, CX = PAD, CW = W - PAD * 2;
  const TOP = 176, BASE = 296, BOTTOM = 336;
  const hasLangs = langs.length > 0;
  const H = hasLangs ? 470 : 390;
  const counts = weeks.map((w) => w.contributionDays.reduce((a, d) => a + d.contributionCount, 0));
  const step = CW / weeks.length;
  const first = weeks[0].contributionDays[0].date;
  const lastDays = weeks[weeks.length - 1].contributionDays;
  const last = lastDays[lastDays.length - 1].date;
  const { d, peak } = pulsePath(counts, CX, CW, BASE, 30, BASE - TOP - 14);
  const p = [];

  hud(p, "LIVE // PULSE", { first, last, total, current, best, repos, stars }, W, PAD);

  p.push(`<rect x="${CX}" y="${TOP - 10}" width="${CW}" height="${BOTTOM - TOP + 10}" fill="url(#grid)"/>`);
  for (const m of monthMarks(weeks)) {
    const x = n(CX + m.i * step);
    p.push(`<line x1="${x}" y1="${TOP - 10}" x2="${x}" y2="${BOTTOM}" stroke="#21262d" stroke-dasharray="3 5"/>`);
    p.push(`<text x="${n(x + 6)}" y="${BOTTOM + 22}" font-family="${MONO}" font-size="12" fill="#8b949e">${m.label}</text>`);
  }
  p.push(`<line x1="${CX}" y1="${BASE}" x2="${CX + CW}" y2="${BASE}" stroke="#2a0b0d" stroke-width="2"/>`);

  const draw = `<animate attributeName="stroke-dashoffset" from="1" to="0" dur="2.6s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".4 0 .2 1"/>`;
  p.push(`<path d="${d}" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1" fill="none" stroke="#ff5a4e" stroke-width="6" stroke-linejoin="round" opacity=".55" filter="url(#glow)">${draw}</path>`);
  p.push(`<path id="pulse" d="${d}" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1" fill="none" stroke="#ff5a4e" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round">${draw}</path>`);

  p.push(`<g opacity="0"><set attributeName="opacity" to="1" begin="2.6s"/>`
    + `<circle r="11" fill="#ff5a4e" opacity=".5" filter="url(#dotglow)"/><circle r="4" fill="#ffe1de"/>`
    + `<animateMotion dur="9s" begin="2.6s" repeatCount="indefinite"><mpath href="#pulse" xlink:href="#pulse"/></animateMotion></g>`);

  if (peak) {
    const px = n(peak.x), py = n(peak.y), right = peak.x < W - 220;
    const tx = right ? px + 16 : px - 16, anchor = right ? "start" : "end";
    p.push(`<g opacity="0">${fadeIn(2.6)}`
      + `<circle cx="${px}" cy="${py}" r="5" fill="none" stroke="#ffe1de" stroke-width="2"/>`
      + `<text x="${n(tx)}" y="${n(py + 4)}" text-anchor="${anchor}" font-family="${MONO}" font-size="12" fill="#e6edf3">PEAK · ${peak.c}/wk</text></g>`);
  }

  if (hasLangs) {
    const y = BOTTOM + 60;
    p.push(`<clipPath id="bar"><rect x="${PAD}" y="${y}" width="${CW}" height="8" rx="4"/></clipPath>`);
    let x = PAD;
    const segs = langs.map((l, i) => {
      const w = (l.pct / 100) * CW;
      const r = `<rect x="${n(x)}" y="${y}" width="${n(w)}" height="8" fill="${RAMP[i]}"/>`;
      x += w;
      return r;
    });
    const col = CW / langs.length;
    const legend = langs.map((l, i) =>
      `<circle cx="${n(PAD + col * i + 6)}" cy="${y + 32}" r="5" fill="${RAMP[i]}"/>`
      + `<text x="${n(PAD + col * i + 18)}" y="${y + 37}" font-family="${SANS}" font-size="14" fill="#e6edf3">${esc(l.name)} <tspan fill="#8b949e">${l.pct.toFixed(1)}%</tspan></text>`);
    p.push(`<g opacity="0">${fadeIn(2.8)}<g clip-path="url(#bar)">${segs.join("")}</g>${legend.join("")}</g>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#161b22"/></pattern>
<filter id="glow" filterUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><feGaussianBlur stdDeviation="5"/></filter>
<filter id="dotglow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="5"/></filter>
<radialGradient id="bg" cx="50%" cy="70%" r="70%"><stop offset="0" stop-color="#1a0a0c"/><stop offset="1" stop-color="#0d1117"/></radialGradient>
</defs>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="16" fill="url(#bg)" stroke="#21262d"/>
${p.join("\n")}
</svg>
`;
}

const user = await fetchUser();
const cal = (await fetchPublicCalendar(process.env.USERNAME).catch(() => null)) ?? user.contributionsCollection.contributionCalendar;
const days = cal.weeks.flatMap((w) => w.contributionDays);
const repoNodes = user.repositories.nodes;

const data = {
  weeks: cal.weeks,
  total: cal.totalContributions,
  ...streaks(days),
  repos: user.repositories.totalCount,
  stars: repoNodes.reduce((a, r) => a + r.stargazerCount, 0),
  langs: topLanguages(repoNodes),
};
const skylineOut = join(dirname(OUT), "skyline.svg");
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, render(data));
writeFileSync(skylineOut, renderSkyline(data));
console.log(`wrote ${OUT} and ${skylineOut}`);

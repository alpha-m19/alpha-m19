import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const OUT = process.env.OUT || "dist/activity.svg";
const LEVEL = { NONE: "#161b22", FIRST_QUARTILE: "#4c0b0e", SECOND_QUARTILE: "#8e1519", THIRD_QUARTILE: "#d7262b", FOURTH_QUARTILE: "#ff5a4e" };
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
        weeks { contributionDays { date weekday contributionCount contributionLevel } }
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
const fadeIn = (delay) => `<animate attributeName="opacity" from="0" to="1" begin="${delay.toFixed(2)}s" dur=".5s" fill="freeze"/>`;
const monthYear = (iso) => { const [y, m] = iso.split("-"); return `${MONTHS[+m - 1]} ${y}`; };

function render({ weeks, total, current, best, repos, stars, langs }) {
  const W = 1200, PAD = 60, GX = 104, GY = 214, STEP = (W - PAD - GX) / weeks.length, CELL = STEP - 4;
  const gridBottom = GY + 7 * STEP;
  const legendY = gridBottom + 34;
  const hasLangs = langs.length > 0;
  const H = Math.round(legendY + (hasLangs ? 96 : 34));
  const first = weeks[0].contributionDays[0].date;
  const lastWeek = weeks[weeks.length - 1].contributionDays;
  const last = lastWeek[lastWeek.length - 1].date;
  const p = [];

  p.push(`<text x="${PAD}" y="50" font-family="${MONO}" font-size="13" letter-spacing="3" fill="#e5262d">// ACTIVITY</text>`);
  p.push(`<text x="${W - PAD}" y="50" text-anchor="end" font-family="${MONO}" font-size="13" fill="#8b949e">${monthYear(first)} – ${monthYear(last)}</text>`);

  const stats = [
    [total, "contributions", true],
    [current, current === 1 ? "day current streak" : "days current streak"],
    [best, best === 1 ? "day best streak" : "days best streak"],
    [repos, `public repos · ${stars} ★`],
  ];
  const colW = (W - PAD * 2) / stats.length;
  stats.forEach(([value, label, accent], i) => {
    const x = PAD + colW * i;
    if (i > 0) p.push(`<line x1="${x}" y1="84" x2="${x}" y2="146" stroke="#21262d" stroke-width="2"/>`);
    const tx = i === 0 ? x : x + 28;
    p.push(`<g opacity="0">${fadeIn(0.1 * i)}`
      + `<text x="${tx}" y="122" font-family="${SANS}" font-size="40" font-weight="700" fill="${accent ? "#ff5a4e" : "#e6edf3"}">${esc(value)}</text>`
      + `<text x="${tx}" y="146" font-family="${SANS}" font-size="15" fill="#8b949e">${esc(label)}</text></g>`);
  });
  p.push(`<line x1="${PAD}" y1="172" x2="${W - PAD}" y2="172" stroke="#21262d" stroke-width="2"/>`);

  let lastLabelCol = -4;
  weeks.forEach((w, c) => {
    const date = w.contributionDays[0].date;
    const month = +date.slice(5, 7);
    const isNew = c === 0 ? +date.slice(8) <= 14 : month !== +weeks[c - 1].contributionDays[0].date.slice(5, 7);
    if (isNew && c - lastLabelCol >= 3 && c < weeks.length - 2) {
      p.push(`<text x="${(GX + c * STEP).toFixed(1)}" y="${GY - 10}" font-family="${SANS}" font-size="13" fill="#8b949e">${MONTHS[month - 1]}</text>`);
      lastLabelCol = c;
    }
  });
  [["Mon", 1], ["Wed", 3], ["Fri", 5]].forEach(([n, r]) =>
    p.push(`<text x="${PAD}" y="${(GY + r * STEP + CELL - 3).toFixed(1)}" font-family="${SANS}" font-size="13" fill="#8b949e">${n}</text>`));

  weeks.forEach((w, c) => {
    const cells = w.contributionDays.map((d) =>
      `<rect x="${(GX + c * STEP).toFixed(1)}" y="${(GY + d.weekday * STEP).toFixed(1)}" width="${CELL.toFixed(1)}" height="${CELL.toFixed(1)}" rx="3" fill="${LEVEL[d.contributionLevel] || LEVEL.NONE}"/>`);
    p.push(`<g opacity="0">${fadeIn(0.4 + c * 0.015)}${cells.join("")}</g>`);
  });

  p.push(`<text x="${GX}" y="${legendY}" font-family="${SANS}" font-size="14" fill="#8b949e">${esc(total)} contributions in the last year</text>`);
  const levels = Object.values(LEVEL);
  const lx = W - PAD - levels.length * 18 - 36;
  p.push(`<text x="${lx - 8}" y="${legendY}" text-anchor="end" font-family="${SANS}" font-size="13" fill="#8b949e">Less</text>`);
  levels.forEach((col, i) => p.push(`<rect x="${lx + i * 18}" y="${legendY - 12}" width="14" height="14" rx="3" fill="${col}"/>`));
  p.push(`<text x="${lx + levels.length * 18 + 4}" y="${legendY}" font-family="${SANS}" font-size="13" fill="#8b949e">More</text>`);

  if (hasLangs) {
    const y = legendY + 34, bw = W - PAD * 2;
    p.push(`<clipPath id="bar"><rect x="${PAD}" y="${y}" width="${bw}" height="8" rx="4"/></clipPath>`);
    let x = PAD;
    const segs = langs.map((l, i) => {
      const w = (l.pct / 100) * bw;
      const r = `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="8" fill="${RAMP[i]}"/>`;
      x += w;
      return r;
    });
    const step = bw / langs.length;
    const legend = langs.map((l, i) =>
      `<circle cx="${PAD + step * i + 6}" cy="${y + 34}" r="5" fill="${RAMP[i]}"/>`
      + `<text x="${PAD + step * i + 18}" y="${y + 39}" font-family="${SANS}" font-size="14" fill="#e6edf3">${esc(l.name)} <tspan fill="#8b949e">${l.pct.toFixed(1)}%</tspan></text>`);
    p.push(`<g opacity="0">${fadeIn(1.2)}<g clip-path="url(#bar)">${segs.join("")}</g>${legend.join("")}</g>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="16" fill="#0d1117" stroke="#21262d"/>
${p.join("\n")}
</svg>
`;
}

const user = await fetchUser();
const cal = user.contributionsCollection.contributionCalendar;
const days = cal.weeks.flatMap((w) => w.contributionDays);
const repoNodes = user.repositories.nodes;

const svg = render({
  weeks: cal.weeks,
  total: cal.totalContributions,
  ...streaks(days),
  repos: user.repositories.totalCount,
  stars: repoNodes.reduce((a, r) => a + r.stargazerCount, 0),
  langs: topLanguages(repoNodes),
});
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, svg);
console.log(`wrote ${OUT}`);

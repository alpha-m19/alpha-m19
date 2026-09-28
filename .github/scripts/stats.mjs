import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const OUT = process.env.OUT || "dist/stats.svg";
const RAMP = ["#ff5a4e", "#d7262b", "#a3181d", "#6e1014", "#484f58"];
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
      "User-Agent": "profile-stats",
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
const fade = (i) => `opacity="0"><animate attributeName="opacity" from="0" to="1" begin="${(0.15 * i).toFixed(2)}s" dur=".6s" fill="freeze"/`;

function render({ total, current, best, repos, stars, langs }) {
  const W = 1200, hasLangs = langs.length > 0, H = hasLangs ? 300 : 210;
  const stats = [
    [total, "", "CONTRIBUTIONS", "past year"],
    [current, current === 1 ? " day" : " days", "CURRENT STREAK", ""],
    [best, best === 1 ? " day" : " days", "BEST STREAK", ""],
    [repos, "", "REPOSITORIES", `${stars} stars`],
  ];
  const colW = (W - 120) / stats.length;
  const parts = [];

  stats.forEach(([value, unit, label, sub], i) => {
    const cx = 60 + colW * i + colW / 2;
    if (i > 0) parts.push(`<line x1="${60 + colW * i}" y1="62" x2="${60 + colW * i}" y2="158" stroke="#21262d" stroke-width="2"/>`);
    parts.push(`<g ${fade(i)}>`
      + `<text x="${cx}" y="112" text-anchor="middle" font-family="${SANS}" font-size="46" font-weight="700" fill="${i === 0 ? "#ff5a4e" : "#e6edf3"}">${esc(value)}<tspan font-size="20" font-weight="400" fill="#8b949e">${unit}</tspan></text>`
      + `<text x="${cx}" y="140" text-anchor="middle" font-family="${MONO}" font-size="13" letter-spacing="2" fill="#8b949e">${label}</text>`
      + (sub ? `<text x="${cx}" y="160" text-anchor="middle" font-family="${MONO}" font-size="12" fill="#484f58">${esc(sub)}</text>` : "")
      + `</g>`);
  });

  if (hasLangs) {
    const x0 = 60, bw = W - 120, y = 212;
    parts.push(`<line x1="60" y1="186" x2="${W - 60}" y2="186" stroke="#21262d" stroke-width="2"/>`);
    parts.push(`<clipPath id="bar"><rect x="${x0}" y="${y}" width="${bw}" height="10" rx="5"/></clipPath>`);
    let x = x0;
    const segs = [], legend = [];
    langs.forEach((l, i) => {
      const w = (l.pct / 100) * bw;
      segs.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="10" fill="${RAMP[i]}"/>`);
      x += w;
    });
    const step = bw / langs.length;
    langs.forEach((l, i) => {
      const lx = x0 + step * i;
      legend.push(`<circle cx="${lx + 6}" cy="${y + 42}" r="6" fill="${RAMP[i]}"/>`
        + `<text x="${lx + 20}" y="${y + 47}" font-family="${SANS}" font-size="15" fill="#e6edf3">${esc(l.name)} <tspan fill="#8b949e">${l.pct.toFixed(1)}%</tspan></text>`);
    });
    parts.push(`<g ${fade(4)}><g clip-path="url(#bar)"><rect x="${x0}" y="${y}" width="${bw}" height="10" fill="#161b22"/>${segs.join("")}</g>${legend.join("")}</g>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="12" cy="12" r="1" fill="#161b22"/></pattern></defs>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="16" fill="#0d1117" stroke="#21262d"/>
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="16" fill="url(#dots)"/>
<text x="60" y="42" font-family="${MONO}" font-size="13" letter-spacing="3" fill="#e5262d">// GITHUB STATS</text>
${parts.join("\n")}
</svg>
`;
}

const user = await fetchUser();
const cal = user.contributionsCollection.contributionCalendar;
const days = cal.weeks.flatMap((w) => w.contributionDays);
const { current, best } = streaks(days);
const repoNodes = user.repositories.nodes;

const svg = render({
  total: cal.totalContributions,
  current,
  best,
  repos: user.repositories.totalCount,
  stars: repoNodes.reduce((a, r) => a + r.stargazerCount, 0),
  langs: topLanguages(repoNodes),
});
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, svg);
console.log(`wrote ${OUT}`);

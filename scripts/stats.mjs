// Renders GitHub stats and top-language cards as SVG, using only the workflow's own GITHUB_TOKEN.
// Replaces hosted stat services that break under rate limits.
import { mkdirSync, writeFileSync } from 'node:fs';

const LOGIN = process.env.STATS_USER || 'nikhil-partap';
const TOKEN = process.env.GITHUB_TOKEN;
const OUT = process.env.STATS_OUT || 'dist';
if (!TOKEN) throw new Error('GITHUB_TOKEN is required');

async function gql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'profile-stats' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const { user } = await gql(
  `query($login: String!) {
    user(login: $login) {
      createdAt
      repositories(ownerAffiliations: OWNER, isFork: false, first: 100, orderBy: { field: PUSHED_AT, direction: DESC }) {
        totalCount
        nodes {
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name color } } }
        }
      }
    }
  }`,
  { login: LOGIN },
);

// Contributions, one calendar year at a time, from account creation to today.
const now = new Date();
const days = [];
let totalContributions = 0;
let commitsThisYear = 0;
let contributionsThisYear = 0;
for (let y = new Date(user.createdAt).getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
  const from = new Date(Date.UTC(y, 0, 1)).toISOString();
  const to = (y === now.getUTCFullYear() ? now : new Date(Date.UTC(y, 11, 31, 23, 59, 59))).toISOString();
  const { user: u } = await gql(
    `query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          totalCommitContributions
          restrictedContributionsCount
          contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
        }
      }
    }`,
    { login: LOGIN, from, to },
  );
  const c = u.contributionsCollection;
  totalContributions += c.contributionCalendar.totalContributions;
  if (y === now.getUTCFullYear()) {
    commitsThisYear = c.totalCommitContributions + c.restrictedContributionsCount;
    contributionsThisYear = c.contributionCalendar.totalContributions;
  }
  for (const w of c.contributionCalendar.weeks) for (const d of w.contributionDays) days.push(d);
}

const today = now.toISOString().slice(0, 10);
const seen = new Map(days.filter((d) => d.date <= today).map((d) => [d.date, d.contributionCount]));
const sorted = [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
let longest = 0;
let run = 0;
for (const [, n] of sorted) {
  run = n > 0 ? run + 1 : 0;
  longest = Math.max(longest, run);
}
// A streak is still alive if today has nothing yet but yesterday did.
let current = 0;
let i = sorted.length - 1;
if (i >= 0 && sorted[i][1] === 0) i--;
for (; i >= 0 && sorted[i][1] > 0; i--) current++;

const activeDays = sorted.filter(([d, n]) => n > 0 && d.startsWith(String(now.getUTCFullYear()))).length;
const langs = new Map();
for (const r of user.repositories.nodes) {
  for (const e of r.languages.edges) {
    const l = langs.get(e.node.name) || { size: 0, color: e.node.color || '#8b949e' };
    l.size += e.size;
    langs.set(e.node.name, l);
  }
}
const langTotal = [...langs.values()].reduce((s, l) => s + l.size, 0) || 1;
const top = [...langs.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 8);

const THEMES = {
  dark: { bg: '#0d1117', border: '#30363d', title: '#e6edf3', text: '#c9d1d9', muted: '#8b949e', accent: '#0d99ff' },
  light: { bg: '#ffffff', border: '#d0d7de', title: '#1f2328', text: '#1f2328', muted: '#59636e', accent: '#0969da' },
};
const FONT = `font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"`;
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
const fmt = (n) => n.toLocaleString('en-US');

function statsCard(t) {
  const rows = [
    ['Total contributions', fmt(totalContributions)],
    [`Commits in ${now.getUTCFullYear()}`, fmt(commitsThisYear)],
    [`Contributions in ${now.getUTCFullYear()}`, fmt(contributionsThisYear)],
    ['Repositories', fmt(user.repositories.totalCount)],
    ['Current streak', `${fmt(current)} day${current === 1 ? '' : 's'}`],
    ['Longest streak', `${fmt(longest)} day${longest === 1 ? '' : 's'}`],
    [`Active days in ${now.getUTCFullYear()}`, fmt(activeDays)],
    ['On GitHub since', String(new Date(user.createdAt).getUTCFullYear())],
  ];
  const cells = rows.map(([k, v], n) => {
    const x = n % 2 ? 262 : 24;
    const y = 76 + Math.floor(n / 2) * 30;
    return `<text x="${x}" y="${y}" fill="${t.muted}" font-size="13">${esc(k)}</text><text x="${x + 214}" y="${y}" fill="${t.text}" font-size="13" font-weight="600" text-anchor="end">${esc(v)}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="194" viewBox="0 0 500 194" ${FONT}>
<rect x="0.5" y="0.5" width="499" height="193" rx="8" fill="${t.bg}" stroke="${t.border}"/>
<text x="24" y="38" fill="${t.title}" font-size="17" font-weight="600">GitHub activity</text>
<rect x="24" y="48" width="28" height="2" fill="${t.accent}"/>
${cells}
</svg>`;
}

function langCard(t) {
  let x = 24;
  const barW = 452;
  const segs = top.map(([, l]) => {
    const w = Math.max(2, (l.size / langTotal) * barW);
    const r = `<rect x="${x.toFixed(1)}" y="58" width="${w.toFixed(1)}" height="8" fill="${l.color}"/>`;
    x += w;
    return r;
  }).join('');
  const legend = top.map(([name, l], n) => {
    const lx = n % 2 ? 262 : 24;
    const ly = 92 + Math.floor(n / 2) * 26;
    return `<circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${l.color}"/><text x="${lx + 16}" y="${ly}" fill="${t.text}" font-size="13">${esc(name)}</text><text x="${lx + 214}" y="${ly}" fill="${t.muted}" font-size="13" text-anchor="end">${((l.size / langTotal) * 100).toFixed(1)}%</text>`;
  }).join('');
  const h = 92 + Math.ceil(top.length / 2) * 26;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="${h}" viewBox="0 0 500 ${h}" ${FONT}>
<rect x="0.5" y="0.5" width="499" height="${h - 1}" rx="8" fill="${t.bg}" stroke="${t.border}"/>
<text x="24" y="38" fill="${t.title}" font-size="17" font-weight="600">Most used languages</text>
<clipPath id="bar"><rect x="24" y="58" width="${barW}" height="8" rx="4"/></clipPath>
<g clip-path="url(#bar)">${segs}</g>
${legend}
</svg>`;
}

mkdirSync(OUT, { recursive: true });
for (const [name, t] of Object.entries(THEMES)) {
  writeFileSync(`${OUT}/stats-${name}.svg`, statsCard(t));
  writeFileSync(`${OUT}/languages-${name}.svg`, langCard(t));
}
console.log(`contributions=${totalContributions} commits=${commitsThisYear} current=${current} longest=${longest} langs=${top.map(([n]) => n).join(',')}`);

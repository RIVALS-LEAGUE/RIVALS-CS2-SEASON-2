#!/usr/bin/env node
// Saves the public registration order for each CS2 Season 2 track into this
// repository, as rule 2.1.2 requires when the window closes and when the
// Groups are published. It reads the same public endpoint the website uses,
// so it needs no credentials. Run by .github/workflows/archive-registration-order.yml.
//
//   node scripts/archive-registration-order.mjs --moment window-closed [--track legends|rivals|both]
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SITE = 'https://www.rivalsleague.gg';
export const TRACKS = { legends: 'rivals-cs2-s2-legends', rivals: 'rivals-cs2-s2-rivals' };
export const MOMENTS = {
  'window-closed': 'when the registration window closed',
  'groups-published': 'when the Groups were published',
};
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function sourceUrl(slug, site = SITE) {
  return `${site}/api/registration/public-order?slug=${slug}`;
}

export function assertOrder(order, slug) {
  if (!order || typeof order !== 'object' || order.tournament?.slug !== slug
      || !Array.isArray(order.teams) || typeof order.free_slots !== 'number') {
    throw new Error(`Unexpected response for ${slug}`);
  }
}

// Returns why this moment can't be saved yet, or null when it can.
export function notReadyReason(moment, order, now = new Date()) {
  const { tournament } = order;
  if (moment === 'window-closed' && !(now.getTime() > Date.parse(tournament.registration_closes_at))) {
    return `${tournament.slug}: registration closes ${tournament.registration_closes_at}, nothing to save yet.`;
  }
  if (moment === 'groups-published' && !tournament.frozen_at) {
    return `${tournament.slug}: the order is not frozen. Freeze it in the registration admin tools when the Groups are published, then run this again.`;
  }
  return null;
}

const stockholm = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm', hourCycle: 'h23', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export function stockholmTime(value) {
  const date = new Date(value);
  const p = Object.fromEntries(stockholm.formatToParts(date).map((part) => [part.type, part.value]));
  const localAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour), Number(p.minute), Number(p.second));
  const offset = (localAsUtc - Math.floor(date.getTime() / 1000) * 1000) / 3_600_000;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${offset === 2 ? 'CEST' : 'CET'}`;
}

// Team names and tags are typed by teams, so nothing in them may become a
// link, an image, HTML or a broken table row.
export function cell(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]()|#~!]/g, '\\$&');
}

export function statusText(team) {
  if (team.status === 'withdrawn') return 'Withdrawn';
  if (team.status === 'not_approved') return 'Not approved';
  if (team.status === 'waitlist') return `Waitlist ${team.waitlist_position}`;
  return team.approved ? 'Approved' : 'Registered';
}

export function renderMarkdown({ moment, source, fetchedAt, order }) {
  const t = order.tournament;
  const lines = [
    `# ${cell(t.name)}`,
    '',
    `Registration order saved ${MOMENTS[moment]}, under rule 2.1.2 of the rulebook. The JSON file next to this one holds the same list exactly as the website returned it.`,
    '',
    `- Saved: ${stockholmTime(fetchedAt)}`,
    `- Source: ${source}`,
    `- Registration window: ${stockholmTime(t.registration_opens_at)} to ${stockholmTime(t.registration_closes_at)}`,
    ...(t.frozen_at ? [`- Order frozen: ${stockholmTime(t.frozen_at)}`] : []),
    `- Slots: ${t.slot_cap}. Free: ${order.free_slots}. On the waitlist: ${order.counts?.waitlist ?? 0}.`,
    '',
  ];
  if (!order.teams.length) return [...lines, 'No teams registered.', ''].join('\n');
  return [...lines,
    '| Order | Team | Tag | Registration Time | Status |',
    '| --- | --- | --- | --- | --- |',
    ...order.teams.map((team) => `| ${team.order ?? ''} | ${cell(team.team_name)} | ${cell(team.tri_code)} | ${cell(team.registered_at_local)} | ${statusText(team)} |`),
    '',
  ].join('\n');
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

export async function archive({ moment, tracks, root = ROOT, site = SITE, now = () => new Date(), fetchImpl = fetch, log = console.log }) {
  const saved = [];
  const problems = [];
  for (const track of tracks) {
    const slug = TRACKS[track];
    const dir = path.join(root, 'registration-order', moment);
    const jsonFile = path.join(dir, `${track}.json`);
    // An archive is a record: never overwrite one, even on a re-run.
    if (await exists(jsonFile)) { log(`${track}: already saved for ${moment}, leaving it alone.`); continue; }
    const source = sourceUrl(slug, site);
    const response = await fetchImpl(source, { headers: { accept: 'application/json' } });
    if (!response.ok) { problems.push(`${track}: ${source} answered HTTP ${response.status}.`); continue; }
    const order = await response.json();
    assertOrder(order, slug);
    const fetchedAt = now().toISOString();
    const reason = notReadyReason(moment, order, new Date(fetchedAt));
    if (reason) { problems.push(reason); continue; }
    await mkdir(dir, { recursive: true });
    await writeFile(jsonFile, `${JSON.stringify({ moment, saved_at: fetchedAt, source, order }, null, 2)}\n`);
    await writeFile(path.join(dir, `${track}.md`), renderMarkdown({ moment, source, fetchedAt, order }));
    log(`${track}: saved ${order.teams.length} teams for ${moment}.`);
    saved.push(track);
  }
  return { saved, problems };
}

function parseArgs(argv) {
  const args = { track: 'both' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!['moment', 'track'].includes(key) || argv[i + 1] === undefined) throw new Error(`Unknown or empty argument: ${argv[i]}`);
    args[key] = argv[i + 1];
  }
  if (!MOMENTS[args.moment]) throw new Error(`--moment must be one of: ${Object.keys(MOMENTS).join(', ')}`);
  if (args.track !== 'both' && !TRACKS[args.track]) throw new Error('--track must be legends, rivals or both');
  return { moment: args.moment, tracks: args.track === 'both' ? Object.keys(TRACKS) : [args.track] };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { problems } = await archive(parseArgs(process.argv.slice(2)));
    for (const problem of problems) console.error(problem);
    process.exitCode = problems.length ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

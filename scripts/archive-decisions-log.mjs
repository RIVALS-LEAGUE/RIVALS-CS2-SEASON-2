#!/usr/bin/env node
// Saves the CS2 Season 2 Decisions Log and the league's Sanctions Register
// into this repository. Rule 1.3.2 has every Decisions Log entry archived on
// GitHub the same day it is published. The website publishes both records as
// JSON with every deploy, so this needs no credentials. Run by
// .github/workflows/archive-decisions-log.yml.
//
//   node scripts/archive-decisions-log.mjs
//
// Each record gets a JSON file, byte for byte what the website returned, and a
// Markdown file to read here. Neither holds the time of saving, so a run that
// finds nothing new changes nothing; the commit history says when each
// version was saved.
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cell, stockholmTime } from './archive-registration-order.mjs';

export const SITE = 'https://www.rivalsleague.gg';
export const RECORDS = {
  log: { label: 'Decisions Log', dir: 'decisions-log', file: 'cs2-s2-decisions-log', feed: '/data/cs2-s2-decisions-log.json', page: '/cs2/decisions' },
  register: { label: 'Sanctions Register', dir: 'sanctions-register', file: 'sanctions-register', feed: '/data/sanctions-register.json', page: '/sanctions' },
};
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Swedish labels, as on the website. The Swedish text is the master (1.3.1);
// the English translation stays in the JSON file.
const ROLE = {
  commissioner: 'Ligakommissarien',
  'head-of-compops': 'Tävlingsansvarig',
  'competition-administration': 'Tävlingsadministrationen',
  'match-admin': 'Matchadmin',
  'disciplinary-board': 'Disciplinrådet',
  'review-committee': 'Granskningskommittén',
};
const CATEGORY = {
  eligibility: 'Behörighet', disqualification: 'Diskvalificering', withdrawal: 'Avhopp', sanction: 'Sanktion',
  standings: 'Tabell', placing: 'Placering', schedule: 'Schema', 'map-pool': 'Kartpool', appeal: 'Överklagande', other: 'Övrigt',
};
const TRACK = { legends: 'LEGENDS', rivals: 'RIVALS', both: 'Båda Spåren' };
const KIND = { suspension: 'Avstängning', expulsion: 'Uteslutning', 'withdrawal-bar': 'Spärr efter Avhopp' };
const GAME = { cs2: 'CS2', lol: 'LoL', val: 'VALORANT' };

const pad = (id) => `#${String(id).padStart(3, '0')}`;
const label = (map, key) => map[key] ?? cell(key);
const sv = (text) => cell(text?.sv);

export function provision(p) {
  const [clause, ground] = String(p).split(':');
  return ground ? `${clause} grund ${ground}` : clause;
}

export function appealText(appeal) {
  if (appeal?.to === 'review-committee') {
    return `Kan överklagas till Granskningskommittén genom Supportärende senast ${stockholmTime(appeal.deadline)} (regel 7.3.2).`;
  }
  if (appeal?.to === 'head-of-compops') {
    return `Lagkaptenen kan begära prövning av Tävlingsansvarig genom Supportärende senast ${stockholmTime(appeal.deadline)} (regel 7.3.1).`;
  }
  return ['Kan inte överklagas.', appeal?.note ? sv(appeal.note) : ''].filter(Boolean).join(' ');
}

export function assertFeed(kind, feed) {
  const ok = feed && typeof feed === 'object' && Array.isArray(feed.entries)
    && feed.entries.every((entry) => Number.isInteger(entry?.id))
    && (kind !== 'log' || feed.log === 'cs2-s2');
  if (!ok) throw new Error(`${RECORDS[kind].label}: unexpected response`);
}

const header = (title, source) => [
  `# ${title}`,
  '',
  'Svensk text gäller. Den engelska översättningen finns i JSON-filen bredvid och på webbplatsen.',
  'The Swedish text applies. The English translation is in the JSON file next to this one and on the website.',
  '',
  `- Source: ${source}`,
  '- Saved: see the commit history of this file.',
  '',
];

export function renderLog(feed, source) {
  const lines = header('Beslutsloggen, RIVALS CS2 Säsong 2', source);
  if (!feed.entries.length) return [...lines, 'Inga beslut är publicerade än.', ''].join('\n');
  for (const e of feed.entries) {
    lines.push(
      `## ${pad(e.id)} ${sv(e.title)}`,
      '',
      `- Beslutat: ${stockholmTime(e.decidedAt)}`,
      `- Spår: ${label(TRACK, e.track)}`,
      `- Typ: ${label(CATEGORY, e.category)}`,
      `- Beslutsfattare: ${label(ROLE, e.decidedBy)}`,
      `- Berörda: ${sv(e.affected)}`,
      `- Bestämmelse: ${(e.provisions ?? []).map((p) => cell(provision(p))).join(', ')}`,
      `- Skäl: ${sv(e.reasons)}`,
      `- Följd: ${sv(e.consequence)}`,
      `- Överklagande: ${appealText(e.appeal)}`,
      ...(e.replaces?.length ? [`- Ersätter: ${e.replaces.map(pad).join(', ')}`] : []),
      ...(e.reviewOf !== undefined ? [`- Prövning av: ${pad(e.reviewOf)}`] : []),
      '',
    );
  }
  return lines.join('\n');
}

export function renderRegister(feed, source) {
  const lines = header('Sanktionsregistret, RIVALS LEAGUE', source);
  if (!feed.entries.length) return [...lines, 'Inga avstängningar, uteslutningar eller spärrar är registrerade.', ''].join('\n');
  for (const e of feed.entries) {
    lines.push(
      `## ${pad(e.id)} ${sv(e.subject)}`,
      '',
      `- Typ: ${label(KIND, e.kind)}`,
      `- Spel: ${label(GAME, e.game)}`,
      `- Omfattning: ${sv(e.scope)}`,
      `- Från och med: ${cell(e.from)}`,
      `- Till och med: ${e.until === null ? sv(e.untilText) : cell(e.until)}`,
      `- Beslutat av: ${label(ROLE, e.decidedBy)}`,
      `- Beslut: Beslutsloggen ${cell(e.decision?.log)} ${pad(e.decision?.id)}`,
      ...(e.lifted ? [`- Hävd: ${cell(e.lifted.on)}, Beslutsloggen ${cell(e.lifted.decision?.log)} ${pad(e.lifted.decision?.id)}`] : []),
      '',
    );
  }
  return lines.join('\n');
}

async function readIfExists(file) {
  try { return await readFile(file, 'utf8'); } catch { return null; }
}

// What the commit message says about one record: the new entry numbers, or
// that existing entries changed (an English translation, a fixed typo).
export function describeChange(name, before, after) {
  if (!before) return `${name} (first save)`;
  const known = new Set(before.entries.map((e) => e.id));
  const added = after.entries.filter((e) => !known.has(e.id)).map((e) => pad(e.id));
  return added.length ? `${name} ${added.join(', ')}` : `${name} (entries updated)`;
}

export async function archive({ root = ROOT, site = SITE, fetchImpl = fetch, log = console.log } = {}) {
  const changes = [];
  const problems = [];
  for (const [kind, record] of Object.entries(RECORDS)) {
    const dir = path.join(root, record.dir);
    const jsonFile = path.join(dir, `${record.file}.json`);
    const previousText = await readIfExists(jsonFile);
    const source = `${site}${record.feed}`;
    try {
      const response = await fetchImpl(source, { headers: { accept: 'application/json' } });
      if (!response.ok) {
        // Before the website first publishes the feed there is nothing to keep.
        if (response.status === 404 && previousText === null) {
          log(`${record.label}: ${source} is not published yet, nothing to save.`);
        } else {
          problems.push(`${record.label}: ${source} answered HTTP ${response.status}.`);
        }
        continue;
      }
      const text = await response.text();
      const feed = JSON.parse(text);
      assertFeed(kind, feed);
      if (text === previousText) { log(`${record.label}: unchanged.`); continue; }
      const previous = previousText === null ? null : JSON.parse(previousText);
      // Entries are append-only (rule 1.3.2 and the website's own checks).
      // If one vanished, keep the archived version and let a person look.
      const now = new Set(feed.entries.map((e) => e.id));
      const missing = (previous?.entries ?? []).map((e) => e.id).filter((id) => !now.has(id));
      if (missing.length) {
        problems.push(`${record.label}: ${missing.map(pad).join(', ')} disappeared from ${source}. The archive was left as it was.`);
        continue;
      }
      await mkdir(dir, { recursive: true });
      await writeFile(jsonFile, text);
      await writeFile(path.join(dir, `${record.file}.md`),
        kind === 'log' ? renderLog(feed, `${site}${record.page}`) : renderRegister(feed, `${site}${record.page}`));
      const change = describeChange(record.label, previous, feed);
      log(`${record.label}: saved, ${change}.`);
      changes.push(change);
    } catch (error) {
      problems.push(`${record.label}: ${error.message}`);
    }
  }
  return { changes, problems, message: changes.length ? `Archive ${changes.join(' and ')}` : null };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { message, problems } = await archive();
  if (message && process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `message=${message}\n`);
  for (const problem of problems) console.error(problem);
  process.exitCode = problems.length ? 1 : 0;
}

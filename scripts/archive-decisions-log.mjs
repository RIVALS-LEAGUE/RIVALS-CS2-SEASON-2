#!/usr/bin/env node
// Saves the CS2 Season 2 Decisions Log, the league's Sanctions Register and
// the rulebook Changelog into this repository. Rule 1.3.2 has every Decisions
// Log entry archived on GitHub the same day it is published, and the
// rulebook's full version history kept here. The website publishes all three
// as JSON with every deploy, so this needs no credentials. Run by
// .github/workflows/archive-decisions-log.yml.
//
//   node scripts/archive-decisions-log.mjs
//
// Each record gets a JSON file, byte for byte what the website returned, and a
// Markdown file to read here. Neither holds the time of saving, so a run that
// finds nothing new changes nothing; the commit history says when each
// version was saved. For every rulebook version in the Changelog whose PDFs
// are not here yet, both PDFs are copied from the website into the
// repository root. Nothing is ever overwritten.
import { access, mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cell, stockholmTime } from './archive-registration-order.mjs';

export const SITE = 'https://www.rivalsleague.gg';
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
const VERSION_KIND = { publication: 'Publicering', change: 'Ändring', errata: 'Errata', exception: 'Undantag' };
const BASIS = { valve: 'Valves turneringskrav', law: 'Svensk lag', 'force-majeure': 'Force majeure' };

const pad = (id) => `#${String(id).padStart(3, '0')}`;
const label = (map, key) => map[key] ?? cell(key);
const sv = (text) => cell(text?.sv);

// The rulebook PDFs in this repository: RIVALS-CS2-S2-REGELBOK-SV-v1.0.pdf and
// RIVALS-CS2-S2-RULEBOOK-EN-v1.0.pdf. The website's githubPdfName (src/lib/
// changelog.ts in the website repository) links to these names.
export const VERSION_RE = /^\d+\.\d+(?:\.\d+)?$/;
export const pdfName = (version, language) =>
  language === 'sv' ? `RIVALS-CS2-S2-REGELBOK-SV-v${version}.pdf` : `RIVALS-CS2-S2-RULEBOOK-EN-v${version}.pdf`;
const SITE_PDF_RE = /^\/rules\/[A-Za-z0-9._-]+\.pdf$/;

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

const archiveLink = (url) => (/^https:\/\/[^\s<>]+$/.test(url ?? '') ? `<${url}>` : null);

export function renderChangelog(feed, source) {
  const lines = header('Ändringsloggen, RIVALS CS2 Säsong 2', source);
  lines.push('Regel 1.3.2 och 1.3.4. En ändring gäller tidigast 7 dagar efter publiceringen och aldrig retroaktivt. Errata gäller direkt.', '');
  for (const e of [...feed.entries].reverse()) {
    const archived = ['page', 'sv', 'en'].map((k) => archiveLink(e.archived?.[k])).filter(Boolean);
    const exception = e.exception
      ? [`- Grund: ${label(BASIS, e.exception.basis)}. Spår: ${(e.exception.tracks ?? []).map((t) => label(TRACK, t)).join(', ')}.${e.exception.valveApproval ? ` Valves skriftliga godkännande ${cell(e.exception.valveApproval)}.` : ''}`]
      : [];
    lines.push(
      `## Version ${cell(e.version)}, ${label(VERSION_KIND, e.kind)}`,
      '',
      `- Publicerad: ${stockholmTime(e.publishedAt)}`,
      `- Gäller från: ${stockholmTime(e.appliesFrom)}`,
      ...(e.clauses?.length ? [`- Klausuler: ${e.clauses.map((c) => cell(provision(c))).join(', ')}`] : []),
      `- Sammanfattning: ${sv(e.summary)}`,
      ...(e.reasons ? [`- Skäl: ${sv(e.reasons)}`] : []),
      ...exception,
      ...(e.kind !== 'publication' ? ['- Beslutat av: Ligakommissarien'] : []),
      ...(VERSION_RE.test(e.version)
        ? [`- Regelbok: [${pdfName(e.version, 'sv')}](../${pdfName(e.version, 'sv')}), [${pdfName(e.version, 'en')}](../${pdfName(e.version, 'en')})`]
        : []),
      ...(archived.length ? [`- Arkiverad kopia: ${archived.join(', ')}`] : []),
      '',
    );
  }
  return lines.join('\n');
}

export const RECORDS = {
  log: {
    label: 'Decisions Log', dir: 'decisions-log', file: 'cs2-s2-decisions-log', feed: '/data/cs2-s2-decisions-log.json', page: '/cs2/decisions',
    key: (e) => e.id, name: pad, valid: (feed) => feed.log === 'cs2-s2' && feed.entries.every((e) => Number.isInteger(e?.id)), render: renderLog,
  },
  register: {
    label: 'Sanctions Register', dir: 'sanctions-register', file: 'sanctions-register', feed: '/data/sanctions-register.json', page: '/sanctions',
    key: (e) => e.id, name: pad, valid: (feed) => feed.entries.every((e) => Number.isInteger(e?.id)), render: renderRegister,
  },
  changelog: {
    label: 'Changelog', dir: 'changelog', file: 'cs2-s2-changelog', feed: '/data/cs2-s2-changelog.json', page: '/cs2/rules/changelog',
    key: (e) => e.version, name: (v) => `v${v}`,
    valid: (feed) => feed.entries.every((e) => VERSION_RE.test(e?.version ?? '') && SITE_PDF_RE.test(e?.pdf?.sv ?? '') && SITE_PDF_RE.test(e?.pdf?.en ?? '')),
    render: renderChangelog,
  },
};

export function assertFeed(kind, feed) {
  const ok = feed && typeof feed === 'object' && Array.isArray(feed.entries) && RECORDS[kind].valid(feed);
  if (!ok) throw new Error(`${RECORDS[kind].label}: unexpected response`);
}

async function readIfExists(file) {
  try { return await readFile(file, 'utf8'); } catch { return null; }
}
async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

// What the commit message says about one record: the new entries, or that
// existing entries changed (an English translation, a fixed typo).
export function describeChange(record, before, after) {
  if (!before) return `${record.label} (first save)`;
  const known = new Set(before.entries.map(record.key));
  const added = after.entries.filter((e) => !known.has(record.key(e))).map((e) => record.name(record.key(e)));
  return added.length ? `${record.label} ${added.join(', ')}` : `${record.label} (entries updated)`;
}

// Copies both PDFs of every Changelog version that is not in the repository
// yet. Returns the versions copied.
async function copyRulebookPdfs({ feed, root, site, fetchImpl, log, problems }) {
  const copied = [];
  for (const entry of feed.entries) {
    let wrote = false;
    for (const language of ['sv', 'en']) {
      const target = path.join(root, pdfName(entry.version, language));
      if (await exists(target)) continue;
      const source = `${site}${entry.pdf[language]}`;
      const response = await fetchImpl(source);
      if (!response.ok) { problems.push(`Rulebook v${entry.version} (${language}): ${source} answered HTTP ${response.status}.`); continue; }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') { problems.push(`Rulebook v${entry.version} (${language}): ${source} is not a PDF.`); continue; }
      await writeFile(target, bytes);
      log(`Rulebook v${entry.version} (${language}): copied ${pdfName(entry.version, language)}.`);
      wrote = true;
    }
    if (wrote) copied.push(`v${entry.version}`);
  }
  return copied;
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
      const previous = previousText === null ? null : JSON.parse(previousText);
      // Entries are append-only (rule 1.3.2 and the website's own checks).
      // If one vanished, keep the archived version and let a person look.
      const now = new Set(feed.entries.map(record.key));
      const missing = (previous?.entries ?? []).map(record.key).filter((key) => !now.has(key));
      if (missing.length) {
        problems.push(`${record.label}: ${missing.map(record.name).join(', ')} disappeared from ${source}. The archive was left as it was.`);
        continue;
      }
      if (text === previousText) {
        log(`${record.label}: unchanged.`);
      } else {
        await mkdir(dir, { recursive: true });
        await writeFile(jsonFile, text);
        await writeFile(path.join(dir, `${record.file}.md`), record.render(feed, `${site}${record.page}`));
        const change = describeChange(record, previous, feed);
        log(`${record.label}: saved, ${change}.`);
        changes.push(change);
      }
      if (kind === 'changelog') {
        const copied = await copyRulebookPdfs({ feed, root, site, fetchImpl, log, problems });
        if (copied.length) changes.push(`rulebook PDFs ${copied.join(', ')}`);
      }
    } catch (error) {
      problems.push(`${record.label}: ${error.message}`);
    }
  }
  const list = changes.length > 1 ? `${changes.slice(0, -1).join(', ')} and ${changes.at(-1)}` : changes[0];
  return { changes, problems, message: changes.length ? `Archive ${list}` : null };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { message, problems } = await archive();
  if (message && process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `message=${message}\n`);
  for (const problem of problems) console.error(problem);
  process.exitCode = problems.length ? 1 : 0;
}

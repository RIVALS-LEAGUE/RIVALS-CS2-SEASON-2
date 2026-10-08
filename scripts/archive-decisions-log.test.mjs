// node --test scripts/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RECORDS, appealText, archive, assertFeed, describeChange, pdfName, provision, renderChangelog, renderLog, renderRegister } from './archive-decisions-log.mjs';

const SITE = 'https://site.test';
const decision = (id, extra = {}) => ({
  id,
  decidedAt: '2026-10-25T21:40:00+01:00',
  track: 'legends',
  category: 'eligibility',
  decidedBy: 'head-of-compops',
  title: { sv: 'Spelare ej godkänd i Behörighetskontrollen', en: 'Player not approved in the Eligibility Check' },
  affected: { sv: 'exempel (Lag Exempel, EXM)' },
  provisions: ['2.1.9', '2.7:3'],
  reasons: { sv: 'Avstängd enligt Sanktionsregistret.' },
  consequence: { sv: 'Spelaren får inte spela.' },
  appeal: { to: 'review-committee', deadline: '2026-10-26T21:40:00+01:00' },
  ...extra,
});
const sanction = (id, extra = {}) => ({
  id,
  game: 'cs2',
  kind: 'withdrawal-bar',
  subject: { sv: 'Lag Avhopp (AVH) och spelarna a, b och c' },
  scope: { sv: 'RIVALS CS2 Säsong 3 och Säsong 4, alla Spår' },
  from: '2026-11-10',
  until: null,
  untilText: { sv: 'Till och med RIVALS CS2 Säsong 4' },
  decidedBy: 'head-of-compops',
  decision: { log: 'cs2-s2', id: 2 },
  ...extra,
});
const logFeed = (entries) => `${JSON.stringify({ log: 'cs2-s2', page: `${SITE}/cs2/decisions`, entries }, null, 2)}\n`;
const registerFeed = (entries) => `${JSON.stringify({ page: `${SITE}/sanctions`, entries }, null, 2)}\n`;
const fakeFetch = (bodies) => async (url) => {
  const body = bodies[new URL(url).pathname];
  const status = typeof body === 'number' ? body : body === undefined ? 404 : 200;
  return { ok: status === 200, status, text: async () => body, arrayBuffer: async () => Buffer.from(body) };
};
const quiet = () => {};
const run = (root, bodies) => archive({ root, site: SITE, fetchImpl: fakeFetch(bodies), log: quiet });
const LOG = '/data/cs2-s2-decisions-log.json';
const REGISTER = '/data/sanctions-register.json';

test('provisions and appeals read like the website', () => {
  assert.equal(provision('2.7:3'), '2.7 grund 3');
  assert.equal(provision('6.8.4'), '6.8.4');
  assert.equal(appealText({ to: 'review-committee', deadline: '2026-10-26T21:40:00+01:00' }),
    'Kan överklagas till Granskningskommittén genom Supportärende senast 2026-10-26 21:40:00 CET (regel 7.3.2).');
  assert.match(appealText({ to: 'head-of-compops', deadline: '2026-10-21T20:00:00Z' }), /Tävlingsansvarig .* 2026-10-21 22:00:00 CEST \(regel 7\.3\.1\)/);
  assert.equal(appealText({ to: 'none', note: { sv: 'Ändringar beslutas enligt 1.3.4.' } }), 'Kan inte överklagas. Ändringar beslutas enligt 1.3.4.');
});

test('a log entry shows every field rule 1.3.2 asks for, in Swedish', () => {
  const md = renderLog(JSON.parse(logFeed([decision(1), decision(2, { replaces: [1], reviewOf: 1 })])), `${SITE}/cs2/decisions`);
  for (const line of [
    '## #001 Spelare ej godkänd i Behörighetskontrollen',
    '- Beslutat: 2026-10-25 21:40:00 CET',
    '- Spår: LEGENDS',
    '- Typ: Behörighet',
    '- Beslutsfattare: Tävlingsansvarig',
    // Brackets are escaped (they render as plain brackets on GitHub).
    '- Berörda: exempel \\(Lag Exempel, EXM\\)',
    '- Bestämmelse: 2.1.9, 2.7 grund 3',
    '- Skäl: Avstängd enligt Sanktionsregistret.',
    '- Följd: Spelaren får inte spela.',
    '- Ersätter: #001',
    '- Prövning av: #001',
  ]) assert.ok(md.includes(line), line);
  assert.ok(!md.includes('Player not approved'), 'the Markdown is the Swedish master text');
});

test('text cannot turn into links or HTML', () => {
  const md = renderLog(JSON.parse(logFeed([decision(1, { affected: { sv: '[x](https://evil.test) <b>' } })])), SITE);
  assert.ok(md.includes('- Berörda: \\[x\\]\\(https://evil.test\\) &lt;b&gt;'));
});

test('a register entry without an end date says what the end is', () => {
  const md = renderRegister(JSON.parse(registerFeed([sanction(1, { lifted: { on: '2026-12-01', decision: { log: 'cs2-s2', id: 5 } } })])), `${SITE}/sanctions`);
  assert.ok(md.includes('- Till och med: Till och med RIVALS CS2 Säsong 4'));
  assert.ok(md.includes('- Typ: Spärr efter Avhopp'));
  assert.ok(md.includes('- Beslut: Beslutsloggen cs2-s2 #002'));
  assert.ok(md.includes('- Hävd: 2026-12-01, Beslutsloggen cs2-s2 #005'));
});

test('feeds of the wrong shape are refused', () => {
  assert.throws(() => assertFeed('log', { log: 'other', entries: [] }), /unexpected response/);
  assert.throws(() => assertFeed('register', { entries: [{ id: 'x' }] }), /unexpected response/);
  assertFeed('log', { log: 'cs2-s2', entries: [] });
});

test('the first save keeps the JSON byte for byte, and a rerun changes nothing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'decisions-'));
  const bodies = { [LOG]: logFeed([decision(1)]), [REGISTER]: registerFeed([]) };
  const first = await run(root, bodies);
  assert.deepEqual(first.problems, []);
  assert.equal(first.message, 'Archive Decisions Log (first save) and Sanctions Register (first save)');
  assert.equal(await readFile(path.join(root, 'decisions-log/cs2-s2-decisions-log.json'), 'utf8'), bodies[LOG]);
  assert.deepEqual((await readdir(path.join(root, 'sanctions-register'))).sort(), ['sanctions-register.json', 'sanctions-register.md']);
  const again = await run(root, bodies);
  assert.equal(again.message, null);
  assert.deepEqual(again.changes, []);
});

test('new entries are named in the commit message', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'decisions-'));
  await run(root, { [LOG]: logFeed([decision(1)]), [REGISTER]: registerFeed([]) });
  const next = await run(root, { [LOG]: logFeed([decision(1), decision(2), decision(3)]), [REGISTER]: registerFeed([sanction(1)]) });
  assert.equal(next.message, 'Archive Decisions Log #002, #003 and Sanctions Register #001');
  const edited = await run(root, { [LOG]: logFeed([decision(1, { reasons: { sv: 'Skäl.', en: 'Reasons.' } }), decision(2), decision(3)]), [REGISTER]: registerFeed([sanction(1)]) });
  assert.equal(edited.message, 'Archive Decisions Log (entries updated)');
});

test('an entry that disappears is reported and the archive is kept', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'decisions-'));
  await run(root, { [LOG]: logFeed([decision(1), decision(2)]), [REGISTER]: registerFeed([]) });
  const result = await run(root, { [LOG]: logFeed([decision(1)]), [REGISTER]: registerFeed([]) });
  assert.match(result.problems[0], /#002 disappeared/);
  assert.equal(result.message, null);
  const kept = JSON.parse(await readFile(path.join(root, 'decisions-log/cs2-s2-decisions-log.json'), 'utf8'));
  assert.deepEqual(kept.entries.map((e) => e.id), [1, 2]);
});

test('a feed that is not published yet is fine; one that goes missing later is not', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'decisions-'));
  const before = await run(root, {});
  assert.deepEqual(before.problems, []);
  assert.equal(before.message, null);
  await mkdir(path.join(root, 'decisions-log'), { recursive: true });
  await writeFile(path.join(root, 'decisions-log/cs2-s2-decisions-log.json'), logFeed([]));
  const after = await run(root, { [REGISTER]: 500 });
  assert.deepEqual(after.problems, [
    `Decisions Log: ${SITE}${LOG} answered HTTP 404.`,
    `Sanctions Register: ${SITE}${REGISTER} answered HTTP 500.`,
  ]);
});

test('invalid JSON is a problem, not a crash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'decisions-'));
  const result = await run(root, { [LOG]: '<html>', [REGISTER]: registerFeed([]) });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /^Decisions Log: /);
  assert.equal(result.message, 'Archive Sanctions Register (first save)');
});

test('describeChange names a first save', () => {
  assert.equal(describeChange(RECORDS.log, null, { entries: [] }), 'Decisions Log (first save)');
  assert.equal(describeChange(RECORDS.changelog, { entries: [{ version: '1.0' }] }, { entries: [{ version: '1.0' }, { version: '1.1' }] }), 'Changelog v1.1');
});

const CHANGELOG = '/data/cs2-s2-changelog.json';
const version = (v, extra = {}) => ({
  version: v,
  kind: v === '1.0' ? 'publication' : 'change',
  publishedAt: v === '1.0' ? '2026-10-02T12:00:00+02:00' : '2026-10-20T12:00:00+02:00',
  appliesFrom: v === '1.0' ? '2026-10-02T12:00:00+02:00' : '2026-10-27T12:00:00+01:00',
  clauses: v === '1.0' ? [] : ['6.4.4', '2.7:6'],
  summary: { sv: v === '1.0' ? 'Regelboken publiceras.' : 'Ny väntetid.' },
  pdf: { sv: `/rules/RIVALS-CS2-S2-Regelbok-v${v}-SV.pdf`, en: `/rules/RIVALS-CS2-S2-Rulebook-v${v}-EN.pdf` },
  ...extra,
});
const changelogFeed = (entries) => `${JSON.stringify({ page: `${SITE}/cs2/rules/changelog`, entries }, null, 2)}
`;
const PDF = (tag) => `%PDF-1.7 ${tag}`;
const withV10 = async (root) => {
  await writeFile(path.join(root, pdfName('1.0', 'sv')), 'published v1.0 sv');
  await writeFile(path.join(root, pdfName('1.0', 'en')), 'published v1.0 en');
};

test('the Changelog reads newest first, in Swedish, with links to the PDFs here', () => {
  const md = renderChangelog(JSON.parse(changelogFeed([
    version('1.0', { archived: { page: 'https://web.archive.org/web/2026/x', sv: 'javascript:alert(1)' } }),
    version('1.1', { kind: 'exception', reasons: { sv: 'Krav från Valve.' }, exception: { basis: 'valve', tracks: ['legends'], valveApproval: '2026-10-19' } }),
  ])), `${SITE}/cs2/rules/changelog`);
  assert.ok(md.indexOf('## Version 1.1, Undantag') < md.indexOf('## Version 1.0, Publicering'));
  for (const line of [
    '- Publicerad: 2026-10-20 12:00:00 CEST',
    '- Gäller från: 2026-10-27 12:00:00 CET',
    '- Klausuler: 6.4.4, 2.7 grund 6',
    '- Skäl: Krav från Valve.',
    '- Grund: Valves turneringskrav. Spår: LEGENDS. Valves skriftliga godkännande 2026-10-19.',
    '- Beslutat av: Ligakommissarien',
    '- Regelbok: [RIVALS-CS2-S2-REGELBOK-SV-v1.1.pdf](../RIVALS-CS2-S2-REGELBOK-SV-v1.1.pdf), [RIVALS-CS2-S2-RULEBOOK-EN-v1.1.pdf](../RIVALS-CS2-S2-RULEBOOK-EN-v1.1.pdf)',
    '- Arkiverad kopia: <https://web.archive.org/web/2026/x>',
  ]) assert.ok(md.includes(line), line);
  assert.ok(!md.includes('javascript:'), 'only https archive links are written');
});

test('a feed with PDF paths outside /rules/ is refused', () => {
  assert.throws(() => assertFeed('changelog', { entries: [version('1.0', { pdf: { sv: '/rules/../x.pdf', en: '/rules/a-EN.pdf' } })] }), /unexpected response/);
  assert.throws(() => assertFeed('changelog', { entries: [version('one')] }), /unexpected response/);
});

test('a new rulebook version gets its PDFs copied here, and 1.0 is left alone', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'changelog-'));
  await withV10(root);
  const bodies = {
    [LOG]: logFeed([]), [REGISTER]: registerFeed([]), [CHANGELOG]: changelogFeed([version('1.0')]),
  };
  const first = await run(root, bodies);
  assert.deepEqual(first.problems, []);
  assert.equal(first.message, 'Archive Decisions Log (first save), Sanctions Register (first save) and Changelog (first save)');
  const next = await run(root, {
    ...bodies,
    [CHANGELOG]: changelogFeed([version('1.0'), version('1.1')]),
    '/rules/RIVALS-CS2-S2-Regelbok-v1.1-SV.pdf': PDF('sv'),
    '/rules/RIVALS-CS2-S2-Rulebook-v1.1-EN.pdf': PDF('en'),
  });
  assert.deepEqual(next.problems, []);
  assert.equal(next.message, 'Archive Changelog v1.1 and rulebook PDFs v1.1');
  assert.equal(await readFile(path.join(root, 'RIVALS-CS2-S2-REGELBOK-SV-v1.1.pdf'), 'utf8'), PDF('sv'));
  assert.equal(await readFile(path.join(root, 'RIVALS-CS2-S2-RULEBOOK-EN-v1.1.pdf'), 'utf8'), PDF('en'));
  assert.equal(await readFile(path.join(root, pdfName('1.0', 'sv')), 'utf8'), 'published v1.0 sv');
});

test('PDFs are never overwritten, and a page that is not a PDF is refused', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'changelog-'));
  await withV10(root);
  await writeFile(path.join(root, pdfName('1.1', 'sv')), 'already here');
  const result = await run(root, {
    [LOG]: logFeed([]), [REGISTER]: registerFeed([]), [CHANGELOG]: changelogFeed([version('1.0'), version('1.1')]),
    '/rules/RIVALS-CS2-S2-Regelbok-v1.1-SV.pdf': PDF('new sv'),
    '/rules/RIVALS-CS2-S2-Rulebook-v1.1-EN.pdf': '<html>not found</html>',
  });
  assert.equal(await readFile(path.join(root, pdfName('1.1', 'sv')), 'utf8'), 'already here');
  assert.deepEqual(result.problems, [`Rulebook v1.1 (en): ${SITE}/rules/RIVALS-CS2-S2-Rulebook-v1.1-EN.pdf is not a PDF.`]);
  assert.deepEqual((await readdir(root)).filter((f) => f.endsWith('.pdf')).sort(), [pdfName('1.0', 'en'), pdfName('1.0', 'sv'), pdfName('1.1', 'sv')].sort());
});

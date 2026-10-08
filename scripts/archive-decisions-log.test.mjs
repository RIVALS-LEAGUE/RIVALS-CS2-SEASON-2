// node --test scripts/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appealText, archive, assertFeed, describeChange, provision, renderLog, renderRegister } from './archive-decisions-log.mjs';

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
  return { ok: status === 200, status, text: async () => body };
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
  assert.equal(describeChange('Decisions Log', null, { entries: [] }), 'Decisions Log (first save)');
});

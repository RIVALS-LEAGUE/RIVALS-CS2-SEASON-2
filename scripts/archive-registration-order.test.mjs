// node --test scripts/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { archive, cell, notReadyReason, renderMarkdown, statusText, stockholmTime, sourceUrl } from './archive-registration-order.mjs';

const CLOSES = '2026-10-21T21:59:59+00:00';
const tournament = (slug, extra = {}) => ({
  id: '9a247a61-540d-4896-b1b0-0a7f26fcd46a', slug, name: 'RIVALS LEAGUE Counter-Strike 2 Season 2: LEGENDS',
  track: 'legends', slot_cap: 2, registration_opens_at: '2026-10-09T10:00:00+00:00',
  registration_closes_at: CLOSES, registration_state: 'closed', frozen_at: null, ...extra,
});
const row = (order, name, extra = {}) => ({
  order, team_name: name, tri_code: name.slice(0, 3).toUpperCase(), logo_url: null,
  registered_at: '2026-10-09T10:00:07.000Z', registered_at_local: '2026-10-09 12:00:07 CEST',
  registered_at_utc: '2026-10-09 10:00:07 UTC', status: 'slot', waitlist_position: null, approved: false, ...extra,
});
const order = (slug, extra = {}) => ({
  tournament: tournament(slug, extra), free_slots: 0, counts: { slot: 2, waitlist: 1, withdrawn: 2 },
  teams: [
    row(1, 'Alpha', { approved: true }), row(2, 'Bravo'), row(3, 'Charlie', { status: 'waitlist', waitlist_position: 1 }),
    row(null, 'Delta', { status: 'withdrawn' }), row(null, 'Echo', { status: 'not_approved' }),
  ],
});
const fakeFetch = (bodies) => async (url) => {
  const slug = new URL(url).searchParams.get('slug');
  const body = bodies[slug];
  return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
};
const quiet = () => {};

test('window-closed waits until after 23:59:59 CEST on 21 October', () => {
  const o = order('rivals-cs2-s2-legends');
  assert.match(notReadyReason('window-closed', o, new Date(CLOSES)), /nothing to save yet/);
  assert.equal(notReadyReason('window-closed', o, new Date('2026-10-21T22:00:00Z')), null);
});

test('groups-published needs a frozen order', () => {
  assert.match(notReadyReason('groups-published', order('rivals-cs2-s2-legends'), new Date('2026-10-26T17:00:00Z')), /not frozen/);
  assert.equal(notReadyReason('groups-published', order('rivals-cs2-s2-legends', { frozen_at: '2026-10-26T17:00:00Z' })), null);
});

test('Stockholm time switches from CEST to CET on 25 October', () => {
  assert.equal(stockholmTime('2026-10-21T21:59:59Z'), '2026-10-21 23:59:59 CEST');
  assert.equal(stockholmTime('2026-10-26T17:00:00Z'), '2026-10-26 18:00:00 CET');
});

test('team names cannot become links, HTML or extra table cells', () => {
  assert.equal(cell('[win](https://x.test)'), '\\[win\\]\\(https://x.test\\)');
  assert.equal(cell('<img src=x>'), '&lt;img src=x&gt;');
  assert.equal(cell('a | b\nc'), 'a \\| b c');
  assert.equal(cell(null), '');
});

test('statuses read like the website', () => {
  assert.deepEqual(order('x').teams.map(statusText), ['Approved', 'Registered', 'Waitlist 1', 'Withdrawn', 'Not approved']);
});

test('the Markdown file lists every team in order', () => {
  const md = renderMarkdown({ moment: 'window-closed', source: sourceUrl('rivals-cs2-s2-legends'),
    fetchedAt: '2026-10-21T22:15:03Z', order: order('rivals-cs2-s2-legends') });
  assert.match(md, /^# RIVALS LEAGUE Counter-Strike 2 Season 2: LEGENDS\n/);
  assert.match(md, /- Saved: 2026-10-22 00:15:03 CEST/);
  assert.match(md, /\| 1 \| Alpha \| ALP \| 2026-10-09 12:00:07 CEST \| Approved \|/);
  assert.match(md, /\|  \| Echo \| ECH \| 2026-10-09 12:00:07 CEST \| Not approved \|/);
  assert.doesNotMatch(md, /Order frozen/);
  assert.doesNotMatch(md, /—/);
  const empty = renderMarkdown({ moment: 'window-closed', source: 's', fetchedAt: '2026-10-21T22:15:03Z',
    order: { ...order('x'), teams: [] } });
  assert.match(empty, /No teams registered\.\n$/);
});

test('archive saves both tracks once and never overwrites', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'reg-order-'));
  const bodies = { 'rivals-cs2-s2-legends': order('rivals-cs2-s2-legends'), 'rivals-cs2-s2-rivals': order('rivals-cs2-s2-rivals') };
  const now = () => new Date('2026-10-21T22:15:03Z');
  const first = await archive({ moment: 'window-closed', tracks: ['legends', 'rivals'], root, now, fetchImpl: fakeFetch(bodies), log: quiet });
  assert.deepEqual(first, { saved: ['legends', 'rivals'], problems: [] });
  const dir = path.join(root, 'registration-order', 'window-closed');
  assert.deepEqual((await readdir(dir)).sort(), ['legends.json', 'legends.md', 'rivals.json', 'rivals.md']);
  const saved = JSON.parse(await readFile(path.join(dir, 'legends.json'), 'utf8'));
  assert.equal(saved.saved_at, '2026-10-21T22:15:03.000Z');
  assert.deepEqual(saved.order, bodies['rivals-cs2-s2-legends']);

  await writeFile(path.join(dir, 'legends.json'), 'kept');
  const again = await archive({ moment: 'window-closed', tracks: ['legends', 'rivals'], root, now, fetchImpl: fakeFetch({}), log: quiet });
  assert.deepEqual(again, { saved: [], problems: [] });
  assert.equal(await readFile(path.join(dir, 'legends.json'), 'utf8'), 'kept');
});

test('archive writes nothing for a track that is not ready or not answering', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'reg-order-'));
  const result = await archive({ moment: 'window-closed', tracks: ['legends', 'rivals'], root,
    now: () => new Date('2026-10-21T20:00:00Z'), fetchImpl: fakeFetch({ 'rivals-cs2-s2-legends': order('rivals-cs2-s2-legends') }), log: quiet });
  assert.deepEqual(result.saved, []);
  assert.equal(result.problems.length, 2);
  assert.match(result.problems[0], /nothing to save yet/);
  assert.match(result.problems[1], /HTTP 404/);
  await assert.rejects(readdir(path.join(root, 'registration-order')));
});

test('archive refuses a response for the wrong track', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'reg-order-'));
  await assert.rejects(archive({ moment: 'window-closed', tracks: ['rivals'], root, now: () => new Date('2026-10-22T00:00:00Z'),
    fetchImpl: fakeFetch({ 'rivals-cs2-s2-rivals': order('rivals-cs2-s2-legends') }), log: quiet }), /Unexpected response/);
});

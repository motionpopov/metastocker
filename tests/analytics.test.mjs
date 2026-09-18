import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { Store, validateBatch, dateRange, dayOf } from '../server/store.mjs';
import { createCredentials, auth } from '../server/auth.mjs';
import { makeServer, limiter } from '../server/server.mjs';
import { clientIp, countryForIp } from '../server/geography.mjs';
import { backupDatabase } from '../server/backup.mjs';

const pages = new Set(['/', '/blog/']);
const model = 'local-qwen-2b';
const now = Date.parse('2026-09-18T10:00:00Z');
const context = { country: 'PL', device: 'desktop', browser: 'Chrome' };
const event = (kind, props = {}) => ({ id: randomUUID(), kind, ...props });
const batch = (events = [event('page_view')], extra = {}) => ({ visit: randomUUID(), page: '/', referrer: '', events, ...extra });
const range = { from: '2026-09-18', to: '2026-09-18' };
test('schema rejects content, arbitrary model names and paths, raw errors, URLs and oversized batches', () => {
  for (const extra of [{ filename: 'private.jpg' }, { ip: '1.2.3.4' }, { page: '/someone@example.com' }, { referrer: 'google.com/search?q=private' }, { visit: 'persistent-id' }]) assert.throws(() => validateBatch(batch(undefined, extra), pages));
  for (const e of [event('file_error', { model, error: 'private.jpg' }), event('file_start', { model: 'my-secret-model' }), event('file_success', { model, prompt: 'private' }), event('file_start'), event('files_added', { count: -1 }), event('file_success', { model, duration: Infinity })]) assert.throws(() => validateBatch(batch([e]), pages));
  assert.throws(() => validateBatch(batch(Array.from({ length: 31 }, () => event('page_view'))), pages));
  assert.throws(() => validateBatch(batch([event('file_start', { model })], { page: '/blog/' }), pages));
  assert.equal(validateBatch(batch([event('file_success', { model, duration: 2000 })]), pages).events[0].model, model);
});
test('parallel attempts, duplicated deliveries, exports and empty days aggregate correctly', () => {
  const s = new Store(':memory:', now);
  const b = batch([event('page_view'), event('files_added', { count: 3 }), event('model_selected', { model: 'local-gemma-e2b' }), event('file_start', { model, threads: 2 }), event('file_start', { model, threads: 2 }), event('file_start', { model, threads: 2 }), event('file_success', { model, duration: 3000 }), event('file_error', { model, error: 'memory' }), event('file_cancel', { model }), event('export', { format: 'adobe', count: 1 })]);
  s.record(validateBatch(b, pages), context, now); s.record(b, context, now + 100);
  s.record(batch(undefined, { page: '/blog/', referrer: 'google.com' }), { ...context, country: 'UA' }, now);
  const summary = s.summary({ from: '2026-09-17', to: range.to });
  assert.equal(summary.totals.visits, 2); assert.equal(summary.totals.attempts, 3); assert.equal(summary.totals.success, 1);
  assert.equal(summary.totals.errors, 1); assert.equal(summary.totals.cancelled, 1); assert.equal(summary.totals.exports, 1);
  assert.deepEqual(summary.funnel, [1, 1, 1, 1, 1]);
  assert.equal(summary.models[0].model, model); assert.equal(summary.models[0].duration, 3000); assert.equal(summary.models[0].threads, 2);
  assert.equal(summary.models.find(m => m.model === 'local-gemma-e2b').attempts, 0);
  assert.equal(summary.daily[0].visits, 0); assert.equal(summary.countries.length, 2);
  assert.equal(summary.formats[0].rows, 1);
  s.close();
});
test('funnel is a page-opening cohort, events use their own dates and incomplete visits do not convert', () => {
  const s = new Store(':memory:', now), old = batch([event('page_view'), event('files_added', { count: 1 })]);
  s.record(old, context, now - 13 * 3600000);
  s.record({ ...old, events: [event('file_start', { model }), event('file_success', { model, duration: 20 })] }, context, now);
  s.record(batch([event('export', { format: 'adobe', count: 1 })]), context, now);
  const result = s.summary(range);
  assert.equal(result.totals.success, 1);
  assert.deepEqual(result.funnel, [1, 0, 0, 0, 0]);
  s.close();
});
test('visit code cannot persist past 24 hours or across pages, and 90-day retention removes linked events', () => {
  const s = new Store(':memory:', now), b = batch();
  s.record(b, context, now);
  s.record({ ...b, events: [event('file_start', { model })] }, context, now + 86400001);
  s.record({ ...b, page: '/blog/', events: [event('page_view')] }, context, now);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
  s.prune(now + 91 * 86400000);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM visits').get().n, 0);
  s.close();
});
test('date filtering uses Warsaw calendar days and rejects impossible, future and overly old ranges', () => {
  assert.equal(dayOf(Date.parse('2026-09-17T22:30:00Z')), '2026-09-18');
  assert.deepEqual(dateRange(new URLSearchParams('days=1'), now), range);
  for (const query of ['from=2026-02-31', 'to=2027-01-01', 'days=91', 'days=NaN', 'from=2026-09-19&to=2026-09-18']) assert.throws(() => dateRange(new URLSearchParams(query), now));
});
test('online backup captures WAL data and can be restored without changing the live store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meta-backup-test-'));
  const s = new Store(join(dir, 'live.sqlite'), now); s.record(batch(), context, now);
  await backupDatabase(join(dir, 'live.sqlite'), join(dir, 'copy.sqlite'));
  const copy = new Store(join(dir, 'copy.sqlite'), now);
  assert.equal(copy.summary(range).totals.visits, 1); copy.close(); s.close(); rmSync(dir, { recursive: true });
});
test('IP trust is explicit and offline country lookup stores only a country', () => {
  const req = { headers: { 'x-forwarded-for': '8.8.8.8, 1.1.1.1' }, socket: { remoteAddress: '::ffff:127.0.0.1' } };
  assert.equal(clientIp(req, false), '127.0.0.1'); assert.equal(clientIp(req, true), '1.1.1.1');
  assert.equal(countryForIp('127.0.0.1'), 'ZZ'); assert.match(countryForIp('8.8.8.8'), /^[A-Z]{2}$/);
});
test('owner password and signed cookies cannot be forged or used after expiry', async () => {
  const a = auth(await createCredentials('a-test-only-password'));
  assert.equal(await a.verify('a-test-only-password'), true); assert.equal(await a.verify('a-wrong-test-password'), false);
  const cookie = a.cookie(false, now).split(';')[0]; assert.equal(a.valid(cookie, now), true);
  assert.equal(a.valid(cookie, now + 8 * 3600000), false);
  assert.equal(a.valid(cookie.replace(/.$/, cookie.endsWith('a') ? 'b' : 'a'), now), false);
  assert.match(a.cookie(), /HttpOnly; SameSite=Strict; Max-Age=28800; Secure/);
  assert.equal(a.valid(a.cookie(true)), false);
});
test('HTTP authorization, CSRF, privacy exclusions, validation and login rate limits', async t => {
  const s = new Store(':memory:'); const credentials = await createCredentials('a-test-only-password');
  // Listen first, then provide a stable test origin independent of the random port.
  const origin = 'https://test.metastocker.net';
  const server = makeServer({ store: s, credentials, origin, pages });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); s.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'user-agent': 'Chrome/140', ...headers }, body: JSON.stringify(body), redirect: 'manual' });
  assert.equal((await fetch(base + '/admin/api/summary')).status, 401);
  assert.equal((await fetch(base + '/admin/', { redirect: 'manual' })).status, 303);
  assert.equal((await fetch(base + '/admin/assets/admin.js')).status, 401);
  assert.equal((await post('/api/analytics', batch(), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/analytics', { ...batch(), photo: 'private' })).status, 400);
  assert.equal((await post('/api/analytics', batch())).status, 204);
  const login = await post('/admin/api/login', { password: 'a-test-only-password' });
  assert.equal(login.status, 200); assert.equal(login.headers.get('cache-control'), 'no-store');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const headers of [{ cookie }, { DNT: '1' }, { 'sec-gpc': '1' }, { 'user-agent': 'Googlebot' }]) assert.equal((await post('/api/analytics', batch(), headers)).status, 204);
  const response = await fetch(base + '/admin/api/summary?days=1', { headers: { cookie } });
  assert.equal(response.status, 200); assert.equal((await response.json()).totals.visits, 1);
  assert.equal((await fetch(base + '/admin/api/summary?days=999', { headers: { cookie } })).status, 400);
  const dump = JSON.stringify(s.db.prepare('SELECT * FROM visits').all());
  assert.doesNotMatch(dump, /127\.0\.0\.1|Chrome\/140|private|password/);
  for (let i = 0; i < 7; i++) assert.equal((await post('/admin/api/login', { password: 'wrong-test-password' })).status, 401);
  assert.equal((await post('/admin/api/login', { password: 'wrong-test-password' })).status, 429);
});
test('rate limiter resets on expiry', () => { const allow = limiter(2, 1000); assert.ok(allow('ip', 0)); assert.ok(allow('ip', 10)); assert.ok(!allow('ip', 20)); assert.ok(allow('ip', 1000)); });

const trackerSource = readFileSync(new URL('../analytics.js', import.meta.url), 'utf8');
function tracker({ disabled = false, dnt = false } = {}) {
  const handlers = {}, sent = [], writes = [];
  const ctx = { location: { pathname: '/', hostname: 'metastocker.net' }, document: { hidden: false, referrer: 'https://google.com/search?q=secret', addEventListener: (name, fn) => { handlers[name] = fn; } }, navigator: { doNotTrack: dnt ? '1' : '0', sendBeacon: (url, blob) => { sent.push({ url, blob }); return true; } }, localStorage: { getItem: () => disabled ? '1' : null, setItem: (...args) => writes.push(args) }, crypto: { randomUUID }, URL, Blob, Date, setTimeout: () => 1, clearTimeout: () => {}, addEventListener: (name, fn) => { handlers[name] = fn; } };
  ctx.window = ctx; vm.runInNewContext(trackerSource, ctx);
  return { ctx, handlers, sent, writes };
}
test('tracker creates a new in-memory page ID, strips unrelated props and referrer queries, writes no ID to storage', async () => {
  const a = tracker(); a.ctx.MetaStockerStats.event('file_error', { model, error: 'memory', prompt: 'secret', filename: 'private.jpg' }); a.handlers.pagehide();
  const body = JSON.parse(await a.sent[0].blob.text());
  assert.equal(body.referrer, 'google.com'); assert.equal(body.events.length, 2); assert.deepEqual(a.writes, []);
  assert.doesNotMatch(JSON.stringify(body), /secret|private/);
  const b = tracker(); b.handlers.pagehide(); assert.notEqual(JSON.parse(await b.sent[0].blob.text()).visit, body.visit);
  assert.equal(a.ctx.MetaStockerStats.errorCode(new Error('my private.jpg failed: GPU out of memory')), 'memory');
});
test('tracker respects DNT, opt-out and opt-out changes in another tab', () => {
  for (const options of [{ disabled: true }, { dnt: true }]) { const t = tracker(options); t.ctx.MetaStockerStats.event('files_added', { count: 1 }); t.handlers.pagehide(); assert.equal(t.sent.length, 0); }
  const t = tracker(); t.handlers.storage({ key: 'metastocker_stats_disabled', newValue: '1' }); t.handlers.pagehide(); assert.equal(t.sent.length, 0);
});

import { DatabaseSync } from 'node:sqlite';

export const MODELS = ['local-gemma-e2b', 'local-qwen-2b', 'local-gemma-e4b', 'gpt-5.6-luna', 'gpt-5.4-mini', 'gpt-5.4-nano'];
export const KINDS = ['page_view', 'files_added', 'model_selected', 'model_load_start', 'model_load_success', 'model_load_error', 'model_load_cancel', 'model_unload', 'model_delete', 'gpu_available', 'gpu_unavailable', 'file_start', 'file_success', 'file_error', 'file_cancel', 'export'];
export const ERRORS = ['memory', 'gpu', 'network', 'auth', 'quota', 'invalid_output', 'preview', 'unknown'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fields = ['id', 'kind', 'model', 'count', 'duration', 'threads', 'format', 'error', 'cached'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
export function validateBatch(body, pages) {
  if (!object(body) || Object.keys(body).some(k => !['visit', 'page', 'referrer', 'events'].includes(k)) || !UUID.test(body.visit || '') || !pages.has(body.page) || !Array.isArray(body.events) || !body.events.length || body.events.length > 30) throw new Error('invalid_event');
  if (typeof body.referrer !== 'string' || (body.referrer && (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(body.referrer) || body.referrer.length > 253))) throw new Error('invalid_event');
  for (const e of body.events) {
    if (!object(e) || Object.keys(e).some(k => !fields.includes(k)) || !UUID.test(e.id || '') || !KINDS.includes(e.kind)) throw new Error('invalid_event');
    if (e.model !== undefined && !MODELS.includes(e.model)) throw new Error('invalid_event');
    if ((e.kind.startsWith('model_') || e.kind.startsWith('file_')) && !e.model) throw new Error('invalid_event');
    for (const [key, max] of [['count', 10000], ['duration', 86400000], ['threads', 20]]) if (e[key] !== undefined && !bounded(e[key], max)) throw new Error('invalid_event');
    if (e.format !== undefined && !['adobe', 'envato', 'shutterstock', 'freepik'].includes(e.format)) throw new Error('invalid_event');
    if (e.error !== undefined && !ERRORS.includes(e.error)) throw new Error('invalid_event');
    if (e.cached !== undefined && typeof e.cached !== 'boolean') throw new Error('invalid_event');
    if (e.kind === 'export' && (!e.format || !e.count)) throw new Error('invalid_event');
    if (body.page !== '/' && e.kind !== 'page_view') throw new Error('invalid_event');
  }
  return body;
}

const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' });
export const dayOf = (now = Date.now()) => dayFormatter.format(new Date(now));
export function dateRange(params, now = Date.now()) {
  const today = dayOf(now);
  const oldest = new Date(Date.parse(today) - 89 * 86400000).toISOString().slice(0, 10);
  const days = Number(params.get('days') || 7);
  const to = params.get('to') || today;
  const from = params.get('from') || new Date(Date.parse(to) - (days - 1) * 86400000).toISOString().slice(0, 10);
  for (const date of [from, to]) if (!/^\d{4}-\d\d-\d\d$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('invalid_range');
  if (from > to || from < oldest || to > today) throw new Error('invalid_range');
  return { from, to };
}

export class Store {
  constructor(filename, now = Date.now()) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS visits (
        id TEXT PRIMARY KEY, started INTEGER NOT NULL, day TEXT NOT NULL, page TEXT NOT NULL,
        referrer TEXT NOT NULL, country TEXT NOT NULL, device TEXT NOT NULL, browser TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, visit TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
        at INTEGER NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, model TEXT NOT NULL,
        count INTEGER NOT NULL, duration INTEGER, threads INTEGER, format TEXT NOT NULL,
        error TEXT NOT NULL, cached INTEGER);
      CREATE INDEX IF NOT EXISTS events_day ON events(day);
      CREATE INDEX IF NOT EXISTS events_visit ON events(visit);
      CREATE INDEX IF NOT EXISTS visits_day ON visits(day);`);
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('collection_started', new Date(now).toISOString());
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('schema', '1');
  }
  record(batch, context, now = Date.now()) {
    const day = dayOf(now);
    const existing = this.db.prepare('SELECT started, page FROM visits WHERE id=?').get(batch.visit);
    // A visit cannot be reused across pages or kept alive as a long-lived visitor ID.
    if (existing && (now - existing.started > 86400000 || existing.page !== batch.page)) return;
    const visit = this.db.prepare('INSERT OR IGNORE INTO visits VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const event = this.db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      visit.run(batch.visit, now, day, batch.page, batch.referrer || 'direct', context.country || 'ZZ', context.device, context.browser);
      for (const e of batch.events) event.run(e.id, batch.visit, now, day, e.kind, e.model || '', e.count ?? 1, e.duration ?? null, e.threads ?? null, e.format || '', e.error || '', e.cached === undefined ? null : Number(e.cached));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  prune(now = Date.now()) {
    const cutoff = new Date(Date.parse(dayOf(now)) - 89 * 86400000).toISOString().slice(0, 10);
    this.db.prepare('DELETE FROM visits WHERE day < ?').run(cutoff);
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }
  summary(range) {
    const { from, to } = range;
    const all = (sql, ...extra) => this.db.prepare(sql).all(from, to, ...extra);
    const events = all(`SELECT kind, COUNT(*) AS total, SUM(count) AS files FROM events WHERE day BETWEEN ? AND ? GROUP BY kind`);
    const count = kind => events.find(e => e.kind === kind)?.total || 0;
    const sum = kind => events.find(e => e.kind === kind)?.files || 0;
    const visits = all('SELECT COUNT(*) AS n FROM visits WHERE day BETWEEN ? AND ?')[0].n;
    const models = all(`SELECT model, SUM(kind='file_start') AS attempts, SUM(kind='file_success') AS success,
      SUM(kind='file_error') AS errors, SUM(kind='file_cancel') AS cancelled,
      SUM(kind='model_load_start') AS loads, SUM(kind='model_load_success') AS loaded,
      SUM(kind='model_load_error') AS load_errors, SUM(kind='model_load_cancel') AS load_cancelled,
      AVG(CASE WHEN kind='file_success' THEN duration END) AS duration,
      AVG(CASE WHEN kind='file_start' THEN threads END) AS threads
      FROM events WHERE day BETWEEN ? AND ? AND model != '' GROUP BY model ORDER BY attempts DESC, success DESC, model`);
    const dailyVisits = all('SELECT day, COUNT(*) AS visits FROM visits WHERE day BETWEEN ? AND ? GROUP BY day');
    const dailyEvents = all(`SELECT day, SUM(kind='file_success') AS success, SUM(kind='file_error') AS errors,
      SUM(kind='export') AS exports FROM events WHERE day BETWEEN ? AND ? GROUP BY day`);
    const daily = [];
    for (let date = Date.parse(from); date <= Date.parse(to); date += 86400000) {
      const day = new Date(date).toISOString().slice(0, 10);
      daily.push({ day, visits: 0, success: 0, errors: 0, exports: 0, ...dailyVisits.find(d => d.day === day), ...dailyEvents.find(d => d.day === day) });
    }
    const stages = all(`WITH stages AS (SELECT v.id,
      MAX(e.kind='files_added') AS imported, MAX(e.kind='file_start') AS started,
      MAX(e.kind='file_success') AS succeeded, MAX(e.kind='export') AS exported
      FROM visits v LEFT JOIN events e ON e.visit=v.id AND e.day <= ?3
      WHERE v.day BETWEEN ?1 AND ?2 AND v.page='/' GROUP BY v.id)
      SELECT COUNT(*) AS opened, COALESCE(SUM(imported),0) AS imported,
      COALESCE(SUM(imported AND started),0) AS started,
      COALESCE(SUM(imported AND started AND succeeded),0) AS succeeded,
      COALESCE(SUM(imported AND started AND succeeded AND exported),0) AS exported FROM stages`, to)[0];
    const breakdown = field => all(`SELECT ${field} AS name, COUNT(*) AS count FROM visits WHERE day BETWEEN ? AND ? GROUP BY ${field} ORDER BY count DESC, name LIMIT 30`);
    return {
      range, timeZone: 'Europe/Warsaw', retentionDays: 90,
      collectionStarted: this.db.prepare('SELECT value FROM meta WHERE key=?').get('collection_started').value,
      totals: { visits, attempts: count('file_start'), success: count('file_success'), errors: count('file_error'), cancelled: count('file_cancel'), imports: sum('files_added'), exports: count('export'), exportedRows: sum('export'),
        local: all("SELECT COUNT(*) AS n FROM events WHERE day BETWEEN ? AND ? AND kind='file_start' AND model LIKE 'local-%'")[0].n,
        gpuAvailable: count('gpu_available'), gpuUnavailable: count('gpu_unavailable') },
      funnel: [stages.opened, stages.imported, stages.started, stages.succeeded, stages.exported],
      models, daily, countries: breakdown('country'), referrers: breakdown('referrer'), pages: breakdown('page'), devices: breakdown('device'), browsers: breakdown('browser'),
      formats: all("SELECT format AS name, COUNT(*) AS count, SUM(count) AS rows FROM events WHERE day BETWEEN ? AND ? AND kind='export' GROUP BY format ORDER BY count DESC"),
      errors: all("SELECT error AS name, model, kind, COUNT(*) AS count FROM events WHERE day BETWEEN ? AND ? AND kind IN ('file_error','model_load_error') GROUP BY error, model, kind ORDER BY count DESC LIMIT 30")
    };
  }
  close() { this.db.close(); }
}

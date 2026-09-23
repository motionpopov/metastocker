import { createServer } from 'node:http';
import { readFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auth } from './auth.mjs';
import { Store, validateBatch, dateRange, dayOf } from './store.mjs';
import { browserContext, clientIp, countryForIp } from './geography.mjs';
import { backupDatabase } from './backup.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
export function limiter(limit, windowMs) {
  const buckets = new Map();
  const prune = () => { const now = Date.now(); for (const [key, bucket] of buckets) if (now >= bucket.until) buckets.delete(key); };
  const timer = setInterval(prune, Math.min(windowMs, 60000)); timer.unref();
  const allow = (key, now = Date.now()) => {
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.until) {
      if (buckets.size >= 5000) for (const [id, item] of buckets) if (now >= item.until) buckets.delete(id);
      if (buckets.size >= 5000 && !buckets.has(key)) return false;
      bucket = { count: 0, until: now + windowMs }; buckets.set(key, bucket);
    }
    return ++bucket.count <= limit;
  };
  allow.close = () => clearInterval(timer);
  return allow;
}
async function readBody(req) {
  if (Number(req.headers['content-length'] || 0) > 24000) throw new Error('body_too_large');
  let length = 0;
  const parts = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 24000) throw new Error('body_too_large');
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

export function makeServer({ store, credentials, origin = 'https://metastocker.net', pages, trustProxy = false }) {
  const owner = auth(credentials, origin.startsWith('https:'));
  const collectLimit = limiter(120, 60000), loginLimit = limiter(8, 15 * 60000), globalLoginLimit = limiter(40, 60000);
  const assets = new Map([
    ['/admin/login', ['login.html', 'text/html; charset=utf-8', false]],
    ['/admin/assets/login.js', ['login.js', 'text/javascript; charset=utf-8', false]],
    ['/admin/assets/admin.css', ['admin.css', 'text/css; charset=utf-8', false]],
    ['/admin/', ['index.html', 'text/html; charset=utf-8', true]],
    ['/admin/assets/admin.js', ['admin.js', 'text/javascript; charset=utf-8', true]]
  ]);
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(data === undefined ? undefined : JSON.stringify(data)); };
    const redirect = target => { res.writeHead(303, { Location: target }); res.end(); };
    try {
      const url = new URL(req.url, origin), path = url.pathname;
      const loggedIn = owner.valid(req.headers.cookie);
      const ip = clientIp(req, trustProxy);
      if (req.method === 'POST') {
        if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'origin' });
        if (path === '/api/analytics' && !url.search) {
          // Known bots, privacy preferences and owner sessions are never written to the database.
          if (loggedIn || req.headers.dnt === '1' || req.headers['sec-gpc'] === '1' || /bot|crawl|spider|headless|preview|lighthouse/i.test(req.headers['user-agent'] || '')) return send(204);
          if (!collectLimit(ip)) return send(429, { error: 'rate_limit' });
          const batch = validateBatch(await readBody(req), pages);
          store.record(batch, { ...browserContext(req.headers['user-agent']), country: countryForIp(ip) });
          return send(204);
        }
        if (path === '/admin/api/login') {
          if (!loginLimit(ip) || !globalLoginLimit('all')) { res.setHeader('Retry-After', '900'); return send(429, { error: 'rate_limit' }); }
          const body = await readBody(req);
          if (!await owner.verify(body?.password)) return send(401, { error: 'invalid_password' });
          res.setHeader('Set-Cookie', owner.cookie()); return send(200, { ok: true });
        }
        if (path === '/admin/api/logout') {
          if (!loggedIn) return send(401, { error: 'unauthorized' });
          res.setHeader('Set-Cookie', owner.cookie(true)); return send(200, { ok: true });
        }
        return send(404, { error: 'not_found' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'method' });
      if (path === '/health') { store.db.prepare('SELECT 1').get(); return send(200, { ok: true, version: '2.20' }); }
      if (path === '/admin') return redirect('/admin/');
      if (path === '/admin/api/summary') {
        if (!loggedIn) return send(401, { error: 'unauthorized' });
        return send(200, store.summary(dateRange(url.searchParams)));
      }
      if (path === '/admin/api/editorial') {
        if (!loggedIn) return send(401, { error: 'unauthorized' });
        let editorial = { status: 'not_configured' }, published = {};
        try { editorial = JSON.parse(readFileSync(process.env.EDITORIAL_STATUS || '/data/editorial-status.json', 'utf8')); } catch { }
        try { published = JSON.parse(readFileSync(join(directory, 'editorial.json'), 'utf8')); } catch { }
        const safe = {};
        for (const key of ['status', 'checked_at', 'last_success', 'failed_at', 'last_topic', 'current_topic', 'remaining_topics', 'schedule', 'cadence', 'error']) {
          if (typeof editorial[key] === 'string' || typeof editorial[key] === 'number') safe[key] = editorial[key];
        }
        return send(200, { ...safe, articles: published.articles || 0, topics: published.topics || 0 });
      }
      const asset = assets.get(path);
      if (asset) {
        if (asset[2] && !loggedIn) return path === '/admin/' ? redirect('/admin/login') : send(401, { error: 'unauthorized' });
        if (path === '/admin/login' && loggedIn) return redirect('/admin/');
        res.writeHead(200, { 'Content-Type': asset[1], 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
        res.end(req.method === 'HEAD' ? undefined : readFileSync(join(directory, 'admin', asset[0]))); return;
      }
      return send(404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof SyntaxError || ['invalid_event', 'invalid_range', 'body_too_large'].includes(error.message) || error instanceof RangeError) return send(400, { error: 'invalid_request' });
      // Never log request bodies, cookies, URLs, user agents, IPs or arbitrary exception messages.
      console.error('analytics_request_failed');
      return send(500, { error: 'unavailable' });
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.maxHeadersCount = 40;
  server.on('close', () => { collectLimit.close(); loginLimit.close(); globalLoginLimit.close(); });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const database = process.env.ANALYTICS_DB || '/data/analytics.sqlite';
  mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  const store = new Store(database);
  const pages = new Set(JSON.parse(readFileSync(process.env.ANALYTICS_PAGES || join(directory, 'pages.json'), 'utf8')));
  const credentials = JSON.parse(readFileSync(process.env.AUTH_FILE || '/run/secrets/auth.json', 'utf8'));
  const server = makeServer({ store, credentials, pages, origin: process.env.ORIGIN || 'https://metastocker.net', trustProxy: process.env.TRUST_PROXY === '1' });
  let maintenanceRunning = false;
  const maintenance = async () => {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    try {
      store.prune();
      const backupDir = join(dirname(database), 'backups');
      mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      const today = dayOf();
      const name = `analytics-${today}.sqlite`;
      if (!readdirSync(backupDir).includes(name)) await backupDatabase(database, join(backupDir, name));
      for (const old of readdirSync(backupDir)) {
        if (/^analytics-(?:before-)?[\dTZ-]+\.sqlite$/.test(old) && statSync(join(backupDir, old)).mtimeMs < Date.now() - 7 * 86400000) rmSync(join(backupDir, old));
      }
    } catch { console.error('analytics_maintenance_failed'); }
    finally { maintenanceRunning = false; }
  };
  await maintenance();
  const timer = setInterval(maintenance, 3600000); timer.unref();
  server.listen(Number(process.env.PORT || 8081), process.env.HOST || '0.0.0.0', () => console.log('MetaStocker analytics ready'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { clearInterval(timer); server.close(() => { store.close(); process.exit(0); }); });
}

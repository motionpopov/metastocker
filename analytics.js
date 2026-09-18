/* First-party counters. Visit IDs live only in this page's memory, never in storage. */
(function () {
  'use strict';
  const preference = 'metastocker_stats_disabled';
  const allowed = new Set(['page_view', 'files_added', 'model_selected', 'model_load_start', 'model_load_success', 'model_load_error', 'model_load_cancel', 'model_unload', 'model_delete', 'gpu_available', 'gpu_unavailable', 'file_start', 'file_success', 'file_error', 'file_cancel', 'export']);
  const propertyKeys = ['model', 'count', 'duration', 'threads', 'format', 'error', 'cached'];
  let queue = [], timer, visit, started = 0, sending = false;
  let page = location.pathname.replace(/\/index\.html$/, '/');
  if (page === '/blog') page = '/blog/';
  if (/^\/blog\/[a-z0-9-]+$/.test(page)) page += '.html';
  const enabled = () => {
    try { return (page === '/' || /^\/blog\/(?:[a-z0-9-]+\.html)?$/.test(page)) && navigator.doNotTrack !== '1' && !navigator.globalPrivacyControl && localStorage.getItem(preference) !== '1' && typeof crypto.randomUUID === 'function'; } catch { return false; }
  };
  let referrer = '';
  try { const url = new URL(document.referrer); if (url.hostname !== location.hostname && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)) referrer = url.hostname; } catch { }
  function begin() {
    if (visit && Date.now() - started < 86400000) return;
    queue = []; visit = crypto.randomUUID(); started = Date.now();
    queue.push({ id: crypto.randomUUID(), kind: 'page_view' });
  }
  async function flush(beacon = false) {
    clearTimeout(timer);
    if (!enabled()) { queue = []; return; }
    if (!queue.length || sending) return;
    const events = queue.splice(0, 30);
    const body = JSON.stringify({ visit, page, referrer, events });
    if (beacon && navigator.sendBeacon) {
      try { if (navigator.sendBeacon('/api/analytics', new Blob([body], { type: 'text/plain;charset=UTF-8' }))) return; } catch { }
    }
    sending = true;
    try {
      await fetch('/api/analytics', { method: 'POST', body, headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, credentials: 'same-origin', keepalive: true });
    } catch { /* Analytics must never interrupt or retry AI work. */ }
    finally { sending = false; if (queue.length) timer = setTimeout(() => void flush(), 1000); }
  }
  function event(kind, properties = {}) {
    try {
      if (!enabled() || !allowed.has(kind)) return;
      begin();
      if (kind !== 'page_view') {
        const safe = { id: crypto.randomUUID(), kind };
        for (const key of propertyKeys) if (properties[key] !== undefined) safe[key] = properties[key];
        queue.push(safe);
      }
      if (queue.length > 60) queue = queue.slice(-60);
      if (queue.length >= 20) void flush();
      else { clearTimeout(timer); timer = setTimeout(() => void flush(), 1000); }
    } catch { }
  }
  function errorCode(error) {
    const message = String(error?.message || error || '').toLowerCase();
    if (/out of memory|allocation|memory limit|buffer.*size/.test(message)) return 'memory';
    if (/webgpu|gpu|adapter|device lost/.test(message)) return 'gpu';
    if (/401|403|api key|authentication|unauthorized/.test(message)) return 'auth';
    if (/429|quota|rate limit|billing/.test(message)) return 'quota';
    if (/preview|thumbnail|decode|pdf compatible/.test(message)) return 'preview';
    if (/metadata|json|tags|final response|thinking/.test(message)) return 'invalid_output';
    if (/fetch|network|download|timeout|timed out|502|503|504/.test(message)) return 'network';
    return 'unknown';
  }
  window.MetaStockerStats = { event, errorCode };
  const view = () => { if (!document.hidden) event('page_view'); };
  view();
  document.addEventListener('visibilitychange', () => document.hidden ? void flush(true) : view());
  window.addEventListener('pagehide', () => void flush(true));
  window.addEventListener('storage', e => { if (e.key === preference && e.newValue === '1') { queue = []; visit = null; clearTimeout(timer); } });
})();

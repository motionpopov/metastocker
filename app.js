/************** Utils **************/
const sleep = ms => new Promise(r => setTimeout(r, ms));
const yieldToMain = () => new Promise(r => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    channel.port2.close();
    r();
  };
  channel.port2.postMessage(null);
});
const tick = () => document.hidden ? yieldToMain() : new Promise(r => requestAnimationFrame(() => r()));
const $ = s => document.querySelector(s);
let logs = [];

const THEME_STORAGE_KEY = 'meta_theme';
function applyTheme(theme, persist = false) {
  const dark = theme === 'dark';
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.classList.toggle('light', !dark);
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, dark ? 'dark' : 'light'); } catch { }
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#12131b' : '#fafafa');
  const toggle = document.getElementById('themeToggle');
  if (!toggle) return;
  const nextLabel = dark ? 'Switch to light theme' : 'Switch to dark theme';
  toggle.setAttribute('aria-pressed', String(dark));
  toggle.setAttribute('aria-label', nextLabel);
  toggle.title = nextLabel;
}
function initThemeToggle() {
  const toggle = document.getElementById('themeToggle');
  if (!toggle) return;
  applyTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  toggle.addEventListener('click', () => applyTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark', true));
}

/************** Web Worker for Background Processing **************/
let apiWorker = null;
let workerCallbacks = new Map();
let workerCallId = 0;

function initApiWorker() {
  const workerCode = `
    const controllers = new Map();
    self.onmessage = async (e) => {
      const { id, url, options, type } = e.data;
      if (type === 'cancel') {
        controllers.get(id)?.abort();
        return;
      }
      const controller = new AbortController();
      controllers.set(id, controller);
      const timeout = setTimeout(() => controller.abort(), 120000);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        const data = await response.json().catch(() => null);
        self.postMessage({ id, ok: response.ok, status: response.status, data, retryAfter: response.headers.get('retry-after') });
      } catch (err) {
        const error = err?.name === 'AbortError' ? 'Request timed out' : (err?.message || String(err));
        self.postMessage({ id, ok: false, error });
      } finally {
        clearTimeout(timeout);
        controllers.delete(id);
      }
    };
  `;
  let workerUrl = '';
  try {
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    workerUrl = URL.createObjectURL(blob);
    apiWorker = new Worker(workerUrl);
    URL.revokeObjectURL(workerUrl);
    workerUrl = '';
    apiWorker.onmessage = (e) => {
      const { id, ok, status, data, error, retryAfter } = e.data;
      const cb = workerCallbacks.get(id);
      if (cb) {
        workerCallbacks.delete(id);
        clearTimeout(cb.timer);
        cb.resolve({ ok, status, data, error, retryAfter });
      }
    };
    apiWorker.onerror = (err) => {
      console.error('API Worker error:', err);
      addLog('API Worker error: ' + err.message, 'error');
      for (const cb of workerCallbacks.values()) {
        clearTimeout(cb.timer);
        cb.resolve({ ok: false, error: 'API Worker failed' });
      }
      workerCallbacks.clear();
      apiWorker?.terminate();
      apiWorker = null;
    };
    addLog('API Worker initialized for background processing', 'success');
  } catch (err) {
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    apiWorker?.terminate();
    console.warn('Web Worker not available, using main thread:', err);
    apiWorker = null;
  }
}

function workerFetch(url, options) {
  return new Promise((resolve) => {
    if (!apiWorker) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      fetch(url, { ...options, signal: controller.signal })
        .then(async r => {
          const data = await r.json().catch(() => null);
          resolve({ ok: r.ok, status: r.status, data, retryAfter: r.headers.get('retry-after') });
        })
        .catch(err => resolve({ ok: false, error: err?.name === 'AbortError' ? 'Request timed out' : (err?.message || String(err)) }))
        .finally(() => clearTimeout(timer));
      return;
    }
    const id = ++workerCallId;
    const timer = setTimeout(() => {
      const cb = workerCallbacks.get(id);
      if (!cb) return;
      workerCallbacks.delete(id);
      apiWorker?.postMessage({ type: 'cancel', id });
      resolve({ ok: false, error: 'Request timed out' });
    }, 125000);
    workerCallbacks.set(id, { resolve, timer });
    try {
      apiWorker.postMessage({ id, url, options: { method: options.method, headers: options.headers, body: options.body } });
    } catch (error) {
      clearTimeout(timer);
      workerCallbacks.delete(id);
      resolve({ ok: false, error: error?.message || 'API Worker is unavailable' });
    }
  });
}

/************** Keep-Alive for Background Tabs **************/
let keepAliveInterval = null;
let keepAliveAudio = null;

function startKeepAlive() {
  if (keepAliveInterval) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      const ctx = new AudioContext();
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer; source.loop = true; source.connect(ctx.destination); source.start(0);
      keepAliveAudio = { ctx, source };
      addLog('Audio background keep-alive started', 'info');
    }
  } catch (err) { }

  keepAliveInterval = setInterval(() => {
    if (state.running && !state.paused) uiUpdate();
  }, 500);
  addLog('Keep-alive interval started', 'info');
}

function stopKeepAlive() {
  if (keepAliveAudio) {
    try { keepAliveAudio.source.stop(); keepAliveAudio.ctx.close(); } catch (e) { }
    keepAliveAudio = null;
    addLog('Audio background keep-alive stopped', 'info');
  }
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
    addLog('Keep-alive interval stopped', 'info');
  }
}

try { initApiWorker(); } catch (e) { console.warn('Worker init failed:', e); }

let wakeLock = null; let wakeLockVisibilityHooked = false;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => addLog('Wake Lock released', 'info'));
      if (!wakeLockVisibilityHooked) {
        document.addEventListener('visibilitychange', async () => {
          try { if (document.visibilityState === 'visible' && state.running && !state.paused) { wakeLock = await navigator.wakeLock.request('screen'); addLog('Wake Lock re-acquired', 'info'); } }
          catch (e) { addLog('Wake Lock re-acquire failed: ' + (e?.message || e), 'warning'); }
        });
        wakeLockVisibilityHooked = true;
      }
      addLog('Wake Lock active', 'success');
    } else {
      addLog('Wake Lock API not supported in this browser', 'warning');
    }
  } catch (e) { addLog('Wake Lock request failed: ' + (e?.message || e), 'warning'); }
}
function releaseWakeLock() {
  try { wakeLock?.release?.(); wakeLock = null; } catch (e) { }
}

/************** Nyan Progress helpers **************/
function updateNyanProgress(progress, text, processInfo = '') {
  try {
    const nyanPercent = document.getElementById('nyanPercent');
    const nyanProcessText = document.getElementById('nyanProcessText');
    const nyanProcessDetails = document.getElementById('nyanProcessDetails');
    const nyanProgressFill = document.getElementById('nyanProgressFill');
    const nyanProgressBar = document.getElementById('nyanProgressBar');
    const nyanCompletionCheck = document.getElementById('nyanCompletionCheck');
    const nyanRing = document.getElementById('nyanRing');

    const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));
    if (nyanPercent) nyanPercent.textContent = `${safeProgress}%`;
    if (nyanProcessText && text) nyanProcessText.textContent = text;
    if (nyanProcessDetails) {
      const totalFiles = state.phaseTotal || activeFileCount();
      nyanProcessDetails.textContent = processInfo || `${state.completed}/${totalFiles} • in-flight: ${state.inFlight}`;
    }
    if (nyanProgressFill) {
      nyanProgressFill.style.width = `${safeProgress}%`;
      if (safeProgress <= 0 || safeProgress >= 100) nyanProgressFill.style.borderRadius = '16px';
      else nyanProgressFill.style.borderRadius = '16px 0 0 16px';
    }
    if (nyanProgressBar) {
      nyanProgressBar.style.pointerEvents = 'none';
      nyanProgressBar.setAttribute('aria-valuenow', String(safeProgress));
    }
    if (safeProgress >= 100) {
      if (nyanRing) nyanRing.style.display = 'none';
      nyanCompletionCheck?.classList.add('hidden');
    } else {
      nyanCompletionCheck?.classList.add('hidden');
      if (nyanRing) nyanRing.style.display = '';
    }
  } catch (e) { console.warn('NyanProgressBar not available:', e); }
}
function showNyanLoader() {
  try {
    const dragDropContent = document.getElementById('dragDropContent');
    const nyanLoaderContent = document.getElementById('nyanLoaderContent');
    if (dragDropContent && nyanLoaderContent) {
      dragDropContent.classList.add('hidden');
      dragDropContent.style.pointerEvents = 'none';
      nyanLoaderContent.classList.remove('hidden');
      updateNyanProgress(0, 'Ready to process files');
    }
  } catch (e) { }
}
function hideNyanLoader() {
  try {
    const dragDropContent = document.getElementById('dragDropContent');
    const nyanLoaderContent = document.getElementById('nyanLoaderContent');
    if (dragDropContent && nyanLoaderContent) {
      dragDropContent.classList.remove('hidden');
      dragDropContent.style.pointerEvents = '';
      nyanLoaderContent.classList.add('hidden');
    }
  } catch (e) { }
}
function updateFileCount() {
  try {
    const count = activeFileCount();
    const fileCount = document.getElementById('fileCount');
    const fileCountText = document.getElementById('fileCountText');
    const importContent = document.getElementById('importContent');
    if (fileCount && fileCountText) {
      fileCountText.textContent = `${count} file${count === 1 ? '' : 's'} imported`;
      fileCount.classList.toggle('opacity-0', count === 0);
      fileCount.classList.toggle('opacity-100', count > 0);
    }
    if (importContent) importContent.style.transform = count ? 'translateY(0)' : 'translateY(20px)';
  } catch (e) { }
}

/************** Types & Globals **************/
const SUPPORTED = ['image/jpeg', 'image/png', 'image/svg+xml', 'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'];
let files = [];
let fileStatuses = [];
let csvStore = new Map();
const editingTags = new Set();
const processingFiles = new Set();
let importing = false;
const thumbCache = new Map();
const previewFailures = new Map();

function activeFileCount() {
  return files.reduce((count, file) => count + (file ? 1 : 0), 0);
}

function countActiveWithStatus(status) {
  return files.reduce((count, file, idx) => count + (file && fileStatuses[idx] === status ? 1 : 0), 0);
}

function activePendingCount() {
  return files.reduce((count, file, idx) => count + (file && fileStatuses[idx] !== 'done' && fileStatuses[idx] !== 'processing' ? 1 : 0), 0);
}

function removeCompletionForStatus(status) {
  if (status === 'done') {
    state.succeeded = Math.max(0, state.succeeded - 1);
    state.completed = Math.max(0, state.completed - 1);
  } else if (status === 'error') {
    state.failed = Math.max(0, state.failed - 1);
    state.completed = Math.max(0, state.completed - 1);
  }
}

const ENVATO_DEFAULTS = {
  category: '', priceSingle: '15', priceMulti: '49',
  people: 'No', buildings: 'No', releases: '',
  isMG: 'No', aj: '', color: '', pace: '', movement: '', composition: '', setting: '',
  numPeople: '', gender: '', age: '', ethnicity: '',
  alpha: 'No', looped: 'No', audio: ''
};
let envatoDefaults = { ...ENVATO_DEFAULTS };
let envatoRows = new Map();
let shutterRows = new Map();
const ADOBE_PROMPT_EXPERT = (tagsCount) => `You are an expert Adobe Stock Metadata Specialist. Your goal is to maximize the commercial visibility and sales potential of stock assets through precise, SEO-optimized metadata.

### CORE GUIDELINES:
1. **Title (The "Hook")**: 
   - Length: 60-80 characters (Optimized for search engines).
   - Style: Factual, descriptive, and natural. Avoid "A photo of..." or "An image of...".
   - Content: Include the main subject, setting, and primary action.

2. **Keywords (The "Engine")**:
   - Quantity: Exactly ${tagsCount} tags.
   - **CRITICAL: Order of Importance**: The first 10 tags MUST be the most descriptive and relevant.
   - Diversity: Include a mix of:
     - *Literal*: What is in the image (subject, objects, colors).
     - *Conceptual*: Themes and emotions (e.g., "innovation", "solitude", "growth").
     - *Technical*: Composition and lighting (e.g., "top view", "bokeh", "copy space").
     - *Demographic*: If people are present (age, ethnicity, gender, number of people).
   - Format: Singular forms preferred. No duplicates. No brand names.

3. **Commercial Appeal**: Focus on what a buyer would type into a search bar to find this specific asset.

### OUTPUT FORMAT:
Return ONLY a JSON object with:
1. "title": A string (60-80 chars).
2. "tags": An array of ${tagsCount} strings, sorted by relevance.

Example:
{
  "title": "Diverse business team collaborating on digital strategy in sunlit modern office",
  "tags": ["business", "teamwork", "office", "collaboration", "diversity", "strategy", "meeting"]
}`;

const ADOBE_PROMPT_NANO = (tagsCount) => `You are a professional stock content metadata editor for Adobe Stock. Your job is to attribute images and videos with high-quality metadata that follows Adobe Stock guidelines.

Key requirements:
- Title: Clear, descriptive, between 80-100 characters. Use natural language, avoid ALL CAPS or hashtags.
- Tags: Generate exactly ${tagsCount} relevant, search-friendly tags. Use singular forms where natural, avoid duplicates.
- Focus on commercial appeal and searchability
- Avoid brand names, trademarks, or copyrighted content
- Use English language only

CRITICAL: You MUST return a JSON object with exactly these two fields:
1. "title" - the title string (80-100 characters)
2. "tags" - an array of exactly ${tagsCount} tag strings

IMPORTANT: Always generate exactly ${tagsCount} tags. Title must be between 80-100 characters.

Example response:
{"title": "Professional business team collaborating in modern office environment during strategic planning meeting", "tags": ["business", "meeting", "office", "professional", "corporate", "teamwork"]}
Return ONLY the JSON object.`;

const ADOBE_CONFIG = {
  get titleMax() { return $('#model').value === 'gpt-5.4-nano' ? 100 : 80; },
  get tagsMax() { return Math.max(10, Math.min(49, parseInt($('#tagsCount')?.value || 20, 10) || 20)); },
  prompt(tagsCount) { return $('#model').value === 'gpt-5.4-nano' ? ADOBE_PROMPT_NANO(tagsCount) : ADOBE_PROMPT_EXPERT(tagsCount); }
};

const ENVATO_CATEGORIES_FOOTAGE = [
  'Buildings', 'Business, Corporate', 'Cartoons', 'City', 'Construction', 'Education', 'Food', 'Holidays', 'Industrial', 'Kids', 'Lifestyle', 'Medical', 'Military', 'Nature', 'Overhead', 'People', 'Religious', 'Science', 'Slow Motion', 'Special Events', 'Sports', 'Stop Motion', 'Technology', 'Time Lapse', 'Vehicles', 'Weather'
];

const ENVATO_CATEGORIES_MG = [
  'backgrounds', 'backgrounds/3d-object', 'backgrounds/abstract', 'backgrounds/cartoons', 'backgrounds/corporate', 'backgrounds/electric', 'backgrounds/events', 'backgrounds/fire', 'backgrounds/grunge', 'backgrounds/industrial', 'backgrounds/kids', 'backgrounds/light', 'backgrounds/medical', 'backgrounds/nature', 'backgrounds/retro', 'backgrounds/sky-clouds', 'backgrounds/space', 'backgrounds/sports', 'backgrounds/technology', 'backgrounds/water', 'backgrounds/miscellaneous', 'bugs', 'bugs/3d-object', 'bugs/abstract', 'bugs/cartoons', 'bugs/corporate', 'bugs/electric', 'bugs/events', 'bugs/fire', 'bugs/grunge', 'bugs/industrial', 'bugs/kids', 'bugs/light', 'bugs/medical', 'bugs/nature', 'bugs/retro', 'bugs/sky-clouds', 'bugs/space', 'bugs/sports', 'bugs/technology', 'bugs/water', 'bugs/miscellaneous', 'distortions', 'elements', 'elements/3d-object', 'elements/abstract', 'elements/cartoons', 'elements/corporate', 'elements/electric', 'elements/events', 'elements/fire', 'elements/grunge', 'elements/industrial', 'elements/kids', 'elements/light', 'elements/medical', 'elements/nature', 'elements/retro', 'elements/sky-clouds', 'elements/space', 'elements/sports', 'elements/technology', 'elements/water', 'elements/miscellaneous', 'interface-effects', 'interface-effects/3d-object', 'interface-effects/abstract', 'interface-effects/cartoons', 'interface-effects/corporate', 'interface-effects/electric', 'interface-effects/events', 'interface-effects/fire', 'interface-effects/grunge', 'interface-effects/industrial', 'interface-effects/kids', 'interface-effects/light', 'interface-effects/medical', 'interface-effects/nature', 'interface-effects/retro', 'interface-effects/sky-clouds', 'interface-effects/space', 'interface-effects/sports', 'interface-effects/technology', 'interface-effects/water', 'interface-effects/miscellaneous', 'lower-thirds', 'lower-thirds/3d-object', 'lower-thirds/abstract', 'lower-thirds/cartoons', 'lower-thirds/corporate', 'lower-thirds/electric', 'lower-thirds/events', 'lower-thirds/fire', 'lower-thirds/grunge', 'lower-thirds/industrial', 'lower-thirds/kids', 'lower-thirds/light', 'lower-thirds/medical', 'lower-thirds/nature', 'lower-thirds/retro', 'lower-thirds/sky-clouds', 'lower-thirds/space', 'lower-thirds/sports', 'lower-thirds/technology', 'lower-thirds/water', 'lower-thirds/miscellaneous', 'overlays', 'overlays/3d-object', 'overlays/abstract', 'overlays/cartoons', 'overlays/corporate', 'overlays/electric', 'overlays/events', 'overlays/fire', 'overlays/grunge', 'overlays/industrial', 'overlays/kids', 'overlays/light', 'overlays/medical', 'overlays/nature', 'overlays/retro', 'overlays/sky-clouds', 'overlays/space', 'overlays/sports', 'overlays/technology', 'overlays/water', 'overlays/miscellaneous', 'particles', 'revealer', 'revealer/3d-object', 'revealer/abstract', 'revealer/cartoons', 'revealer/corporate', 'revealer/electric', 'revealer/events', 'revealer/fire', 'revealer/grunge', 'revealer/industrial', 'revealer/kids', 'revealer/light', 'revealer/medical', 'revealer/nature', 'revealer/retro', 'revealer/sky-clouds', 'revealer/space', 'revealer/sports', 'revealer/technology', 'revealer/water', 'revealer/miscellaneous', 'transitions', 'transitions/3d-object', 'transitions/abstract', 'transitions/cartoons', 'transitions/corporate', 'transitions/electric', 'transitions/events', 'transitions/fire', 'transitions/grunge', 'transitions/industrial', 'transitions/kids', 'transitions/light', 'transitions/medical', 'transitions/nature', 'transitions/retro', 'transitions/sky-clouds', 'transitions/space', 'transitions/sports', 'transitions/technology', 'transitions/water', 'transitions/miscellaneous', 'water-and-fluid', 'miscellaneous', 'miscellaneous/3d-object', 'miscellaneous/abstract', 'miscellaneous/cartoons', 'miscellaneous/corporate', 'miscellaneous/electric', 'miscellaneous/events', 'miscellaneous/fire', 'miscellaneous/grunge', 'miscellaneous/industrial', 'miscellaneous/kids', 'miscellaneous/light', 'miscellaneous/medical', 'miscellaneous/nature', 'miscellaneous/retro', 'miscellaneous/sky-clouds', 'miscellaneous/space', 'miscellaneous/sports', 'miscellaneous/technology', 'miscellaneous/water', 'miscellaneous/miscellaneous', 'infographics'
];

const ENVATO_CONFIG = {
  prompt: ({ title, tags, isMG }) => {
    const categories = isMG ? ENVATO_CATEGORIES_MG : ENVATO_CATEGORIES_FOOTAGE;
    const catStr = categories.join(' | ');
    return `
You are a metadata editor for Envato Elements Stock Video.
Given an approved Adobe Stock title and keywords, prepare Envato-specific fields.

Rules:
- Make a concise Title up to 90 characters (no hashtags, no ALL CAPS, no brand names).
- Make an SEO-optimized Description up to 300 characters. This description must naturally weave in the provided keywords to improve searchability while remaining readable and compelling.
- Select ONE category that best fits the visual asset from the following list: ${catStr}
- Keep the language EN only.

CRITICAL: Return a JSON object with exactly these fields:
1. "title90" - the title string (up to 90 characters)
2. "description300" - the SEO description string (up to 300 characters)
3. "category" - the chosen category string from the provided list

IMPORTANT: The input TITLE comes from Adobe Stock; rewrite it to fit Envato's 90-char limit, and create a rich SEO description based on the title and keywords. Also, you must accurately categorize the asset observing the provided frame.

Example response:
{"title90": "Professional business team collaborating in modern office", "description300": "Professional business team collaborating in a modern office. Highly relevant for corporate teamwork, strategic planning, business development, diversity in workplace, executive meetings, and successful professional partnerships.", "category": "Business, Corporate"}

Input:
TITLE: ${title}
KEYWORDS: ${Array.isArray(tags) ? tags.join(', ') : String(tags)}

Return ONLY the JSON object.`;
  }
};

const SHUTTER_VIDEO_CATEGORIES = Object.freeze([
  'Animals/Wildlife', 'Arts', 'Backgrounds/Textures', 'Buildings/Landmarks', 'Business/Finance',
  'Education', 'Food and drink', 'Healthcare/Medical', 'Holidays', 'Industrial', 'Nature', 'Objects',
  'People', 'Religion', 'Science', 'Signs/Symbols', 'Sports/Recreation', 'Technology', 'Transportation'
]);
const SHUTTER_IMAGE_CATEGORIES = Object.freeze([
  'Abstract', 'Animals/Wildlife', 'Arts', 'Backgrounds/Textures', 'Beauty/Fashion', 'Buildings/Landmarks',
  'Business/Finance', 'Celebrities', 'Education', 'Food and drink', 'Healthcare/Medical', 'Holidays',
  'Industrial', 'Interiors', 'Miscellaneous', 'Nature', 'Objects', 'Parks/Outdoor', 'People', 'Religion',
  'Science', 'Signs/Symbols', 'Sports/Recreation', 'Technology', 'Transportation', 'Vintage'
]);
function extOf(name) { return String(name).toLowerCase().split('.').pop(); }
const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'mpeg', 'mpg', 'wmv', 'mts', 'm2ts', '3gp', '3g2', 'hevc'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tif', 'tiff', 'heic', 'bmp'];
function isVideoFilename(name) { return VIDEO_EXT.includes(extOf(name)); }
function pickShutterListByName(filename) { return isVideoFilename(filename) ? SHUTTER_VIDEO_CATEGORIES : SHUTTER_IMAGE_CATEGORIES; }

/************** Column widths **************/
const WIDTH_KEYS = { title: '--col-title', description: '--col-description', tags: '--col-tags' };
function setColWidth(name, px) {
  document.documentElement.style.setProperty(WIDTH_KEYS[name], px + 'px');
  document.querySelector(`.resizer[data-col="${name}"]`)?.setAttribute('aria-valuenow', String(px));
  try { localStorage.setItem('stock_col_' + name, String(px)); } catch { }
}
function getColWidth(name) { const v = getComputedStyle(document.documentElement).getPropertyValue(WIDTH_KEYS[name]).trim(); return Number(v.replace('px', '')) || 0; }
(function initWidths() {
  for (const k of Object.keys(WIDTH_KEYS)) {
    let value = 0;
    try { value = Number(localStorage.getItem('stock_col_' + k)); } catch { }
    setColWidth(k, value || getColWidth(k) || 300);
  }
})();
let drag = null;
function onPointerDown(e) { const handle = e.target.closest('.resizer'); if (!handle) return; e.preventDefault(); const name = handle.dataset.col; const th = handle.parentElement; const startW = getColWidth(name) || th.getBoundingClientRect().width; drag = { name, startX: e.clientX, startW, th }; th.classList.add('resizing'); document.body.style.cursor = 'col-resize'; window.addEventListener('pointermove', onPointerMove); window.addEventListener('pointerup', onPointerUp, { once: true }); }
function onPointerMove(e) { if (!drag) return; e.preventDefault(); const dx = e.clientX - drag.startX; const min = 200, max = 2400; const w = Math.max(min, Math.min(max, Math.round(drag.startW + dx))); setColWidth(drag.name, w); }
function onPointerUp() { if (!drag) return; drag.th.classList.remove('resizing'); drag = null; document.body.style.cursor = ''; window.removeEventListener('pointermove', onPointerMove); }
window.addEventListener('pointerdown', onPointerDown);
window.addEventListener('keydown', event => {
  const handle = event.target.closest?.('.resizer');
  if (!handle || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const name = handle.dataset.col;
  const direction = event.key === 'ArrowRight' ? 1 : -1;
  const step = event.shiftKey ? 50 : 20;
  const width = Math.max(200, Math.min(2400, (getColWidth(name) || 300) + direction * step));
  setColWidth(name, width);
  handle.setAttribute('aria-valuenow', String(width));
});

/************** CSV helpers & persistence **************/
function csvEscape(s, delimiter = ',') {
  s = String(s ?? '');
  if (s.includes(delimiter) || /["\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function updateCsvRow(name, title, description, tagsArr, category) {
  const seen = new Set();
  const tags = (tagsArr || []).map(x => String(x).trim()).filter(tag => {
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 49);
  csvStore.set(name, { name, title, description, tags, category });
}

/************** API key persistence **************/
function restoreApiKeyFromSession() {
  try {
    const legacyKey = localStorage.getItem('meta_access_key');
    const key = sessionStorage.getItem('meta_access_key') || legacyKey;
    localStorage.removeItem('meta_access_key');
    localStorage.removeItem('stock_csv_rows');
    if (key) {
      $('#accessKey').value = key;
      sessionStorage.setItem('meta_access_key', key);
    }
  } catch { }
}
function persistApiKeyToSession() {
  try {
    const key = $('#accessKey').value.trim();
    localStorage.removeItem('meta_access_key');
    if (key) sessionStorage.setItem('meta_access_key', key);
    else sessionStorage.removeItem('meta_access_key');
  } catch { }
}

/************** Tags helpers **************/
function clip(s, n) { s = (s || '').trim(); return s.length <= n ? s : s.slice(0, n).trim(); }
function parseAlwaysTags() { const raw = $('#alwaysTags')?.value || ''; return raw.split(/[\,\n;|]+/g).map(s => s.trim()).filter(Boolean); }
function normalizeTags(modelTags, always, maxN, placement = 'start') {
  let arr = Array.isArray(modelTags) ? modelTags.slice() : (typeof modelTags === 'string' ? modelTags.split(/[;,|]/g) : []);
  arr = arr.map(s => String(s).trim()).filter(Boolean);
  always = always.map(s => String(s).trim()).filter(Boolean);
  const seen = new Set(), uniqA = [], rest = [];
  for (const t of always) { const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); uniqA.push(t); } }
  for (const t of arr) { const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); rest.push(t); } }
  const limit = Math.max(0, Number(maxN) || 0);
  const required = uniqA.slice(0, limit);
  const generated = rest.slice(0, Math.max(0, limit - required.length));

  if (placement === 'end') return generated.concat(required);
  if (placement === 'random') {
    const distributed = generated.slice();
    for (const tag of required) {
      distributed.splice(Math.floor(Math.random() * (distributed.length + 1)), 0, tag);
    }
    return distributed;
  }
  return required.concat(generated);
}
const alwaysTagsPlacementHints = {
  start: 'Keep these tags first in every generated list.',
  end: 'Place these tags after the generated tags in every list.',
  random: 'Place these tags at random positions among the generated tags in each list.'
};
function updateAlwaysTagsPlacementHint() {
  const select = document.getElementById('alwaysTagsPosition');
  const hint = document.getElementById('alwaysTagsPositionHelp');
  if (select && hint) hint.textContent = alwaysTagsPlacementHints[select.value] || alwaysTagsPlacementHints.start;
}
function createRunConfig() {
  const model = $('#model').value;
  const tagsCount = ADOBE_CONFIG.tagsMax;
  const storedPrompt = localStorage.getItem(`meta_system_prompt_${model}`) || '';
  const promptEditorOpen = document.getElementById('settingsCard')?.classList.contains('flipped');
  const editorPrompt = document.getElementById('systemPromptInp')?.value.trim() || '';
  const savedPrompt = promptEditorOpen ? editorPrompt : storedPrompt;
  return Object.freeze({
    accessKey: $('#accessKey').value.trim(),
    model,
    tagsCount,
    titleMax: model === 'gpt-5.4-nano' ? 100 : 80,
    savedPrompt,
    comments: ($('#comments')?.value || '').trim(),
    alwaysTags: Object.freeze(parseAlwaysTags()),
    alwaysTagsPlacement: $('#alwaysTagsPosition')?.value || 'start',
    useMetadata: Boolean($('#useMetadata')?.checked),
    outputEnvato: Boolean($('#outEnvato')?.checked),
    outputShutter: Boolean($('#outShutter')?.checked),
    serviceTier: 'flex',
    envatoDefaults: Object.freeze({ ...envatoDefaults })
  });
}

function buildPrompt(metadata, config = createRunConfig()) {
  const { model, tagsCount, savedPrompt, comments, alwaysTags } = config;
  let prompt = savedPrompt || (model === 'gpt-5.4-nano' ? ADOBE_PROMPT_NANO(tagsCount) : ADOBE_PROMPT_EXPERT(tagsCount));

  if (savedPrompt) {
    prompt += `\n\nCRITICAL INSTRUCTION: You MUST generate EXACTLY ${tagsCount} tags.`;
  }

  if (comments) prompt += `\n\nBatch context: ${comments}`;
  if (alwaysTags.length > 0) prompt += `\n\nInclude these requested tags in the tag list: ${alwaysTags.join(', ')}`;

  if (metadata) {
    prompt += `\n\nImage Metadata (use this to guide the title and keywords generation):\n`;
    prompt += `IMPORTANT: The user has provided specific metadata. You MUST use this information. If the metadata contains brand names or specific terms, you MUST include them in the title and tags, IGNORING any general instructions to avoid brands. The metadata is the primary source of truth.\n`;
    if (metadata.title) prompt += `Title: ${metadata.title}\n`;
    if (metadata.description) prompt += `Description: ${metadata.description}\n`;
    if (metadata.keywords && metadata.keywords.length) prompt += `Keywords: ${metadata.keywords.join(', ')}\n`;
  }
  return prompt;
}

/************** Preview builders **************/
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

function isAiFile(file) { return extOf(file.name) === 'ai'; }

async function extractAiPreviewToDataUrl(file, maxEdge) {
  if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js not loaded');
  const arrayBuffer = await file.arrayBuffer();
  let pdf = null;
  let page = null;
  try {
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    pdf = await loadingTask.promise;
    page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1.0 });
    const scale = Math.min(1, maxEdge / Math.max(viewport.width, viewport.height));
    const scaledViewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;

    const renderContext = { canvasContext: ctx, viewport: scaledViewport };
    await page.render(renderContext).promise;
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch (e) {
    throw new Error('Failed to parse .ai file (Make sure "Create PDF Compatible File" was checked): ' + e.message);
  } finally {
    try { page?.cleanup?.(); } catch { }
    try { await pdf?.destroy?.(); } catch { }
  }
}

async function fileToDataUrl(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }
async function downscaleDataUrlToJpeg(dataUrl, maxEdge, q = 0.85) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
  const srcW = (img.naturalWidth || img.width || 1024);
  const srcH = (img.naturalHeight || img.height || 1024);
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const w = Math.round(srcW * scale), h = Math.round(srcH * scale);
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, w, h); return canvas.toDataURL('image/jpeg', q);
}
async function downscaleImageToJpegDataUrl(file, maxEdge) { const dataUrl = await fileToDataUrl(file); return downscaleDataUrlToJpeg(dataUrl, maxEdge, 0.85); }
function createPlaceholderImage(maxEdge) {
  const canvas = document.createElement('canvas'); canvas.width = maxEdge; canvas.height = maxEdge;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, maxEdge, maxEdge);
  grad.addColorStop(0, '#f3f4f6'); grad.addColorStop(1, '#e5e7eb');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, maxEdge, maxEdge);
  ctx.fillStyle = '#9ca3af'; ctx.font = `${maxEdge / 8}px Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('🎞️', maxEdge / 2, maxEdge / 2);
  return canvas.toDataURL('image/jpeg', 0.85);
}
function captureFrameAt(file, frac, maxEdge, q = 0.85) {
  return new Promise((resolve, reject) => {
    const safeType = file.type ? file.type : (extOf(file.name) === 'mov' ? 'video/quicktime' : 'video/mp4');
    const safeFile = !file.type ? new File([file], file.name, { type: safeType }) : file;
    const url = URL.createObjectURL(safeFile);
    const video = document.createElement('video');
    video.preload = 'auto'; video.src = url; video.muted = true; video.playsInline = true;
    let timer, loadTimer, done = false;
    const cleanup = () => { if (done) return; done = true; URL.revokeObjectURL(url); clearTimeout(timer); clearTimeout(loadTimer); video.remove(); };
    const draw = () => {
      try {
        if (!video.videoWidth || !video.videoHeight) throw new Error('Invalid video dimensions');
        const vw = video.videoWidth, vh = video.videoHeight;
        const scale = Math.min(1, maxEdge / Math.max(vw, vh));
        const w = Math.round(vw * scale), h = Math.round(vh * scale);
        const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', q); cleanup(); resolve(dataUrl);
      } catch (e) { cleanup(); reject(e); }
    };
    const seek = () => { try { const dur = isFinite(video.duration) && video.duration > 0 ? video.duration : 1; const t = Math.max(0.05, Math.min(dur - 0.05, dur * frac)); video.currentTime = t; } catch (e) { cleanup(); reject(new Error('Video seek failed')); } };
    loadTimer = setTimeout(() => { cleanup(); reject(new Error('Video metadata load timeout')); }, 10000);
    video.addEventListener('loadedmetadata', () => { clearTimeout(loadTimer); seek(); }, { once: true });
    video.addEventListener('seeked', () => draw(), { once: true });
    video.addEventListener('error', () => { cleanup(); reject(new Error('Video decode error')); }, { once: true });
    timer = setTimeout(() => { try { (video.readyState >= 2) ? draw() : (cleanup(), reject(new Error('Video processing timeout'))); } catch (e) { cleanup(); reject(e); } }, 15000);
  });
}
async function captureMiddleFrameToDataUrl(file, maxEdge) {
  const order = [0.25, 0.5, 0.75];
  let lastErr = null;
  for (let i = 0; i < order.length; i++) {
    try { return await captureFrameAt(file, order[i], maxEdge); }
    catch (e) { lastErr = e; await sleep(100); }
  }
  console.warn('Video decode failed after all attempts:', lastErr);
  throw new Error('VIDEO_DECODE_FAILED');
}
function isVideo(file) { return file.type.startsWith('video/') || VIDEO_EXT.includes(extOf(file.name)); }
function isImage(file) { return file.type.startsWith('image/') || IMAGE_EXT.includes(extOf(file.name)); }
function isSupportedFile(file) { return Boolean(file) && (SUPPORTED.includes(file.type) || isAiFile(file) || isImage(file) || isVideo(file)); }
async function buildThumbDataUrl(file, maxEdge = 480) {
  try {
    if (isAiFile(file)) return await extractAiPreviewToDataUrl(file, maxEdge);
    if (isImage(file)) return await downscaleImageToJpegDataUrl(file, maxEdge);
    if (isVideo(file)) return await captureMiddleFrameToDataUrl(file, maxEdge);
    throw new Error('Unsupported file type');
  } catch (e) {
    console.warn('Preview error:', e);
    throw e;
  }
}

/************** OpenAI call **************/
function isGrokModel(m) { return m.startsWith('grok'); }
function getApiEndpoint(m) { return isGrokModel(m) ? 'https://api.x.ai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions'; }
function modelTemperature(m) {
  if (m.startsWith('gpt-5')) return undefined;
  return 0.2;
}
function getRetryDelay(result, attempt, isRateLimit) {
  const retryAfter = result?.retryAfter;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const headerDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(headerDelay) && headerDelay > 0) return Math.min(headerDelay, 60000);
  }
  return attempt * 1000 + (isRateLimit ? 2000 : 0) + Math.round(Math.random() * 750);
}
async function callOpenAI({ accessKey, model, imageDataUrl, prompt, responseFormat, contents, tagsCount = ADOBE_CONFIG.tagsMax, serviceTier = 'flex' }) {
  const schema = {
    name: 'stock_fields',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' }, minItems: tagsCount, maxItems: tagsCount }
      },
      required: ['title', 'tags'],
      additionalProperties: false
    },
    strict: true
  };
  let body, messages = [];
  messages.push({ role: 'developer', content: prompt });
  if (responseFormat && responseFormat.type === "text") {
    const userContent = contents ? contents : [{ type: 'text', text: "Process this asset." }];
    messages.push({ role: 'user', content: userContent });
    body = { model, messages, response_format: { type: 'text' } };
  } else {
    const userContent = contents ? contents : (imageDataUrl ? [{ type: 'image_url', image_url: { url: imageDataUrl } }] : [{ type: 'text', text: "Process this asset." }]);
    messages.push({ role: 'user', content: userContent });
    body = { model, messages, response_format: { type: 'json_schema', json_schema: schema } };
  }
  const temp = modelTemperature(model);
  if (temp !== undefined) body.temperature = temp;
  if (model.startsWith('gpt-5')) body.reasoning_effort = 'medium';
  if (!isGrokModel(model)) body.service_tier = serviceTier;
  const headers = { 'Authorization': `Bearer ${accessKey}`, 'Content-Type': 'application/json' };
  const fetchOptions = { method: 'POST', headers, body: JSON.stringify(body) };
  for (let attempt = 1; attempt <= 3; attempt++) {
    let result;
    try {
      addLog(`Attempt ${attempt}/3 for API call`, 'info');
      result = await workerFetch(getApiEndpoint(model), fetchOptions);
    } catch (err) {
      addLog(`Attempt ${attempt} failed: ${err.message}`, 'warning');
      if (attempt < 3) { await sleep(2000 * attempt); continue; }
      throw err;
    }
    if (result.error && !result.ok) {
      if (attempt < 3) { await sleep(2000 * attempt); continue; }
      throw new Error(result.error);
    }
    const data = result.data;
    if (result.ok) {
      addTokens(data?.usage, model);
      let txt = data?.choices?.[0]?.message?.content?.trim();
      if (!txt) { if (attempt < 3) { await sleep(3000 * attempt); continue; } throw new Error('Empty content from model'); }
      if (responseFormat && responseFormat.type === "text") { return txt; }
      let parsed;
      try { parsed = JSON.parse(txt); }
      catch (e) {
        const m = txt.match(/\{[\s\S]*\}/);
        if (!m) {
          if (attempt < 3) { await sleep(2000 * attempt); continue; }
          throw e;
        }
        parsed = JSON.parse(m[0]);
      }
      const title = typeof parsed?.title === 'string' ? parsed.title.trim() : '';
      const tags = Array.isArray(parsed?.tags) ? parsed.tags.map(tag => String(tag).trim()).filter(Boolean) : [];
      const uniqueTags = new Set(tags.map(tag => tag.toLowerCase()));
      if (!title || tags.length !== tagsCount || uniqueTags.size !== tagsCount) {
        if (attempt < 3) { await sleep(1500 * attempt); continue; }
        throw new Error(`Model returned invalid metadata; expected exactly ${tagsCount} unique tags.`);
      }
      return { ...parsed, title, tags };
    }
    const isRate = result.status === 429, isServer = result.status >= 500, isAuth = result.status === 401 || result.status === 403;
    if (isAuth) { throw new Error(result.status === 401 ? 'Invalid key. Please check your credentials.' : 'Access forbidden. Please check the API key permissions.'); }
    if (result.status === 404) { throw new Error('Configuration error: the selected model or API endpoint was not found.'); }
    if (attempt < 3 && (isRate || isServer)) { await sleep(getRetryDelay(result, attempt, isRate)); continue; }
    throw new Error(data?.error?.message || `HTTP ${result.status}`);
  }
}

async function fetchEnvatoMeta({ accessKey, model, title, tags, isMG, imageDataUrl, serviceTier }) {
  const prompt = ENVATO_CONFIG.prompt({ title, tags, isMG });
  const contents = [{ type: 'text', text: "Process this asset." }];
  if (imageDataUrl) {
    contents.push({ type: 'image_url', image_url: { url: imageDataUrl } });
  }
  const txt = await callOpenAI({ accessKey, model, imageDataUrl, prompt, responseFormat: { type: 'text' }, contents, serviceTier });
  let parsed;
  try { parsed = JSON.parse((txt.match(/\{[\s\S]*\}/) || [txt])[0]); }
  catch { throw new Error('Envato response was not valid JSON.'); }
  const allowed = isMG ? ENVATO_CATEGORIES_MG : ENVATO_CATEGORIES_FOOTAGE;
  const categoryMap = new Map(allowed.map(category => [category.toLowerCase(), category]));
  const category = categoryMap.get(String(parsed?.category || '').trim().toLowerCase());
  const title90 = String(parsed?.title90 || '').trim().slice(0, 90);
  const description300 = String(parsed?.description300 || '').trim().slice(0, 300);
  if (!title90 || !description300 || !category) throw new Error('Envato response was missing a valid title, description, or category.');
  return { title90, description300, category };
}
async function fetchShutterstockCategories({ accessKey, model, filename, adobeTitle, adobeKeywords, serviceTier }) {
  const allowed = pickShutterListByName(filename);
  const type = isVideoFilename(filename) ? 'Video' : 'Image';
  const prompt = `Choose ONE or TWO ${type} categories for this asset from the list: ${allowed.join(' | ')}.
  Context: TITLE: ${adobeTitle}, KEYWORDS: ${Array.isArray(adobeKeywords) ? adobeKeywords.join(', ') : String(adobeKeywords)}.
  Return ONLY JSON: {"categories": "Category1, Category2"}`;
  const txt = await callOpenAI({ accessKey, model, imageDataUrl: '', prompt, responseFormat: { type: 'text' }, serviceTier });
  let parsed;
  try { parsed = JSON.parse((txt.match(/\{[\s\S]*\}/) || [txt])[0]); }
  catch { throw new Error('Shutterstock response was not valid JSON.'); }
  const allowedMap = new Map(allowed.map(category => [category.toLowerCase(), category]));
  const categories = String(parsed?.categories || '').split(',').map(value => allowedMap.get(value.trim().toLowerCase())).filter(Boolean);
  const unique = Array.from(new Set(categories)).slice(0, 2);
  if (!unique.length) throw new Error('Shutterstock response did not contain a valid category.');
  return { categories: unique.join(', ') };
}

/************** Table UI **************/
function addTableRow(idx, file) {
  const isV = isVideoFilename(file.name);
  const displayName = file.name.length > 25 ? file.name.substring(0, 25) + '...' : file.name;
  const tr = document.createElement('tr'); tr.id = 'row-' + idx;
  tr.innerHTML = `
    <td class="p-3 text-[color:var(--subtle)]">${idx + 1}</td>
    <td class="p-3"><button id="preview-${idx}" type="button" class="preview-button h-16 w-16 rounded-lg overflow-hidden relative" style="background:var(--muted)" disabled><img id="thumb-${idx}" class="h-16 w-16 object-cover hidden cursor-zoom-in" alt="" /></button></td>
    <td class="p-3 cell" id="f-${idx}"></td>
    <td class="p-3 cell col-title" id="t-${idx}">—</td>
  <td class="p-3 cell col-tags" id="g-${idx}">—</td>
  <td class="p-3" id="s-${idx}"><span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border bg-gray-100 text-gray-600 border-gray-200">queued</span></td>
  <td class="p-3 text-center">
    <div class="flex items-center justify-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity">
      <button id="regenerate-${idx}" type="button" class="row-action hover:bg-blue-100 rounded p-1 text-blue-600" title="Regenerate">↻</button>
      <button id="delete-${idx}" type="button" class="row-action hover:bg-red-100 rounded p-1 text-red-600" title="Delete">✕</button>
    </div>
  </td>`;
  document.getElementById('resultsBody').appendChild(tr);
  const fileCell = document.getElementById('f-' + idx);
  if (fileCell) {
    fileCell.appendChild(document.createTextNode(displayName + ' '));
    if (isV) {
      const typeBadge = document.createElement('span');
      typeBadge.className = 'badge';
      typeBadge.textContent = 'video';
      fileCell.appendChild(typeBadge);
    }
  }
  const previewButton = document.getElementById('preview-' + idx);
  const previewImage = document.getElementById('thumb-' + idx);
  if (previewButton && previewImage) {
    previewButton.setAttribute('aria-label', `Preview ${file.name}`);
    previewButton.addEventListener('mouseenter', event => window.showPreviewHover(event, previewImage.src));
    previewButton.addEventListener('mouseleave', window.hidePreviewHover);
    previewButton.addEventListener('mousemove', window.movePreviewHover);
    previewButton.addEventListener('focus', event => window.showPreviewHover(event, previewImage.src));
    previewButton.addEventListener('blur', window.hidePreviewHover);
    previewButton.addEventListener('click', event => window.showPreviewHover(event, previewImage.src));
  }
  const regenerateButton = document.getElementById('regenerate-' + idx);
  const deleteButton = document.getElementById('delete-' + idx);
  if (regenerateButton) {
    regenerateButton.setAttribute('aria-label', `Regenerate ${file.name}`);
    regenerateButton.disabled = state.running || importing;
    regenerateButton.addEventListener('click', () => window.regenerateFile(idx));
  }
  if (deleteButton) {
    deleteButton.setAttribute('aria-label', `Delete ${file.name}`);
    deleteButton.disabled = state.running || importing;
    deleteButton.addEventListener('click', () => window.deleteFile(idx));
  }
}
function setThumb(idx, src) {
  const img = document.getElementById('thumb-' + idx);
  const button = document.getElementById('preview-' + idx);
  if (img) { img.src = src; img.classList.remove('hidden'); }
  if (button) button.disabled = false;
}
function updateTableRow(idx, { title, description, tags, category, status, error }) {
  if (title !== undefined) {
    const el = document.getElementById('t-' + idx);
    if (el) {
      if (title === '—' && !csvStore.has(files[idx]?.name)) {
         el.textContent = '—';
      } else {
         el.innerHTML = '';
         const wrap = document.createElement('div');
         wrap.className = 'relative group h-full min-h-[48px] flex flex-col';
         
         const ta = document.createElement('textarea');
         ta.className = 'w-full h-full min-h-[60px] resize-y bg-transparent outline-none p-0 border-none text-[color:var(--text)] text-[13px] leading-snug';
         ta.value = title;
         ta.setAttribute('aria-label', `Title for ${files[idx]?.name || `file ${idx + 1}`}`);
         ta.onblur = () => window.updateTitle(idx, ta.value);
         
         const btn = document.createElement('button');
         btn.className = 'absolute bottom-1 right-1 opacity-0 group-hover:opacity-80 hover:!opacity-100 transition-opacity bg-[color:var(--card)] border border-[color:var(--border)] rounded px-1.5 py-0.5 text-[10px] text-[color:var(--text)] shadow-sm z-10';
         btn.innerHTML = 'Copy';
         btn.setAttribute('aria-label', `Copy title for ${files[idx]?.name || `file ${idx + 1}`}`);
         btn.onclick = () => window.copyText(btn, idx, 'title');
         
         wrap.appendChild(ta);
         wrap.appendChild(btn);
         el.appendChild(wrap);
      }
    }
  }
  if (tags !== undefined) {
    const el = document.getElementById('g-' + idx);
    if (el) {
      if (Array.isArray(tags)) {
        const isEditing = editingTags.has(idx);
        const wasFocused = isEditing && document.activeElement && document.activeElement.id === 'tag-input-' + idx;
        
        el.innerHTML = '';
        const tagsContainer = document.createElement('div');
        
        if (isEditing) {
            tagsContainer.className = 'flex flex-wrap gap-1 mt-1';
            
            tags.forEach((tag, tagIndex) => {
                const tagEl = document.createElement('span');
                tagEl.className = 'val-tag inline-flex items-center gap-1 bg-[color:var(--muted)] text-[color:var(--text)] text-[12px] px-2.5 py-0.5 rounded-full border border-[color:var(--border)] max-w-full cursor-grab active:cursor-grabbing hover:border-gray-400 transition-colors duration-150';
                
                const tagText = document.createElement('span');
                tagText.className = 'truncate pointer-events-none';
                tagText.textContent = tag;
                
                const rmBtn = document.createElement('button');
                rmBtn.className = 'tag-remove opacity-50 hover:opacity-100 hover:text-red-500 ml-0.5 transition-opacity outline-none cursor-pointer p-0.5 leading-none bg-transparent border-none font-bold shrink-0';
                rmBtn.innerHTML = '&times;';
                rmBtn.setAttribute('aria-label', `Remove tag ${tag}`);
                rmBtn.onclick = () => window.removeTag(idx, tagIndex);

                const moveLeftBtn = document.createElement('button');
                moveLeftBtn.className = 'tag-move opacity-50 hover:opacity-100 p-0.5 leading-none bg-transparent border-none shrink-0';
                moveLeftBtn.type = 'button';
                moveLeftBtn.textContent = '←';
                moveLeftBtn.disabled = tagIndex === 0;
                moveLeftBtn.setAttribute('aria-label', `Move tag ${tag} left`);
                moveLeftBtn.onclick = () => window.moveTag(idx, tagIndex, tagIndex - 1);

                const moveRightBtn = document.createElement('button');
                moveRightBtn.className = 'tag-move opacity-50 hover:opacity-100 p-0.5 leading-none bg-transparent border-none shrink-0';
                moveRightBtn.type = 'button';
                moveRightBtn.textContent = '→';
                moveRightBtn.disabled = tagIndex === tags.length - 1;
                moveRightBtn.setAttribute('aria-label', `Move tag ${tag} right`);
                moveRightBtn.onclick = () => window.moveTag(idx, tagIndex, tagIndex + 1);
                
                tagEl.appendChild(tagText);
                tagEl.appendChild(moveLeftBtn);
                tagEl.appendChild(moveRightBtn);
                tagEl.appendChild(rmBtn);
                tagsContainer.appendChild(tagEl);
            });

            const tagInputWrap = document.createElement('div');
            tagInputWrap.className = 'ignore-sort flex-1 min-w-[70px] flex';
            
            const tagInput = document.createElement('input');
            tagInput.id = 'tag-input-' + idx;
            tagInput.className = 'w-full border border-[color:var(--border)] rounded-full px-2.5 py-0.5 text-[12px] outline-none focus:border-[color:var(--ring)] bg-transparent text-[color:var(--text)]';
            tagInput.placeholder = '+ Add...';
            tagInput.setAttribute('aria-label', `Add tags for ${files[idx]?.name || `file ${idx + 1}`}`);
            tagInput.onkeydown = (e) => {
                if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    const v = tagInput.value.trim();
                    if (v) window.addTag(idx, v);
                }
            };
            
            tagInputWrap.appendChild(tagInput);
            tagsContainer.appendChild(tagInputWrap);
            el.appendChild(tagsContainer);
            
            if (typeof Sortable !== 'undefined') {
                new Sortable(tagsContainer, {
                    animation: 250,
                    filter: '.ignore-sort, button',
                    preventOnFilter: false,
                    draggable: '.val-tag',
                    ghostClass: 'opacity-40',
                    onEnd: function (evt) {
                        if (evt.oldDraggableIndex !== undefined && evt.newDraggableIndex !== undefined && evt.oldDraggableIndex !== evt.newDraggableIndex) {
                            window.moveTag(idx, evt.oldDraggableIndex, evt.newDraggableIndex);
                        }
                    }
                });
            }

            if (wasFocused) {
                setTimeout(() => {
                    const newInput = document.getElementById('tag-input-' + idx);
                    if (newInput) newInput.focus();
                }, 0);
            }
        } else {
            tagsContainer.className = 'text-[13px] leading-snug break-words mb-1';
            tagsContainer.textContent = tags.join(', ');
            el.appendChild(tagsContainer);
        }
        
        const footerBottom = document.createElement('div');
        footerBottom.className = 'flex items-center w-full justify-start gap-1.5 mt-1.5';
        
        const editBtn = document.createElement('button');
        editBtn.className = 'bg-[color:var(--card)] hover:bg-[color:var(--muted)] border border-[color:var(--border)] rounded px-2 py-0.5 text-[10px] text-[color:var(--subtle)] hover:text-[color:var(--text)] transition-colors shadow-sm';
        editBtn.textContent = isEditing ? 'Done' : 'Edit';
        editBtn.setAttribute('aria-label', `${isEditing ? 'Finish editing' : 'Edit'} tags for ${files[idx]?.name || `file ${idx + 1}`}`);
        editBtn.onclick = () => window.toggleEditTags(idx);
        
        const cBtn = document.createElement('button');
        cBtn.className = 'bg-[color:var(--card)] hover:bg-[color:var(--muted)] border border-[color:var(--border)] rounded px-2 py-0.5 text-[10px] text-[color:var(--subtle)] hover:text-[color:var(--text)] transition-colors shadow-sm';
        cBtn.textContent = 'Copy';
        cBtn.setAttribute('aria-label', `Copy tags for ${files[idx]?.name || `file ${idx + 1}`}`);
        cBtn.onclick = () => window.copyText(cBtn, idx, 'tags');
        
        footerBottom.appendChild(editBtn);
        footerBottom.appendChild(cBtn);
        el.appendChild(footerBottom);
      } else {
        el.textContent = tags;
      }
    }
  }
  const sEl = document.getElementById('s-' + idx);
  if (sEl) {
    if (status !== undefined) sEl.dataset.status = status;
    if (tags !== undefined) sEl.dataset.tagCount = Array.isArray(tags) ? tags.length : '';
    if (error !== undefined) sEl.dataset.error = error;

    const curStatus = sEl.dataset.status || '';
    const curTags = sEl.dataset.tagCount || '';
    const curErr = sEl.dataset.error || '';

    if (curErr) {
      sEl.innerHTML = '';
      const errorBadge = document.createElement('span');
      errorBadge.className = 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-100 text-red-700 border border-red-200';
      errorBadge.textContent = curErr;
      sEl.appendChild(errorBadge);
    } else {
      let html = '';
      if (curTags && curStatus === 'done') html += `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border bg-green-100 text-green-800 border-green-200 mr-2">tags: ${curTags}</span>`;
      if (curStatus) {
         let colorClass = 'bg-amber-100 text-amber-800 border-amber-200';
         if (curStatus === 'done') colorClass = 'bg-green-100 text-green-800 border-green-200';
         else if (curStatus === 'error') colorClass = 'bg-red-100 text-red-800 border-red-200';
         else if (curStatus === 'queued') colorClass = 'bg-gray-100 text-gray-700 border-gray-200';
         else if (curStatus === 'processing') colorClass = 'bg-blue-100 text-blue-800 border-blue-200';
         
         html += `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${colorClass}">${curStatus}</span>`;
      }
      sEl.innerHTML = html ? `<div class="flex items-center">${html}</div>` : '';
    }
  }
}
window.copyText = async function(btn, idx, type) {
  const file = files[idx];
  if (!file) return;
  const name = file.name;
  let rowData = csvStore.get(name);
  if (!rowData) return;
  
  let text = '';
  if (type === 'title') {
     const ta = btn.parentElement.querySelector('textarea');
     text = ta ? ta.value : rowData.title;
  } else if (type === 'tags') {
     text = (rowData.tags || []).join(', ');
  }
  
  if (text) {
     const copied = await copyToClipboard(text);
     if (copied) {
        const orig = btn.innerHTML;
        btn.innerHTML = 'Copied!';
        setTimeout(() => { btn.innerHTML = orig; }, 1500);
     } else {
        addLog('Clipboard access was blocked by the browser.', 'warning');
     }
  }
};

window.updateTitle = function(idx, newTitle) {
  const file = files[idx];
  if (!file) return;
  const name = file.name;
  let rowData = csvStore.get(name);
  if (rowData) {
    updateCsvRow(name, newTitle, rowData.description, rowData.tags, rowData.category);
    if (shutterRows.has(name)) {
      const sRow = shutterRows.get(name);
      sRow.description = String(newTitle).slice(0, 200).trim();
      shutterRows.set(name, sRow);
    }
    if (envatoRows.has(name)) {
      const eRow = envatoRows.get(name);
      eRow.title90 = String(newTitle).slice(0, 90).trim();
      envatoRows.set(name, eRow);
    }
  }
};

window.removeTag = function(idx, tagIndex) {
  const file = files[idx];
  if (!file) return;
  const name = file.name;
  let rowData = csvStore.get(name);
  if (rowData && rowData.tags) {
    const newTags = [...rowData.tags];
    newTags.splice(tagIndex, 1);
    updateCsvRow(name, rowData.title, rowData.description, newTags, rowData.category);
    if (shutterRows.has(name)) {
      const sRow = shutterRows.get(name);
      sRow.keywords = [...csvStore.get(name).tags];
      shutterRows.set(name, sRow);
    }
    updateTableRow(idx, { tags: csvStore.get(name).tags });
  }
};

window.addTag = function(idx, tagStr) {
  const file = files[idx];
  if (!file) return;
  const name = file.name;
  let rowData = csvStore.get(name);
  if (rowData && rowData.tags) {
    const rawTags = tagStr.split(',').map(s => s.trim()).filter(Boolean);
    if (rawTags.length > 0) {
      const newTags = [...rowData.tags, ...rawTags];
      updateCsvRow(name, rowData.title, rowData.description, newTags, rowData.category);
      if (shutterRows.has(name)) {
        const sRow = shutterRows.get(name);
        sRow.keywords = [...csvStore.get(name).tags];
        shutterRows.set(name, sRow);
      }
      updateTableRow(idx, { tags: csvStore.get(name).tags });
    }
  }
};

window.moveTag = function(idx, fromIndex, toIndex) {
  const file = files[idx];
  if (!file) return;
  const name = file.name;
  let rowData = csvStore.get(name);
  if (rowData && rowData.tags) {
    const newTags = [...rowData.tags];
    const [moved] = newTags.splice(fromIndex, 1);
    newTags.splice(toIndex, 0, moved);
    updateCsvRow(name, rowData.title, rowData.description, newTags, rowData.category);
    if (shutterRows.has(name)) {
      const sRow = shutterRows.get(name);
      sRow.keywords = [...csvStore.get(name).tags];
      shutterRows.set(name, sRow);
    }
    updateTableRow(idx, { tags: csvStore.get(name).tags });
  }
};

window.showPreviewHover = function(e, src) {
   const tooltip = document.getElementById('imagePreviewTooltip');
   const img = document.getElementById('imagePreviewImg');
   if(!tooltip || !img || !src) return;
   img.src = src;
   tooltip.classList.remove('hidden');
   tooltip.setAttribute('aria-hidden', 'false');
   window.movePreviewHover(e);
};

window.hidePreviewHover = function() {
   const tooltip = document.getElementById('imagePreviewTooltip');
   if(tooltip) {
     tooltip.classList.add('hidden');
     tooltip.setAttribute('aria-hidden', 'true');
   }
};

window.movePreviewHover = function(e) {
   const tooltip = document.getElementById('imagePreviewTooltip');
   if(!tooltip || tooltip.classList.contains('hidden')) return;
   
   const rect = tooltip.getBoundingClientRect();
   const viewportW = window.innerWidth;
   const viewportH = window.innerHeight;
   const anchorRect = e?.currentTarget?.getBoundingClientRect?.();
   const pointerX = Number.isFinite(e?.clientX) && e.clientX > 0 ? e.clientX : (anchorRect?.right || 16);
   const pointerY = Number.isFinite(e?.clientY) && e.clientY > 0 ? e.clientY : (anchorRect?.top || 16);
   let x = pointerX + 16;
   let y = pointerY + 16;

   if(x + rect.width > viewportW - 16) x = pointerX - rect.width - 16;
   if(y + rect.height > viewportH - 16) y = pointerY - rect.height - 16;
   x = Math.max(16, Math.min(x, viewportW - rect.width - 16));
   y = Math.max(16, Math.min(y, viewportH - rect.height - 16));
   
   tooltip.style.left = x + 'px';
   tooltip.style.top = y + 'px';
};

window.toggleEditTags = function(idx) {
    if (editingTags.has(idx)) {
        editingTags.delete(idx);
    } else {
        editingTags.add(idx);
    }
    const file = files[idx];
    if (file && csvStore.has(file.name)) {
        updateTableRow(idx, { tags: csvStore.get(file.name).tags });
    }
};

window.deleteFile = function (idx) {
  if (state.running || importing) return alert('Wait for the current operation to finish');
  if (fileStatuses[idx] === 'processing' || processingFiles.has(idx)) return alert('Cannot delete while processing');
  editingTags.delete(idx);
  const file = files[idx]; if (!file) return;
  const tr = document.getElementById('row-' + idx); if (tr) tr.remove();
  const name = file.name;
  csvStore.delete(name); envatoRows.delete(name); shutterRows.delete(name); thumbCache.delete(name); previewFailures.delete(name);
  removeCompletionForStatus(fileStatuses[idx]);
  files[idx] = null; fileStatuses[idx] = 'deleted';
  updateFileCount(); uiUpdate();
};

window.regenerateFile = async function (idx) {
  if (state.running || processingFiles.has(idx) || fileStatuses[idx] === 'processing') return alert('Wait for the current processing to finish');
  if (!$('#accessKey').value.trim()) return alert('Enter your OpenAI API key');
  if (selectedOutputKeys().length === 0) return alert('Select at least one output format');
  editingTags.delete(idx);
  const file = files[idx]; if (!file) return;
  removeCompletionForStatus(fileStatuses[idx]);
  fileStatuses[idx] = 'queued';
  updateTableRow(idx, { status: 'queued', title: '—', tags: '—', error: '' });
  const name = file.name;
  csvStore.delete(name); envatoRows.delete(name); shutterRows.delete(name);
  await runSingleFile(idx);
};

/************** Build CSVs **************/
const ENVATO_HEADERS = [
  'Filename*', 'Title*', 'Description*', 'Keywords*', 'Category*',
  'Price: Single Use License ($USD)*', 'Price: Multi-use License ($USD)*',
  'Recognisable people?*', 'Recognisable buildings?*', 'Releases',
  'Is Motion Graphics?', 'AudioJungle Track (IDs)', 'Color', 'Pace', 'Movement',
  'Composition', 'Setting', 'No. of People', 'Gender', 'Age', 'Ethnicity',
  'Alpha Channel', 'Looped', 'Source Audio'
];
function buildAdobeCsv() {
  const rows = Array.from(csvStore.values());
  const header = ['Filename', 'Title', 'Keywords', 'Category', 'Releases'];
  const lines = [header, ...rows.map(r => [r.name, clip(r.title || '', 200), (r.tags || []).slice(0, 49).join(', '), r.category || '', ''])];
  return lines.map(line => line.map(csvEscape).join(',')).join('\r\n');
}
function buildEnvatoCsv() {
  const rows = Array.from(csvStore.values());
  const lines = [ENVATO_HEADERS];
  for (const r of rows) {
    const env = envatoRows.get(r.name) || {};
    const title90 = (env.title90 || String(r.title || '').slice(0, 90)).trim();
    const desc300 = (env.description300 || env.description200 || String(r.title || '').slice(0, 300)).trim();
    const d = envatoDefaults;
    const category = d.category || env.category || '';
    lines.push([
      r.name, title90, desc300, (r.tags || []).join(', '), category, d.priceSingle || '', d.priceMulti || '',
      d.people || 'No', d.buildings || 'No', d.releases || '', d.isMG || 'No', d.aj || '', d.color || '',
      d.pace || '', d.movement || '', d.composition || '', d.setting || '', d.numPeople || '',
      d.gender || '', d.age || '', d.ethnicity || '', d.alpha || 'No', d.looped || 'No', d.audio || ''
    ].map(csvEscape));
  }
  return lines.map(row => row.join(',')).join('\r\n');
}
function buildShutterstockCsv() {
  const lines = [['Filename', 'Description', 'Keywords', 'Categories']];
  for (const r of csvStore.values()) {
    const entry = shutterRows.get(r.name) || {};
    const allowed = pickShutterListByName(r.name);
    const description = (entry.description ?? r.title ?? '').toString().slice(0, 200).trim();
    const categories = sanitizeShutterCategories(entry.categories, allowed);
    lines.push([r.name, description, (entry.keywords ?? r.tags ?? []).join(', '), categories].map(csvEscape));
  }
  return lines.map(row => row.join(',')).join('\r\n');
}
function sanitizeShutterCategories(raw, allowed) {
  const map = new Map(allowed.map(c => [c.toLowerCase(), c]));
  const items = String(raw || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 2);
  const out = [];
  for (const it of items) { const canon = map.get(it.toLowerCase()); if (canon && !out.includes(canon)) out.push(canon); }
  return (out.length ? out : [allowed[0]]).join(', ');
}
function buildFreepikCsv() {
  const lines = [['filename', 'title', 'keywords']];
  for (const r of csvStore.values()) {
    const title = clip(r.title || '', 200);
    const keywords = (r.tags || []).slice(0, 49).join(',');
    lines.push([r.name, title, keywords]);
  }
  return lines.map(row => row.map(value => csvEscape(value, ';')).join(';')).join('\r\n');
}

/************** Processing pipeline **************/
const PRICING = {
  'gpt-5.4-mini': { in: 0.375 / 1000000, cachedIn: 0.0375 / 1000000, out: 2.25 / 1000000 },
  'gpt-5.4-nano': { in: 0.10 / 1000000, cachedIn: 0.010 / 1000000, out: 0.625 / 1000000 }
};
const state = { running: false, paused: false, stopRequested: false, nextIdx: 0, inFlight: 0, completed: 0, succeeded: 0, failed: 0, phaseTotal: 0, totalTokens: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalCost: 0 };
let activeRunConfig = null;
function addTokens(usage, model) {
  if (!usage) return;
  const pt = usage.prompt_tokens || 0;
  const ct = usage.completion_tokens || 0;
  const cached = usage.prompt_tokens_details?.cached_tokens || 0;
  const normalPt = pt - cached;

  const tt = usage.total_tokens || (pt + ct);
  state.totalTokens = (state.totalTokens || 0) + tt;
  state.promptTokens = (state.promptTokens || 0) + normalPt;
  state.cachedTokens = (state.cachedTokens || 0) + cached;
  state.completionTokens = (state.completionTokens || 0) + ct;
  if (model && PRICING[model]) {
    state.totalCost = (state.totalCost || 0) + (normalPt * PRICING[model].in) + (cached * PRICING[model].cachedIn) + (ct * PRICING[model].out);
  }
  const el = $('#tokenCounter');
  if (el) {
    let costStr = state.totalCost > 0 ? ` ≈ $${state.totalCost.toFixed(4)}` : '';
    let details = `In: ${state.promptTokens.toLocaleString()}`;
    details += `, Cached: ${state.cachedTokens.toLocaleString()}`;
    details += `, Out: ${state.completionTokens.toLocaleString()}`;
    el.innerHTML = `${state.totalTokens.toLocaleString()} tokens <span class="opacity-70">(${details})</span>${costStr}`;
    el.classList.remove('hidden');
  }
}
function isFatalApiError(message) {
  return /invalid key|access forbidden|configuration error/i.test(String(message || ''));
}
async function processOne(idx, config = activeRunConfig || createRunConfig()) {
  const file = files[idx];
  if (!file || fileStatuses[idx] === 'deleted' || fileStatuses[idx] === 'done' || processingFiles.has(idx)) return false;
  processingFiles.add(idx);
  fileStatuses[idx] = 'processing';
  let succeeded = false;
  try {
    updateTableRow(idx, { status: 'processing', error: '' });
    const { accessKey, model, tagsCount: tagsMax, titleMax, alwaysTags, alwaysTagsPlacement, outputEnvato, outputShutter, serviceTier } = config;
    const defaults = config.envatoDefaults;
    const metadata = await extractMetadata(file, config.useMetadata);
    const prompt = buildPrompt(metadata, config);
    const knownPreviewFailure = previewFailures.get(file.name);
    if (knownPreviewFailure) throw new Error(knownPreviewFailure);
    let previewUrl = '';
    try {
      previewUrl = await buildThumbDataUrl(file, 1600);
    } catch {
      if (isAiFile(file)) throw new Error('Cannot extract PDF preview from .ai. Was it saved with "Create PDF Compatible File" checked?');
      if (isVideoFilename(file.name)) throw new Error('Skipped: Video thumbnail could not be decoded (codec unsupported).');
      throw new Error('Skipped: Image preview could not be decoded.');
    }

    const raw = await callOpenAI({ accessKey, model, imageDataUrl: previewUrl, prompt, tagsCount: tagsMax, serviceTier });
    const title = clip(raw.title || '', titleMax);
    const tags = normalizeTags(raw.tags || [], alwaysTags, tagsMax, alwaysTagsPlacement);
    if (!title || tags.length !== tagsMax) throw new Error(`Invalid metadata: expected a title and exactly ${tagsMax} unique tags.`);
    updateTableRow(idx, { title, tags, status: 'processing' });
    updateCsvRow(file.name, title, '', tags, null);
    const outputErrors = [];
    let fatalOutputError = false;
    if (outputEnvato) {
      try {
        const isMG = defaults.isMG === 'Yes';
        envatoRows.delete(file.name);
        const env = await fetchEnvatoMeta({ accessKey, model, title, tags, isMG, imageDataUrl: previewUrl, serviceTier });
        envatoRows.set(file.name, { title90: String(env.title90 || title).slice(0, 90).trim(), description300: String(env.description300 || title).slice(0, 300).trim(), category: env.category });
      } catch (e) {
        const message = e?.message || String(e);
        outputErrors.push(`Envato: ${message}`);
        fatalOutputError = isFatalApiError(message);
        addLog(`Envato metadata failed for ${file.name}: ${message}`, 'warning');
      }
    }
    if (outputShutter && !fatalOutputError) {
      try {
        shutterRows.delete(file.name);
        const res = await fetchShutterstockCategories({ accessKey, model, filename: file.name, adobeTitle: title, adobeKeywords: tags, serviceTier });
        const allowed = pickShutterListByName(file.name);
        shutterRows.set(file.name, { description: String(title).slice(0, 200), keywords: Array.isArray(tags) ? tags : [], categories: sanitizeShutterCategories(res?.categories, allowed) });
      } catch (e) {
        const message = e?.message || String(e);
        outputErrors.push(`Shutterstock: ${message}`);
        addLog(`Shutterstock categories failed for ${file.name}: ${message}`, 'warning');
      }
    }
    if (outputErrors.length) throw new Error(`Output generation incomplete — ${outputErrors.join('; ')}`);
    fileStatuses[idx] = 'done';
    updateTableRow(idx, { status: 'done', error: '' });
    state.succeeded++;
    succeeded = true;
  } catch (err) {
    const message = err?.message || String(err);
    fileStatuses[idx] = 'error';
    state.failed++;
    updateTableRow(idx, { status: 'error', error: 'Error: ' + message });
    if (isFatalApiError(message)) {
      state.stopRequested = true;
      addLog('Batch stopped because the API credentials or model configuration were rejected.', 'error');
    }
  } finally {
    processingFiles.delete(idx);
    state.completed++;
    uiUpdate();
  }
  return succeeded;
}

async function runSingleFile(idx) {
  if (!files[idx] || state.running || processingFiles.has(idx)) return;
  state.running = true;
  state.paused = false;
  state.stopRequested = false;
  state.phaseTotal = activeFileCount();
  state.succeeded = countActiveWithStatus('done');
  state.failed = countActiveWithStatus('error');
  state.completed = state.succeeded + state.failed;
  state.inFlight = 1;
  activeRunConfig = createRunConfig();
  const wakeLockPromise = requestWakeLock();
  startKeepAlive();
  uiUpdate();
  try {
    await processOne(idx);
  } finally {
    state.inFlight = 0;
    state.running = false;
    state.paused = false;
    activeRunConfig = null;
    stopKeepAlive();
    await wakeLockPromise;
    releaseWakeLock();
    uiUpdate();
  }
}

async function extractMetadata(file, useMetadata = Boolean($('#useMetadata')?.checked)) {
  if (!file || !file.type.startsWith('image/') || !useMetadata) return null;
  try {
    const data = await exifr.parse(file, { iptc: true, xmp: true, exif: true, tiff: true });
    if (data) {
      const title = data.ObjectName || data['dc:title'] || data.Title || data.ImageDescription || data['dc:description'] || data.Description;
      const description = data.Caption || data['dc:description'] || data.Description || data.ImageDescription;
      let keywords = data.Keywords || data['dc:subject'] || data.Subject;
      if (typeof keywords === 'string') keywords = [keywords];
      return { title, description, keywords: keywords ? Array.from(keywords) : [] };
    }
  } catch (e) { console.warn('Metadata extraction failed', e); }
  return null;
}

async function workerLoop() {
  while (state.running && !state.stopRequested) {
    if (state.paused) { await sleep(50); continue; }
    const idx = state.nextIdx++;
    if (idx >= files.length) break;
    if (!files[idx] || fileStatuses[idx] === 'deleted' || fileStatuses[idx] === 'done' || fileStatuses[idx] === 'processing') continue;
    try { state.inFlight++; uiUpdate(); await processOne(idx); }
    finally { state.inFlight--; uiUpdate(); }
  }
}

async function startProcessing() {
  if (state.running || processingFiles.size > 0) return;
  const total = activeFileCount();
  let pendingCount = activePendingCount();
  if (pendingCount === 0 && total > 0) {
    if (confirm('All files are already processed. Do you want to re-generate metadata for ALL files from scratch?')) {
      for (let i = 0; i < files.length; i++) {
        if (files[i] && (fileStatuses[i] === 'done' || fileStatuses[i] === 'error')) {
          editingTags.delete(i);
          fileStatuses[i] = 'queued';
          updateTableRow(i, { status: 'queued', title: '—', tags: '—', error: '' });
          const name = files[i].name;
          csvStore.delete(name); envatoRows.delete(name); shutterRows.delete(name);
        }
      }
      state.completed = 0; state.succeeded = 0; state.failed = 0;
      pendingCount = total;
      uiUpdate();
    } else {
      return;
    }
  } else if (pendingCount === 0) {
    return;
  }
  const accessKey = $('#accessKey').value.trim();
  if (!accessKey) { alert('Enter your OpenAI API key'); return; }
  if (selectedOutputKeys().length === 0) { alert('Select at least one output format'); return; }
  activeRunConfig = createRunConfig();
  state.running = true; state.paused = false; state.stopRequested = false; state.nextIdx = 0; state.inFlight = 0;
  state.succeeded = countActiveWithStatus('done'); state.failed = 0; state.completed = state.succeeded;
  state.phaseTotal = total;
  const wakeLockPromise = requestWakeLock();
  startKeepAlive(); uiUpdate();
  const workers = [];
  const concurrency = Math.max(1, Math.min(20, Number($('#concurrency').value || 1)));
  for (let w = 0; w < Math.min(concurrency, pendingCount); w++) workers.push(workerLoop());
  try {
    await Promise.all(workers);
  } finally {
    state.running = false; state.paused = false;
    activeRunConfig = null;
    stopKeepAlive();
    await wakeLockPromise;
    releaseWakeLock(); uiUpdate();
  }
}

/************** Logs **************/
function addLog(message, type = 'info') { const t = new Date().toLocaleTimeString(); logs.push({ time: t, message, type }); if (logs.length > 100) logs = logs.slice(-50); updateLogsDisplay(); }
function updateLogsDisplay() {
  const el = document.getElementById('logsContent'); if (!el) return;
  el.innerHTML = '';
  const fragment = document.createDocumentFragment();
  logs.forEach(log => {
    const row = document.createElement('div');
    row.className = `mb-1 ${log.type === 'error' ? 'text-red-700' : log.type === 'warning' ? 'text-yellow-800' : log.type === 'success' ? 'text-green-800' : 'text-gray-800'}`;
    row.textContent = `[${log.time}] [${(log.type || 'info').toUpperCase()}] ${log.message}`;
    fragment.appendChild(row);
  });
  el.appendChild(fragment);
  setTimeout(() => { el.scrollTop = el.scrollHeight; }, 10);
}
function clearLogs() { logs = []; updateLogsDisplay(); }
async function copyToClipboard(content) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content);
      return true;
    }
  } catch { }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = content;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}
function downloadBlob(content, type, filename) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
async function copyLogs() {
  const content = logs.map(l => `[${l.time}] [${(l.type || 'INFO').toUpperCase()}] ${l.message}`).join('\n');
  if (await copyToClipboard(content)) addLog('Logs copied', 'success');
  else addLog('Clipboard access was blocked by the browser.', 'warning');
}
function downloadLogs() {
  const content = logs.map(l => `[${l.time}] [${(l.type || 'INFO').toUpperCase()}] ${l.message}`).join('\n');
  downloadBlob(content, 'text/plain;charset=utf-8', `logs-${new Date().getTime()}.txt`);
}

/************** DnD & wiring **************/
async function handleFiles(list) {
  if (importing || state.running || processingFiles.size > 0) {
    addLog('Wait for processing to finish before importing more files.', 'warning');
    return;
  }
  const candidates = Array.from(list || []);
  const unsupported = candidates.filter(file => !isSupportedFile(file));
  if (unsupported.length) {
    const names = unsupported.slice(0, 3).map(file => file.name).join(', ');
    addLog(`Skipped ${unsupported.length} unsupported file${unsupported.length === 1 ? '' : 's'}: ${names}`, 'warning');
    alert(`Skipped unsupported file${unsupported.length === 1 ? '' : 's'}: ${names}`);
  }
  const knownNames = new Set(files.filter(Boolean).map(file => file.name));
  const arr = candidates.filter(isSupportedFile).filter(file => {
    if (knownNames.has(file.name)) return false;
    knownNames.add(file.name);
    return true;
  });
  if (!arr.length) return;
  importing = true;
  uiUpdate();
  let localKeepAliveStarted = false;
  if (!keepAliveInterval) { startKeepAlive(); localKeepAliveStarted = true; }

  const loader = document.getElementById('loader');
  loader.classList.remove('hidden');
  loader.setAttribute('aria-hidden', 'false');
  document.getElementById('loaderBar1').style.width = '0%';
  document.getElementById('loaderBar2').style.width = '0%';
  document.getElementById('loaderBar1').setAttribute('aria-valuenow', '0');
  document.getElementById('loaderBar2').setAttribute('aria-valuenow', '0');
  const startIdx = files.length;
  try {
    files.push(...arr);
    for (let i = 0; i < arr.length; i++) {
      fileStatuses[startIdx + i] = 'queued'; addTableRow(startIdx + i, arr[i]);
      document.getElementById('loaderText1').textContent = `${i + 1} / ${arr.length}`;
      const addProgress = Math.round(((i + 1) / arr.length) * 100);
      document.getElementById('loaderBar1').style.width = `${addProgress}%`;
      document.getElementById('loaderBar1').setAttribute('aria-valuenow', String(addProgress));
      await tick();
    }
    for (let i = 0; i < arr.length; i++) {
      try {
        const dataUrl = await buildThumbDataUrl(arr[i], 480);
        thumbCache.set(arr[i].name, dataUrl);
        previewFailures.delete(arr[i].name);
        setThumb(startIdx + i, dataUrl);
      } catch (e) {
        const failureMessage = isAiFile(arr[i])
          ? 'Cannot extract PDF preview from .ai. Was it saved with "Create PDF Compatible File" checked?'
          : isVideoFilename(arr[i].name)
            ? 'Skipped: Video thumbnail could not be decoded (codec unsupported).'
            : 'Skipped: Image preview could not be decoded.';
        previewFailures.set(arr[i].name, failureMessage);
        setThumb(startIdx + i, createPlaceholderImage(480));
        addLog(`Preview unavailable for ${arr[i].name}: ${e?.message || e}`, 'warning');
        if (e.message === 'VIDEO_DECODE_FAILED') {
          const isWin = /Win/i.test(navigator.userAgent);
          const msg = isWin
            ? '⚠️ Внимание: Некоторые видео (например ProRes или HEVC) не поддерживаются вашим Windows-браузером. Мы не смогли извлечь кадр, поэтому этот файл будет ПРОПУЩЕН при генерации (чтобы не тратить ваши токены впустую).\n\nРешение: переведите эти файлы в MP4-прокси (h264) или используйте браузер Safari на Mac.'
            : '⚠️ Внимание: Браузер не смог извлечь кадр из видео (возможно неподдерживаемый кодек). Файл будет пропущен.';
          if (!window.codecWarningShown) { window.codecWarningShown = true; setTimeout(() => alert(msg), 150); }
        }
      }
      document.getElementById('loaderText2').textContent = `${i + 1} / ${arr.length}`;
      const previewProgress = Math.round(((i + 1) / arr.length) * 100);
      document.getElementById('loaderBar2').style.width = `${previewProgress}%`;
      document.getElementById('loaderBar2').setAttribute('aria-valuenow', String(previewProgress));
      await tick();
    }
  } finally {
    if (localKeepAliveStarted && !state.running) stopKeepAlive();
    loader.classList.add('hidden');
    loader.setAttribute('aria-hidden', 'true');
    importing = false;
    uiUpdate();
  }
}

const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let activeDialog = null;
let dialogReturnFocus = null;

function setDialogBackgroundInert(inert) {
  [document.querySelector('.topbar'), document.querySelector('main'), document.getElementById('showLogsBtn')]
    .filter(Boolean)
    .forEach(element => { element.inert = inert; });
  document.body.classList.toggle('modal-open', inert);
}

function openDialog(dialog, trigger = document.activeElement) {
  if (!dialog || dialog === activeDialog) return;
  if (activeDialog) closeDialog(activeDialog, false);
  dialogReturnFocus = trigger instanceof HTMLElement ? trigger : null;
  activeDialog = dialog;
  dialog.inert = false;
  dialog.classList.remove('hidden');
  dialog.setAttribute('aria-hidden', 'false');
  setDialogBackgroundInert(true);
  requestAnimationFrame(() => {
    const firstFocusable = dialog.querySelector(focusableSelector);
    (firstFocusable || dialog).focus();
  });
}

function closeDialog(dialog = activeDialog, restoreFocus = true) {
  if (!dialog) return;
  dialog.classList.add('hidden');
  dialog.setAttribute('aria-hidden', 'true');
  dialog.inert = true;
  if (dialog === activeDialog) {
    activeDialog = null;
    setDialogBackgroundInert(false);
    const returnTarget = dialogReturnFocus;
    dialogReturnFocus = null;
    if (restoreFocus && returnTarget?.isConnected) requestAnimationFrame(() => returnTarget.focus());
  }
}

function wireDialog(openId, dialogId, closeIds = []) {
  const dialog = document.getElementById(dialogId);
  const opener = openId ? document.getElementById(openId) : null;
  opener?.addEventListener('click', () => openDialog(dialog, opener));
  closeIds.forEach(id => document.getElementById(id)?.addEventListener('click', () => closeDialog(dialog)));
  dialog?.addEventListener('click', event => { if (event.target === dialog) closeDialog(dialog); });
  return dialog;
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') window.hidePreviewHover();
  if (!activeDialog) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDialog(activeDialog);
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(activeDialog.querySelectorAll(focusableSelector)).filter(element => !element.closest('[inert]'));
  if (!focusable.length) {
    event.preventDefault();
    activeDialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

const drop = document.getElementById('drop');
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => drop.addEventListener(evt, e => e.preventDefault()));
drop.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
drop.addEventListener('click', () => {
  if (state.running || importing) return;
  const total = activeFileCount();
  const isDone = total > 0 && state.failed === 0 && state.succeeded === total && csvStore.size > 0;
  if (isDone) {
    showDownloadModal();
  } else {
    document.getElementById('fileInput').click();
  }
});
drop.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  drop.click();
});
document.getElementById('fileInput').addEventListener('change', async e => {
  await handleFiles(e.target.files);
  e.target.value = '';
});

document.getElementById('startBtn').addEventListener('click', async () => {
  if (!state.running) {
    const accessKey = $('#accessKey').value.trim();
    if (!accessKey) { alert('Enter your OpenAI API key'); return; }
    if (!activeFileCount()) { alert('Add files'); return; }
    await startProcessing();
  } else {
    state.paused = !state.paused; uiUpdate();
  }
});

document.getElementById('downloadAdobeBtn').addEventListener('click', () => showDownloadModal());
const logsDialog = wireDialog('showLogsBtn', 'logsPanel', ['logsClose']);
document.getElementById('showLogsBtn').addEventListener('click', updateLogsDisplay);
const aboutDialog = wireDialog('aboutBtn', 'aboutModal', ['aboutClose']);
const contactDialog = wireDialog('contactBtn', 'contactModal', ['contactClose']);
const guideDialog = wireDialog('guideBtn', 'guideModal', ['guideClose', 'guideCloseAlt']);
const downloadDialog = wireDialog(null, 'downloadModal', ['downloadClose']);
const envatoDialog = wireDialog('envatoSettingsBtn', 'envatoModal', ['envatoClose']);
document.getElementById('debugClose')?.addEventListener('click', () => {
  document.getElementById('debugInfo').style.display = 'none';
});

// Flip Card Logic
document.getElementById('openPromptBtn').addEventListener('click', () => {
  const model = $('#model').value;
  const tagsCount = ADOBE_CONFIG.tagsMax;
  const storageKey = `meta_system_prompt_${model}`;
  const current = localStorage.getItem(storageKey) || ADOBE_CONFIG.prompt(tagsCount);
  document.getElementById('systemPromptInp').value = current;
  const settingsCard = document.getElementById('settingsCard');
  const front = settingsCard.querySelector('.flip-card-front');
  const back = settingsCard.querySelector('.flip-card-back');
  settingsCard.classList.add('flipped');
  front.inert = true;
  front.setAttribute('aria-hidden', 'true');
  back.inert = false;
  back.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => document.getElementById('systemPromptInp').focus());
});
document.getElementById('closePromptBtn').addEventListener('click', () => {
  const settingsCard = document.getElementById('settingsCard');
  const front = settingsCard.querySelector('.flip-card-front');
  const back = settingsCard.querySelector('.flip-card-back');
  settingsCard.classList.remove('flipped');
  back.inert = true;
  back.setAttribute('aria-hidden', 'true');
  front.inert = false;
  front.setAttribute('aria-hidden', 'false');
  const val = document.getElementById('systemPromptInp').value.trim();
  const model = $('#model').value;
  const tagsCount = ADOBE_CONFIG.tagsMax;
  const storageKey = `meta_system_prompt_${model}`;
  if (val && val !== ADOBE_CONFIG.prompt(tagsCount)) {
    localStorage.setItem(storageKey, val);
  } else {
    localStorage.removeItem(storageKey);
  }
  uiUpdate();
  requestAnimationFrame(() => {
    const openButton = document.getElementById('openPromptBtn');
    (openButton.disabled ? document.getElementById('startBtn') : openButton).focus();
  });
});

document.getElementById('accessKey').addEventListener('input', persistApiKeyToSession);
document.getElementById('accessKeyToggle').addEventListener('click', () => {
  const inp = document.getElementById('accessKey');
  inp.type = inp.type === 'password' ? 'text' : 'password';
  const isVisible = inp.type === 'text';
  document.getElementById('accessKeyToggle').setAttribute('aria-pressed', String(isVisible));
  document.getElementById('accessKeyToggle').setAttribute('aria-label', isVisible ? 'Hide OpenAI API key' : 'Show OpenAI API key');
});

document.getElementById('outEnvato').addEventListener('change', () => document.getElementById('envatoSettingsBtn').classList.toggle('hidden', !$('#outEnvato').checked));
document.getElementById('concurrency').addEventListener('change', e => {
  const value = Math.max(1, Math.min(20, Number(e.target.value) || 1));
  e.target.value = String(value);
});
document.getElementById('tagsCount').addEventListener('change', e => {
  const value = Math.max(10, Math.min(49, parseInt(e.target.value, 10) || 20));
  e.target.value = String(value);
});
document.getElementById('alwaysTagsPosition').addEventListener('change', updateAlwaysTagsPlacementHint);

function updateModelHint() {
  const model = $('#model').value;
  const hintEl = $('#modelHint');
  const hintText = model === 'gpt-5.4-nano'
    ? 'Fast and economical for large batches.'
    : model === 'gpt-5.4-mini'
      ? 'Higher-quality descriptions for complex scenes.'
      : isGrokModel(model)
        ? 'Requires a compatible xAI API key.'
        : '';

  if (hintEl) hintEl.textContent = hintText;

  // Update prompt editor if it's currently showing
  const systemPromptInp = document.getElementById('systemPromptInp');
  if (systemPromptInp && document.getElementById('settingsCard').classList.contains('flipped')) {
    const storageKey = `meta_system_prompt_${model}`;
    systemPromptInp.value = localStorage.getItem(storageKey) || ADOBE_CONFIG.prompt(ADOBE_CONFIG.tagsMax);
  }
}

document.getElementById('model').addEventListener('change', updateModelHint);

function selectedOutputKeys() {
  const selected = [];
  if ($('#outAdobe').checked) selected.push('adobe');
  if ($('#outEnvato').checked) selected.push('envato');
  if ($('#outShutter').checked) selected.push('shutterstock');
  if ($('#outFreepik').checked) selected.push('freepik');
  return selected;
}

function outputIsReady(key) {
  const rows = Array.from(csvStore.values());
  if (!rows.length) return false;
  if (key === 'envato') return rows.every(row => envatoRows.has(row.name));
  if (key === 'shutterstock') return rows.every(row => shutterRows.has(row.name));
  return true;
}

function showDownloadModal() {
  if (!csvStore.size) {
    alert('No successfully generated rows are ready to download.');
    return;
  }
  const downloadButtons = document.getElementById('downloadButtons');
  downloadButtons.innerHTML = '';
  const selected = selectedOutputKeys();
  if (!selected.length) {
    alert('Select at least one output format.');
    return;
  }
  const unavailable = selected.filter(key => !outputIsReady(key));
  selected.filter(outputIsReady).forEach(key => {
    const b = document.createElement('button'); b.className = 'btn primary';
    b.textContent = key.charAt(0).toUpperCase() + key.slice(1);
    b.onclick = () => {
      let csv = '';
      if (key === 'adobe') csv = buildAdobeCsv();
      else if (key === 'envato') csv = buildEnvatoCsv();
      else if (key === 'shutterstock') csv = buildShutterstockCsv();
      else if (key === 'freepik') csv = buildFreepikCsv();
      downloadBlob(csv, 'text/csv;charset=utf-8', `${key}_metadata.csv`);
    };
    downloadButtons.appendChild(b);
  });
  const activeCount = activeFileCount();
  if (csvStore.size < activeCount) {
    const partialNotice = document.createElement('p');
    partialNotice.className = 'hint download-warning';
    partialNotice.textContent = `Exports include ${csvStore.size} successful row${csvStore.size === 1 ? '' : 's'} out of ${activeCount} imported files.`;
    downloadButtons.appendChild(partialNotice);
  }
  if (unavailable.length) {
    const warning = document.createElement('p');
    warning.className = 'hint download-warning';
    warning.textContent = `${unavailable.map(key => key.charAt(0).toUpperCase() + key.slice(1)).join(', ')} data is incomplete for one or more files. Regenerate those rows before downloading this format.`;
    downloadButtons.appendChild(warning);
  }
  openDialog(downloadDialog, document.activeElement);
}
document.getElementById('envatoSave').addEventListener('click', () => {
  const requiredPrices = [$('#envPriceSingle'), $('#envPriceMulti')];
  const invalidPrice = requiredPrices.find(input => !input.checkValidity());
  if (invalidPrice) {
    invalidPrice.reportValidity();
    return;
  }
  envatoDefaults = {
    category: $('#envCat').value.trim(), priceSingle: $('#envPriceSingle').value, priceMulti: $('#envPriceMulti').value,
    people: $('#envPeople').value, buildings: $('#envBuildings').value, releases: $('#envReleases').value.trim(),
    isMG: $('#envIsMG').value, aj: $('#envAJ').value.trim(), color: $('#envColor').value.trim(),
    pace: $('#envPace').value.trim(), movement: $('#envMovement').value.trim(), composition: $('#envComposition').value.trim(),
    setting: $('#envSetting').value.trim(), numPeople: $('#envNumPeople').value, gender: $('#envGender').value.trim(),
    age: $('#envAge').value.trim(), ethnicity: $('#envEthnicity').value.trim(), alpha: $('#envAlpha').value,
    looped: $('#envIsLooped').value, audio: $('#envAudio').value.trim()
  };
  closeDialog(envatoDialog);
});

function uiUpdate() {
  const total = activeFileCount();
  const completed = Math.min(state.completed, total);
  const hasProgress = total > 0 && (state.running || completed > 0 || state.stopRequested);
  if (hasProgress) {
    showNyanLoader();
    let progressText;
    let progressDetails = '';
    if (state.running) {
      progressText = state.paused ? 'Paused...' : 'Processing...';
    } else if (state.stopRequested && completed < total) {
      const waiting = total - completed;
      progressText = 'Batch stopped after an API authorization or configuration error';
      progressDetails = `${state.succeeded} ready • ${state.failed} failed • ${waiting} not processed`;
    } else if (completed < total) {
      const waiting = total - completed;
      progressText = `${waiting} file${waiting === 1 ? '' : 's'} ready to process`;
      progressDetails = `${state.succeeded} ready • ${state.failed} failed • ${waiting} waiting`;
    } else if (state.failed > 0) {
      progressText = `Completed with ${state.failed} error${state.failed === 1 ? '' : 's'}`;
      progressDetails = `${state.succeeded} file${state.succeeded === 1 ? '' : 's'} ready • ${state.failed} need attention`;
    } else {
      progressText = 'Download CSV ready!';
      progressDetails = 'You can now download your CSV file';
    }
    updateNyanProgress(Math.round((completed / total) * 100), progressText, progressDetails);
    document.getElementById('brandText').classList.toggle('shimmer', state.running);
  } else {
    hideNyanLoader(); document.getElementById('brandText').classList.remove('shimmer');
  }
  document.getElementById('startBtn').textContent = !state.running ? 'Start' : (state.paused ? 'Resume' : 'Pause');
  document.getElementById('startBtn').disabled = importing;
  const lockedControlIds = ['accessKey', 'model', 'tagsCount', 'comments', 'alwaysTags', 'alwaysTagsPosition', 'useMetadata', 'outAdobe', 'outEnvato', 'outShutter', 'outFreepik', 'openPromptBtn', 'systemPromptInp', 'guideBtn', 'envatoSettingsBtn', 'concurrency'];
  lockedControlIds.forEach(id => {
    const control = document.getElementById(id);
    if (control) control.disabled = state.running || importing;
  });
  document.getElementById('downloadAdobeBtn').disabled = state.running || csvStore.size === 0;
  document.querySelectorAll('.row-action').forEach(button => { button.disabled = state.running || importing; });
  drop.classList.toggle('is-disabled', state.running || importing);
  drop.setAttribute('aria-disabled', String(state.running || importing));
  updateFileCount();
}

function handleLocationHash() {
  if (location.hash === '#about') openDialog(aboutDialog, null);
  else if (location.hash === '#contact') openDialog(contactDialog, null);
}

(function init() {
  initThemeToggle();
  restoreApiKeyFromSession();
  const model = $('#model').value;
  const currentPrompt = localStorage.getItem(`meta_system_prompt_${model}`) || ADOBE_CONFIG.prompt(ADOBE_CONFIG.tagsMax);
  document.getElementById('systemPromptInp').value = currentPrompt;
  const settingsCard = document.getElementById('settingsCard');
  const front = settingsCard.querySelector('.flip-card-front');
  const back = settingsCard.querySelector('.flip-card-back');
  front.inert = false;
  front.setAttribute('aria-hidden', 'false');
  back.inert = true;
  back.setAttribute('aria-hidden', 'true');
  updateModelHint(); updateAlwaysTagsPlacementHint(); uiUpdate(); handleLocationHash();
})();
window.addEventListener('hashchange', handleLocationHash);

/************** Particles **************/
(function particles() {
  const ts = window.tsParticles;
  if (!ts || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  Promise.resolve(ts.load('particles', {
    fullScreen: { enable: false },
    particles: {
      number: { value: 140, density: { enable: true, area: 800 } },
      color: { value: '#000000' },
      opacity: { value: 0.45 },
      size: { value: 2.2, random: true },
      links: { enable: true, distance: 160, opacity: 0.35, color: '#000000' },
      move: { enable: true, speed: 0.6 }
    }
  })).catch(error => console.warn('Particles failed to initialize:', error));
})();

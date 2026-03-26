/************** Utils **************/
const yieldToMain = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(null); });
const tick = () => document.hidden ? yieldToMain() : new Promise(r => requestAnimationFrame(() => r()));
const $ = s => document.querySelector(s);

/************** Web Worker for Background Processing **************/
let apiWorker = null;
let workerCallbacks = new Map();
let workerCallId = 0;

function initApiWorker() {
  const workerCode = `
    self.onmessage = async (e) => {
      const { id, url, options } = e.data;
      try {
        const response = await fetch(url, options);
        const data = await response.json().catch(() => null);
        self.postMessage({ id, ok: response.ok, status: response.status, data });
      } catch (err) {
        self.postMessage({ id, ok: false, error: err.message });
      }
    };
  `;
  try {
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    apiWorker = new Worker(URL.createObjectURL(blob));
    apiWorker.onmessage = (e) => {
      const { id, ok, status, data, error } = e.data;
      const cb = workerCallbacks.get(id);
      if (cb) {
        workerCallbacks.delete(id);
        cb({ ok, status, data, error });
      }
    };
    apiWorker.onerror = (err) => {
      console.error('API Worker error:', err);
      addLog('API Worker error: ' + err.message, 'error');
    };
    addLog('API Worker initialized for background processing', 'success');
  } catch (err) {
    console.warn('Web Worker not available, using main thread:', err);
    apiWorker = null;
  }
}

function workerFetch(url, options) {
  return new Promise((resolve, reject) => {
    if (!apiWorker) {
      fetch(url, options)
        .then(async r => {
          const data = await r.json().catch(() => null);
          resolve({ ok: r.ok, status: r.status, data });
        })
        .catch(err => resolve({ ok: false, error: err.message }));
      return;
    }
    const id = ++workerCallId;
    workerCallbacks.set(id, resolve);
    apiWorker.postMessage({ id, url, options: { method: options.method, headers: options.headers, body: options.body } });
    setTimeout(() => {
      if (workerCallbacks.has(id)) {
        workerCallbacks.delete(id);
        resolve({ ok: false, error: 'Worker timeout' });
      }
    }, 120000);
  });
}

/************** Keep-Alive for Background Tabs **************/
let keepAliveInterval = null;
let lastActivityTime = Date.now();
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
    lastActivityTime = Date.now();
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

async function runConcurrent(items, workerFn, { label }) {
  const maxC = Math.max(1, Math.min(20, Number($('#concurrency').value || 1)));
  state.inFlight = 0; state.completed = 0; state.phaseTotal = items.length; uiUpdate();
  let next = 0;
  async function one() {
    while (next < items.length) {
      const idx = next++;
      try {
        state.inFlight++; uiUpdate();
        await workerFn(idx, items[idx]);
      } finally {
        state.inFlight--; state.completed++; uiUpdate();
      }
    }
  }
  const n = Math.min(maxC, items.length || 1);
  await Promise.all(Array.from({ length: n }, one));
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

    if (nyanPercent) nyanPercent.textContent = `${progress}%`;
    if (nyanProcessText && text) nyanProcessText.textContent = text;
    if (nyanProcessDetails) {
      const totalFiles = state.phaseTotal || files.length;
      nyanProcessDetails.textContent = `${state.completed}/${totalFiles} • in-flight: ${state.inFlight}`;
    }
    if (nyanProgressFill) {
      nyanProgressFill.style.width = `${progress}%`;
      if (progress <= 0 || progress >= 100) nyanProgressFill.style.borderRadius = '16px';
      else nyanProgressFill.style.borderRadius = '16px 0 0 16px';
    }
    if (nyanProgressBar) nyanProgressBar.style.pointerEvents = 'none';
    if (progress >= 100) {
      if (nyanRing) nyanRing.style.display = 'none';
      nyanCompletionCheck?.classList.add('hidden');
      if (nyanProcessText) nyanProcessText.textContent = 'Download CSV ready!';
      if (nyanProcessDetails) nyanProcessDetails.textContent = 'You can now download your CSV file';
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
    const count = files.length;
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
let importing = false;
const thumbCache = new Map();

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
  get tagsMax() { return parseInt($('#tagsCount')?.value || 20, 10); },
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
function setColWidth(name, px) { document.documentElement.style.setProperty(WIDTH_KEYS[name], px + 'px'); localStorage.setItem('stock_col_' + name, String(px)); }
function getColWidth(name) { const v = getComputedStyle(document.documentElement).getPropertyValue(WIDTH_KEYS[name]).trim(); return Number(v.replace('px', '')) || 0; }
(function initWidths() { for (const k of Object.keys(WIDTH_KEYS)) { const v = Number(localStorage.getItem('stock_col_' + k)); if (v) setColWidth(k, v); } })();
let drag = null;
function onPointerDown(e) { const handle = e.target.closest('.resizer'); if (!handle) return; e.preventDefault(); const name = handle.dataset.col; const th = handle.parentElement; const startW = getColWidth(name) || th.getBoundingClientRect().width; drag = { name, startX: e.clientX, startW, th }; th.classList.add('resizing'); document.body.style.cursor = 'col-resize'; window.addEventListener('pointermove', onPointerMove); window.addEventListener('pointerup', onPointerUp, { once: true }); }
function onPointerMove(e) { if (!drag) return; e.preventDefault(); const dx = e.clientX - drag.startX; const min = 200, max = 2400; const w = Math.max(min, Math.min(max, Math.round(drag.startW + dx))); setColWidth(drag.name, w); }
function onPointerUp() { if (!drag) return; drag.th.classList.remove('resizing'); drag = null; document.body.style.cursor = ''; window.removeEventListener('pointermove', onPointerMove); }
window.addEventListener('pointerdown', onPointerDown);

/************** CSV helpers & persistence **************/
function csvEscape(s) { s = String(s ?? ''); if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'; return s; }
function updateCsvRow(name, title, description, tagsArr, category) {
  const tags = Array.from(new Set((tagsArr || []).map(x => String(x).trim()).filter(Boolean)));
  csvStore.set(name, { name, title, description, tags, category });
  persistCsvToLocalStorage();
}
function restoreCsvFromLocalStorage() { try { const raw = localStorage.getItem('stock_csv_rows'); if (!raw) return; const arr = JSON.parse(raw); csvStore = new Map(arr.map(r => [r.name, r])); } catch { } }
function persistCsvToLocalStorage() { try { const arr = Array.from(csvStore.values()); localStorage.setItem('stock_csv_rows', JSON.stringify(arr)); } catch { } }

/************** Access Key persistence **************/
function restoreApiKeyFromLocalStorage() { try { const key = localStorage.getItem('meta_access_key'); if (key) $('#accessKey').value = key; } catch { } }
function persistApiKeyToLocalStorage() { try { const key = $('#accessKey').value.trim(); if (key) localStorage.setItem('meta_access_key', key); else localStorage.removeItem('meta_access_key'); } catch { } }

/************** Tags helpers **************/
function clip(s, n) { s = (s || '').trim(); return s.length <= n ? s : s.slice(0, n).trim(); }
function parseAlwaysTags() { const raw = $('#alwaysTags')?.value || ''; return raw.split(/[\,\n;|]+/g).map(s => s.trim()).filter(Boolean); }
function normalizeTags(modelTags, always, maxN) {
  let arr = Array.isArray(modelTags) ? modelTags.slice() : (typeof modelTags === 'string' ? modelTags.split(/[;,|]/g) : []);
  arr = arr.map(s => String(s).trim()).filter(Boolean);
  always = always.map(s => String(s).trim()).filter(Boolean);
  const seen = new Set(), uniqA = [], rest = [];
  for (const t of always) { const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); uniqA.push(t); } }
  for (const t of arr) { const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); rest.push(t); } }
  return uniqA.concat(rest).slice(0, maxN);
}
function buildPrompt(metadata) {
  const model = $('#model').value;
  const tagsCount = ADOBE_CONFIG.tagsMax;
  const storageKey = `meta_system_prompt_${model}`;
  let savedPrompt = localStorage.getItem(storageKey);
  let prompt = savedPrompt ? savedPrompt : ADOBE_CONFIG.prompt(tagsCount);

  if (savedPrompt) {
    prompt += `\n\nCRITICAL INSTRUCTION: You MUST generate EXACTLY ${tagsCount} tags.`;
  }

  const comments = ($('#comments')?.value || '').trim();
  const always = parseAlwaysTags();
  if (comments) prompt += `\n\nBatch comments: ${comments}`;
  if (always.length > 0) prompt += `\n\nAlways include these tags if relevant: ${always.join(', ')}`;

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
  try {
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
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
    video.preload = 'metadata'; video.src = url; video.muted = true; video.playsInline = true;
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
    video.addEventListener('loadedmetadata', () => { clearTimeout(loadTimer); (video.readyState >= 2) ? seek() : video.addEventListener('loadeddata', seek, { once: true }); }, { once: true });
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
async function buildThumbDataUrl(file) {
  const EDGE = 1920;
  try {
    if (isAiFile(file)) return await extractAiPreviewToDataUrl(file, EDGE);
    if (isImage(file)) return await downscaleImageToJpegDataUrl(file, EDGE);
    if (isVideo(file)) return await captureMiddleFrameToDataUrl(file, EDGE);
    throw new Error('Unsupported file type');
  } catch (e) {
    if (isAiFile(file) || e.message === 'VIDEO_DECODE_FAILED') throw e; // Fail hard
    console.warn('Preview error:', e);
    return createPlaceholderImage(EDGE);
  }
}

/************** OpenAI call **************/
function isGrokModel(m) { return m.startsWith('grok'); }
function getApiEndpoint(m) { return isGrokModel(m) ? 'https://api.x.ai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions'; }
function modelTemperature(m) {
  if (m.startsWith('gpt-5')) return undefined;
  return 0.2;
}
async function callOpenAI({ accessKey, model, imageDataUrl, prompt, responseFormat, contents }) {
  const schema = { name: 'stock_fields', schema: { type: 'object', properties: { title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['title', 'tags'], additionalProperties: false }, strict: true };
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
  if (!isGrokModel(model)) { const tierEl = document.getElementById('serviceTier'); const tier = tierEl ? (tierEl.value || 'flex') : 'flex'; body.service_tier = tier; }
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
      try { return JSON.parse(txt); }
      catch (e) { const m = txt.match(/\{[\s\S]*\}/); if (!m) { if (attempt < 3) { await sleep(2000 * attempt); continue; } throw e; } return JSON.parse(m[0]); }
    }
    const isRate = result.status === 429, isServer = result.status >= 500, isAuth = result.status === 401;
    if (isAuth) { throw new Error('Invalid key. Please check your credentials.'); }
    if (attempt < 3 && (isRate || isServer)) { await sleep(attempt * 1000 + (isRate ? 2000 : 0)); continue; }
    throw new Error(data?.error?.message || `HTTP ${result.status}`);
  }
}

async function fetchEnvatoMeta({ accessKey, model, title, tags, isMG, imageDataUrl }) {
  const prompt = ENVATO_CONFIG.prompt({ title, tags, isMG });
  const contents = [{ type: 'text', text: "Process this asset." }];
  if (imageDataUrl) {
    contents.push({ type: 'image_url', image_url: { url: imageDataUrl } });
  }
  const txt = await callOpenAI({ accessKey, model, imageDataUrl, prompt, responseFormat: { type: 'text' }, contents });
  try { const jsonStr = (txt.match(/\{[\s\S]*\}/) || [txt])[0]; return JSON.parse(jsonStr); } catch (e) { return {}; }
}
async function fetchShutterstockCategories({ accessKey, model, filename, adobeTitle, adobeKeywords }) {
  const allowed = pickShutterListByName(filename);
  const type = isVideoFilename(filename) ? 'Video' : 'Image';
  const prompt = `Choose ONE or TWO ${type} categories for this asset from the list: ${allowed.join(' | ')}.
  Context: TITLE: ${adobeTitle}, KEYWORDS: ${Array.isArray(adobeKeywords) ? adobeKeywords.join(', ') : String(adobeKeywords)}.
  Return ONLY JSON: {"categories": "Category1, Category2"}`;
  const txt = await callOpenAI({ accessKey, model, imageDataUrl: '', prompt, responseFormat: { type: 'text' } });
  try { const jsonStr = (txt.match(/\{[\s\S]*\}/) || [txt])[0]; return JSON.parse(jsonStr); } catch (e) { return {}; }
}

/************** Table UI **************/
function addTableRow(idx, file) {
  const isV = isVideoFilename(file.name);
  const tr = document.createElement('tr'); tr.id = 'row-' + idx;
  tr.innerHTML = `
    <td class="p-3 text-[color:var(--subtle)]">${idx + 1}</td>
    <td class="p-3"><div class="h-16 w-16 rounded-lg overflow-hidden relative" style="background:var(--muted)"><img id="thumb-${idx}" class="h-16 w-16 object-cover hidden cursor-zoom-in" alt="" onmouseenter="window.showPreviewHover(event, this.src)" onmouseleave="window.hidePreviewHover()" onmousemove="window.movePreviewHover(event)" /></div></td>
    <td class="p-3 cell">${file.name.length > 25 ? file.name.substring(0, 25) + '...' : file.name} ${isV ? '<span class="badge">video</span>' : ''}</td>
    <td class="p-3 cell col-title" id="t-${idx}">—</td>
  <td class="p-3 cell col-tags" id="g-${idx}">—</td>
  <td class="p-3" id="s-${idx}"><span class="text-amber-600">queued</span></td>
  <td class="p-3 text-center">
    <div class="flex items-center justify-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity">
      <button onclick="window.regenerateFile(${idx})" class="hover:bg-blue-100 rounded p-1 text-blue-600" title="Regenerate">↻</button>
      <button onclick="window.deleteFile(${idx})" class="hover:bg-red-100 rounded p-1 text-red-600" title="Delete">✕</button>
    </div>
  </td>`;
  document.getElementById('resultsBody').appendChild(tr);
}
function setThumb(idx, src) { const img = document.getElementById('thumb-' + idx); if (img) { img.src = src; img.classList.remove('hidden'); } }
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
         ta.onblur = () => window.updateTitle(idx, ta.value);
         
         const btn = document.createElement('button');
         btn.className = 'absolute bottom-1 right-1 opacity-0 group-hover:opacity-80 hover:!opacity-100 transition-opacity bg-[color:var(--card)] border border-[color:var(--border)] rounded px-1.5 py-0.5 text-[10px] text-[color:var(--text)] shadow-sm z-10';
         btn.innerHTML = 'Copy';
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
        const wasFocused = document.activeElement && document.activeElement.id === 'tag-input-' + idx;
        
        el.innerHTML = '';
        const headerTop = document.createElement('div');
        headerTop.className = 'flex items-center mb-1 group w-full justify-end';
        headerTop.innerHTML = `
          <button class="opacity-0 group-hover:opacity-100 transition-opacity bg-[color:var(--card)] border border-[color:var(--border)] rounded px-1.5 py-0.5 text-[10px] text-[color:var(--text)] shadow-sm focus:opacity-100">Copy</button>
        `;
        const cBtn = headerTop.querySelector('button');
        cBtn.onclick = () => window.copyText(cBtn, idx, 'tags');
        el.appendChild(headerTop);
        const tagsContainer = document.createElement('div');
        tagsContainer.className = 'flex flex-wrap gap-1 mt-1';
        
        tags.forEach((tag, tagIndex) => {
            const tagEl = document.createElement('span');
            tagEl.className = 'val-tag inline-flex items-center gap-1 bg-[color:var(--muted)] text-[color:var(--text)] text-[12px] px-2.5 py-0.5 rounded-full border border-[color:var(--border)] max-w-full cursor-grab active:cursor-grabbing hover:border-gray-400 transition-colors duration-150';
            const tagText = document.createElement('span');
            tagText.className = 'truncate pointer-events-none';
            tagText.textContent = tag;
            const rmBtn = document.createElement('button');
            rmBtn.className = 'opacity-50 hover:opacity-100 hover:text-red-500 ml-0.5 transition-opacity outline-none cursor-pointer p-0.5 leading-none bg-transparent border-none font-bold shrink-0';
            rmBtn.innerHTML = '&times;';
            rmBtn.onclick = () => window.removeTag(idx, tagIndex);
            
            tagEl.appendChild(tagText);
            tagEl.appendChild(rmBtn);
            tagsContainer.appendChild(tagEl);
        });

        const tagInputWrap = document.createElement('div');
        tagInputWrap.className = 'ignore-sort flex-1 min-w-[70px] flex';
        
        const tagInput = document.createElement('input');
        tagInput.id = 'tag-input-' + idx;
        tagInput.className = 'w-full border border-[color:var(--border)] rounded-full px-2.5 py-0.5 text-[12px] outline-none focus:border-[color:var(--ring)] bg-transparent text-[color:var(--text)]';
        tagInput.placeholder = '+ Add...';
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
      sEl.innerHTML = `<span class="text-red-600">${curErr}</span>`;
    } else {
      let html = '';
      if (curTags && curStatus === 'done') html += `<span class="badge mr-2">tags: ${curTags}</span>`;
      if (curStatus) html += `<span class="${curStatus === 'done' ? 'text-green-700' : 'text-amber-600'}">${curStatus}</span>`;
      sEl.innerHTML = html ? `<div class="flex items-center">${html}</div>` : '';
    }
  }
}
window.copyText = function(btn, idx, type) {
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
     navigator.clipboard.writeText(text).then(() => {
        const orig = btn.innerHTML;
        btn.innerHTML = 'Copied!';
        setTimeout(() => { btn.innerHTML = orig; }, 1500);
     });
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
      eRow.description300 = String(newTitle).slice(0, 300).trim();
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
   if(!tooltip || !img || !src || src.includes('f3f4f6')) return;
   img.src = src;
   tooltip.classList.remove('hidden');
   window.movePreviewHover(e);
};

window.hidePreviewHover = function() {
   const tooltip = document.getElementById('imagePreviewTooltip');
   if(tooltip) tooltip.classList.add('hidden');
};

window.movePreviewHover = function(e) {
   const tooltip = document.getElementById('imagePreviewTooltip');
   if(!tooltip || tooltip.classList.contains('hidden')) return;
   
   let x = e.clientX + 16;
   let y = e.clientY + 16;
   
   const rect = tooltip.getBoundingClientRect();
   const viewportW = window.innerWidth;
   const viewportH = window.innerHeight;
   
   if(x + rect.width > viewportW - 16) x = e.clientX - rect.width - 16;
   if(y + rect.height > viewportH - 16) y = e.clientY - rect.height - 16;
   
   tooltip.style.left = x + 'px';
   tooltip.style.top = y + 'px';
};

window.deleteFile = function (idx) {
  if (state.running && fileStatuses[idx] === 'processing') return alert('Cannot delete while processing');
  const file = files[idx]; if (!file) return;
  const tr = document.getElementById('row-' + idx); if (tr) tr.remove();
  const name = file.name;
  csvStore.delete(name); envatoRows.delete(name); shutterRows.delete(name); thumbCache.delete(name);
  if (fileStatuses[idx] === 'done' || fileStatuses[idx] === 'error') { if (state.completed > 0) state.completed--; }
  files[idx] = null; fileStatuses[idx] = 'deleted';
  updateFileCount(); uiUpdate();
};

window.regenerateFile = async function (idx) {
  if (state.running && fileStatuses[idx] === 'processing') return alert('Already processing');
  const file = files[idx]; if (!file) return;
  if (fileStatuses[idx] === 'done' || fileStatuses[idx] === 'error') { if (state.completed > 0) state.completed--; }
  fileStatuses[idx] = 'queued';
  updateTableRow(idx, { status: 'queued', title: '—', tags: '—', error: '' });
  const name = file.name;
  csvStore.delete(name); envatoRows.delete(name); shutterRows.delete(name);
  if (!state.running) {
    state.inFlight++; uiUpdate();
    try { await processOne(idx); } finally { state.inFlight--; uiUpdate(); }
  } else {
    if (state.nextIdx > idx) { state.inFlight++; uiUpdate(); processOne(idx).finally(() => { state.inFlight--; uiUpdate(); }); }
  }
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
    const category = env.category || d.category || '';
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
    const title = clip(r.title || '', 200).replace(/;/g, ',');
    const keywords = (r.tags || []).slice(0, 49).join(',').replace(/;/g, '');
    lines.push([r.name, title, keywords]);
  }
  return lines.map(row => row.join(';')).join('\r\n');
}

/************** Processing pipeline **************/
const PRICING = {
  'gpt-5.4-mini': { in: 0.375 / 1000000, cachedIn: 0.0375 / 1000000, out: 2.25 / 1000000 },
  'gpt-5.4-nano': { in: 0.10 / 1000000, cachedIn: 0.010 / 1000000, out: 0.625 / 1000000 }
};
const state = { running: false, paused: false, nextIdx: 0, inFlight: 0, completed: 0, phaseTotal: 0, totalTokens: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalCost: 0 };
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
async function processOne(idx) {
  const file = files[idx];
  if (fileStatuses[idx] === 'done') return;
  fileStatuses[idx] = 'processing';
  try {
    updateTableRow(idx, { status: 'processing...' });
    const accessKey = $('#accessKey').value.trim(); const model = $('#model').value;
    const metadata = await extractMetadata(file);
    const prompt = buildPrompt(metadata);
    let previewUrl = thumbCache.get(file.name) || '';
    if (!previewUrl && isAiFile(file)) throw new Error('Cannot extract PDF preview from .ai. Was it saved with "Create PDF Compatible File" checked?');
    if (!previewUrl && isVideoFilename(file.name)) throw new Error('Skipped: Video thumbnail could not be decoded (codec unsupported).');

    // Instead of sending placeholder, if previewUrl isn't empty but is the placeholder string
    let finalImageUrl = previewUrl.includes('f3f4f6') ? '' : previewUrl;

    const raw = await callOpenAI({ accessKey, model, imageDataUrl: finalImageUrl, prompt });
    const title = clip(raw.title || '', ADOBE_CONFIG.titleMax);
    let tags = normalizeTags(raw.tags || [], parseAlwaysTags(), ADOBE_CONFIG.tagsMax);
    updateTableRow(idx, { title, tags, status: 'done' });
    updateCsvRow(file.name, title, '', tags, null);
    if ($('#outEnvato').checked) {
      try {
        const isMG = envatoDefaults.isMG === 'Yes';
        const env = await fetchEnvatoMeta({ accessKey, model, title, tags, isMG, imageDataUrl: finalImageUrl });
        envatoRows.set(file.name, { title90: String(env.title90 || title).slice(0, 90).trim(), description300: String(env.description300 || title).slice(0, 300).trim(), category: env.category });
      } catch (e) { envatoRows.set(file.name, { title90: String(title).slice(0, 90).trim(), description300: String(title).slice(0, 300).trim(), category: '' }); }
    }
    if ($('#outShutter').checked) {
      try {
        const res = await fetchShutterstockCategories({ accessKey, model, filename: file.name, adobeTitle: title, adobeKeywords: tags });
        const allowed = pickShutterListByName(file.name);
        shutterRows.set(file.name, { description: String(title).slice(0, 200), keywords: Array.isArray(tags) ? tags : [], categories: sanitizeShutterCategories(res?.categories, allowed) });
      } catch (e) { shutterRows.set(file.name, { description: String(title).slice(0, 200), keywords: Array.isArray(tags) ? tags : [], categories: pickShutterListByName(file.name)[0] }); }
    }
    fileStatuses[idx] = 'done';
  } catch (err) { fileStatuses[idx] = 'error'; updateTableRow(idx, { error: 'Error: ' + (err?.message || err) }); }
  finally { state.completed++; uiUpdate(); }
}

async function extractMetadata(file) {
  if (!file || !file.type.startsWith('image/') || !$('#useMetadata')?.checked) return null;
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
  while (state.running) {
    if (state.paused) { await sleep(50); continue; }
    const idx = state.nextIdx++;
    if (idx >= files.length) break;
    try { state.inFlight++; uiUpdate(); await processOne(idx); }
    finally { state.inFlight--; uiUpdate(); }
  }
}

async function startProcessing() {
  const pendingCount = fileStatuses.filter(s => s !== 'done').length;
  if (pendingCount === 0) return;
  const accessKey = $('#accessKey').value.trim();
  if (!accessKey) { alert('Enter Access Token'); return; }
  requestWakeLock(); startKeepAlive();
  state.running = true; state.paused = false; state.nextIdx = 0; state.inFlight = 0; state.completed = fileStatuses.filter(s => s === 'done').length; uiUpdate();
  state.phaseTotal = files.length;
  const workers = [];
  const concurrency = Math.max(1, Math.min(20, Number($('#concurrency').value || 1)));
  for (let w = 0; w < Math.min(concurrency, pendingCount); w++) workers.push(workerLoop());
  await Promise.all(workers);
  state.running = false; state.paused = false; uiUpdate(); stopKeepAlive(); releaseWakeLock();
}

/************** Logs **************/
let logs = [];
function addLog(message, type = 'info') { const t = new Date().toLocaleTimeString(); logs.push({ time: t, message, type }); if (logs.length > 100) logs = logs.slice(-50); updateLogsDisplay(); }
function updateLogsDisplay() {
  const el = document.getElementById('logsContent'); if (!el) return;
  el.innerHTML = logs.map(log => `<div class="mb-1 ${log.type === 'error' ? 'text-red-600' : log.type === 'warning' ? 'text-yellow-600' : log.type === 'success' ? 'text-green-600' : 'text-gray-800'}">[${log.time}] ${log.message}</div>`).join('');
  setTimeout(() => { el.scrollTop = el.scrollHeight; }, 10);
}
function clearLogs() { logs = []; updateLogsDisplay(); }
function copyLogs() {
  const content = logs.map(l => `[${l.time}] [${(l.type || 'INFO').toUpperCase()}] ${l.message}`).join('\n');
  navigator.clipboard.writeText(content).then(() => addLog('Logs copied', 'success'));
}
function downloadLogs() {
  const content = logs.map(l => `[${l.time}] [${(l.type || 'INFO').toUpperCase()}] ${l.message}`).join('\n');
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `logs-${new Date().getTime()}.txt`; a.click();
}

/************** DnD & wiring **************/
async function handleFiles(list) {
  if (importing) return;
  let arr = Array.from(list || []).filter(f => !files.some(existing => existing.name === f.name));
  if (!arr.length) return;
  importing = true;
  let localKeepAliveStarted = false;
  if (!keepAliveInterval) { startKeepAlive(); localKeepAliveStarted = true; }

  document.getElementById('loader').classList.remove('hidden');
  const startIdx = files.length; files.push(...arr);
  for (let i = 0; i < arr.length; i++) {
    fileStatuses[startIdx + i] = 'queued'; addTableRow(startIdx + i, arr[i]);
    document.getElementById('loaderText1').textContent = `${i + 1} / ${arr.length}`;
    document.getElementById('loaderBar1').style.width = `${Math.round(((i + 1) / arr.length) * 100)}%`;
    await tick();
  }
  for (let i = 0; i < arr.length; i++) {
    try {
      const dataUrl = await buildThumbDataUrl(arr[i]); thumbCache.set(arr[i].name, dataUrl); setThumb(startIdx + i, dataUrl);
    } catch (e) {
      setThumb(startIdx + i, createPlaceholderImage(1024));
      if (e.message === 'VIDEO_DECODE_FAILED') {
        const isWin = /Win/i.test(navigator.userAgent);
        const msg = isWin
          ? '⚠️ Внимание: Некоторые видео (например ProRes или HEVC) не поддерживаются вашим Windows-браузером. Мы не смогли извлечь кадр, поэтому этот файл будет ПРОПУЩЕН при генерации (чтобы не тратить ваши токены впустую).\n\nРешение: переведите эти файлы в MP4-прокси (h264) или используйте браузер Safari на Mac.'
          : '⚠️ Внимание: Браузер не смог извлечь кадр из видео (возможно неподдерживаемый кодек). Файл будет пропущен.';
        if (!window.codecWarningShown) { window.codecWarningShown = true; setTimeout(() => alert(msg), 150); }
      }
    }
    document.getElementById('loaderText2').textContent = `${i + 1} / ${arr.length}`;
    document.getElementById('loaderBar2').style.width = `${Math.round(((i + 1) / arr.length) * 100)}%`;
    await tick();
  }
  if (localKeepAliveStarted && !state.running) stopKeepAlive();
  document.getElementById('loader').classList.add('hidden'); importing = false; uiUpdate();
}

const drop = document.getElementById('drop');
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => drop.addEventListener(evt, e => e.preventDefault()));
drop.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
drop.addEventListener('click', () => {
  const isDone = files.length > 0 && !state.running && state.completed === files.length;
  if (isDone) {
    showDownloadModal();
  } else {
    document.getElementById('fileInput').click();
  }
});
document.getElementById('fileInput').addEventListener('change', e => handleFiles(e.target.files));

document.getElementById('startBtn').addEventListener('click', async () => {
  if (!state.running) {
    const accessKey = $('#accessKey').value.trim();
    if (!accessKey) { alert('Enter Access Token'); return; }
    if (!files.length) { alert('Add files'); return; }
    startProcessing();
  } else {
    state.paused = !state.paused; uiUpdate();
  }
});

document.getElementById('downloadAdobeBtn').addEventListener('click', () => showDownloadModal());
document.getElementById('showLogsBtn').addEventListener('click', () => { document.getElementById('logsPanel').classList.remove('hidden'); updateLogsDisplay(); });
document.getElementById('aboutBtn').addEventListener('click', () => document.getElementById('aboutModal').classList.remove('hidden'));
document.getElementById('aboutClose').addEventListener('click', () => document.getElementById('aboutModal').classList.add('hidden'));
document.getElementById('contactBtn').addEventListener('click', () => document.getElementById('contactModal').classList.remove('hidden'));
document.getElementById('contactClose').addEventListener('click', () => document.getElementById('contactModal').classList.add('hidden'));

// Flip Card Logic
document.getElementById('openPromptBtn').addEventListener('click', () => {
  const model = $('#model').value;
  const tagsCount = ADOBE_CONFIG.tagsMax;
  const storageKey = `meta_system_prompt_${model}`;
  const current = localStorage.getItem(storageKey) || ADOBE_CONFIG.prompt(tagsCount);
  document.getElementById('systemPromptInp').value = current;
  document.getElementById('settingsCard').classList.add('flipped');
});
document.getElementById('closePromptBtn').addEventListener('click', () => {
  document.getElementById('settingsCard').classList.remove('flipped');
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
});

// Guide Modal Logic
document.getElementById('guideBtn').addEventListener('click', () => {
  document.getElementById('guideModal').classList.remove('hidden');
});
const closeGuide = () => {
  document.getElementById('guideModal').classList.add('hidden');
};
document.getElementById('guideClose').addEventListener('click', closeGuide);
if (document.getElementById('guideCloseAlt')) {
  document.getElementById('guideCloseAlt').addEventListener('click', closeGuide);
}
document.getElementById('guideModal').addEventListener('click', (e) => {
  if (e.target.id === 'guideModal') closeGuide();
});

document.getElementById('accessKey').addEventListener('input', persistApiKeyToLocalStorage);
document.getElementById('accessKeyToggle').addEventListener('click', () => {
  const inp = document.getElementById('accessKey');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

document.getElementById('outEnvato').addEventListener('change', () => document.getElementById('envatoSettingsBtn').classList.toggle('hidden', !$('#outEnvato').checked));
document.getElementById('concurrency').addEventListener('input', (e) => { document.getElementById('concurrencyValue').textContent = e.target.value; });

function updateModelHint() {
  const model = $('#model').value;
  const hintEl = $('#modelHint');
  const serviceTier = $('#serviceTier');
  const serviceTierLabel = $('#serviceTierLabel');

  let hintText = '';
  let isNano = model === 'gpt-5-nano';
  const isGrok = isGrokModel(model);

  if (model === 'gpt-5') {
    hintText = '<span class="text-red-500 font-bold">⚠️ High cost.</span> Deep reasoning. (~$0.30 per 100 files)';
  } else if (model === 'gpt-5-mini') {
    hintText = '⚖️ Perfect balance of quality and cost.';
  } else if (model === 'gpt-5-nano') {
    hintText = '⚡ Fast and cheapest. (~$0.30 per 5,000 files). Supports Flex mode.';
  } else if (isGrok) {
    hintText = '<span class="text-blue-500 font-bold">🚀 xAI Grok</span> — fast reasoning, 2M context. Excellent choice! Requires xAI API key.';
  }

  if (hintEl) hintEl.innerHTML = hintText;

  if (serviceTier) {
    if (!isNano || isGrok) {
      serviceTier.value = 'default';
      serviceTier.disabled = true;
      serviceTier.style.opacity = '0.5';
      if (serviceTierLabel) serviceTierLabel.style.opacity = '0.5';
    } else {
      serviceTier.disabled = false;
      serviceTier.style.opacity = '1';
      if (serviceTierLabel) serviceTierLabel.style.opacity = '1';
    }
  }

  // Update prompt editor if it's currently showing
  const systemPromptInp = document.getElementById('systemPromptInp');
  if (systemPromptInp && document.getElementById('settingsCard').classList.contains('flipped')) {
    const storageKey = `meta_system_prompt_${model}`;
    systemPromptInp.value = localStorage.getItem(storageKey) || ADOBE_CONFIG.prompt;
  }
}

document.getElementById('model').addEventListener('change', updateModelHint);

function showDownloadModal() {
  const downloadButtons = document.getElementById('downloadButtons');
  downloadButtons.innerHTML = '';
  const selected = [];
  if ($('#outAdobe').checked) selected.push('adobe');
  if ($('#outEnvato').checked) selected.push('envato');
  if ($('#outShutter').checked) selected.push('shutterstock');
  if ($('#outFreepik').checked) selected.push('freepik');
  selected.forEach(key => {
    const b = document.createElement('button'); b.className = 'btn primary';
    b.textContent = key.charAt(0).toUpperCase() + key.slice(1);
    b.onclick = () => {
      let csv = '';
      if (key === 'adobe') csv = buildAdobeCsv();
      else if (key === 'envato') csv = buildEnvatoCsv();
      else if (key === 'shutterstock') csv = buildShutterstockCsv();
      else if (key === 'freepik') csv = buildFreepikCsv();
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${key}_metadata.csv`; a.click();
    };
    downloadButtons.appendChild(b);
  });
  document.getElementById('downloadModal').classList.remove('hidden');
}
document.getElementById('downloadClose').addEventListener('click', () => document.getElementById('downloadModal').classList.add('hidden'));

document.getElementById('envatoSettingsBtn').addEventListener('click', () => document.getElementById('envatoModal').classList.remove('hidden'));
document.getElementById('envatoClose').addEventListener('click', () => document.getElementById('envatoModal').classList.add('hidden'));
document.getElementById('envatoSave').addEventListener('click', () => {
  envatoDefaults = {
    category: $('#envCat').value.trim(), priceSingle: $('#envPriceSingle').value, priceMulti: $('#envPriceMulti').value,
    people: $('#envPeople').value, buildings: $('#envBuildings').value, releases: $('#envReleases').value.trim(),
    isMG: $('#envIsMG').value, aj: $('#envAJ').value.trim(), color: $('#envColor').value.trim(),
    pace: $('#envPace').value.trim(), movement: $('#envMovement').value.trim(), composition: $('#envComposition').value.trim(),
    setting: $('#envSetting').value.trim(), numPeople: $('#envNumPeople').value, gender: $('#envGender').value.trim(),
    age: $('#envAge').value.trim(), ethnicity: $('#envEthnicity').value.trim(), alpha: $('#envAlpha').value,
    looped: $('#envIsLooped').value, audio: $('#envAudio').value.trim()
  };
  document.getElementById('envatoModal').classList.add('hidden');
});

function uiUpdate() {
  const total = files.length; const completed = state.completed;
  if (total > 0 && (state.running || completed === total)) {
    showNyanLoader();
    updateNyanProgress(Math.round((completed / total) * 100), state.running ? (state.paused ? 'Paused...' : 'Processing...') : 'Done!');
    document.getElementById('brandText').classList.toggle('shimmer', state.running);
  } else {
    hideNyanLoader(); document.getElementById('brandText').classList.remove('shimmer');
  }
  document.getElementById('startBtn').textContent = !state.running ? 'Start' : (state.paused ? 'Resume' : 'Pause');
  document.getElementById('startBtn').disabled = importing;
  document.getElementById('concurrency').disabled = state.running;
  document.getElementById('downloadAdobeBtn').disabled = csvStore.size === 0;
  updateFileCount();
}

(function init() {
  try {
    const key = localStorage.getItem('meta_access_key');
    localStorage.clear();
    if (key) localStorage.setItem('meta_access_key', key);
  } catch (e) { }
  restoreApiKeyFromLocalStorage();
  const currentPrompt = localStorage.getItem('meta_system_prompt') || ADOBE_CONFIG.prompt;
  document.getElementById('systemPromptInp').value = currentPrompt;
  updateModelHint(); uiUpdate();
})();

/************** Particles **************/
(function particles() {
  const ts = window.tsParticles;
  if (!ts) return;
  ts.load('particles', {
    fullScreen: { enable: false },
    particles: {
      number: { value: 140, density: { enable: true, area: 800 } },
      color: { value: '#000000' },
      opacity: { value: 0.45 },
      size: { value: 2.2, random: true },
      links: { enable: true, distance: 160, opacity: 0.35, color: '#000000' },
      move: { enable: true, speed: 0.6 }
    }
  });
})();

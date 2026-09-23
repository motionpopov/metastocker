'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}
const options = { titleText: '3D', titlePosition: 'start', tagsText: 'render, studio', tagsPosition: 'start' };

function fixture() {
  const names = ['first,asset.jpg', 'second.jpg', 'pending.jpg', 'failed.jpg'];
  const nodes = new Map();
  const getNode = id => {
    if (!nodes.has(id)) nodes.set(id, {});
    return nodes.get(id);
  };
  const updates = [];
  const context = vm.createContext({
    files: names.map(name => ({ name })).concat(null), fileStatuses: ['done', 'done', 'queued', 'error', 'deleted'],
    csvStore: new Map(names.map((name, i) => [name, { name, title: `Title ${i}`, description: 'Keep this description', tags: ['studio', 'light', 'Blue'], category: 8 }])),
    envatoRows: new Map(names.slice(0, 2).map(name => [name, { title90: 'Distinct Envato title', description300: 'Keep Envato description', category: 'Nature' }])),
    shutterRows: new Map(names.slice(0, 2).map(name => [name, { description: 'Distinct Shutterstock title', keywords: ['studio', 'light', 'Blue'], categories: 'Nature' }])),
    selectedMetadataRows: new Set(), state: { running: false }, importing: false,
    document: { getElementById: getNode, querySelectorAll: () => [] },
    updateTableRow: (idx, data) => updates.push({ idx, data }),
    envatoDefaults: {}, pickShutterListByName: () => ['Nature']
  });
  vm.runInContext([
    section('function isEditableMetadataRow', 'function refreshBulkEditPreview'),
    section('function csvEscape', 'function updateCsvRow'),
    section('function clip', 'function parseAlwaysTags'),
    section('const ENVATO_HEADERS', '/************** Processing pipeline **************/')
  ].join('\n'), context);
  return { c: context, names, nodes, updates };
}

test('only completed rows are selectable; select-all state follows deletion and regeneration', () => {
  const { c, nodes } = fixture();
  assert.deepEqual(Array.from(c.editableMetadataIndices()), [0, 1]);
  c.selectedMetadataRows.add(0);
  c.updateBulkSelectionUI();
  assert.equal(nodes.get('selectAllMetadata').indeterminate, true);
  c.selectedMetadataRows.add(1);
  c.updateBulkSelectionUI();
  assert.equal(nodes.get('selectAllMetadata').checked, true);
  c.files[0] = null;
  c.fileStatuses[1] = 'queued';
  c.updateBulkSelectionUI();
  assert.equal(c.selectedMetadataRows.size, 0);
  assert.equal(nodes.get('bulkToolbar').hidden, true);
  assert.equal(nodes.get('bulkEditBtn').disabled, true);
});

test('a preview is read-only; selected rows and all CSV formats receive the same edit', () => {
  const { c, names, updates } = fixture();
  const untouched = c.csvStore.get(names[1]);
  const plan = c.planBulkEdit([0], options);
  assert.equal(c.csvStore.get(names[0]).title, 'Title 0');
  assert.equal(plan.entries[0].row.title, '3D Title 0');
  assert.equal(c.applyBulkEditPlan(plan), true);
  assert.equal(c.csvStore.get(names[1]), untouched);
  assert.deepEqual(updates.map(item => item.idx), [0]);
  assert.equal(c.csvStore.get(names[0]).description, 'Keep this description');
  assert.equal(c.csvStore.get(names[0]).category, 8);
  assert.equal(c.envatoRows.get(names[0]).description300, 'Keep Envato description');
  assert.equal(c.envatoRows.get(names[0]).title90, '3D Distinct Envato title');
  assert.equal(c.shutterRows.get(names[0]).description, '3D Distinct Shutterstock title');
  assert.match(c.buildAdobeCsv(), /"first,asset.jpg",3D Title 0,"render, studio, light, Blue",8,/);
  assert.match(c.buildEnvatoCsv(), /"first,asset.jpg",3D Distinct Envato title,Keep Envato description,"render, studio, light, Blue",Nature/);
  assert.match(c.buildShutterstockCsv(), /"first,asset.jpg",3D Distinct Shutterstock title,"render, studio, light, Blue",Nature/);
  assert.match(c.buildFreepikCsv(), /first,asset.jpg;3D Title 0;render,studio,light,Blue/);
});

test('title-only suffix preserves tags and platform-specific descriptions and categories', () => {
  const { c, names } = fixture();
  const plan = c.planBulkEdit([0, 1], { ...options, titleText: '  3D  ', titlePosition: 'end', tagsText: '' });
  assert.equal(c.applyBulkEditPlan(plan), true);
  assert.equal(c.csvStore.get(names[0]).title, 'Title 0 3D');
  assert.equal(c.envatoRows.get(names[0]).title90, 'Distinct Envato title 3D');
  assert.equal(c.shutterRows.get(names[0]).description, 'Distinct Shutterstock title 3D');
  assert.deepEqual(Array.from(c.csvStore.get(names[0]).tags), ['studio', 'light', 'Blue']);
  assert.deepEqual(Array.from(c.shutterRows.get(names[0]).keywords), ['studio', 'light', 'Blue']);
  assert.equal(c.shutterRows.get(names[0]).categories, 'Nature');
});

test('tags-only edits move duplicates case-insensitively and preserve multi-word tags', () => {
  const { c, names } = fixture();
  const plan = c.planBulkEdit([0], { ...options, titleText: '', tagsText: ' BLUE; 3D render\nblue | sun light, ', tagsPosition: 'end' });
  assert.equal(c.applyBulkEditPlan(plan), true);
  assert.deepEqual(Array.from(c.csvStore.get(names[0]).tags), ['studio', 'light', 'BLUE', '3D render', 'sun light']);
  assert.equal(c.csvStore.get(names[0]).title, 'Title 0');
  assert.equal(c.envatoRows.get(names[0]).title90, 'Distinct Envato title');
  assert.equal(c.shutterRows.get(names[0]).description, 'Distinct Shutterstock title');
});

test('random insertion keeps existing tag order and applies the exact preview without rerolling', () => {
  const { c, names } = fixture();
  let calls = 0;
  const random = () => { calls++; return calls % 2 ? 0 : 0.99; };
  const plan = c.planBulkEdit([0, 1], { ...options, tagsPosition: 'random' }, random);
  const preview = plan.entries.map(entry => Array.from(entry.row.tags));
  assert.equal(calls, 4);
  assert.deepEqual(preview[0], ['render', 'light', 'Blue', 'studio']);
  assert.equal(c.applyBulkEditPlan(plan), true);
  assert.equal(calls, 4);
  for (let i = 0; i < 2; i++) assert.deepEqual(Array.from(c.csvStore.get(names[i]).tags), preview[i]);
});

test('49 tags are allowed, but overflow rejects the entire edit without dropping original tags', () => {
  const { c, names, updates } = fixture();
  const row = c.csvStore.get(names[1]);
  row.tags = Array.from({ length: 48 }, (_, i) => `tag ${i}`);
  assert.equal(c.planBulkEdit([1], { ...options, tagsText: 'one' }).error, '');
  const plan = c.planBulkEdit([0, 1], options);
  assert.match(plan.error, /50 tags.*maximum 49/);
  assert.equal(c.applyBulkEditPlan(plan), false);
  assert.equal(c.csvStore.get(names[0]).title, 'Title 0');
  assert.equal(row.tags.length, 48);
  assert.equal(updates.length, 0);
});

test('title limits reject the entire edit before any file or platform is changed', () => {
  const { c, names } = fixture();
  c.envatoRows.get(names[1]).title90 = 'x'.repeat(90);
  const plan = c.planBulkEdit([0, 1], options);
  assert.match(plan.error, /Envato's 90-character/);
  assert.equal(c.applyBulkEditPlan(plan), false);
  assert.equal(c.csvStore.get(names[0]).title, 'Title 0');
  c.csvStore.get(names[0]).title = 'x'.repeat(200);
  assert.match(c.planBulkEdit([0], options).error, /200-character/);
});

test('stale previews, processing, importing and unfinished rows cannot modify metadata', () => {
  for (const mutation of [
    c => { c.fileStatuses[1] = 'queued'; },
    c => { c.files[1] = null; },
    c => { c.csvStore.set('second.jpg', { ...c.csvStore.get('second.jpg'), title: 'Manual change' }); },
    c => { c.state.running = true; },
    c => { c.importing = true; }
  ]) {
    const { c, names, updates } = fixture();
    const plan = c.planBulkEdit([0, 1], options);
    mutation(c);
    assert.equal(c.applyBulkEditPlan(plan), false);
    assert.equal(c.csvStore.get(names[0]).title, 'Title 0');
    assert.equal(updates.length, 0);
  }
  const { c } = fixture();
  assert.match(c.planBulkEdit([2], options).error, /selection changed/i);
  assert.equal(c.planBulkEdit([0], { ...options, titleText: ' ', tagsText: ', ; |\n' }).entries.length, 0);
});

test('API is the first/default model, with explicit saved choices preserved and obsolete choices ignored', () => {
  for (const saved of [null, 'gpt-5.6-luna', 'gpt-6-luna', 'local-gemma-e2b', 'gpt-5.4-mini', 'obsolete-model']) {
    const storage = new Map(saved ? [['meta_ai_model', saved]] : []);
    const select = {
      value: '', options: ['gpt-6-luna', 'gpt-5.4-mini', 'gpt-5.4-nano'].map(value => ({ value })),
      appendChild(group) { this.options.push(...group.children); }
    };
    const c = vm.createContext({
      DEFAULT_AI_MODEL: 'gpt-6-luna',
      MODEL_GPT_6_LUNA: 'gpt-6-luna',
      $: id => id === '#model' ? select : { addEventListener() {} },
      document: { createElement: () => ({ children: [], appendChild(option) { this.children.push(option); }, prepend(option) { this.children.unshift(option); } }) },
      MetaStockerLocalAI: { MODELS: [{ id: 'local-gemma-e2b', label: 'Gemma', size: '3.5 GB' }] },
      localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, refreshLocalModelInfo() {}
    });
    vm.runInContext(section('function migrateLunaSettings', 'function selectedOutputKeys'), c);
    c.initLocalModels();
    assert.equal(select.options[0].value, 'gpt-6-luna');
    assert.equal(select.value, saved && !['obsolete-model', 'gpt-5.6-luna'].includes(saved) ? saved : 'gpt-6-luna');
    if (saved === 'gpt-5.6-luna') assert.equal(storage.get('meta_ai_model'), 'gpt-6-luna');
  }
});

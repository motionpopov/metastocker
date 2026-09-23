'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const rootDir = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(rootDir, 'app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return appSource.slice(start, end);
}

const context = {
  $: () => ({ value: 'gpt-6-luna' })
};
vm.createContext(context);
vm.runInContext([
  sourceBetween('const MODEL_GPT_6_LUNA', 'const ENVATO_CATEGORIES_FOOTAGE'),
  sourceBetween('function buildPrompt', '/************** Preview builders **************/'),
  `this.lunaExports = {
    MODEL_GPT_6_LUNA,
    ADOBE_CATEGORIES,
    ADOBE_PROMPT_LUNA,
    getAdobePrompt,
    getAdobeTitleMax,
    buildAdobeResponseSchema,
    normalizeAdobeCategory,
    buildPrompt
  };`
].join('\n'), context);

const {
  MODEL_GPT_6_LUNA,
  ADOBE_CATEGORIES,
  ADOBE_PROMPT_LUNA,
  getAdobePrompt,
  getAdobeTitleMax,
  buildAdobeResponseSchema,
  normalizeAdobeCategory,
  buildPrompt
} = context.lunaExports;

assert.equal(MODEL_GPT_6_LUNA, 'gpt-6-luna');
assert.match(indexSource, /<option value="gpt-6-luna">GPT-6 Luna<\/option>/);
assert.doesNotMatch(indexSource, /<option value="gpt-5\.4-(?:mini|nano)" selected>/);

const expectedNames = [
  'Animals', 'Buildings and Architecture', 'Business', 'Drinks', 'The Environment', 'States of Mind',
  'Food', 'Graphic Resources', 'Hobbies and Leisure', 'Industry', 'Landscape', 'Lifestyle', 'People',
  'Plants and Flowers', 'Culture and Religion', 'Science', 'Social Issues', 'Sports', 'Technology',
  'Transport', 'Travel'
];
assert.deepEqual(Array.from(ADOBE_CATEGORIES, category => category.id), Array.from({ length: 21 }, (_, index) => index + 1));
assert.deepEqual(Array.from(ADOBE_CATEGORIES, category => category.name), expectedNames);

const lunaPrompt = ADOBE_PROMPT_LUNA(20);
assert.equal(getAdobePrompt(MODEL_GPT_6_LUNA, 20), lunaPrompt);
assert.match(lunaPrompt, /exactly 20 unique English keywords/i);
assert.match(lunaPrompt, /"category" - one integer category ID from 1 through 21/);
for (const category of ADOBE_CATEGORIES) {
  assert.ok(lunaPrompt.includes(`${category.id}. ${category.name}`), `Missing Adobe category ${category.id}`);
}
const customLunaPrompt = buildPrompt(null, {
  model: MODEL_GPT_6_LUNA,
  tagsCount: 20,
  savedPrompt: 'Custom metadata instructions.',
  comments: '',
  alwaysTags: []
});
assert.match(customLunaPrompt, /MUST generate EXACTLY 20 tags/);
assert.match(customLunaPrompt, /1\. Animals/);
assert.match(customLunaPrompt, /21\. Travel/);

assert.equal(getAdobeTitleMax(MODEL_GPT_6_LUNA), 70);
assert.equal(getAdobeTitleMax('gpt-5.4-nano'), 100);
assert.equal(getAdobeTitleMax('gpt-5.4-mini'), 80);

const lunaSchema = buildAdobeResponseSchema(MODEL_GPT_6_LUNA, 20);
assert.deepEqual(Array.from(lunaSchema.schema.required), ['title', 'tags', 'category']);
assert.deepEqual(Array.from(lunaSchema.schema.properties.category.enum), Array.from({ length: 21 }, (_, index) => index + 1));
assert.equal(lunaSchema.schema.additionalProperties, false);

const nanoSchema = buildAdobeResponseSchema('gpt-5.4-nano', 20);
assert.deepEqual(Array.from(nanoSchema.schema.required), ['title', 'tags']);
assert.equal(nanoSchema.schema.properties.category, undefined);

assert.equal(normalizeAdobeCategory(1, MODEL_GPT_6_LUNA), 1);
assert.equal(normalizeAdobeCategory(21, MODEL_GPT_6_LUNA), 21);
assert.equal(normalizeAdobeCategory(0, MODEL_GPT_6_LUNA), null);
assert.equal(normalizeAdobeCategory(22, MODEL_GPT_6_LUNA), null);
assert.equal(normalizeAdobeCategory('3', MODEL_GPT_6_LUNA), null);
assert.equal(normalizeAdobeCategory(3, 'gpt-5.4-nano'), null);

console.log('GPT-6 Luna regression tests passed: default cloud model, Adobe categories, prompt, schema, and validation.');

test('GPT-6 Luna sends vision and structured outputs with medium reasoning, Flex and no temperature', async () => {
  const requests = [];
  const metadata = { title: 'Cat relaxing on a sofa', tags: ['cat', 'pet', 'animal', 'feline', 'sofa', 'home', 'relaxation', 'fur', 'whisker', 'domestic'], category: 1 };
  const c = vm.createContext({
    $: () => ({ value: 'gpt-6-luna' }), addLog() {}, addTokens() {}, sleep: async () => {},
    workerFetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      const prompt = body.messages[0].content;
      const result = prompt.includes('title90')
        ? { title90: 'Cat on sofa', description300: 'A domestic cat resting indoors.', category: 'Nature' }
        : prompt.includes('ONE or TWO') ? { categories: 'Animals/Wildlife' } : metadata;
      return { ok: true, data: { choices: [{ message: { content: JSON.stringify(result) } }] } };
    }
  });
  vm.runInContext([
    sourceBetween('const MODEL_GPT_6_LUNA', '/************** Column widths **************/'),
    sourceBetween('function isGrokModel', '/************** Table UI **************/')
  ].join('\n'), c);
  const imageDataUrl = 'data:image/jpeg;base64,AAAA';
  const common = { model: 'gpt-6-luna', accessKey: 'test-key', imageDataUrl };
  const adobe = await c.callOpenAI({ ...common, prompt: 'Attribute this image', tagsCount: 10 });
  assert.equal(adobe.category, 1);
  await c.fetchEnvatoMeta({ ...common, title: metadata.title, tags: metadata.tags, isMG: false });
  await c.fetchShutterstockCategories({ ...common, filename: 'cat.jpg', adobeTitle: metadata.title, adobeKeywords: metadata.tags });
  assert.equal(requests.length, 3);
  for (const { url, body } of requests) {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.reasoning_effort, 'medium');
    assert.equal(body.service_tier, 'flex');
    assert.equal('temperature' in body, false);
    assert.equal('tools' in body, false);
  }
  assert.equal(requests[0].body.response_format.type, 'json_schema');
  assert.deepEqual(requests[0].body.response_format.json_schema.schema.required, ['title', 'tags', 'category']);
  assert.equal(requests[0].body.response_format.json_schema.strict, true);
  for (const request of requests.slice(0, 2)) {
    assert.ok(request.body.messages[1].content.some(part => part.type === 'image_url' && part.image_url.url === imageDataUrl));
  }
  assert.equal(requests[1].body.response_format.type, 'text');
  assert.equal(requests[2].body.response_format.type, 'text');
  assert.equal(c.modelTemperature('gpt-5.4-mini'), undefined);
  assert.equal(c.modelTemperature('gpt-5.4-nano'), undefined);
});

test('Luna settings migration preserves custom prompts, explicit choices and existing new settings', () => {
  const oldKey = 'meta_system_prompt_gpt-5.6-luna';
  const newKey = 'meta_system_prompt_gpt-6-luna';
  for (const choice of ['gpt-5.6-luna', 'local-qwen-2b', 'gpt-5.4-mini']) {
    for (const existing of [null, '', 'New model prompt']) {
      const values = new Map([['meta_ai_model', choice], [oldKey, 'My custom Adobe instructions']]);
      if (existing !== null) values.set(newKey, existing);
      const c = vm.createContext({ MODEL_GPT_6_LUNA: 'gpt-6-luna', localStorage: {
        getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)
      } });
      vm.runInContext(sourceBetween('function migrateLunaSettings', 'function initLocalModels'), c);
      c.migrateLunaSettings();
      c.migrateLunaSettings();
      assert.equal(values.get('meta_ai_model'), choice === 'gpt-5.6-luna' ? 'gpt-6-luna' : choice);
      assert.equal(values.get(newKey), existing ?? 'My custom Adobe instructions');
      assert.equal(values.get(oldKey), 'My custom Adobe instructions');
    }
  }
  const blocked = vm.createContext({ localStorage: { getItem() { throw new Error('Storage blocked'); } } });
  vm.runInContext(sourceBetween('function migrateLunaSettings', 'function initLocalModels'), blocked);
  assert.doesNotThrow(() => blocked.migrateLunaSettings());
});

test('Luna short-context cost estimate uses documented Flex input, cached input and output rates', () => {
  const c = vm.createContext({ $: () => null });
  vm.runInContext(sourceBetween('const PRICING', 'function addTokens') +
    sourceBetween('function addTokens', 'async function processOne') + '\nthis.tokenState = state;', c);
  c.addTokens({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 200 }, completion_tokens: 100 }, 'gpt-6-luna');
  assert.ok(Math.abs(c.tokenState.totalCost - (800 * 0.05 + 200 * 0.005 + 100 * 0.25) / 1000000) < 1e-12);
});

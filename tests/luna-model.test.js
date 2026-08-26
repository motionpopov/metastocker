'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
  $: () => ({ value: 'gpt-5.6-luna' })
};
vm.createContext(context);
vm.runInContext([
  sourceBetween('const MODEL_GPT_5_6_LUNA', 'const ENVATO_CATEGORIES_FOOTAGE'),
  sourceBetween('function buildPrompt', '/************** Preview builders **************/'),
  `this.lunaExports = {
    MODEL_GPT_5_6_LUNA,
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
  MODEL_GPT_5_6_LUNA,
  ADOBE_CATEGORIES,
  ADOBE_PROMPT_LUNA,
  getAdobePrompt,
  getAdobeTitleMax,
  buildAdobeResponseSchema,
  normalizeAdobeCategory,
  buildPrompt
} = context.lunaExports;

assert.equal(MODEL_GPT_5_6_LUNA, 'gpt-5.6-luna');
assert.match(indexSource, /<option value="gpt-5\.6-luna" selected>GPT-5\.6 Luna<\/option>/);
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
assert.equal(getAdobePrompt(MODEL_GPT_5_6_LUNA, 20), lunaPrompt);
assert.match(lunaPrompt, /exactly 20 unique English keywords/i);
assert.match(lunaPrompt, /"category" - one integer category ID from 1 through 21/);
for (const category of ADOBE_CATEGORIES) {
  assert.ok(lunaPrompt.includes(`${category.id}. ${category.name}`), `Missing Adobe category ${category.id}`);
}
const customLunaPrompt = buildPrompt(null, {
  model: MODEL_GPT_5_6_LUNA,
  tagsCount: 20,
  savedPrompt: 'Custom metadata instructions.',
  comments: '',
  alwaysTags: []
});
assert.match(customLunaPrompt, /MUST generate EXACTLY 20 tags/);
assert.match(customLunaPrompt, /1\. Animals/);
assert.match(customLunaPrompt, /21\. Travel/);

assert.equal(getAdobeTitleMax(MODEL_GPT_5_6_LUNA), 70);
assert.equal(getAdobeTitleMax('gpt-5.4-nano'), 100);
assert.equal(getAdobeTitleMax('gpt-5.4-mini'), 80);

const lunaSchema = buildAdobeResponseSchema(MODEL_GPT_5_6_LUNA, 20);
assert.deepEqual(Array.from(lunaSchema.schema.required), ['title', 'tags', 'category']);
assert.deepEqual(Array.from(lunaSchema.schema.properties.category.enum), Array.from({ length: 21 }, (_, index) => index + 1));
assert.equal(lunaSchema.schema.additionalProperties, false);

const nanoSchema = buildAdobeResponseSchema('gpt-5.4-nano', 20);
assert.deepEqual(Array.from(nanoSchema.schema.required), ['title', 'tags']);
assert.equal(nanoSchema.schema.properties.category, undefined);

assert.equal(normalizeAdobeCategory(1, MODEL_GPT_5_6_LUNA), 1);
assert.equal(normalizeAdobeCategory(21, MODEL_GPT_5_6_LUNA), 21);
assert.equal(normalizeAdobeCategory(0, MODEL_GPT_5_6_LUNA), null);
assert.equal(normalizeAdobeCategory(22, MODEL_GPT_5_6_LUNA), null);
assert.equal(normalizeAdobeCategory('3', MODEL_GPT_5_6_LUNA), null);
assert.equal(normalizeAdobeCategory(3, 'gpt-5.4-nano'), null);

console.log('Luna model regression tests passed: default model, Adobe categories, prompt, schema, and validation.');

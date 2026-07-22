'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appPath = path.join(__dirname, '..', 'app.js');
const source = fs.readFileSync(appPath, 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < csv.length; index++) {
    const character = csv[index];
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        field += '"';
        index++;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\r' || character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (character === '\r' && csv[index + 1] === '\n') index++;
    } else {
      field += character;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

assert.doesNotMatch(source, /\.map\(csvEscape\)/, 'csvEscape must be wrapped so Array.map does not pass the column index as its delimiter');

const filename = 'asset,01.jpg';
const sharedRow = {
  name: filename,
  title: 'Abstract background, with cinematic light',
  description: '',
  tags: ['abstract', 'background', 'cinematic light'],
  category: ''
};

const context = {
  csvStore: new Map([[filename, sharedRow]]),
  envatoRows: new Map([[filename, {
    title90: 'Envato title, with comma',
    description300: 'Envato description, with comma',
    category: 'Business, Corporate'
  }]]),
  shutterRows: new Map([[filename, {
    description: 'Shutterstock description, with comma',
    keywords: sharedRow.tags,
    categories: 'Business/Finance, Technology'
  }]]),
  envatoDefaults: {
    category: '', priceSingle: '15', priceMulti: '49', people: 'No', buildings: 'No', releases: '',
    isMG: 'No', aj: '', color: '', pace: '', movement: '', composition: '', setting: '', numPeople: '',
    gender: '', age: '', ethnicity: '', alpha: 'No', looped: 'No', audio: ''
  },
  pickShutterListByName: () => ['Business/Finance', 'Technology']
};

vm.createContext(context);
vm.runInContext([
  sourceBetween('function csvEscape', 'function updateCsvRow'),
  sourceBetween('function clip', 'function parseAlwaysTags'),
  sourceBetween('const ENVATO_HEADERS', '/************** Processing pipeline **************/')
].join('\n'), context);

const adobeRows = parseCsv(context.buildAdobeCsv());
assert.deepEqual(adobeRows[0], ['Filename', 'Title', 'Keywords', 'Category', 'Releases']);
assert.equal(adobeRows[1].length, 5);
assert.equal(adobeRows[1][0], filename);
assert.equal(adobeRows[1][1], sharedRow.title);
assert.equal(adobeRows[1][2], 'abstract, background, cinematic light');

const envatoRows = parseCsv(context.buildEnvatoCsv());
assert.equal(envatoRows[1].length, envatoRows[0].length);
assert.equal(envatoRows[1][0], filename);
assert.equal(envatoRows[1][1], 'Envato title, with comma');
assert.equal(envatoRows[1][2], 'Envato description, with comma');
assert.equal(envatoRows[1][3], 'abstract, background, cinematic light');
assert.equal(envatoRows[1][4], 'Business, Corporate');

const shutterstockRows = parseCsv(context.buildShutterstockCsv());
assert.deepEqual(shutterstockRows[0], ['Filename', 'Description', 'Keywords', 'Categories']);
assert.equal(shutterstockRows[1].length, 4);
assert.equal(shutterstockRows[1][0], filename);
assert.equal(shutterstockRows[1][1], 'Shutterstock description, with comma');
assert.equal(shutterstockRows[1][2], 'abstract, background, cinematic light');
assert.equal(shutterstockRows[1][3], 'Business/Finance, Technology');

console.log('CSV export regression tests passed: Adobe=5, Envato=24, Shutterstock=4 columns.');

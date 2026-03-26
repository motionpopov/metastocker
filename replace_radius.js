const fs = require('fs');

let css = fs.readFileSync('style.css', 'utf8');

const replacements = [
  { match: /\.menu-btn\s*\{[\s\S]*?border-radius:\s*10px;/, find: '10px', replace: 'var(--radius-md)' },
  { match: /\.input,\s*\.select,\s*\.textarea\s*\{[\s\S]*?border-radius:\s*10px;/, find: '10px', replace: 'var(--radius-md)' },
  { match: /\.btn\s*\{[\s\S]*?border-radius:\s*12px;/, find: '12px', replace: 'var(--radius-md)' },
  { match: /#accessKeyToggle\s*\{[\s\S]*?border-radius:\s*8px;/, find: '8px', replace: 'var(--radius-sm)' },
  { match: /\.qmark\s*\{[\s\S]*?border-radius:\s*999px;/, find: '999px', replace: 'var(--radius-full)' },
  { match: /\.hint-tooltip \.tooltip\s*\{[\s\S]*?border-radius:\s*10px;/, find: '10px', replace: 'var(--radius-md)' },
  { match: /\.badge\s*\{[\s\S]*?border-radius:\s*999px;/, find: '999px', replace: 'var(--radius-sm)' },
  { match: /\.segments\s*\{[\s\S]*?border-radius:\s*12px;/, find: '12px', replace: 'var(--radius-full)' },
  { match: /\.segments label\s*\{[\s\S]*?border-radius:\s*12px;/, find: '12px', replace: 'var(--radius-full)' },
  { match: /\.dropzone\s*\{[\s\S]*?border-radius:\s*20px;/, find: '20px', replace: 'var(--radius-xl)' },
  { match: /\.table-wrap\s*\{[\s\S]*?border-radius:\s*14px;/, find: '14px', replace: 'var(--radius-xl)' },
  { match: /#showLogsBtn\s*\{[\s\S]*?border-radius:\s*999px;/, find: '999px', replace: 'var(--radius-full)' },
  { match: /#logsPanel \.sheet\s*\{[\s\S]*?border-radius:\s*16px;/, find: '16px', replace: 'var(--radius-xl)' },
  { match: /#nyanProgressBar\s*\{[\s\S]*?border-radius:\s*16px;/, find: '16px', replace: 'var(--radius-2xl)' },
  { match: /#loader \.panel\s*\{[\s\S]*?border-radius:\s*18px;/, find: '18px', replace: 'var(--radius-2xl)' },
  { match: /\.ring\s*\{[\s\S]*?border-radius:\s*999px;/, find: '999px', replace: 'var(--radius-full)' }
];

replacements.forEach(({match, find, replace}) => {
  const m = css.match(match);
  if (m) {
    const updated = m[0].replace(find, replace);
    css = css.replace(m[0], updated);
  }
});

fs.writeFileSync('style.css', css, 'utf8');

// Also process index.html classes
let html = fs.readFileSync('index.html', 'utf8');
// Fix logo
html = html.replace('class="rounded"', 'class="rounded-sm"');
// Fix checkbox
html = html.replace('border-gray-300 rounded focus', 'border-gray-300 rounded-sm focus');
// Fix envato modal
html = html.replace('rounded-3xl border border-border', 'rounded-2xl border border-border');
// Fix image preview tooltip container
html = html.replace('tooltip" class="fixed z-[9999] hidden pointer-events-none rounded-xl', 'tooltip" class="fixed z-[9999] hidden pointer-events-none rounded-lg');
// Fix image preview tooltip image
html = html.replace('object-contain rounded-lg', 'object-contain rounded-md');

fs.writeFileSync('index.html', html, 'utf8');
console.log('Update complete');

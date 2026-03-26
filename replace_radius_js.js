const fs = require('fs');
let js = fs.readFileSync('app.js', 'utf8');

// Line 606: thumb container `rounded-lg` -> `rounded-md`
js = js.replace('h-16 w-16 rounded-lg overflow-hidden', 'h-16 w-16 rounded-md overflow-hidden');

// Badge strings (tiny status chips -> sm)
js = js.replace(/rounded-full text-\[11px\] font-medium border bg-gray-100/g, 'rounded-sm text-[11px] font-medium border bg-gray-100');
js = js.replace(/rounded-full text-\[11px\] font-medium bg-red-100/g, 'rounded-sm text-[11px] font-medium bg-red-100');
js = js.replace(/rounded-full text-\[11px\] font-medium border bg-green-100/g, 'rounded-sm text-[11px] font-medium border bg-green-100');
js = js.replace(/rounded-full text-\[11px\] font-medium border \$\{colorClass\}/g, 'rounded-sm text-[11px] font-medium border ${colorClass}');

// Buttons (small controls -> sm)
js = js.replace(/hover:bg-blue-100 rounded p-1/g, 'hover:bg-blue-100 rounded-sm p-1');
js = js.replace(/hover:bg-red-100 rounded p-1/g, 'hover:bg-red-100 rounded-sm p-1');
js = js.replace(/border-\[color:var\(--border\)\] rounded px-1\.5 py-0\.5/g, 'border-[color:var(--border)] rounded-sm px-1.5 py-0.5'); // line 637
js = js.replace(/border-\[color:var\(--border\)\] rounded px-2 py-0\.5/g, 'border-[color:var(--border)] rounded-sm px-2 py-0.5'); // lines 728, 733

// Tags and tag inputs (tags/inputs -> md)
js = js.replace(/px-2\.5 py-0\.5 rounded-full border border-\[color:var\(--border\)\]/g, 'px-2.5 py-0.5 rounded-md border border-[color:var(--border)]'); // line 662 tags
js = js.replace(/border border-\[color:var\(--border\)\] rounded-full px-2\.5 py-0\.5/g, 'border border-[color:var(--border)] rounded-md px-2.5 py-0.5'); // line 683 tag input

fs.writeFileSync('app.js', js, 'utf8');
console.log('Update JS complete');

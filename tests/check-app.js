/* Extract the inline app script from index.html and syntax-check it.
 *   node tests/check-app.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!blocks.length) {
  console.error('no inline script found');
  process.exit(1);
}
const code = blocks.join('\n;\n');
fs.writeFileSync(path.join(root, 'out', 'app-inline.js'), code);

try {
  new vm.Script(code, { filename: 'index.html <inline>' });
  console.log('syntax OK  (' + code.split('\n').length + ' lines, ' + blocks.length + ' block)');
} catch (e) {
  console.error('SYNTAX ERROR: ' + e.message);
  process.exit(1);
}

/* cheap structural checks */
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
const used = [...code.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]);
/* ids created at runtime by the app itself, not present in the markup */
const DYNAMIC_IDS = new Set(['chipDel']);
const missing = [...new Set(used)].filter(u => !ids.includes(u) && !DYNAMIC_IDS.has(u));
if (missing.length) {
  console.error('MISSING ELEMENT IDS: ' + missing.join(', '));
  process.exit(1);
}
console.log('all ' + new Set(used).size + ' referenced element ids exist');

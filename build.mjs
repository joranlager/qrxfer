#!/usr/bin/env node
// Build step: turns index_dev.html (the development page) into index.html, a single
// self-contained page with every resource inlined. No dependencies, just Node 18+.
//
//   node build.mjs
//
// What gets inlined:
//   <link rel="stylesheet" href="x.css">     -> <style> block
//   <script type="module" src="app.js">      -> one module script (its relative imports are bundled)
//   <link rel="icon"> and <img src>          -> data: URIs
//   <link rel="worker" / "worker-lib" / "worker-wasm">
//                                            -> the decoder worker source, its library and the
//                                               WebAssembly binary (base64); the worker is started
//                                               from a Blob (window.__makeWorker)
// Anything marked data-keep (manifest, install icons) stays a normal file reference.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const SRC = 'index_dev.html';
const OUT = 'index.html';

const readText = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const readBin = (f) => fs.readFileSync(path.join(root, f));
const fail = (msg) => { console.error('build error: ' + msg); process.exit(1); };

const MIME = {
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
};
const dataUri = (f) => {
  const type = MIME[path.extname(f).toLowerCase()];
  if (!type) fail(`don't know the MIME type of ${f}`);
  return `data:${type};base64,${readBin(f).toString('base64')}`;
};
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : null;
};
const isLocal = (u) => u && !/^([a-z]+:|\/\/|#|data:)/i.test(u);
const noHazard = (text, what, close) => {
  if (text.toLowerCase().includes(close)) fail(`${what} contains "${close}", which would end its inline tag`);
};

// ---------------------------------------------------------------------------
// ES module bundler: handles the import/export forms this project uses
//   import X from './a.js';   import { a, b as c } from './a.js';
//   export const|let|var|function|class name ...;   export default name;
// Every dependency becomes a function scope; the entry module is placed last.
// ---------------------------------------------------------------------------
function bundleModule(entryFile) {
  const order = [];            // dependency-first list of module records
  const byFile = new Map();
  const importRe = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?[ \t]*$/gm;

  const load = (file) => {
    if (byFile.has(file)) return byFile.get(file);
    const rec = { file, id: '__mod' + byFile.size, code: '', exportNames: [], defaultName: null };
    byFile.set(file, rec);
    let code = readText(file);
    const dir = path.posix.dirname(file);

    code = code.replace(importRe, (_all, clause, spec) => {
      if (!spec.startsWith('.')) fail(`${file}: only relative imports can be bundled (${spec})`);
      const dep = load(path.posix.normalize(path.posix.join(dir, spec)));
      const lines = [];
      clause = clause.trim();
      const named = clause.match(/\{([\s\S]*)\}/);
      const def = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, '').trim();
      if (def) lines.push(`const ${def} = ${dep.id}.default;`);
      if (named) {
        const parts = named[1].split(',').map((s) => s.trim()).filter(Boolean)
          .map((s) => s.replace(/\s+as\s+/, ': '));
        if (parts.length) lines.push(`const { ${parts.join(', ')} } = ${dep.id};`);
      }
      return lines.join(' ');
    });

    code = code.replace(/^export\s+default\s+([A-Za-z_$][\w$]*)\s*;?[ \t]*$/gm, (_m, name) => {
      rec.defaultName = name;
      return '';
    });
    code = code.replace(/^export\s+((?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*))/gm,
      (_m, decl, name) => { rec.exportNames.push(name); return decl; });
    if (/^export\s/m.test(code)) fail(`${file}: unsupported export form`);
    rec.code = code;
    order.push(rec);
    return rec;
  };

  const entry = load(entryFile);
  let out = '';
  for (const rec of order) {
    if (rec === entry) continue;
    const ret = [...rec.exportNames];
    out += `// ---- ${rec.file} ----\nconst ${rec.id} = (() => {\n${rec.code}\nreturn { ${rec.defaultName ? `default: ${rec.defaultName}${ret.length ? ', ' : ''}` : ''}${ret.join(', ')} };\n})();\n\n`;
  }
  out += `// ---- ${entry.file} ----\n${entry.code}`;
  return { code: out, files: order.map((r) => r.file) };
}

// ---------------------------------------------------------------------------
let html = readText(SRC);
const inlined = [];
const kept = [];

// stylesheets
html = html.replace(/[ \t]*<link\b[^>]*\brel="stylesheet"[^>]*>[ \t]*\n?/g, (tag) => {
  const href = attr(tag, 'href');
  if (!isLocal(href) || /\bdata-keep\b/.test(tag)) return tag;
  const css = readText(href).replace(/\n+$/, '');
  noHazard(css, href, '</style');
  inlined.push(href);
  return `  <style>\n${css}\n  </style>\n`;
});

// worker declarations (collected, then removed from the page)
const worker = {};
html = html.replace(/[ \t]*<link\b[^>]*\brel="(worker|worker-lib|worker-wasm)"[^>]*>[ \t]*\n?/g, (tag, rel) => {
  worker[rel] = attr(tag, 'href');
  return '';
});

// images and icons
html = html.replace(/<(link|img)\b[^>]*>/g, (tag, name) => {
  if (name === 'link' && !/\brel="(?:shortcut )?icon"/.test(tag)) return tag;
  const key = name === 'img' ? 'src' : 'href';
  const url = attr(tag, key);
  if (!isLocal(url)) return tag;
  if (/\sdata-keep(\s|>|=)/.test(tag)) { kept.push(url); return tag.replace(/\sdata-keep(="[^"]*")?/, ''); }
  inlined.push(url);
  return tag.replace(`${key}="${url}"`, `${key}="${dataUri(url)}"`);
});

// remaining data-keep markers are only for the build: drop them from the output
html = html.replace(/(<link\b[^>]*?)\sdata-keep(?:="[^"]*")?([^>]*>)/g, (_m, a, b) => {
  const url = attr(a + b, 'href');
  if (url) kept.push(url);
  return a + b;
});

// scripts: bundle the module, and add the inline decoder worker
html = html.replace(/[ \t]*<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"[^>]*><\/script>[ \t]*\n?/g, (_tag, src) => {
  if (!isLocal(src)) fail(`external script ${src} cannot be inlined`);
  const { code, files } = bundleModule(src);
  noHazard(code, src, '</script');
  inlined.push(src, ...files);

  let workerHtml = '';
  if (worker.worker) {
    if (!worker['worker-lib'] || !worker['worker-wasm']) fail('worker needs worker-lib and worker-wasm links');
    const lib = readText(worker['worker-lib']).replace(/\n+$/, '');
    let wk = readText(worker.worker);
    const importRe = /importScripts\(\s*['"][^'"]*['"]\s*\);?/;
    if (!importRe.test(wk)) fail(`${worker.worker}: no importScripts(...) line to replace with the library`);
    wk = wk.replace(importRe, () => lib);
    noHazard(wk, worker.worker, '</script');
    const wasm = readBin(worker['worker-wasm']).toString('base64');
    inlined.push(worker.worker, worker['worker-lib'], worker['worker-wasm']);
    workerHtml =
      `  <!-- Decoder worker (${worker.worker} + ${worker['worker-lib']}) and its WebAssembly binary (${worker['worker-wasm']}, base64).\n` +
      `       Only read when the camera is started. -->\n` +
      `  <script type="text/plain" id="worker-src">\n${wk}\n</script>\n` +
      `  <script type="text/plain" id="wasm-b64">${wasm}</script>\n` +
      `  <script>\n` +
      `  window.__makeWorker = (() => {\n` +
      `    let url = null;\n` +
      `    return () => {\n` +
      `      if (!url) {\n` +
      `        const bin = atob(document.getElementById('wasm-b64').textContent.trim());\n` +
      `        const bytes = new Uint8Array(bin.length);\n` +
      `        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);\n` +
      `        const wasmUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));\n` +
      `        const src = 'self.WASM_URL = ' + JSON.stringify(wasmUrl) + ';\\n' + document.getElementById('worker-src').textContent;\n` +
      `        url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));\n` +
      `      }\n` +
      `      return new Worker(url);\n` +
      `    };\n` +
      `  })();\n` +
      `  </script>\n`;
  }
  return workerHtml + `  <script type="module">\n${code}\n</script>\n`;
});

if (/<(?:script|link)\b[^>]*\b(?:src|href)="(?![a-z]+:|data:|#)[^"]*"/i.test(html)) {
  const left = html.match(/<(?:script|link)\b[^>]*\b(?:src|href)="(?![a-z]+:|data:|#)[^"]*"[^>]*>/gi) || [];
  const unexpected = left.filter((t) => !/rel="(manifest|apple-touch-icon|icon)"/.test(t));
  if (unexpected.length) fail('resources left that were not inlined or marked data-keep:\n  ' + unexpected.join('\n  '));
}

// development-only comments stay in index_dev.html
html = html.replace(/[ \t]*<!--\s*DEVELOPMENT PAGE[\s\S]*?-->[ \t]*\n/, '');
html = html.replace(/[ \t]*<!--\s*Decoder worker: browsers ignore[\s\S]*?-->[ \t]*\n/, '');

const banner =`<!-- GENERATED by build.mjs from ${SRC}. Do not edit: change ${SRC} and the files it lists, then run \`node build.mjs\`. -->\n`;
html = html.replace(/^<!doctype html>\n/i, (m) => m + banner);

fs.writeFileSync(path.join(root, OUT), html);
const unique = [...new Set(inlined)];
console.log(`${OUT}: ${(Buffer.byteLength(html) / 1024).toFixed(0)} kB`);
console.log('inlined:   ' + unique.join(', '));
console.log('kept as files: ' + [...new Set(kept)].join(', '));

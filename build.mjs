// Vercel build: copies the site into dist/ and minifies HTML, CSS and JS, so the
// live files are dense and hard to read. The sources in this repo stay readable.
// Run locally with `npm install && npm run build`, then preview dist/ (launch config
// "site-dist"). Vercel serves dist/ and builds api/ as functions on its own.
import { readdir, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { join, dirname, extname, relative } from 'node:path';
import { transform } from 'esbuild';
import { minify as minifyHtml } from 'html-minifier-terser';

const ROOT = dirname(new URL(import.meta.url).pathname);
const OUT = join(ROOT, 'dist');
// Never published: tooling, notes, database scripts, functions (built by Vercel).
const SKIP = new Set(['dist', 'node_modules', 'api', '.git', '.vercel', 'build.mjs', 'package.json', 'package-lock.json',
  'vercel.json', '.vercelignore', '.gitignore', '.github', '.mcp.json', 'CLAUDE.md', '.DS_Store', 'member/supabase', 'member/README.md']);
const skip = (rel) => SKIP.has(rel) || SKIP.has(rel.split('/').pop()) || /(^|\/)_(demo|dev|lokal)/.test(rel);

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name), rel = relative(ROOT, full);
    if (skip(rel)) continue;
    if (e.isDirectory()) yield* walk(full); else yield { full, rel };
  }
}

const HTML = {
  collapseWhitespace: true, conservativeCollapse: true, removeComments: true,
  minifyCSS: true, minifyJS: true, keepClosingSlash: false, decodeEntities: false,
};

await rm(OUT, { recursive: true, force: true });
let n = 0, before = 0, after = 0;
for await (const { full, rel } of walk(ROOT)) {
  const dest = join(OUT, rel);
  await mkdir(dirname(dest), { recursive: true });
  const ext = extname(rel);
  if (!['.html', '.css', '.js'].includes(ext)) { await copyFile(full, dest); continue; }
  const src = await readFile(full, 'utf8');
  let out;
  if (ext === '.js') {
    const esm = /^\s*(import|export)\b/m.test(src);
    out = (await transform(src, { loader: 'js', minify: true, format: esm ? 'esm' : undefined, target: 'es2020', legalComments: 'none' })).code;
  } else if (ext === '.css') {
    out = (await transform(src, { loader: 'css', minify: true, legalComments: 'none' })).code;
  } else {
    out = await minifyHtml(src, HTML);
  }
  await writeFile(dest, out);
  n++; before += src.length; after += out.length;
}
console.log(`minified ${n} files: ${Math.round(before / 1024)} KB -> ${Math.round(after / 1024)} KB`);

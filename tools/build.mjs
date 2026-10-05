// Assembles each src/<page>.html into a self-contained dist/<page>.html.
//   <!--@include path-->                         -> raw contents of path (HTML fragments)
//   <script data-inline="a.js,b.js"></script>    -> one <script> with the files' contents
// Pages are artifact-style fragments (no <!doctype>/<html>/<body>); tools/smoke.mjs wraps them.
// Usage: node tools/build.mjs [page ...]   (default: every src/*.html not starting with "_")
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
mkdirSync(join(root, 'dist'), { recursive: true });

const requested = process.argv.slice(2);
const pages = requested.length
    ? requested.map((p) => `${p}.html`)
    : readdirSync(join(root, 'src')).filter((f) => f.endsWith('.html') && !f.startsWith('_'));

for (const f of pages) {
    let out = read(join('src', f));
    out = out.replace(/<!--@include\s+([^\s]+)\s*-->/g, (_, p) => read(p));
    out = out.replace(/<script data-inline="([^"]+)"><\/script>/g, (_, list) =>
        `<script>\n${list.split(',').map((p) => `// ---- ${p.trim()} ----\n${read(p.trim())}`).join('\n')}\n</script>`);
    if (/@include|data-inline=/.test(out)) throw new Error(`${f}: unresolved include`);
    writeFileSync(join(root, 'dist', f), out);
    console.log(`dist/${f} ${(out.length / 1024).toFixed(1)} KB`);
}

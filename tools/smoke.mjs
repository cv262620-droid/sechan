// Headless smoke test: loads each dist page in Chromium (SwiftShader WebGL), serving the engine
// CDN URLs from node_modules, then checks for errors, exercises the test API and saves screenshots.
// Runs with prefers-reduced-motion so view presets apply instantly (deterministic screenshots).
// Usage: node tools/smoke.mjs [babylon|playcanvas ...]   -> screenshots in .shots/
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, '.shots');
mkdirSync(shots, { recursive: true });
const pages = process.argv.slice(2).length ? process.argv.slice(2) : ['babylon', 'playcanvas'];

// Same skeleton the artifact host adds at publish time.
const wrap = (body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui,sans-serif;background:#fafafa}img{max-width:100%}[hidden]{display:none!important}</style></head><body>
${body}
</body></html>`;

function cdnToLocal(url) {
    const m = url.match(/^https:\/\/cdn\.jsdelivr\.net\/npm\/(@?[^@/]+(?:\/[^@/]+)?)@([^/]+)\/(.+)$/);
    if (!m) return null;
    const file = join(root, 'node_modules', m[1], m[3]);
    return existsSync(file) ? file : null;
}

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});
let failed = false;

// Mean colour of small patches of a PNG buffer, decoded in the page (no image library needed).
async function samplePng(page, buf, pts) {
    return page.evaluate(async ({ b64, pts }) => {
        const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0);
        return pts.map(([px, py, r]) => {
            const d = x.getImageData(Math.round(px - r), Math.round(py - r), 2 * r + 1, 2 * r + 1).data, s = [0, 0, 0];
            for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; }
            return s.map((v) => Math.round(v / (d.length / 4)));
        });
    }, { b64: buf.toString('base64'), pts });
}
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
for (const name of pages) {
    const distFile = join(root, 'dist', `${name}.html`);
    const wrapped = join(shots, `${name}.wrapped.html`);
    writeFileSync(wrapped, wrap(readFileSync(distFile, 'utf8')));
    for (const vp of [{ id: 'desktop', width: 1440, height: 900 }, { id: 'mobile', width: 400, height: 860 }]) {
        for (const scheme of vp.id === 'desktop' ? ['light', 'dark'] : ['light']) {
            const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, deviceScaleFactor: 1, reducedMotion: 'reduce' });
            const page = await ctx.newPage();
            const errors = [];
            page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
            page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
            await page.route('**/*', async (route) => {
                const url = route.request().url();
                if (url.startsWith('file:')) return route.continue();
                const local = cdnToLocal(url);
                if (local) return route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: readFileSync(local) });
                if (/fonts\.(googleapis|gstatic)\.com/.test(url)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
                errors.push(`blocked external request: ${url}`);
                return route.abort();
            });
            const t0 = Date.now();
            await page.goto(pathToFileURL(wrapped).href);
            try {
                await page.waitForFunction(() => window.__app && window.__app.ready === true, null, { timeout: 120000 });
            } catch {
                errors.push('timeout: window.__app.ready never became true');
            }
            const loadMs = Date.now() - t0;
            await page.waitForTimeout(1500);
            const tag = `${name}-${vp.id}${scheme === 'dark' ? '-dark' : ''}`;
            await page.screenshot({ path: join(shots, `${tag}.png`) });
            let info = {};
            if (vp.id === 'desktop' && scheme === 'light') {
                try {
                    info = await page.evaluate(async () => {
                        const a = window.__app;
                        const out = { metricsDefault: a.metrics(), stats: a.stats() };
                        a.setMass({ towerFloors: 20, podiumFloors: 4 });
                        a.setSun({ preset: 'winter', hour: 9.5 });
                        await new Promise((r) => setTimeout(r, 800));
                        out.metricsEdited = a.metrics();
                        return out;
                    });
                    await page.screenshot({ path: join(shots, `${tag}-edited.png`) });
                    for (const view of ['pedestrian', 'top', 'north']) {
                        await page.evaluate((v) => window.__app.setView(v), view);
                        await page.waitForTimeout(1200);
                        await page.screenshot({ path: join(shots, `${tag}-${view}.png`) });
                    }

                    // Colour check: plan view, 하지 12:30, default mass, context + trees hidden. Sample flat lit
                    // surfaces at known plan positions (top preset: ~220 m across the 900 px height, centred in the
                    // area right of the panel) against the spec colours.
                    const plan = await page.evaluate(async () => {
                        const a = window.__app;
                        a.setMass({ podiumFloors: 3, towerFloors: 12, podiumFH: 4.2, towerFH: 3.9 });
                        a.setSun({ preset: 'summer', hour: 12.5 });
                        a.setLayer('context', false); a.setLayer('trees', false);
                        a.setView('top');
                        await new Promise((r) => setTimeout(r, 1500));
                        const p = document.getElementById('panel').getBoundingClientRect();
                        return { cx: (p.right + innerWidth) / 2, cy: innerHeight / 2, k: (innerHeight / 2) / 110 };
                    });
                    const buf = await page.screenshot({ path: join(shots, `${tag}-plan-summer.png`) });
                    const at = (e, n, r) => [plan.cx + e * plan.k, plan.cy - n * plan.k, r];
                    const probes = [
                        { name: 'siteFill', hex: '#efe6c8', pt: at(-19.8, -2, 1) },  // west strip between boundary band and podium
                        { name: 'platform', hex: '#d9d6cf', pt: at(-35, 0, 3) },     // neighbouring parcel (context hidden)
                        { name: 'asphalt', hex: '#5b5f63', pt: at(-5, -22.5, 2) },   // road south of the site
                    ];
                    const got = await samplePng(page, buf, probes.map((q) => q.pt));
                    info.colors = {};
                    probes.forEach((q, i) => {
                        info.colors[q.name] = toHex(got[i]);
                        const dev = Math.max(...hexRgb(q.hex).map((v, j) => Math.abs(v - got[i][j])));
                        // `_` pages are UI harnesses (e.g. the Canvas2D mock): report colours, don't assert them
                        if (dev > 24 && !name.startsWith('_')) errors.push(`colour ${q.name}: got ${toHex(got[i])}, spec ${q.hex} (max channel diff ${dev})`);
                    });

                    // Layers off -> fewer draw calls; then back on.
                    const drawsOff = await page.evaluate(async () => {
                        const a = window.__app;
                        a.setLayer('shadows', false); a.setLayer('terrain', false);
                        await new Promise((r) => setTimeout(r, 1500));
                        const d = a.stats().drawCalls;
                        for (const l of ['context', 'trees', 'shadows', 'terrain']) a.setLayer(l, true);
                        a.setSun({ preset: 'winter', hour: 12.5 });
                        a.setView('aerial');
                        await new Promise((r) => setTimeout(r, 1500));
                        return d;
                    });
                    info.drawCallsAllLayersOff = drawsOff;
                    if (!(drawsOff < info.stats.drawCalls)) errors.push(`layers off did not reduce draw calls (${drawsOff})`);

                    // Real click at the centre of the free canvas area (the aerial orbit target sits inside the
                    // mass): screenToRay + core.pickFloor must select a floor and show the floor card.
                    const c = await page.evaluate(() => { const p = document.getElementById('panel').getBoundingClientRect(); return { x: (p.right + innerWidth) / 2, y: innerHeight / 2 }; });
                    await page.mouse.click(c.x, c.y);
                    await page.waitForTimeout(1200);
                    const pick = await page.evaluate(() => ({ selected: window.__app.state().selected, card: !document.getElementById('floor-card').hidden }));
                    info.pickedFloor = pick.selected;
                    if (!(pick.selected >= 1) || !pick.card) errors.push(`click pick failed: ${JSON.stringify(pick)}`);
                    await page.screenshot({ path: join(shots, `${tag}-pick.png`) });
                    await page.keyboard.press('Escape');

                    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
                    if (scroll > 0) errors.push(`horizontal overflow ${scroll}px`);
                } catch (e) { errors.push(`test API: ${e.message}`); }
            }
            if (vp.id === 'mobile') {
                const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
                if (scroll > 0) errors.push(`mobile horizontal overflow ${scroll}px`);
                try {
                    // bottom sheet: expand (scene re-frames above it), screenshot, collapse
                    await page.click('#sheet-toggle');
                    await page.waitForTimeout(1500);
                    const open = await page.evaluate(() => document.getElementById('panel').dataset.expanded);
                    await page.screenshot({ path: join(shots, `${tag}-sheet.png`) });
                    await page.click('#sheet-toggle');
                    const closed = await page.evaluate(() => document.getElementById('panel').dataset.expanded);
                    if (open !== 'true' || closed !== 'false') errors.push(`sheet toggle: ${open} / ${closed}`);
                } catch (e) { errors.push(`sheet: ${e.message}`); }
            }
            console.log(JSON.stringify({ page: tag, loadMs, errors, ...info }, null, 1));
            if (errors.length) failed = true;
            await ctx.close();
        }
    }
}
await browser.close();
process.exit(failed ? 1 : 0);

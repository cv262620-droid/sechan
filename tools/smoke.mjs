// Headless smoke test: loads each dist page in Chromium (SwiftShader WebGL), serving the engine
// CDN URLs from node_modules, then checks for errors, exercises the test API and saves screenshots.
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
for (const name of pages) {
    const distFile = join(root, 'dist', `${name}.html`);
    const wrapped = join(shots, `${name}.wrapped.html`);
    writeFileSync(wrapped, wrap(readFileSync(distFile, 'utf8')));
    for (const vp of [{ id: 'desktop', width: 1440, height: 900 }, { id: 'mobile', width: 400, height: 860 }]) {
        for (const scheme of vp.id === 'desktop' ? ['light', 'dark'] : ['light']) {
            const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, deviceScaleFactor: 1 });
            const page = await ctx.newPage();
            const errors = [];
            page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
            page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
            await page.route('**/*', async (route) => {
                const url = route.request().url();
                if (url.startsWith('file:')) return route.continue();
                const local = cdnToLocal(url);
                if (local) return route.fulfill({ status: 200, contentType: 'application/javascript', body: readFileSync(local) });
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
                    for (const view of ['pedestrian', 'top']) {
                        await page.evaluate((v) => window.__app.setView(v), view);
                        await page.waitForTimeout(1200);
                        await page.screenshot({ path: join(shots, `${tag}-${view}.png`) });
                    }
                    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
                    if (scroll > 0) errors.push(`horizontal overflow ${scroll}px`);
                } catch (e) { errors.push(`test API: ${e.message}`); }
            }
            if (vp.id === 'mobile') {
                const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
                if (scroll > 0) errors.push(`mobile horizontal overflow ${scroll}px`);
            }
            console.log(JSON.stringify({ page: tag, loadMs, errors, ...info }, null, 1));
            if (errors.length) failed = true;
            await ctx.close();
        }
    }
}
await browser.close();
process.exit(failed ? 1 : 0);

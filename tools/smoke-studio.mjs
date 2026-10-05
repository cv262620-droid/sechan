// Headless smoke test for dist/studio.html (OHSOLV Studio canvas test).
// Wraps the page in the artifact host skeleton, serves jsDelivr URLs from node_modules, stubs Google Fonts,
// then for desktop light / desktop dark / 400 px mobile: waits for window.__studio.ready, screenshots the 2D view,
// runs the edit flow (store API + real mouse events on the canvas), an invalid bow-tie draft, JSON copy/paste,
// the MAP and 3D tabs, and the narrow-screen drawers. Fails on console errors, blocked external requests,
// horizontal overflow or a broken flow.
// Usage: node tools/build.mjs studio && node tools/smoke-studio.mjs      -> screenshots in .shots/studio-*.png
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, '.shots');
mkdirSync(shots, { recursive: true });

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
const typeOf = (f) => (f.endsWith('.css') ? 'text/css' : f.endsWith('.json') ? 'application/json' : 'application/javascript');

const distFile = join(root, 'dist', 'studio.html');
if (!existsSync(distFile)) { console.error('dist/studio.html missing: run node tools/build.mjs studio'); process.exit(1); }
const wrapped = join(shots, 'studio.wrapped.html');
writeFileSync(wrapped, wrap(readFileSync(distFile, 'utf8')));

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});

const scenarios = [
    { id: 'desktop', width: 1440, height: 900, scheme: 'light', full: true },
    { id: 'desktop-dark', width: 1440, height: 900, scheme: 'dark' },
    { id: 'mobile', width: 400, height: 860, scheme: 'light', mobile: true },
];
let failed = false;

for (const sc of scenarios) {
    const context = await browser.newContext({
        viewport: { width: sc.width, height: sc.height }, colorScheme: sc.scheme, deviceScaleFactor: 1,
        isMobile: !!sc.mobile, hasTouch: !!sc.mobile,
    });
    const page = await context.newPage();
    const errors = [], notes = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await page.route('**/*', async (route) => {
        const url = route.request().url();
        if (url.startsWith('file:') || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
        const local = cdnToLocal(url);
        if (local) return route.fulfill({ status: 200, contentType: typeOf(local), headers: { 'Access-Control-Allow-Origin': '*' }, body: readFileSync(local) });
        if (/fonts\.(googleapis|gstatic)\.com/.test(url)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
        errors.push(`blocked external request: ${url}`);
        return route.abort();
    });
    const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: join(shots, `${name}.png`) }); notes.push(`shot ${name}.png`); };
    const check = (cond, msg) => { if (!cond) errors.push(`check failed: ${msg}`); };
    const overflow = async (label) => {
        const o = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - window.innerWidth, body: document.body.scrollWidth - window.innerWidth }));
        if (o.doc > 0 || o.body > 0) errors.push(`horizontal overflow (${label}): ${JSON.stringify(o)}`);
    };
    const S = (fn, arg) => page.evaluate(fn, arg);
    const suffix = sc.id === 'desktop' ? '' : sc.id === 'desktop-dark' ? '-dark' : '-mobile';

    const t0 = Date.now();
    await page.goto(pathToFileURL(wrapped).href);
    try {
        await page.waitForFunction(() => window.__studio && window.__studio.ready === true, null, { timeout: 30000 });
    } catch { errors.push('timeout: window.__studio.ready never became true'); }
    const loadMs = Date.now() - t0;
    await page.waitForTimeout(400);
    await shot(`studio-2d${suffix}`);
    await overflow('2D initial');

    try {
        const init = await S(() => { const st = __studio.store.getState(); return { rev: st.site.current, area: st.site.revisions[0].area, tab: st.ui.tab }; });
        check(init.rev === 1 && Math.abs(init.area - 1255.5) < 0.01 && init.tab === '2D', `initial state r1 1255.5 ㎡ on 2D (${JSON.stringify(init)})`);

        if (sc.full) {
            // ---------- store API flow ----------
            const api = await S(() => {
                const s = __studio.store;
                s.startDraft(null, 'DIRECT');
                for (const p of [[-30, -20], [30, -20], [30, 18], [0, 28], [-30, 18]]) s.edit({ type: 'add', p });
                s.edit({ type: 'close' });
                const closedOk = s.getState().site.draft.validation.ok;
                const poly = s.getState().site.draft.polygon.map((p) => p.slice());
                poly[1] = [34, -20];
                s.preview(poly); s.endPreview(true);
                const moved = s.getState().site.draft.polygon[1][0];
                s.undo();
                const undone = s.getState().site.draft.polygon[1][0];
                s.redo();
                const rev = s.adoptDraft('store API 시험');
                const area = s.getState().site.revisions.find((r) => r.rev === rev).area;
                const restored = s.restoreRevision(1);
                const same = JSON.stringify(s.getState().site.revisions.find((r) => r.rev === restored).polygon) === JSON.stringify(s.getState().site.revisions[0].polygon);
                return { closedOk, moved, undone, rev, area, restored, same };
            });
            check(api.closedOk && api.moved === 34 && api.undone === 30 && api.rev === 2 && api.restored === 3 && api.same, `store API flow ${JSON.stringify(api)}`);
            notes.push(`store API: ${JSON.stringify(api)}`);
            await page.waitForTimeout(200);

            // ---------- real mouse flow on the canvas ----------
            const W = (p) => S((q) => __studio.view('2D').worldToClient(q), p);
            await page.click('#p2-tool-draw');
            const pts = [[-24, -14], [22, -14], [26, 6], [4, 20], [-24, 12]];
            for (const p of pts) { const c = await W(p); await page.mouse.move(c.x, c.y, { steps: 3 }); await page.mouse.click(c.x, c.y); await page.waitForTimeout(60); }
            const last = await W([-10, 0]);
            await page.mouse.move(last.x, last.y, { steps: 4 });
            await shot('studio-2d-drawing');
            const first = await W(pts[0]);
            await page.mouse.move(first.x, first.y, { steps: 4 });
            await page.mouse.click(first.x, first.y);
            await page.waitForTimeout(150);
            const drawn = await S(() => { const d = __studio.store.getState().site.draft; return d && { n: d.polygon.length, closed: d.closed, ok: d.validation.ok, area: d.validation.area, tool: __studio.store.getState().ui.tool, poly: d.polygon }; });
            check(drawn && drawn.n === 5 && drawn.closed && drawn.ok && drawn.tool === 'select', `mouse draw 5 points + close ${JSON.stringify(drawn)}`);
            await page.mouse.move(first.x + 200, first.y + 140);
            await shot('studio-2d-drawn');

            // drag vertex P3 (26, 6) -> (30, 10)
            const a = await W([26, 6]), b = await W([30, 10]);
            await page.mouse.move(a.x, a.y, { steps: 2 });
            await page.mouse.down();
            await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
            await page.mouse.move(b.x, b.y, { steps: 4 });
            await shot('studio-2d-dragging');
            await page.mouse.up();
            await page.waitForTimeout(120);
            const dragged = await S(() => __studio.store.getState().site.draft.polygon[2]);
            check(Math.abs(dragged[0] - 30) < 0.01 && Math.abs(dragged[1] - 10) < 0.01, `vertex drag snapped to (30,10): ${JSON.stringify(dragged)}`);
            await shot('studio-2d-dragged');

            // undo via keyboard
            await page.keyboard.press('Control+z');
            await page.waitForTimeout(120);
            const undone = await S(() => __studio.store.getState().site.draft.polygon[2]);
            check(undone[0] === 26 && undone[1] === 6, `Ctrl+Z restores P3: ${JSON.stringify(undone)}`);

            // numeric edit in the Inspector: select P2 by clicking, type E
            const p2 = await W([22, -14]);
            await page.mouse.click(p2.x, p2.y);
            await page.waitForTimeout(150);
            const selKind = await S(() => __studio.store.getState().selection);
            check(selKind && selKind.kind === 'vertex' && selKind.i === 1, `click selects P2: ${JSON.stringify(selKind)}`);
            await page.fill('#insp-v-e', '23.25');
            await page.press('#insp-v-e', 'Enter');
            await page.waitForTimeout(150);
            const numeric = await S(() => __studio.store.getState().site.draft.polygon[1]);
            check(numeric[0] === 23.25 && numeric[1] === -14, `Inspector E input: ${JSON.stringify(numeric)}`);
            await shot('studio-2d-vertex-inspector');

            // edge length via Inspector
            await S(() => __studio.store.select({ kind: 'edge', i: 0 }));
            await page.waitForTimeout(120);
            await page.fill('#insp-e-len', '48');
            await page.press('#insp-e-len', 'Enter');
            await page.waitForTimeout(150);
            const edgeLen = await S(() => { const p = __studio.store.getState().site.draft.polygon; return Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]); });
            check(Math.abs(edgeLen - 48) < 0.001, `edge length input -> 48 m (got ${edgeLen})`);
            await shot('studio-2d-edge-inspector');

            // adopt via the Inspector button
            await page.fill('#adopt-note', '스모크 시험 채택');
            await page.click('#btn-draft-adopt');
            await page.waitForTimeout(250);
            const adopted = await S(() => { const st = __studio.store.getState(); const r = st.site.revisions.find((x) => x.rev === st.site.current); return { cur: st.site.current, n: st.site.revisions.length, draft: !!st.site.draft, mode: r.dataMode, note: r.note, area: r.area }; });
            check(adopted.cur === 4 && adopted.n === 4 && !adopted.draft && adopted.mode === 'USER_PROVIDED' && adopted.note === '스모크 시험 채택', `adopt -> r4 ${JSON.stringify(adopted)}`);
            notes.push(`adopted: ${JSON.stringify(adopted)}`);
            await shot('studio-2d-adopted');

            // restore r1 from the revisions list
            await page.click('#btn-restore-1');
            await page.waitForTimeout(200);
            const rest = await S(() => { const st = __studio.store.getState(); return { cur: st.site.current, src: st.site.revisions.at(-1).source }; });
            check(rest.cur === 5 && rest.src === 'RESTORE', `restore r1 -> r5 ${JSON.stringify(rest)}`);

            // ---------- invalid bow-tie ----------
            await S(() => {
                __studio.store.startDraft([[-22, -14], [20, 12], [20, -14], [-16, 16]], 'DIRECT');
                __studio.view('2D').fit();
            });
            await page.waitForTimeout(200);
            const bow = await S(() => { const d = __studio.store.getState().site.draft; return { codes: d.validation.issues.map((i) => i.code), disabled: document.getElementById('btn-draft-adopt').disabled }; });
            check(bow.codes.includes('SELF_INTERSECT') && bow.disabled, `bow-tie shows SELF_INTERSECT and blocks adopt ${JSON.stringify(bow)}`);
            await shot('studio-2d-invalid');
            let threw = false;
            await S(() => { try { __studio.store.adoptDraft(); return false; } catch (e) { return true; } }).then((v) => { threw = v; });
            check(threw, 'adoptDraft throws on invalid draft');
            await page.click('#btn-draft-cancel');
            await page.waitForTimeout(150);
            check(await S(() => __studio.store.getState().site.draft === null), 'cancel removes the draft');

            // ---------- JSON copy / paste ----------
            await page.click('#btn-export');
            await page.waitForTimeout(300);
            const exp = await S(() => ({ dialog: !document.getElementById('dlg').hidden, toast: !document.getElementById('toast').hidden }));
            check(exp.dialog || exp.toast, `JSON copy gives a toast or the fallback textarea ${JSON.stringify(exp)}`);
            if (exp.dialog) await page.click('#dlg-close');
            const json = await S(() => __studio.store.serialize());
            await page.click('#btn-import');
            await page.fill('#dlg-text', '{"format":"wrong"}');
            await page.click('#dlg-ok');
            const impErr = await page.textContent('#dlg-err');
            check(/불러올 수 없습니다/.test(impErr), `invalid JSON shows an error (${impErr})`);
            await shot('studio-json-import-error');
            await page.fill('#dlg-text', json);
            await page.click('#dlg-ok');
            await page.waitForTimeout(150);
            const imp = await S(() => ({ open: !document.getElementById('dlg').hidden, n: __studio.store.getState().site.revisions.length }));
            check(!imp.open && imp.n === 5, `valid JSON imports (${JSON.stringify(imp)})`);

            // persistence (browser temp copy)
            await S(() => __studio.persistNow());
            const ls = await S(() => { try { return JSON.parse(localStorage.getItem('ohsolv-studio-test:v1')).site.revisions.length; } catch (e) { return -1; } });
            check(ls === 5, `localStorage temp copy has 5 revisions (${ls})`);
            const chip = await page.textContent('#save-chip');
            check(/서버 저장 아님/.test(chip) && !/저장됨/.test(chip), `save chip is honest (${chip})`);
        }

        // ---------- MAP ----------
        const hasMap = await S(() => typeof window.createMapView === 'function');
        const mapRes = await S(() => Promise.race([__studio.setTab('MAP'), new Promise((r) => setTimeout(() => r({ ok: false, error: 'timeout 60s' }), 60000))]));
        notes.push(`MAP: factory=${hasMap} ${JSON.stringify(mapRes)}`);
        if (hasMap) check(mapRes && mapRes.ok, `MAP view activates (${JSON.stringify(mapRes)})`);
        await page.waitForTimeout(1200);
        await shot(`studio-map${suffix}`);
        await overflow('MAP');
        if (sc.full) {
            await S(() => __studio.store.select({ kind: 'parcel', id: 'P078' }));
            await page.waitForTimeout(500);
            await shot('studio-map-parcel');
            await page.click('#btn-parcel-draft');
            await page.waitForTimeout(500);
            const pd = await S(() => { const d = __studio.store.getState().site.draft; return d && { src: d.source, ok: d.validation.ok, area: d.validation.area }; });
            check(pd && pd.src === 'PARCEL' && pd.ok && Math.abs(pd.area - 713) < 0.01, `parcel draft from P078 ${JSON.stringify(pd)}`);
            await shot('studio-map-parcel-draft');
        }

        // ---------- 3D ----------
        const res3 = await S(() => Promise.race([__studio.setTab('3D'), new Promise((r) => setTimeout(() => r({ ok: false, error: 'timeout 90s' }), 90000))]));
        notes.push(`3D: ${JSON.stringify(res3)}`);
        await page.waitForTimeout(800);
        await shot(`studio-3d${suffix}`);
        await overflow('3D');

        // back to 2D (view resumes)
        await S(() => __studio.setTab('2D'));
        await page.waitForTimeout(300);
        if (sc.full) {
            await shot('studio-2d-parcel-draft');
            // the parcel draft made on MAP is in view on 2D, and the status line no longer talks about 3D
            const vis = await S(() => {
                const d = __studio.store.getState().site.draft, r = document.getElementById('p2-canvas').getBoundingClientRect();
                const pts = d.polygon.map((p) => __studio.view('2D').worldToClient(p));
                return { inView: pts.every((q) => q.x >= r.left && q.x <= r.right && q.y >= r.top && q.y <= r.bottom), status: document.getElementById('status-text').textContent };
            });
            check(vis.inView && !/3D/.test(vis.status), `parcel draft from MAP is visible on 2D, status follows the tab ${JSON.stringify(vis)}`);

            // keyboard drawing over the parcel draft: D, clicks, Backspace, Enter; undo back; Esc returns to it
            const Wc = (q) => S((x) => __studio.view('2D').worldToClient(x), q);
            const clickW = async (q) => { const c = await Wc(q); await page.mouse.move(c.x, c.y, { steps: 2 }); await page.mouse.click(c.x, c.y); await page.waitForTimeout(50); };
            await page.focus('#p2-canvas');
            await page.keyboard.press('d');
            for (const q of [[-40, -10], [-25, -10], [-25, 5]]) await clickW(q);
            await page.keyboard.press('Backspace');
            const afterBs = await S(() => __studio.store.getState().site.draft.polygon.length);
            check(afterBs === 2, `Backspace removes the last point (${afterBs})`);
            await clickW([-31, 8]);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(100);
            const kb = await S(() => { const st = __studio.store.getState(); return { n: st.site.draft.polygon.length, closed: st.site.draft.closed, tool: st.ui.tool }; });
            check(kb.n === 3 && kb.closed && kb.tool === 'select', `Enter closes the boundary ${JSON.stringify(kb)}`);
            await S(() => { const s = __studio.store; for (let g = 0; g < 20 && s.canUndo(); g++) { s.undo(); const d = s.getState().site.draft; if (d.closed && d.source === 'PARCEL') break; } });
            await page.focus('#p2-canvas');
            await page.keyboard.press('d');
            for (const q of [[-40, -10], [-25, -10]]) await clickW(q);
            await page.keyboard.press('Escape');
            await page.waitForTimeout(100);
            const esc = await S(() => { const st = __studio.store.getState(); const d = st.site.draft; return { src: d && d.source, closed: d && d.closed, n: d && d.polygon.length, tool: st.ui.tool }; });
            check(esc.src === 'PARCEL' && esc.closed && esc.n === 4 && esc.tool === 'select', `Esc while drawing returns to the earlier draft ${JSON.stringify(esc)}`);

            // context building -> Inspector shows ASSUMED height
            await S(() => __studio.store.select({ kind: 'building', id: 'BLD075' }));
            await page.waitForTimeout(200);
            const bTxt = await page.textContent('#insp-body');
            check(/ASSUMED/.test(bTxt) && /층수/.test(bTxt), 'building Inspector shows ASSUMED height and floors');
            await shot('studio-2d-building');

            // 2D canvas follows an explicit theme switch (host sets data-theme on <html>)
            const lum = () => S(() => {
                const c = document.getElementById('p2-canvas'), g = c.getContext('2d');
                const d = g.getImageData(0, 0, c.width, c.height).data;
                let s = 0; for (let i = 0; i < d.length; i += 64) s += d[i] + d[i + 1] + d[i + 2];
                return s / (d.length / 64) / 3;
            });
            const before = await lum();
            await S(() => document.documentElement.setAttribute('data-theme', 'dark'));
            await page.waitForTimeout(400);
            const after = await lum();
            check(after < before - 40, `2D canvas redraws dark on data-theme="dark" (mean ${before.toFixed(0)} -> ${after.toFixed(0)})`);
            await shot('studio-2d-theme-dark-attr');
            await S(() => document.documentElement.removeAttribute('data-theme'));
            await page.waitForTimeout(300);

            // reload restores the browser temp copy (revisions + draft)
            await S(() => __studio.persistNow());
            await page.reload();
            await page.waitForFunction(() => window.__studio && window.__studio.ready === true, null, { timeout: 30000 });
            await page.waitForTimeout(300);
            const re = await S(() => { const st = __studio.store.getState(); return { n: st.site.revisions.length, cur: st.site.current, draft: st.site.draft && st.site.draft.source, tab: st.ui.tab, toast: document.getElementById('toast').textContent }; });
            check(re.n === 5 && re.cur === 5 && re.draft === 'PARCEL' && re.tab === '2D' && /임시본/.test(re.toast), `reload restores temp copy ${JSON.stringify(re)}`);
            await shot('studio-2d-reloaded');

            // garbage coordinate (NAN) never costs the revisions on reload; an unchanged draft cannot be adopted
            await S(() => { const s = __studio.store; s.edit({ type: 'setVertex', i: 1, p: ['abc', 0] }); __studio.persistNow(); });
            await page.waitForTimeout(700);
            const nanCard = await S(() => ({ codes: __studio.store.getState().site.draft.validation.issues.map((i) => i.code), disabled: document.getElementById('btn-draft-adopt').disabled }));
            check(nanCard.codes.includes('NAN') && nanCard.disabled, `NAN shown and adoption blocked ${JSON.stringify(nanCard)}`);
            await shot('studio-2d-nan');
            await page.reload();
            await page.waitForFunction(() => window.__studio && window.__studio.ready === true, null, { timeout: 30000 });
            await page.waitForTimeout(300);
            const re2 = await S(() => { const st = __studio.store.getState(); return { n: st.site.revisions.length, nan: !!(st.site.draft && st.site.draft.validation.issues.some((i) => i.code === 'NAN')) }; });
            check(re2.n === 5 && re2.nan, `reload with a NaN draft keeps revisions ${JSON.stringify(re2)}`);
            await S(() => { const s = __studio.store; s.cancelDraft(); s.edit({ type: 'move', i: 0, p: s.currentRevision().polygon[0] }); });
            await page.waitForTimeout(700);
            const same = await S(() => ({ disabled: document.getElementById('btn-draft-adopt').disabled, note: !!document.getElementById('dc-unchanged') }));
            check(same.disabled && same.note, `unchanged draft: adopt disabled with a note ${JSON.stringify(same)}`);
            await S(() => __studio.store.cancelDraft());
        }

        if (sc.mobile) {
            await page.click('#btn-drawer-left');
            await page.waitForTimeout(300);
            await shot('studio-2d-mobile-left');
            await overflow('mobile left drawer');
            await page.click('#scrim', { position: { x: 380, y: 400 } });
            await page.click('#btn-drawer-right');
            await page.waitForTimeout(300);
            await shot('studio-2d-mobile-right');
            await overflow('mobile right drawer');
            await page.click('#btn-close-right');
            // no horizontal page scroll at other widths
            for (const w of [320, 600, 900, 1024, 1280]) {
                await page.setViewportSize({ width: w, height: 800 });
                await page.waitForTimeout(250);
                await overflow(`width ${w}`);
                if (w === 900 || w === 1024) await shot(`studio-2d-w${w}`);
            }
        }
    } catch (e) {
        errors.push(`flow: ${e.message.split('\n')[0]}`);
        try { await shot(`studio-fail${suffix}`); } catch { /* ignore */ }
    }

    console.log(JSON.stringify({ scenario: sc.id, loadMs, errors, notes }, null, 1));
    if (errors.length) failed = true;
    await context.close();
}
await browser.close();
console.log(failed ? 'SMOKE STUDIO: FAIL' : 'SMOKE STUDIO: OK');
process.exit(failed ? 1 : 0);

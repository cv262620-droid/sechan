// 3D view — the adopted site revision + synthetic context (roads, blocks, parcels, context buildings, trees,
// outer terrain) in Babylon.js 9.29.0 (default), PlayCanvas 2.23.0 or three.js 0.186.1, loaded the first time
// the tab is activated. Rendering is done by the mass-study adapters (docs/SPEC.md) fed with
// STUDIO_CORE.makeEngineCore(adopted polygon): the engine origin sits at the site centroid, context buildings
// that overlap the site are left out (core.excluded), and the planned mass is empty (no M03 yet).
// Drafts are never shown in 3D: only the adopted revision (store.site.current).
//
// create3DView(container, store, ctx) → {
//   activate(): Promise<{ok, error?}>   first call loads the engine and builds the scene; resolves once the scene
//                                       is drawn (or the error card is up). Later calls resume the render loop,
//                                       or rebuild if the revision / engine changed meanwhile.
//   deactivate()                        adapter.pause(): no frames, no GPU work while the tab is hidden
//   dispose()                           adapter.dispose() (releases the WebGL context), unsubscribes, removes DOM
//   fit()                               setView('aerial')
//   setView(name), whenIdle(): Promise, debug(), adapter      (tests / tools)
// }
// ctx: { onStatus?(text, kind), isMobile?: boolean | () => boolean }
function create3DView(container, store, ctx) {
    'use strict';
    ctx = ctx || {};
    const C = STUDIO_CORE;
    const LOAD_TIMEOUT_MS = 45000;
    const ENGINES = {
        babylon: {
            name: 'Babylon.js', version: '9.29.0', url: 'https://cdn.jsdelivr.net/npm/babylonjs@9.29.0/babylon.js',
            loaded: () => !!(window.BABYLON && window.BABYLON.Engine), factory: () => window.createBabylonAdapter,
        },
        playcanvas: {
            name: 'PlayCanvas', version: '2.23.0', url: 'https://cdn.jsdelivr.net/npm/playcanvas@2.23.0/build/playcanvas.min.js',
            loaded: () => !!(window.pc && window.pc.AppBase), factory: () => window.createPlayCanvasAdapter,
        },
        // three is ESM-only: the adapter imports the module itself and caches the promise on window; loading it here
        // first (same cache) only separates the download time from the scene time.
        three: {
            name: 'three.js', version: '0.186.1', module: 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js',
            loaded: () => !!window.__threeModuleReady, factory: () => window.createThreeAdapter,
        },
    };
    const ORDER = ['babylon', 'playcanvas', 'three'];
    const VIEWS = [['aerial', '조감'], ['pedestrian', '보행자'], ['top', '평면'], ['north', '북측']];
    const SUN = { preset: 'equinox', hour: 14, label: '춘·추분 14:00' };
    const isMobile = () => (typeof ctx.isMobile === 'function' ? !!ctx.isMobile() : !!ctx.isMobile);
    const fmt = (v, d) => (Number.isFinite(v) ? v.toLocaleString('ko-KR', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }) : '—');
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    let active = false, disposed = false;
    let built = null;        // { engine, rev, hash, adapter, canvas, core, excluded, engineMs, sceneMs, cached }
    let failed = null;       // { engine, hash, rev, error }
    let phase = 'idle';      // 'idle' | 'loading' | 'ready' | 'error'
    let loop = null;         // running build loop (promise)
    let buildCount = 0, view = 'aerial', lastStatus = '', reason = 'first', lastTry = null;
    let wakeWaiters = [];
    let changeWaiters = [];  // builds waiting on an engine download: woken when the wanted engine / site changes
    let pollTimer = 0, northRaf = 0, lastHeading = NaN;

    injectStyleOnce();

    // ---------- DOM ----------
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    const root = el('div', 'v3-root');
    const stage = el('div', 'v3-stage');
    const bar = el('div', 'v3-bar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '3D 보기 도구');
    bar.innerHTML =
        `<div class="v3-seg" role="group" aria-label="렌더링 엔진">${ORDER.map((k) => `<button type="button" class="btn btn--sm" data-engine="${k}" aria-pressed="false" title="${ENGINES[k].name} ${ENGINES[k].version}">${ENGINES[k].name}</button>`).join('')}</div>` +
        `<div class="v3-seg" role="group" aria-label="시점">${VIEWS.map(([k, ko]) => `<button type="button" class="btn btn--sm" data-view="${k}" aria-pressed="false">${ko}</button>`).join('')}</div>` +
        `<span class="v3-sun" title="태양 위치: 서울 37.57N, 춘·추분(3/20) 14:00 KST">태양 ${SUN.label}</span>`;
    const north = el('div', 'v3-north');
    north.innerHTML = '<svg viewBox="0 0 40 40" role="img" aria-label="방위표: 화살표가 북쪽"><circle cx="20" cy="20" r="18" class="v3-n-bg"/>' +
        '<g class="v3-n-rot"><path d="M20 5 L26 27 L20 23 Z" fill="currentColor"/><path d="M20 5 L14 27 L20 23 Z" fill="none" stroke="currentColor" stroke-width="1"/>' +
        '<text x="20" y="36" text-anchor="middle" font-size="8.5" fill="currentColor">N</text></g></svg>';
    const northRot = north.querySelector('.v3-n-rot');
    const foot = el('div', 'v3-foot');
    foot.innerHTML = '<span class="v3-status" id="v3-status"></span><span class="v3-notes" id="v3-notes"></span>';
    const statusEl = foot.querySelector('.v3-status'), notesEl = foot.querySelector('.v3-notes');
    const msg = el('div', 'placeholder v3-msg');
    msg.hidden = true;
    root.append(stage, bar, north, foot, msg);
    container.appendChild(root);
    north.hidden = true;

    bar.addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (!b || b.disabled) return;
        if (b.dataset.engine) { store.setEngine(b.dataset.engine); return; }
        if (b.dataset.view) setView(b.dataset.view);
    });
    msg.addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (b && b.dataset.act === 'retry') { failed = null; ensure(); }
    });

    const onLayout = () => {
        const w = root.clientWidth;
        if (w > 0) root.classList.toggle('v3-narrow', w < 640 || isMobile());
    };
    let ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(onLayout); ro.observe(root); } else window.addEventListener('resize', onLayout);
    onLayout();

    // ---------- store ----------
    const unsubscribe = store.subscribe((st, prev) => {
        if (st.layers !== prev.layers) { applyLayers(); renderNotes(); }
        const siteChanged = st.site.current !== prev.site.current || st.site.revisions !== prev.site.revisions;
        if (st.ui.engine !== prev.ui.engine) renderBar();
        if (!!st.site.draft !== !!prev.site.draft) renderNotes();
        if (siteChanged || st.ui.engine !== prev.ui.engine) {
            wakeChanged();
            if (active) ensure();       // rebuild now (or relabel when the polygon is unchanged)
            else renderStatus();        // rebuilt on the next activate()
        }
    });

    renderBar();
    renderNotes();

    // ================= lifecycle =================
    function activate() {
        if (disposed) return Promise.reject(new Error('3D view disposed'));
        active = true;
        onLayout();
        const w = wakeWaiters; wakeWaiters = [];
        for (const f of w) f();
        if (built && upToDate(wanted())) {
            built.rev = wanted().rev;
            resumeAdapter();
            renderStatus();
            report();
            return Promise.resolve({ ok: true });
        }
        return ensure();
    }

    function deactivate() {
        active = false;
        stopPoll();
        if (built && built.adapter && typeof built.adapter.pause === 'function') built.adapter.pause();
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        deactivate();
        teardown();
        try { unsubscribe(); } catch (e) { /* ignore */ }
        wakeChanged();
        if (ro) ro.disconnect(); else window.removeEventListener('resize', onLayout);
        const w = wakeWaiters; wakeWaiters = [];
        for (const f of w) f();
        root.remove();
    }

    function fit() { setView('aerial'); }

    function setView(name) {
        if (!VIEWS.some(([k]) => k === name)) return;
        view = name;
        if (built && built.adapter) built.adapter.setView(name, framingFor(name));
        renderBar();
    }

    // ================= site-aware framing =================
    // The adapters' presets are tuned for the mass-study site (open block, a tower in the middle). An arbitrary
    // adopted parcel usually sits among 20-70 m context buildings, so a fixed 32-degree aerial from SSE often shows
    // only the building in front. Per site (engine-core local metres, site centroid = origin) pick the aerial /
    // north elevation that clears the context buildings toward the camera, and a pedestrian eye on the street
    // with a clear line of sight to the site. Passed to adapter.setView(name, override); 'top' keeps the preset.
    function computeFraming(core) {
        const DEG = Math.PI / 180, PLAT = 0.15;
        const D = core.data || {};
        const parts = [];
        for (const b of D.buildings || []) for (const q of b.parts) parts.push({ e0: q.e0, e1: q.e1, n0: q.n0, n1: q.n1, top: q.y1 + PLAT });
        const plats = (D.blocks || []).map((b) => ({ e0: b.e0 - b.pad.w, e1: b.e1 + b.pad.e, n0: b.n0 - b.pad.s, n1: b.n1 + b.pad.n }));
        const roads = D.roads || [];
        const trees = D.trees || [];
        const site = core.sitePolygon || [];
        let R = 0;
        for (const [e, n] of site) R = Math.max(R, Math.hypot(e, n));
        R = Math.max(R, 8);
        const angDiff = (a, b) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);
        const inside = (p, r, g) => p[0] > r.e0 - g && p[0] < r.e1 + g && p[1] > r.n0 - g && p[1] < r.n1 + g;
        // ray o + t d (t in [0, tMax]) against rect r grown by g → entry t or null
        function hit(o, d, r, g, tMax) {
            let t0 = 0, t1 = tMax;
            const lo = [r.e0 - g, r.n0 - g], hi = [r.e1 + g, r.n1 + g];
            for (let k = 0; k < 2; k++) {
                if (Math.abs(d[k]) < 1e-9) { if (o[k] < lo[k] || o[k] > hi[k]) return null; continue; }
                const a = (lo[k] - o[k]) / d[k], c = (hi[k] - o[k]) / d[k];
                t0 = Math.max(t0, Math.min(a, c)); t1 = Math.min(t1, Math.max(a, c));
            }
            return t0 < t1 ? t0 : null;
        }
        // Points that should stay visible: the site centre and each corner pulled 20 % toward it (a ray from
        // right on the boundary would graze the neighbour across the parcel line), on the ground.
        const probes = [[0, 0]].concat(site.map(([e, n]) => [e * 0.8, n * 0.8]));
        const dist = Math.max(240, R * 7);   // aerial distance (north: 170 m)
        const near = parts.filter((r) => Math.hypot(Math.max(r.e0, Math.min(0, r.e1)), Math.max(r.n0, Math.min(0, r.n1))) < dist + 40);
        // Does the sight line from ground point o to eye [e, n, up] pass through a context building (grown 0.5 m)?
        // Exact 3D test against the eye the camera will really have: from a finite distance the far side of the
        // site sees the eye lower than the camera elevation, so "elevation clears the roofs" alone is not enough.
        function blocked(o, eye) {
            const d = [eye[0] - o[0], eye[1] - o[1], eye[2] - PLAT];
            for (const r of near) {
                if (inside(o, r, 0)) continue;
                const lo = [r.e0 - 0.5, r.n0 - 0.5, 0], hi = [r.e1 + 0.5, r.n1 + 0.5, r.top], oo = [o[0], o[1], PLAT];
                let t0 = 0, t1 = 1, miss = false;
                for (let k = 0; k < 3 && !miss; k++) {
                    if (Math.abs(d[k]) < 1e-9) { miss = oo[k] < lo[k] || oo[k] > hi[k]; continue; }
                    const a = (lo[k] - oo[k]) / d[k], c = (hi[k] - oo[k]) / d[k];
                    t0 = Math.max(t0, Math.min(a, c)); t1 = Math.min(t1, Math.max(a, c));
                }
                if (!miss && t0 < t1) return true;
            }
            return false;
        }
        const eyeAt = (az, el, ty, dist) => {
            const c = Math.cos(el * DEG);
            return [dist * Math.sin(az * DEG) * c, dist * Math.cos(az * DEG) * c, ty + dist * Math.sin(el * DEG)];
        };
        const hidden = (eye) => probes.reduce((k, o) => k + (blocked(o, eye) ? 1 : 0), 0);
        // lowest elevation in [lo, hi] (2-degree steps) from which every probe sees the eye; when none does, the
        // elevation that hides the fewest (lowest of equals)
        function clearEl(az, ty, dist, lo, hi) {
            let best = null;
            for (let el = lo; el <= hi; el += 2) {
                const k = hidden(eyeAt(az, el, ty, dist));
                if (!best || k < best.k) best = { el, k };
                if (!k) break;
            }
            return best;
        }
        const out = {};
        // aerial: prefer SSE (the presets' 150 deg, sunlit faces at 14:00); go steeper or turn only as needed
        let best = null;
        for (let az = 0; az < 360; az += 15) {
            const c = clearEl(az, 0, dist, 32, 70);
            const score = c.el + 25 * c.k + 0.08 * angDiff(az, 150);
            if (!best || score < best.score) best = { score, az, el: c.el };
        }
        out.aerial = { target: [0, 0, 0], azimuth: best.az, elevation: best.el, distance: dist };
        out.north = { target: [0, 2, 0], azimuth: 0, elevation: clearEl(0, 2, 170, 18, 60).el, distance: 170 };
        // pedestrian: eye 1.6 m above a street or its sidewalk (never a gap between buildings inside a block) ~16 m
        // outside the site's corner radius, no building between it and the site centre, as much of the site in
        // sight and as few street-tree crowns on the sight line as possible
        const cores = D.blocks || [];
        let ped = null;
        for (let az = 0; az < 360; az += 15) {
            const d = [Math.sin(az * DEG), Math.cos(az * DEG)];
            for (let t = R + 6; t <= R + 70; t += 2) {
                const p = [t * d[0], t * d[1]];
                if (!roads.some((r) => inside(p, r, 0)) || cores.some((r) => inside(p, r, 0))) continue; // streets / sidewalks only
                if (parts.some((r) => inside(p, r, 1.5))) continue;
                if (trees.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 2.5)) continue;
                const back = [-d[0], -d[1]];
                if (parts.some((r) => hit(p, back, r, 0.5, t) != null)) continue;
                // street trees whose crown (r ≈ 1.8 m) sits on the sight line hide the site: count them
                let leafy = 0;
                for (const q of trees) {
                    const u = q[0] * d[0] + q[1] * d[1];        // along the line, from the site centre
                    if (u < R * 0.5 || u > t) continue;
                    if (Math.abs(q[0] * d[1] - q[1] * d[0]) < 2.2 * (q[2] || 1)) leafy++;
                }
                const k = hidden([p[0], p[1], 1.75]);
                const score = Math.abs(t - (R + 16)) + 0.12 * angDiff(az, 135) + 8 * leafy + 12 * k;
                if (!ped || score < ped.score) ped = { score, az, t, p };
            }
        }
        if (ped) {
            const ground = plats.some((r) => inside(ped.p, r, 0)) ? PLAT : 0;
            const eyeY = Math.max(1.75, ground + 1.6), ty = 6;
            out.pedestrian = {
                target: [0, ty, 0], azimuth: ped.az, elevation: Math.atan2(eyeY - ty, ped.t) / DEG,
                distance: Math.hypot(ped.t, eyeY - ty), fov: 70, eye: [ped.p[0], eyeY, -ped.p[1]], // eye: engine coords (info only)
            };
        }
        return out;
    }

    // Framing override for adapter.setView: portrait screens back off like the presets do.
    function framingFor(name) {
        const f = built && built.framing && built.framing[name];
        if (!f) return undefined;
        const w = stage.clientWidth || 1, h = stage.clientHeight || 1, aspect = w / h;
        const portrait = aspect < 1 ? Math.min(1.6, Math.sqrt(1 / aspect)) : 1;
        const o = { target: f.target, azimuth: f.azimuth, elevation: f.elevation, distance: name === 'pedestrian' ? f.distance : f.distance * portrait };
        if (f.fov) o.fov = f.fov;
        return o;
    }

    // ================= build loop =================
    function currentRev(st) { return st.site.revisions.find((r) => r.rev === st.site.current) || st.site.revisions[st.site.revisions.length - 1]; }
    function wanted() {
        const st = store.getState();
        const r = currentRev(st);
        return { engine: ENGINES[st.ui.engine] ? st.ui.engine : 'babylon', rev: r.rev, hash: r.inputHash, polygon: r.polygon, area: r.area };
    }
    const upToDate = (w) => !!built && built.engine === w.engine && built.hash === w.hash;
    const sameFailure = (w) => !!failed && failed.engine === w.engine && failed.hash === w.hash;
    const stale = (w) => disposed || (() => { const n = wanted(); return n.engine !== w.engine || n.hash !== w.hash; })();
    const waitActive = () => (active || disposed ? Promise.resolve() : new Promise((r) => wakeWaiters.push(r)));
    const untilChanged = () => new Promise((r) => changeWaiters.push(r));
    function wakeChanged() { const w = changeWaiters; changeWaiters = []; for (const f of w) f(); }

    function ensure() {
        if (!loop) {
            loop = run().finally(() => { loop = null; });
        }
        return loop;
    }

    async function run() {
        for (;;) {
            if (disposed) return { ok: false, error: 'disposed' };
            const w = wanted();
            if (upToDate(w)) {
                if (built.rev !== w.rev) { built.rev = w.rev; renderStatus(); report(); } // same polygon, new revision number
                return { ok: true };
            }
            if (sameFailure(w)) { status(`3D: ${failed.error.title}`, 'error'); return { ok: false, error: failed.error.message }; }
            await buildOnce(w);
        }
    }

    async function buildOnce(w) {
        const E = ENGINES[w.engine];
        buildCount++;
        // what the loading card says it is rebuilding for: a new engine or a new site revision
        reason = !lastTry ? 'first' : lastTry.engine !== w.engine ? 'engine' : lastTry.hash !== w.hash ? 'site' : 'again';
        lastTry = { engine: w.engine, hash: w.hash };
        teardown();
        failed = null;
        phase = 'loading';
        stopPoll();
        renderBar();
        let core = null;
        try { core = C.makeEngineCore(w.polygon); } catch (e) { /* reported below when the scene is built */ }
        const ex = core ? core.excluded : null;
        const cached = E.loaded();
        showLoading(w, ex, cached ? 'scene' : 'engine', null);
        if (!cached) status(`3D: ${E.name} ${E.version} 불러오는 중…`, 'info');
        let adapter = null, canvas = null;
        const t0 = performance.now();
        try {
            // another engine (or site) picked while this one downloads: move on now instead of waiting for the
            // download (up to LOAD_TIMEOUT_MS on a stalled CDN); the download itself goes on and stays cached
            const job = loadEngine(w.engine);
            while (!(await Promise.race([job.then(() => true), untilChanged().then(() => false)])) && !stale(w)) { /* same build still wanted */ }
            if (stale(w)) return;
            const engineMs = cached ? 0 : Math.round(performance.now() - t0);
            if (!active) await waitActive();       // tab left while the engine loaded → build when it comes back
            if (stale(w)) return;
            await waitForSize();
            if (stale(w)) return;
            showLoading(w, ex, 'scene', engineMs);
            status(`3D: 장면 만드는 중… 채택 r${w.rev} · ${E.name}`, 'info');
            if (!core) core = C.makeEngineCore(w.polygon);
            const factory = E.factory();
            if (typeof factory !== 'function') throw tagged(new Error(`${E.name} 어댑터가 이 빌드에 없습니다.`), 'scene');
            const t1 = performance.now();
            canvas = document.createElement('canvas');
            canvas.className = 'v3-canvas';
            canvas.setAttribute('aria-label', `채택 대지 r${w.rev} 3D 장면 (${E.name})`);
            stage.appendChild(canvas);
            adapter = await factory(canvas, core);
            if (!adapter || typeof adapter.init !== 'function') throw tagged(new Error('어댑터가 올바른 객체를 돌려주지 않았습니다.'), 'scene');
            if (stale(w)) return;
            await adapter.init();
            if (stale(w)) return;
            adapter.setMass(C.emptyMass(w.polygon));
            const sp = core.SUN_PRESETS[SUN.preset];
            const p = core.solarPosition({ month: sp.month, day: sp.day, hour: SUN.hour });
            adapter.setSun({ vector: core.sunVector(p.altitude, p.azimuth), altitude: p.altitude, azimuth: p.azimuth });
            let framing = {};
            try { framing = computeFraming(core); } catch (e) { console.warn('[studio] 3D framing fell back to presets', e); }
            built = {
                engine: w.engine, rev: w.rev, hash: w.hash, adapter, canvas, core, excluded: core.excluded || { buildings: 0, trees: 0 },
                engineMs, sceneMs: 0, cached, label: [adapter.engineName || E.name, adapter.engineVersion || E.version].join(' '), framing,
            };
            view = 'aerial';
            adapter.setView('aerial', framingFor('aerial'));
            adapter = null; canvas = null;        // owned by `built` now
            applyLayers();
            const mine = built;
            await nextFrame();
            if (built !== mine) return;           // disposed meanwhile
            built.sceneMs = Math.round(performance.now() - t1);
            phase = 'ready';
            hideMessage();
            renderBar();
            renderNotes();
            renderStatus();
            if (active) { startPoll(); report(); } else built.adapter.pause();
        } catch (err) {
            if (adapter) { try { adapter.dispose(); } catch (e) { /* half-built */ } }
            if (canvas) canvas.remove();
            adapter = null; canvas = null;
            if (stale(w)) return;
            const error = describe(err, E);
            failed = { engine: w.engine, hash: w.hash, rev: w.rev, error };
            phase = 'error';
            console.warn('[studio] 3D view failed', err);
            renderBar();
            showError(error, E);
            status(`3D: ${error.title}`, 'error');
        } finally {
            if (adapter) { try { adapter.dispose(); } catch (e) { /* ignore */ } }   // stale build: drop it
            if (canvas) canvas.remove();
        }
    }

    // Dispose the current adapter (releases its WebGL context) and remove its canvas.
    function teardown() {
        stopPoll();
        if (built) {
            const b = built;
            built = null;
            try { b.adapter.dispose(); } catch (e) { console.warn('[studio] 3D adapter dispose failed', e); }
            b.canvas.remove();
        }
        north.hidden = true;
        if (phase === 'ready') phase = 'idle';
    }

    function resumeAdapter() {
        if (!built) return;
        if (typeof built.adapter.resume === 'function') built.adapter.resume();
        startPoll();
    }

    // ================= engine loading =================
    function loadEngine(key) {
        const E = ENGINES[key];
        if (E.loaded()) return Promise.resolve();
        let timer = 0;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${E.name} 응답 없음(${LOAD_TIMEOUT_MS / 1000}초 시간 초과)`)), LOAD_TIMEOUT_MS);
        });
        const job = E.module ? loadThree(E.module) : loadScript(E.url).then(() => {
            if (!E.loaded()) throw new Error(`${E.name} 스크립트를 받았지만 엔진 객체가 없습니다.`);
        });
        return Promise.race([job, timeout]).then(() => clearTimeout(timer), (err) => {
            clearTimeout(timer);
            throw tagged(err, 'cdn');
        });
    }

    // Same cache key as createThreeAdapter (window.__threeModulePromise), so the adapter reuses this download.
    // A failed dynamic import stays in the document's module map (Chrome answers every later import() of that URL
    // with the same error, without a request), so a retry imports under a new module-map key: same URL plus a
    // fragment. The fragment is not sent, so the request (and the HTTP cache entry) is the same file.
    function loadThree(url) {
        if (!window.__threeModulePromise) {
            const n = window.__threeImportFailures || 0;
            window.__threeModulePromise = import(n ? `${url}#retry-${n}` : url).catch((err) => {
                window.__threeModulePromise = null; // allow a retry
                window.__threeImportFailures = n + 1;
                throw err;
            });
        }
        return window.__threeModulePromise.then((m) => { window.__threeModuleReady = true; return m; });
    }

    // Shared cached script loader (same as map.js): one <script> per URL, a failed load can be retried.
    function loadScript(src) {
        if (typeof window.__loadScript !== 'function') {
            const cache = new Map();
            window.__loadScript = function (url) {
                if (!cache.has(url)) {
                    cache.set(url, new Promise((resolve, reject) => {
                        const s = document.createElement('script');
                        s.src = url;
                        s.async = true;
                        s.onload = () => resolve();
                        s.onerror = () => { cache.delete(url); s.remove(); reject(new Error('스크립트를 불러오지 못했습니다: ' + url)); };
                        (document.head || document.documentElement).appendChild(s);
                    }));
                }
                return cache.get(url);
            };
        }
        return Promise.resolve(window.__loadScript(src));
    }

    function waitForSize() {
        return new Promise((resolve) => {
            let n = 0;
            const tick = () => {
                if (disposed || (stage.clientWidth > 0 && stage.clientHeight > 0) || ++n > 60) resolve();
                else requestAnimationFrame(tick);
            };
            tick();
        });
    }
    const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

    // ================= layers =================
    // Store layers → adapter layers. boundary / roads / parcels are part of the baked 3D ground (site band, asphalt,
    // parcel lines) and stay visible; the note in the footer says so.
    function applyLayers() {
        if (!built) return;
        const L = store.getState().layers;
        const a = built.adapter;
        a.setLayer('context', !!L.context);
        a.setLayer('trees', !!L.context);
        a.setLayer('terrain', !!L.terrain);
    }

    // ================= status / chrome =================
    function status(text, kind) {
        if (!active) return;   // never overwrite another tab's status line
        lastStatus = text;
        try { if (ctx.onStatus) ctx.onStatus(text, kind); } catch (e) { /* cosmetic */ }
    }
    function report() {
        if (!built) return;
        status(`3D 준비 · 채택 r${built.rev} · ${built.label} · 로드 ${fmt(built.engineMs)} ms${built.cached ? '(재사용)' : ''} · 장면 ${fmt(built.sceneMs)} ms`, '');
    }

    function excludedText(ex) {
        if (!ex) return '대지 내 기존 합성 건물 확인 중';
        const b = ex.buildings ? `대지 내 기존 합성 건물 ${fmt(ex.buildings)}동 제외(SYNTHETIC)` : '대지 내 기존 합성 건물 없음(SYNTHETIC)';
        return ex.trees ? `${b} · 가로수 ${fmt(ex.trees)}그루 제외` : b;
    }

    function renderStatus() {
        if (!built) { statusEl.textContent = phase === 'error' ? `3D 장면 없음 · 채택 r${wanted().rev} · 2D 도면은 그대로 쓸 수 있습니다` : `채택 r${wanted().rev} 기준 · 3D 장면 준비 중`; return; }
        const s = built.adapter.stats ? built.adapter.stats() : {};
        const w = wanted();
        const pending = !upToDate(w) ? ` · r${w.rev} 반영 대기` : '';
        // items never break inside ("장면 / 1,087 ms" on a phone); the separators are the break points
        const it = (html) => `<span class="v3-it">${html}</span>`;
        statusEl.innerHTML = [
            `<b>채택 r${built.rev} 기준</b>`, esc(excludedText(built.excluded)), it(esc(built.label)),
            it(`로드 <span class="num">${fmt(built.engineMs)}</span> ms${built.cached ? '(재사용)' : ''}`),
            it(`장면 <span class="num">${fmt(built.sceneMs)}</span> ms`),
            it(`드로우콜 <span class="num" id="v3-draws">${Number.isFinite(s.drawCalls) ? fmt(s.drawCalls) : '—'}</span>${esc(pending)}`),
        ].join('<span class="v3-sep">·</span>');
    }

    function renderNotes() {
        const st = store.getState();
        const L = st.layers;
        const bakedOff = ['boundary', 'roads', 'parcels'].filter((k) => !L[k]);
        const names = { boundary: '경계', roads: '도로', parcels: '필지' };
        const notes = [];
        if (st.site.draft) notes.push('<span class="chip chip-ko chip--draft">초안은 3D에 반영하지 않음</span>');
        notes.push('<span class="chip chip-ko chip--assumed">주변 건물 높이 ASSUMED</span>');
        notes.push(`<span class="v3-baked" data-off="${bakedOff.length > 0}" title="대지경계 띠·도로·필지선은 3D 바닥 장면에 함께 들어 있어 레이어 토글로 끄지 않습니다.">` +
            (bakedOff.length ? `${bakedOff.map((k) => names[k]).join('·')} 끔: 2D·MAP에만 적용(3D 바닥에 포함)` : '경계·도로·필지는 3D 바닥에 포함') + '</span>');
        notesEl.innerHTML = notes.join('');
    }

    function renderBar() {
        const eng = wanted().engine;
        for (const b of bar.querySelectorAll('[data-engine]')) b.setAttribute('aria-pressed', String(b.dataset.engine === eng));
        const ready = !!built && phase === 'ready';
        for (const b of bar.querySelectorAll('[data-view]')) {
            b.setAttribute('aria-pressed', String(ready && b.dataset.view === view));
            b.disabled = !ready;
        }
        north.hidden = !ready;
    }

    function showLoading(w, ex, step, engineMs) {
        const E = ENGINES[w.engine];
        const title = step === 'engine' ? `${E.name} ${E.version} 불러오는 중…`
            : reason === 'engine' ? `${E.name} 엔진으로 3D 장면 다시 만드는 중…`
            : reason === 'site' ? `r${w.rev} 대지로 3D 장면 다시 만드는 중…`
            : reason === 'again' ? '3D 장면 다시 만드는 중…' : '3D 장면 만드는 중…';
        const sub = step === 'engine'
            ? '엔진은 3D 탭을 처음 열 때 cdn.jsdelivr.net에서 한 번 받습니다. 그동안 다른 탭은 그대로 쓸 수 있습니다.'
            : '채택 대지, 주변 합성 건물·도로·필지, 원경 지형을 배치합니다. 초안은 넣지 않습니다.';
        msg.innerHTML = `<div class="ph-card v3-card" role="status" aria-live="polite">
          <div class="row"><span class="chip chip-ko chip--plain">3D</span><span class="chip chip--synth">SYNTHETIC</span></div>
          <h2>${esc(title)}</h2>
          <p>${esc(sub)}</p>
          <div class="v3-progress" aria-hidden="true"><i></i></div>
          <dl>
            <dt>기준</dt><dd>채택 r${w.rev} · ${fmt(w.area, 1)} ㎡</dd>
            <dt>제외</dt><dd>${esc(excludedText(ex))}</dd>
            <dt>엔진</dt><dd>${esc(E.name)} ${esc(E.version)}${engineMs != null ? ` · 로드 ${fmt(engineMs)} ms${E.loaded() && engineMs === 0 ? '(재사용)' : ''}` : ''}</dd>
            <dt>태양</dt><dd>${SUN.label} (서울)</dd>
          </dl>
        </div>`;
        msg.hidden = false;
        statusEl.textContent = `채택 r${w.rev} 기준 · ${E.name} 준비 중`;
    }

    function showError(error, E) {
        msg.innerHTML = `<div class="ph-card v3-card" role="alert">
          <div class="row"><span class="chip chip-ko chip--error">불러오기 실패</span><span class="chip chip-ko chip--plain">${esc(E.name)} ${esc(E.version)}</span></div>
          <h2>${esc(error.title)}</h2>
          <p>${esc(error.hint)} ${esc(error.others)}</p>
          <div class="err">${esc(error.message)}</div>
          <div class="row"><button type="button" class="btn btn--sm btn--primary" data-act="retry">다시 시도</button></div>
        </div>`;
        msg.hidden = false;
        renderStatus();
    }
    function hideMessage() { msg.hidden = true; msg.innerHTML = ''; }

    function tagged(err, kind) { const e = err instanceof Error ? err : new Error(String(err)); if (!e.kind) e.kind = kind; return e; }
    function describe(err, E) {
        const m = (err && err.message) || String(err || '알 수 없는 오류');
        let kind = err && err.kind;
        if (!kind || kind === 'scene') {
            if (/webgl|context|graphics ?device|gpu/i.test(m)) kind = 'webgl';
            else if (/cdn|불러오지 못했|import|fetch|module/i.test(m)) kind = 'cdn';
            else kind = 'scene';
        }
        if (kind === 'cdn') return { kind, message: m, title: `${E.name} ${E.version} 엔진을 받지 못했습니다`, hint: 'cdn.jsdelivr.net에 연결할 수 없거나 보안 정책이 막았습니다. 네트워크를 확인한 뒤 다시 시도하세요.', others: '2D·MAP 탭은 그대로 쓸 수 있고, 위에서 다른 엔진을 고를 수도 있습니다.' };
        if (kind === 'webgl') return { kind, message: m, title: '이 브라우저에서 WebGL 장면을 만들지 못했습니다', hint: '브라우저의 그래픽 가속이 꺼져 있거나, WebGL을 쓰는 탭이 너무 많이 열려 있을 수 있습니다.', others: '2D 도면은 그대로 쓸 수 있습니다. 다른 탭을 닫은 뒤 다시 시도하거나 위에서 다른 엔진을 고르세요.' };
        return { kind, message: m, title: '3D 장면을 만들지 못했습니다', hint: '장면을 만드는 중에 문제가 생겼습니다.', others: '2D·MAP 탭은 그대로 쓸 수 있고, 위에서 다른 엔진을 고를 수도 있습니다.' };
    }

    // ================= live readouts (only while active) =================
    function startPoll() {
        stopPoll();
        if (!built || !active) return;
        pollTimer = setInterval(() => {
            if (!built || !active) return;
            const s = built.adapter.stats();
            const d = root.querySelector('#v3-draws');
            if (d && Number.isFinite(s.drawCalls)) d.textContent = fmt(s.drawCalls);
        }, 1000);
        const spin = () => {
            northRaf = 0;
            if (!built || !active) return;
            const h = built.adapter.cameraHeading ? built.adapter.cameraHeading() : 0;
            if (!(Math.abs(h - lastHeading) < 0.1)) { lastHeading = h; northRot.setAttribute('transform', `rotate(${(-h).toFixed(1)} 20 20)`); }
            northRaf = requestAnimationFrame(spin);
        };
        northRaf = requestAnimationFrame(spin);
    }
    function stopPoll() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
        if (northRaf) { cancelAnimationFrame(northRaf); northRaf = 0; }
    }

    function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

    function injectStyleOnce() {
        if (document.getElementById('v3-style')) return;
        const st = document.createElement('style');
        st.id = 'v3-style';
        st.textContent = `
.v3-root{position:absolute;inset:0;overflow:hidden;background:var(--cv-paper,#fbfbfa);font-family:var(--font-ui,system-ui,sans-serif)}
.v3-stage{position:absolute;inset:0}
.v3-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;outline:none;touch-action:none}
.v3-bar{position:absolute;z-index:4;top:8px;left:8px;right:60px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;pointer-events:none}
.v3-bar>*{pointer-events:auto}
.v3-seg{display:inline-flex;box-shadow:0 1px 2px rgb(0 0 0/.10)}
.v3-seg .btn{background:var(--panel);border-radius:0}
.v3-seg .btn+.btn{margin-left:-1px}
.v3-seg .btn:first-child{border-radius:2px 0 0 2px}
.v3-seg .btn:last-child{border-radius:0 2px 2px 0}
.v3-seg .btn[aria-pressed="true"]{background:var(--ink);color:var(--panel);border-color:var(--ink);position:relative;z-index:1}
.v3-seg .btn:disabled{opacity:.55}
.v3-sun{display:inline-flex;align-items:center;height:24px;padding:0 8px;border:1px solid var(--line-strong);border-radius:2px;background:var(--panel);
  color:var(--muted);font-size:var(--fs-xs);white-space:nowrap}
.v3-north{position:absolute;z-index:4;top:8px;right:10px;width:40px;height:40px;color:var(--ink);pointer-events:none}
.v3-north svg{display:block;width:40px;height:40px;font-family:var(--font-mono,monospace)}
.v3-north .v3-n-bg{fill:var(--panel);fill-opacity:.88;stroke:var(--line-strong);stroke-width:1}
.v3-north[hidden]{display:none}
.v3-foot{position:absolute;z-index:4;left:0;right:0;bottom:0;display:flex;flex-wrap:wrap;align-items:center;gap:3px 14px;min-height:26px;padding:4px 10px;
  background:color-mix(in srgb,var(--panel) 92%,transparent);border-top:1px solid var(--line);font-size:var(--fs-xs);color:var(--muted);line-height:1.45}
.v3-status{color:var(--ink);min-width:0;overflow-wrap:anywhere;word-break:keep-all}
.v3-status b{font-weight:600;white-space:nowrap}
.v3-it{white-space:nowrap}
.v3-status .num{font-family:var(--font-mono);font-variant-numeric:tabular-nums}
.v3-sep{margin:0 6px;color:var(--line-strong)}
.v3-notes{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin-left:auto;min-width:0}
.v3-baked{white-space:nowrap}
.v3-baked[data-off="true"]{color:var(--warn)}
.v3-msg{z-index:3}
.v3-msg[hidden]{display:none}
.v3-card{word-break:keep-all;overflow-wrap:break-word}
.v3-card dd{font-family:var(--font-ui);font-variant-numeric:tabular-nums}
.v3-progress{position:relative;height:2px;background:var(--line);overflow:hidden}
.v3-progress i{position:absolute;top:0;bottom:0;left:0;width:32%;background:var(--accent);animation:v3-slide 1.15s ease-in-out infinite}
@keyframes v3-slide{0%{left:-32%}100%{left:100%}}
.v3-narrow .v3-bar{right:54px;gap:5px}
.v3-narrow .v3-seg .btn{padding:0 7px}
.v3-narrow .v3-north{right:8px}
.v3-narrow .v3-foot{padding:4px 8px;gap:2px 10px}
.v3-narrow .v3-notes{margin-left:0}
.v3-narrow .v3-baked[data-off="false"]{display:none}
@media (pointer:coarse){.v3-seg .btn{min-height:32px}.v3-sun{height:32px}}
`;
        (document.head || document.documentElement).appendChild(st);
    }

    return {
        activate, deactivate, dispose, fit, setView,
        whenIdle: () => (loop || Promise.resolve()).then(() => undefined),
        debug() {
            const a = built && built.adapter;
            const s = a && a.stats ? a.stats() : {};
            return {
                phase, active, engine: built ? built.engine : null, label: built ? built.label : null, rev: built ? built.rev : null,
                excluded: built ? Object.assign({}, built.excluded) : null, engineMs: built ? built.engineMs : null,
                sceneMs: built ? built.sceneMs : null, frames: s.frames, drawCalls: s.drawCalls, buildCount, view,
                framing: built ? JSON.parse(JSON.stringify(built.framing)) : null,
                error: failed ? failed.error.message : null, status: lastStatus, canvases: stage.querySelectorAll('canvas').length,
            };
        },
        get adapter() { return built ? built.adapter : null; },
    };
}

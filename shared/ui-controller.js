// UI shell controller, engine-agnostic: panel controls <-> SITE_CORE <-> renderer adapter.
// Adapter contract and test API: docs/SPEC.md. Entry point: startApp(createAdapter).
var __APP_T0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

function startApp(createAdapter) {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const now = () => performance.now();
    const HOUR_MIN = 6, HOUR_MAX = 19;
    const PLAY_RATE = 1.2;           // simulated hours per real second (06:00 -> 19:00 in ~11 s)
    const CLICK_SLOP = 5, CLICK_MS = 400;
    const VIEWS = ['aerial', 'pedestrian', 'top', 'north'];
    const LAYERS = ['context', 'trees', 'shadows', 'terrain'];
    const DIRS = ['북', '북북동', '북동', '동북동', '동', '동남동', '남동', '남남동', '남', '남남서', '남서', '서남서', '서', '서북서', '북서', '북북서'];

    let core = null, adapter = null, canvas = null;
    const S = {
        params: null, mass: null,
        preset: 'winter', hour: 12.5, sun: null,
        view: 'aerial', layers: { context: true, trees: true, shadows: true, terrain: true },
        selected: null, playing: false, playRaf: 0,
        loadMs: null, ready: false,
    };
    window.__app = { ready: false };

    // ---------- small helpers ----------
    const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    const pad2 = (n) => String(n).padStart(2, '0');
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    function hhmm(hour) {
        const m = Math.floor(hour * 60 + 1e-6);
        return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
    }
    function snap(key, v) {
        const L = core.MASS_LIMITS[key];
        const s = Math.round((clamp(Number(v), L.min, L.max) - L.min) / L.step) * L.step + L.min;
        return Number(s.toFixed(2));
    }
    function dirName(az) { return DIRS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16]; }
    function guard(fn) {
        return function (ev) {
            try { return fn.call(this, ev); } catch (err) { console.error('[ui]', err); }
        };
    }
    function setFill(input) {
        const min = Number(input.min), max = Number(input.max), v = Number(input.value);
        const p = max > min ? (v - min) / (max - min) : 0;
        input.style.setProperty('--fill', (p * 100).toFixed(2) + '%');
    }

    // ---------- error / loading ----------
    function hasWebGL() {
        try {
            const c = document.createElement('canvas');
            const gl = c.getContext('webgl2') || c.getContext('webgl');
            if (!gl) return false;
            const lose = gl.getExtension('WEBGL_lose_context');
            if (lose) lose.loseContext();
            return true;
        } catch (e) { return false; }
    }
    function describe(err) {
        const msg = (err && (err.message || String(err))) || '알 수 없는 오류';
        if (err && err.name === 'ReferenceError' && /\b(BABYLON|pc|SITE_CORE|SITE_DATA)\b/.test(msg)) {
            return '엔진 스크립트가 로드되지 않았습니다 (' + msg + '). 네트워크에서 CDN에 접근할 수 있는지 확인하세요.';
        }
        if (/webgl|context/i.test(msg) || !hasWebGL()) {
            return 'WebGL을 시작하지 못했습니다 (' + msg + '). 브라우저의 하드웨어 가속을 켜 주세요.';
        }
        return msg;
    }
    function fail(err) {
        console.error('[startApp]', err);
        stopPlay();
        const reason = describe(err);
        const box = $('error'), splash = $('splash');
        if ($('error-reason')) $('error-reason').textContent = reason;
        if (box) box.hidden = false;
        if (splash) splash.hidden = true;
        window.__app = { ready: false, error: reason };
    }

    // ---------- mass ----------
    function renderMassControls() {
        for (const key of Object.keys(core.MASS_LIMITS)) {
            const el = $('in-' + key);
            if (!el) continue;
            const v = S.params[key];
            if (Number(el.value) !== v) el.value = String(v);
            setFill(el);
            const isFloors = /Floors$/.test(key);
            const text = isFloors ? v + '층' : core.fmt(v, 1) + ' m';
            setText('out-' + key, text);
            el.setAttribute('aria-valuetext', isFloors ? v + '개 층' : core.fmt(v, 1) + '미터');
        }
    }
    function renderMetrics() {
        const m = S.mass.metrics, F = S.mass.floors;
        setText('m-siteArea', core.fmt(m.siteArea, 2));
        setText('m-buildingArea', core.fmt(m.buildingArea, 2));
        setText('m-gfa', core.fmt(m.gfa, 2));
        const pod = F.filter((f) => f.kind === 'podium'), tow = F.filter((f) => f.kind === 'tower');
        const sum = (arr) => arr.reduce((s, f) => s + f.area, 0);
        setText('m-podN', pod.length); setText('m-podA', core.fmt(sum(pod), 2));
        setText('m-towN', tow.length); setText('m-towA', core.fmt(sum(tow), 2));
        setText('m-bcr', core.fmt(m.bcr, 2));
        setText('m-far', core.fmt(m.far, 2));
        setText('m-height', core.fmt(m.height, 2));
        setText('m-floors', '지상 ' + m.floorsAbove);
        setText('sum-gfa', core.fmt(m.gfa, 0));
        setText('sum-far', core.fmt(m.far, 1));
        setText('sum-height', core.fmt(m.height, 1));
    }
    function applyMass() {
        pending.mass = false;
        S.mass = core.buildMainMass(S.params);
        adapter.setMass(S.mass);
        if (S.selected != null) {
            if (S.selected > S.mass.floors.length) clearSelection();
            else { adapter.setHighlight(S.selected); renderFloorCard(); }
        }
        renderMetrics();
        renderShadowLength();
    }

    // ---------- sun ----------
    function renderSunControls() {
        for (const key of Object.keys(core.SUN_PRESETS)) {
            const r = $('sun-' + key);
            if (r) r.checked = key === S.preset;
        }
        const p = core.SUN_PRESETS[S.preset];
        setText('out-date', p.month + '월 ' + p.day + '일');
        const el = $('in-hour');
        const mins = Math.round(S.hour * 60);
        if (Number(el.value) !== Math.round(mins / 10) * 10) el.value = String(Math.round(mins / 10) * 10);
        setFill(el);
        setText('out-hour', hhmm(S.hour));
        const t = hhmm(S.hour).split(':');
        el.setAttribute('aria-valuetext', p.label + ' ' + Number(t[0]) + '시 ' + Number(t[1]) + '분');
    }
    function renderShadowLength() {
        const s = S.sun;
        if (!s || !S.mass) return;
        if (s.altitude <= 0) { setText('out-shadow', '—'); return; }
        const len = S.mass.metrics.height / Math.tan(s.altitude * Math.PI / 180);
        setText('out-shadow', len > 9999 ? '> 9,999 m' : core.fmt(len, 1) + ' m');
    }
    function renderSun() {
        const s = S.sun, up = s.altitude > 0;
        setText('out-alt', core.fmt(s.altitude, 1) + '°');
        setText('out-az', core.fmt(s.azimuth, 1) + '°');
        setText('out-az-dir', dirName(s.azimuth));
        $('sun-state').hidden = up;
        $('sun-read').classList.toggle('is-night', !up);
        renderShadowLength();
    }
    function applySun() {
        pending.sun = false;
        const p = core.SUN_PRESETS[S.preset];
        const s = core.solarPosition({ month: p.month, day: p.day, hour: S.hour });
        S.sun = s;
        adapter.setSun({ vector: core.sunVector(s.altitude, s.azimuth), altitude: s.altitude, azimuth: s.azimuth });
        renderSun();
    }
    function startPlay() {
        if (S.playing) return;
        if (S.hour >= HOUR_MAX - 1e-6) S.hour = HOUR_MIN;
        S.playing = true;
        const btn = $('btn-play');
        btn.setAttribute('aria-pressed', 'true');
        setText('btn-play-text', '정지');
        let last = now();
        const step = (t) => {
            if (!S.playing) return;
            try {
                const dt = Math.min(0.1, Math.max(0, (t - last) / 1000));
                last = t;
                S.hour = Math.min(HOUR_MAX, S.hour + dt * PLAY_RATE);
                renderSunControls();
                applySun();
                if (S.hour >= HOUR_MAX) { stopPlay(); return; }
            } catch (err) { console.error('[ui] play', err); stopPlay(); return; }
            S.playRaf = requestAnimationFrame(step);
        };
        S.playRaf = requestAnimationFrame(step);
    }
    function stopPlay() {
        if (!S.playing) return;
        S.playing = false;
        cancelAnimationFrame(S.playRaf);
        const btn = $('btn-play');
        if (btn) btn.setAttribute('aria-pressed', 'false');
        setText('btn-play-text', '재생');
    }

    // ---------- rAF throttle for live slider drags ----------
    const pending = { mass: false, sun: false };
    let flushRaf = 0;
    function schedule(kind) {
        pending[kind] = true;
        if (!flushRaf) flushRaf = requestAnimationFrame(flush);
    }
    function flush() {
        flushRaf = 0;
        try {
            if (pending.mass) applyMass();
            if (pending.sun) applySun();
        } catch (err) { console.error('[ui]', err); }
    }

    // ---------- view / layers ----------
    function renderViewButtons() {
        for (const v of VIEWS) {
            const b = $('view-' + v);
            if (b) b.setAttribute('aria-pressed', String(S.view === v));
        }
    }
    function setView(name) {
        if (!VIEWS.includes(name)) throw new Error('알 수 없는 시점: ' + name);
        S.view = name;
        adapter.setView(name);
        renderViewButtons();
    }
    function setLayer(name, visible) {
        if (!LAYERS.includes(name)) throw new Error('알 수 없는 레이어: ' + name);
        S.layers[name] = !!visible;
        const el = $('layer-' + name);
        if (el) el.checked = !!visible;
        adapter.setLayer(name, !!visible);
    }
    function markCustomView() {
        if (S.view == null) return;
        S.view = null;
        renderViewButtons();
    }

    // ---------- floor selection ----------
    function renderFloorCard() {
        const f = S.mass && S.mass.floors[S.selected - 1];
        if (!f) return;
        setText('fc-label', f.label);
        setText('fc-use', f.use);
        setText('fc-area', core.fmt(f.area, 2));
        setText('fc-fl', '+' + core.fmt(f.floorLevel, 2));
        setText('fc-fh', core.fmt(f.height, 1));
        $('floor-card').hidden = false;
    }
    function select(level) {
        if (!S.mass || level < 1 || level > S.mass.floors.length) { clearSelection(); return; }
        S.selected = level;
        adapter.setHighlight(level);
        renderFloorCard();
    }
    function clearSelection() {
        const had = S.selected != null;
        S.selected = null;
        $('floor-card').hidden = true;
        if (had) adapter.setHighlight(null);
    }
    function pickAt(x, y) {
        const r = adapter.screenToRay(x, y);
        const hit = r && S.mass ? core.pickFloor(r.origin, r.dir, S.mass) : null;
        if (hit) select(hit.level); else clearSelection();
    }

    // ---------- loops ----------
    let lastHeading = NaN, lastHeadingLabel = NaN;
    function compassFrame() {
        let h = NaN;
        try { h = adapter.cameraHeading(); } catch (e) { h = NaN; }
        if (Number.isFinite(h) && !(Math.abs(h - lastHeading) < 0.05)) {
            lastHeading = h;
            $('compass-needle').setAttribute('transform', 'rotate(' + (-h).toFixed(2) + ')');
            if (!(Math.abs(h - lastHeadingLabel) < 5)) {
                lastHeadingLabel = h;
                $('compass').setAttribute('aria-label', '방위표: 화면은 ' + dirName(h) + '쪽(' + Math.round(((h % 360) + 360) % 360) + '°)을 바라봄');
            }
        }
        requestAnimationFrame(compassFrame);
    }
    let statsWarned = false;
    function renderStats() {
        let st = null;
        try { st = adapter.stats(); } catch (err) { if (!statsWarned) { statsWarned = true; console.warn('[ui] stats', err); } }
        const ok = (v) => typeof v === 'number' && Number.isFinite(v);
        setText('st-fps', st && ok(st.fps) ? String(Math.round(st.fps)) : '—');
        setText('st-draws', st && ok(st.drawCalls) ? String(Math.round(st.drawCalls)) : '—');
    }

    // Collapsed sections are a per-viewer convenience; storage may be unavailable (private mode, previews).
    const SEC_KEY = 'mass-study.sections';
    function restoreSections() {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(SEC_KEY) || 'null'); } catch (e) { saved = null; }
        for (const d of document.querySelectorAll('#panel-body details.sec')) {
            if (saved && typeof saved[d.id] === 'boolean') d.open = saved[d.id];
            d.addEventListener('toggle', () => {
                const state = {};
                for (const x of document.querySelectorAll('#panel-body details.sec')) state[x.id] = x.open;
                try { localStorage.setItem(SEC_KEY, JSON.stringify(state)); } catch (e) { /* storage blocked */ }
            });
        }
    }

    // ---------- event wiring ----------
    function bindControls() {
        for (const key of Object.keys(core.MASS_LIMITS)) {
            const el = $('in-' + key);
            if (!el) continue;
            const L = core.MASS_LIMITS[key];
            el.min = String(L.min); el.max = String(L.max); el.step = String(L.step);
            el.addEventListener('input', guard(() => {
                S.params[key] = snap(key, el.value);
                renderMassControls();
                schedule('mass');
            }));
        }
        $('btn-mass-reset').addEventListener('click', guard(() => {
            S.params = Object.assign({}, core.MASS_DEFAULTS);
            renderMassControls();
            applyMass();
        }));

        for (const key of Object.keys(core.SUN_PRESETS)) {
            const r = $('sun-' + key);
            if (!r) continue;
            const p = core.SUN_PRESETS[key];
            setText('sun-' + key + '-date', p.month + '.' + p.day);
            r.addEventListener('change', guard(() => {
                if (!r.checked) return;
                S.preset = key;
                renderSunControls();
                schedule('sun');
            }));
        }
        const hourEl = $('in-hour');
        hourEl.min = String(HOUR_MIN * 60); hourEl.max = String(HOUR_MAX * 60); hourEl.step = '10';
        hourEl.addEventListener('input', guard(() => {
            stopPlay();
            S.hour = clamp(Number(hourEl.value) / 60, HOUR_MIN, HOUR_MAX);
            renderSunControls();
            schedule('sun');
        }));
        $('btn-play').addEventListener('click', guard(() => { if (S.playing) stopPlay(); else startPlay(); }));

        for (const v of VIEWS) {
            const b = $('view-' + v);
            if (b) b.addEventListener('click', guard(() => setView(v)));
        }
        for (const name of LAYERS) {
            const el = $('layer-' + name);
            if (el) el.addEventListener('change', guard(() => setLayer(name, el.checked)));
        }

        $('fc-close').addEventListener('click', guard(clearSelection));
        document.addEventListener('keydown', guard((e) => {
            if (e.key === 'Escape' && S.selected != null) clearSelection();
        }));

        const panel = $('panel'), toggle = $('sheet-toggle');
        toggle.addEventListener('click', guard(() => {
            const open = panel.dataset.expanded !== 'true';
            panel.dataset.expanded = String(open);
            toggle.setAttribute('aria-expanded', String(open));
            setText('sheet-toggle-text', open ? '접기' : '펼치기');
        }));
    }

    // Click vs drag on the canvas. Window capture listeners so engine handlers cannot swallow them.
    function bindCanvasPicking() {
        const downs = new Map();
        window.addEventListener('pointerdown', (e) => {
            if (e.target !== canvas) return;
            if (downs.size) { for (const d of downs.values()) d.multi = true; }
            downs.set(e.pointerId, { x: e.clientX, y: e.clientY, t: now(), multi: downs.size > 0 || e.button !== 0, dragged: false });
        }, true);
        window.addEventListener('pointermove', (e) => {
            const d = downs.get(e.pointerId);
            if (d && !d.dragged && Math.hypot(e.clientX - d.x, e.clientY - d.y) >= CLICK_SLOP) {
                d.dragged = true;
                markCustomView();
            }
        }, true);
        window.addEventListener('pointerup', guard((e) => {
            const d = downs.get(e.pointerId);
            if (!d) return;
            downs.delete(e.pointerId);
            if (d.multi || d.dragged) return;
            if (Math.hypot(e.clientX - d.x, e.clientY - d.y) >= CLICK_SLOP || now() - d.t >= CLICK_MS) return;
            pickAt(e.clientX, e.clientY);
        }), true);
        window.addEventListener('pointercancel', (e) => { downs.delete(e.pointerId); }, true);
        canvas.addEventListener('wheel', () => markCustomView(), { passive: true });
    }

    // ---------- view inset: tell the renderer which part of the canvas the panel covers ----------
    // Desktop: the left side panel (inset.left = its right edge). Phone (<= 640 px): the bottom sheet
    // (inset.bottom = its height over the canvas). Adapters lens-shift the image so the subject sits in the
    // free area (docs/SPEC.md, setViewInset). Optional in the contract: skipped if the adapter lacks it.
    const sheetQuery = window.matchMedia ? window.matchMedia('(max-width: 640px)') : null;
    let lastInset = '';
    function updateViewInset() {
        if (!adapter || typeof adapter.setViewInset !== 'function' || !canvas) return;
        const panel = $('panel');
        const c = canvas.getBoundingClientRect(), p = panel ? panel.getBoundingClientRect() : null;
        let left = 0, bottom = 0;
        if (p && p.width > 0 && p.height > 0 && c.width > 0 && c.height > 0) {
            if (sheetQuery && sheetQuery.matches) bottom = clamp(c.bottom - p.top, 0, c.height * 0.8);
            else left = clamp(p.right - c.left, 0, c.width * 0.5);
        }
        const key = left.toFixed(1) + ',' + bottom.toFixed(1);
        if (key === lastInset) return;
        lastInset = key;
        adapter.setViewInset({ left, bottom });
    }
    function bindViewInset() {
        const onLayout = guard(updateViewInset);
        if (window.ResizeObserver) {
            const ro = new ResizeObserver(onLayout);
            ro.observe(canvas);
            if ($('panel')) ro.observe($('panel')); // sheet expand/collapse, sections opening
        }
        window.addEventListener('resize', onLayout);
    }

    // ---------- boot ----------
    async function boot() {
        if (typeof SITE_CORE === 'undefined') throw new ReferenceError('SITE_CORE is not defined');
        core = SITE_CORE;
        canvas = $('scene');
        if (!canvas) throw new Error('#scene 캔버스를 찾을 수 없습니다.');
        if (typeof createAdapter !== 'function') throw new Error('렌더러 어댑터 함수가 없습니다.');

        const loc = core.data.site.location;
        setText('tb-loc', loc.lat.toFixed(2) + '°N ' + loc.lon.toFixed(2) + '°E');
        restoreSections();
        S.params = Object.assign({}, core.MASS_DEFAULTS);
        bindControls();
        renderMassControls();
        renderSunControls();

        const slow = setTimeout(() => setText('splash-msg', '장면 생성 중… 시간이 걸리고 있습니다'), 20000);
        adapter = await createAdapter(canvas, core);
        if (!adapter || typeof adapter.init !== 'function') throw new Error('어댑터가 올바른 객체를 돌려주지 않았습니다.');
        updateViewInset(); // before init: the first frame is already framed
        bindViewInset();
        await adapter.init();
        clearTimeout(slow);

        const label = [adapter.engineName, adapter.engineVersion].filter(Boolean).join(' ') || '렌더러';
        setText('engine-badge', label);
        setText('st-engine', adapter.engineName || '렌더러');

        applyMass();
        applySun();
        for (const name of LAYERS) if (!S.layers[name]) adapter.setLayer(name, false);
        renderViewButtons();
        bindCanvasPicking();

        S.loadMs = Math.round(now() - __APP_T0);
        setText('st-load', core.fmt(S.loadMs, 0));
        renderStats();
        setInterval(renderStats, 500);
        requestAnimationFrame(compassFrame);
        $('splash').hidden = true;
        $('error').hidden = true; // a non-fatal early error (see ui-body guard) must not cover a working scene
        S.ready = true;

        window.__app = {
            ready: true,
            metrics() { return Object.assign({}, S.mass.metrics); },
            stats() { return Object.assign({}, adapter.stats(), { loadMs: S.loadMs }); },
            setMass(partial) {
                for (const key of Object.keys(partial || {})) {
                    if (key in core.MASS_LIMITS) S.params[key] = snap(key, partial[key]);
                }
                renderMassControls();
                applyMass();
                return Object.assign({}, S.mass.metrics);
            },
            setSun(opts) {
                const o = opts || {};
                if (o.preset != null) {
                    if (!core.SUN_PRESETS[o.preset]) throw new Error('알 수 없는 기준일: ' + o.preset);
                    S.preset = o.preset;
                }
                if (o.hour != null) { stopPlay(); S.hour = clamp(Number(o.hour), HOUR_MIN, HOUR_MAX); }
                renderSunControls();
                applySun();
                return { altitude: S.sun.altitude, azimuth: S.sun.azimuth };
            },
            setView,
            setLayer,
            selectFloor(level) { if (level == null) clearSelection(); else select(level); return S.selected; },
            state() {
                return { params: Object.assign({}, S.params), preset: S.preset, hour: S.hour, view: S.view, layers: Object.assign({}, S.layers), selected: S.selected };
            },
        };
    }

    const run = () => boot().catch(fail);
    if (document.readyState === 'loading') {
        return new Promise((resolve) => document.addEventListener('DOMContentLoaded', () => resolve(run()), { once: true }));
    }
    return run();
}

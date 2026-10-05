// Mock renderer adapter (Canvas2D) for testing the UI shell without WebGL.
// Draws the scene data as a plan: north is up when the heading is 0; other "views" rotate the plan so the
// camera heading is screen-up, which exercises the 방위표. Implements the full adapter contract (docs/SPEC.md).
async function createMockAdapter(canvas, core) {
    'use strict';
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas2D context unavailable');
    const D = core.data;
    const reduceMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    const COL = {
        sky: '#cdd6dd', terrain: '#9ea88c', asphalt: '#5b5f63', platform: '#d9d6cf', park: '#9fb38a',
        yellow: '#e2b83b', white: '#f2f2ee', parcel: '#9a968d', siteFill: '#efe6c8', boundary: '#d2352b',
        building: '#eceae4', buildingEdge: '#a9a59c', crown: '#6f8f5a', podium: '#c98d4b', tower: '#d9a35f',
        slab: '#5a4636', rooftop: '#b9b2a6', select: '#2f7de1',
    };
    // heading = azimuth the camera looks toward (deg); scale = px per metre (at 1440 px wide)
    const VIEWS = {
        aerial: { heading: 330, scale: 3.4, e: 0, n: 0 },
        pedestrian: { heading: 315, scale: 9, e: 12, n: -12 },
        top: { heading: 0, scale: 3.6, e: 0, n: 0 },
        north: { heading: 180, scale: 4.4, e: 0, n: 0 },
    };
    const cam = { heading: 330, scale: 3.4, e: 0, n: 0 };
    let tween = null;
    const layers = { context: true, trees: true, shadows: true, terrain: true };
    let mass = null, sun = null, highlight = null;
    let dirty = true, raf = 0, drawOps = 0, lastDrawOps = 0;
    let frames = 0, fps = 0, fpsT = performance.now();
    let firstFrame = null;
    let cssW = 0, cssH = 0, dpr = 1;

    // ---------- geometry helpers ----------
    const toRad = (d) => d * Math.PI / 180;
    function hull(pts) {
        const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        const lo = [], up = [];
        for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
        for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
        up.pop(); lo.pop();
        return lo.concat(up);
    }
    const rect = (a) => [[a.e0, a.n0], [a.e1, a.n0], [a.e1, a.n1], [a.e0, a.n1]];
    function polyPath(poly) {
        ctx.moveTo(poly[0][0], poly[0][1]);
        for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
        ctx.closePath();
    }
    function fillPolys(polys, color) {
        if (!polys.length) return;
        ctx.beginPath();
        for (const p of polys) polyPath(p);
        ctx.fillStyle = color; ctx.fill(); drawOps++;
    }
    // shadow offset (e, n) per metre of height, or null when the sun is down
    function shadowStep() {
        if (!sun || sun.altitude <= 0) return null;
        const v = sun.vector; // engine: x = e, y = up, z = -n
        const up = Math.max(v[1], 0.02);
        return [-v[0] / up, v[2] / up];
    }

    // ---------- view transform ----------
    // World (e, n) -> device px: x = cx + s(c·e − sn·n), y = cy − s(sn·e + c·n); the heading points screen-up.
    // On desktop the plan centre is shifted right so the site is not hidden behind the panel.
    function viewParams() {
        const h = toRad(cam.heading), s = cam.scale * Math.min(1, cssW / 1440 + 0.25) * dpr;
        const cx0 = cssW * dpr * 0.5 + (cssW > 640 ? 180 * dpr : 0), cy0 = cssH * dpr * 0.5;
        const c = Math.cos(h), sn = Math.sin(h);
        return { s, c, sn, cx: cx0 - (c * cam.e - sn * cam.n) * s, cy: cy0 + (sn * cam.e + c * cam.n) * s };
    }
    function setTransform() {
        const T = viewParams();
        ctx.setTransform(T.s * T.c, -T.s * T.sn, -T.s * T.sn, -T.s * T.c, T.cx, T.cy);
        return T;
    }
    function screenToWorld(px, py) {
        const T = viewParams();
        const x = (px * dpr - T.cx) / T.s, y = -(py * dpr - T.cy) / T.s;
        return [T.c * x + T.sn * y, -T.sn * x + T.c * y];
    }

    // ---------- drawing ----------
    function resize() {
        dpr = Math.min(2, window.devicePixelRatio || 1);
        cssW = canvas.clientWidth || window.innerWidth; cssH = canvas.clientHeight || window.innerHeight;
        const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; dirty = true; }
    }

    function draw() {
        drawOps = 0;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = COL.sky; ctx.fillRect(0, 0, canvas.width, canvas.height); drawOps++;
        const T = setTransform();
        const px = 1 / T.s; // one device pixel in metres
        const C = D.city;
        if (layers.terrain) fillPolys([[[C.eMin - 1200, C.nMin - 1200], [C.eMax + 1200, C.nMin - 1200], [C.eMax + 1200, C.nMax + 1200], [C.eMin - 1200, C.nMax + 1200]]], COL.terrain);
        fillPolys([rect({ e0: C.eMin, e1: C.eMax, n0: C.nMin, n1: C.nMax })], COL.asphalt);
        fillPolys(D.blocks.map((b) => rect({ e0: b.e0 - b.pad.w, e1: b.e1 + b.pad.e, n0: b.n0 - b.pad.s, n1: b.n1 + b.pad.n })), COL.platform);
        fillPolys(D.blocks.filter((b) => b.kind === 'park').map(rect), COL.park);

        for (const color of ['yellow', 'white']) {
            ctx.beginPath();
            for (const m of D.markings) if (m.color === color) { ctx.moveTo(m.e0, m.n0); ctx.lineTo(m.e1, m.n1); }
            ctx.strokeStyle = COL[color]; ctx.lineWidth = Math.max(0.16, px); ctx.stroke(); drawOps++;
        }
        ctx.beginPath();
        for (const p of D.parcels) polyPath(rect(p));
        ctx.strokeStyle = COL.parcel; ctx.lineWidth = px; ctx.stroke(); drawOps++;

        fillPolys([D.site.polygon], COL.siteFill);

        // shadows: hulls of every solid's base and its sun-projected top, drawn once at fixed alpha
        const st = shadowStep();
        if (layers.shadows && st) {
            const polys = [];
            const proj = (poly, y) => poly.map(([e, n]) => [e + st[0] * y, n + st[1] * y]);
            if (layers.context) for (const b of D.buildings) for (const p of b.parts) polys.push(hull(proj(rect(p), p.y0).concat(proj(rect(p), p.y1))));
            if (mass) for (const f of mass.floors) polys.push(hull(proj(f.footprint, f.y0).concat(proj(f.footprint, f.y1))));
            ctx.save();
            ctx.globalAlpha = 0.32;
            fillPolys(polys, '#1d2733');
            if (layers.trees) {
                ctx.beginPath();
                for (const [e, n, s] of D.trees) { const y = 0.15 + 3.9 * s; const x0 = e + st[0] * y, y0 = n + st[1] * y; ctx.moveTo(x0 + 1.8 * s, y0); ctx.arc(x0, y0, 1.8 * s, 0, Math.PI * 2); }
                ctx.fillStyle = '#1d2733'; ctx.fill(); drawOps++;
            }
            ctx.restore();
        }

        // site boundary
        ctx.beginPath(); polyPath(D.site.polygon);
        ctx.strokeStyle = COL.boundary; ctx.lineWidth = 2.5 * px; ctx.setLineDash([10 * px, 4 * px, 2 * px, 4 * px]); ctx.stroke(); ctx.setLineDash([]); drawOps++;

        if (layers.context) {
            const parts = [];
            for (const b of D.buildings) for (const p of b.parts) parts.push(p);
            parts.sort((a, b) => a.y1 - b.y1);
            ctx.beginPath();
            for (const p of parts) polyPath(rect(p));
            ctx.fillStyle = COL.building; ctx.fill(); drawOps++;
            ctx.strokeStyle = COL.buildingEdge; ctx.lineWidth = px; ctx.stroke(); drawOps++;
        }
        if (layers.trees) {
            ctx.beginPath();
            for (const [e, n, s] of D.trees) { ctx.moveTo(e + 1.8 * s, n); ctx.arc(e, n, 1.8 * s, 0, Math.PI * 2); }
            ctx.fillStyle = COL.crown; ctx.fill(); drawOps++;
        }

        if (mass) {
            for (const f of mass.floors) {
                fillPolys([f.footprint], f.level === highlight ? COL.select : f.kind === 'podium' ? COL.podium : COL.tower);
                ctx.beginPath(); polyPath(f.footprint); ctx.strokeStyle = COL.slab; ctx.lineWidth = px; ctx.stroke(); drawOps++;
            }
            const top = mass.floors.length ? mass.floors[mass.floors.length - 1].footprint : null;
            if (top) fillPolys([[[-6, 2], [2, 2], [2, 8], [-6, 8]]], COL.rooftop);
            const hf = highlight != null && mass.floors[highlight - 1];
            if (hf) {
                ctx.beginPath(); polyPath(hf.footprint);
                ctx.strokeStyle = COL.select; ctx.lineWidth = 3 * px; ctx.setLineDash([6 * px, 4 * px]); ctx.stroke(); ctx.setLineDash([]); drawOps++;
            }
        }

        // night: dim ambient
        if (sun && sun.altitude <= 0) {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.fillStyle = 'rgba(16, 22, 34, 0.45)'; ctx.fillRect(0, 0, canvas.width, canvas.height); drawOps++;
        }
        lastDrawOps = drawOps;
    }

    function loop(t) {
        raf = requestAnimationFrame(loop);
        frames++;
        if (t - fpsT >= 500) { fps = (frames * 1000) / (t - fpsT); frames = 0; fpsT = t; }
        resize();
        if (tween) {
            const k = Math.min(1, (t - tween.t0) / tween.ms), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
            let dh = ((tween.to.heading - tween.from.heading + 540) % 360) - 180;
            cam.heading = (tween.from.heading + dh * e + 360) % 360;
            for (const key of ['scale', 'e', 'n']) cam[key] = tween.from[key] + (tween.to[key] - tween.from[key]) * e;
            if (k >= 1) tween = null;
            dirty = true;
        }
        if (dirty) {
            dirty = false;
            draw();
            if (firstFrame) { const r = firstFrame; firstFrame = null; r(); }
        }
    }

    // ---------- simple camera input: drag = rotate, right/Shift drag = pan, wheel = zoom ----------
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
        tween = null;
    });
    window.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX; drag.y = e.clientY;
        if (drag.pan) {
            const a = screenToWorld(0, 0), b = screenToWorld(dx, dy);
            cam.e -= b[0] - a[0]; cam.n -= b[1] - a[1];
        } else {
            cam.heading = (cam.heading - dx * 0.3 + 360) % 360;
        }
        dirty = true;
    });
    window.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.id) drag = null; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        cam.scale = Math.min(30, Math.max(0.6, cam.scale * Math.exp(-e.deltaY * 0.0015)));
        tween = null; dirty = true;
    }, { passive: false });

    const adapter = {
        engineName: 'Mock Canvas2D',
        engineVersion: '1.0',
        async init() {
            resize();
            dirty = true;
            const ready = new Promise((resolve) => { firstFrame = resolve; });
            raf = requestAnimationFrame(loop);
            await ready;
        },
        setMass(m) { mass = m; dirty = true; },
        setSun(s) { sun = s; dirty = true; },
        setView(name) {
            const v = VIEWS[name];
            if (!v) throw new Error('unknown view ' + name);
            if (reduceMotion) { Object.assign(cam, v); tween = null; }
            else tween = { from: Object.assign({}, cam), to: v, t0: performance.now(), ms: 600 };
            dirty = true;
        },
        setLayer(name, visible) {
            if (!(name in layers)) throw new Error('unknown layer ' + name);
            layers[name] = !!visible; dirty = true;
        },
        setHighlight(level) { highlight = level == null ? null : level; dirty = true; },
        screenToRay(clientX, clientY) {
            const r = canvas.getBoundingClientRect();
            const [e, n] = screenToWorld(clientX - r.left, clientY - r.top);
            return { origin: [e, 1000, -n], dir: [0, -1, 0] };
        },
        cameraHeading() { return cam.heading; },
        stats() { return { fps, drawCalls: lastDrawOps, triangles: null }; },
        dispose() { cancelAnimationFrame(raf); },
    };
    return adapter;
}

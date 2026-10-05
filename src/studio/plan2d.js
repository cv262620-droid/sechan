// 2D site plan editor (Canvas2D) for OHSOLV Studio · M01-01 직접 경계 작성.
// createPlanView(container, store, ctx) -> { activate(): Promise, deactivate(), dispose(), fit(), worldToClient([e,n]) }
// World = local plane metres [e, n]; screen y grows downward, so north is up.
function createPlanView(container, store, ctx) {
    'use strict';
    const C = STUDIO_CORE, D = SITE_DATA;
    const VERTEX_SNAP_PX = 10, HIT_VERTEX_PX = 9, HIT_EDGE_PX = 6, DRAG_PX = 4;

    container.classList.add('p2');
    container.innerHTML = `
<canvas class="p2-canvas" id="p2-canvas" tabindex="0" role="img" aria-label="대지 2D 도면. 화살표 키로 선택한 꼭짓점을 옮기고 Delete로 삭제합니다."></canvas>
<div class="p2-tools" role="toolbar" aria-label="2D 편집 도구">
  <div class="seg" role="group" aria-label="도구">
    <button type="button" class="btn btn--sm" id="p2-tool-select" aria-pressed="true" title="선택 · 꼭짓점/변 이동 (V)">선택 <span class="key">V</span></button>
    <button type="button" class="btn btn--sm" id="p2-tool-draw" aria-pressed="false" title="그리기 · 클릭으로 꼭짓점 추가 (D)">그리기 <span class="key">D</span></button>
  </div>
  <div class="seg" role="group" aria-label="되돌리기">
    <button type="button" class="btn btn--sm" id="p2-undo" title="실행취소 (Ctrl+Z)">실행취소</button>
    <button type="button" class="btn btn--sm" id="p2-redo" title="다시실행 (Ctrl+Shift+Z)">다시실행</button>
  </div>
  <button type="button" class="btn btn--sm" id="p2-fit" title="대지에 맞춤 (F)">대지에 맞춤 <span class="key">F</span></button>
  <div class="seg p2-snaps" role="group" aria-label="스냅">
    <button type="button" class="btn btn--sm" id="p2-snap-grid" aria-pressed="true" title="그리드 0.5 m 스냅">그리드 0.5</button>
    <button type="button" class="btn btn--sm" id="p2-snap-vertex" aria-pressed="true" title="기존 필지·대지 꼭짓점 스냅 (화면 10 px)">꼭짓점</button>
    <span class="p2-ortho mono" id="p2-ortho" title="Shift를 누르는 동안 직교 스냅">SHIFT 직교</span>
  </div>
</div>
<svg class="p2-north" id="p2-north" viewBox="0 0 40 52" aria-label="방위표: 위쪽이 북" role="img">
  <circle cx="20" cy="30" r="15" fill="none" stroke="currentColor" stroke-width="1"/>
  <path d="M20 10 L27 38 L20 33 Z" fill="currentColor"/>
  <path d="M20 10 L13 38 L20 33 Z" fill="none" stroke="currentColor" stroke-width="1"/>
  <text x="20" y="8" text-anchor="middle" font-size="9" font-family="IBM Plex Mono, ui-monospace, monospace" fill="currentColor">N</text>
</svg>
<div class="p2-mobile-note" id="p2-mobile-note" hidden>열람 중심 화면 · 정밀 편집은 데스크톱 기준</div>
<div class="p2-foot" id="p2-foot">
  <span class="p2-xy mono" id="p2-xy">E —  N —</span>
  <span class="p2-snapkind" id="p2-snapkind"></span>
  <span class="p2-legend"><i class="lg lg--adopted"></i><span id="p2-lg-adopted">채택 r1</span><i class="lg lg--draft"></i><span>초안</span></span>
  <span class="p2-hint" id="p2-hint"></span>
</div>`;

    const canvas = container.querySelector('#p2-canvas');
    const g = canvas.getContext('2d');
    const $ = (id) => container.querySelector('#' + id);
    const ui = {
        sel: $('p2-tool-select'), draw: $('p2-tool-draw'), undo: $('p2-undo'), redo: $('p2-redo'), fit: $('p2-fit'),
        snapGrid: $('p2-snap-grid'), snapVertex: $('p2-snap-vertex'), ortho: $('p2-ortho'),
        xy: $('p2-xy'), snapKind: $('p2-snapkind'), hint: $('p2-hint'), lgAdopted: $('p2-lg-adopted'), mobileNote: $('p2-mobile-note'),
    };

    let active = false, disposed = false, fitted = false, raf = 0;
    let W = 0, H = 0, dpr = 1;
    const view = { e: 0, n: 0, s: 4 };                  // centre (m) and scale (px per m)
    let col = {};                                        // resolved theme colours
    let hover = null;                                    // { kind:'vertex'|'edge'|'parcel'|'building'|'close', i?, id? }
    let cursor = null;                                   // { x, y, w:[e,n], snap }
    let drag = null;                                     // vertex / pan / pinch gesture in progress
    let spaceDown = false, shiftDown = false;
    const snapOpt = { grid: true, vertex: true };
    const pointers = new Map();
    const cleanups = [];

    // ------------------------------------------------------------ coordinates
    const toS = (p) => [W / 2 + (p[0] - view.e) * view.s, H / 2 - (p[1] - view.n) * view.s];
    const toW = (x, y) => [view.e + (x - W / 2) / view.s, view.n - (y - H / 2) / view.s];
    const r2 = (v) => Math.round(v * 100) / 100;
    const fmt = (v, d) => (Number.isFinite(v) ? v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
    const fmtSigned = (v, d) => (v > 0 ? '+' : v < 0 ? '−' : '±') + fmt(Math.abs(v), d);
    const coord = (v) => ((v < 0 ? '−' : ' ') + Math.abs(v).toFixed(2)).padStart(8, ' ');

    function localXY(ev) {
        const r = canvas.getBoundingClientRect();
        return [ev.clientX - r.left, ev.clientY - r.top];
    }

    function currentRev(st) { return st.site.revisions.find((r) => r.rev === st.site.current); }
    function work(st) {
        st = st || store.getState();
        const d = st.site.draft;
        if (d) return { poly: d.polygon, closed: d.closed, draft: d };
        const r = currentRev(st);
        return { poly: r.polygon, closed: true, draft: null };
    }

    // ------------------------------------------------------------ theme
    function readColors() {
        const cs = getComputedStyle(document.documentElement);
        const v = (n) => cs.getPropertyValue(n).trim();
        col = {
            paper: v('--cv-paper'), road: v('--cv-road'), block: v('--cv-block'), park: v('--cv-park'), parcel: v('--cv-parcel'),
            bldg: v('--cv-bldg'), bldgLine: v('--cv-bldg-line'), grid: v('--cv-grid'), gridMajor: v('--cv-grid-major'), mark: v('--cv-mark'),
            ink: v('--ink'), muted: v('--muted'), accent: v('--accent'), boundary: v('--boundary'), warn: v('--warn'), ok: v('--ok'),
            onAccent: v('--on-accent'), panel: v('--panel'), line: v('--line'),
            mono: v('--font-mono') || 'ui-monospace, monospace', sans: v('--font-ui') || 'sans-serif',
        };
    }
    function alpha(c, a) {
        // accepts #rgb / #rrggbb; anything else is returned as-is with globalAlpha handled by caller
        if (/^#([0-9a-f]{3})$/i.test(c)) c = '#' + c.slice(1).split('').map((h) => h + h).join('');
        const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
        return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : c;
    }

    // ------------------------------------------------------------ sizing / view
    function resize() {
        const r = container.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (w !== W || h !== H || canvas.width !== Math.round(w * dpr)) {
            W = w; H = h;
            canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
            canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
        }
        syncToolbar();
        request();
    }

    const finiteP = (p) => Number.isFinite(p[0]) && Number.isFinite(p[1]);
    function bbox(poly) {
        let e0 = Infinity, e1 = -Infinity, n0 = Infinity, n1 = -Infinity;
        for (const p of poly) { if (!finiteP(p)) continue; e0 = Math.min(e0, p[0]); e1 = Math.max(e1, p[0]); n0 = Math.min(n0, p[1]); n1 = Math.max(n1, p[1]); }
        return { e0, e1, n0, n1 };
    }

    // Fit the sheet to the adopted site plus the draft (when there is one), so both can be compared.
    function fitPoly(st) {
        const w = work(st), adopted = currentRev(st).polygon;
        const pts = w.poly.filter(finiteP);
        if (!w.draft || pts.length < 2) return pts.length >= 2 ? pts : adopted;
        return st.layers.boundary ? pts.concat(adopted) : pts;
    }
    function fit() {
        const st = store.getState();
        const b = bbox(fitPoly(st));
        const bw = Math.max(b.e1 - b.e0, 4), bh = Math.max(b.n1 - b.n0, 4);
        const narrow = W < 600;
        const k = narrow ? 1.35 : 2.2;                      // site takes ~45% of the sheet on desktop
        const padTop = 46, padBottom = 30;                  // toolbar and footer
        view.s = Math.max(0.2, Math.min(200, Math.min(W / (bw * k), (H - padTop - padBottom) / (bh * k))));
        view.e = (b.e0 + b.e1) / 2;
        view.n = (b.n0 + b.n1) / 2 - ((padTop - padBottom) / 2) / view.s;
        request();
    }

    function zoomAt(x, y, factor) {
        const before = toW(x, y);
        view.s = Math.max(0.2, Math.min(400, view.s * factor));
        const after = toW(x, y);
        view.e += before[0] - after[0];
        view.n += before[1] - after[1];
        request();
    }

    // ------------------------------------------------------------ hit testing
    function distToSeg(p, a, b) {
        const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
        let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
        t = Math.max(0, Math.min(1, t));
        const q = [a[0] + dx * t, a[1] + dy * t];
        return { d: Math.hypot(p[0] - q[0], p[1] - q[1]), t };
    }
    function hitVertex(x, y, poly, tol) {
        let best = -1, bd = tol;
        poly.forEach((p, i) => { const s = toS(p), d = Math.hypot(s[0] - x, s[1] - y); if (d <= bd) { bd = d; best = i; } });
        return best;
    }
    function hitEdge(x, y, poly, closed, tol) {
        const n = poly.length, m = closed ? n : n - 1;
        let best = null;
        for (let i = 0; i < m; i++) {
            const a = toS(poly[i]), b = toS(poly[(i + 1) % n]);
            const r = distToSeg([x, y], a, b);
            if (r.d <= tol && (!best || r.d < best.d)) best = { i, d: r.d, t: r.t };
        }
        return best;
    }
    function hitTest(x, y, touch) {
        const st = store.getState();
        const w = work(st);
        const tv = touch ? 16 : HIT_VERTEX_PX, te = touch ? 12 : HIT_EDGE_PX;
        if (st.layers.boundary || w.draft) {
            const vi = hitVertex(x, y, w.poly, tv);
            if (vi >= 0) return { kind: 'vertex', i: vi };
            const ed = hitEdge(x, y, w.poly, w.closed, te);
            if (ed) return { kind: 'edge', i: ed.i, t: ed.t };
        }
        const p = toW(x, y);
        if (w.closed && w.poly.length >= 3 && C.pointInPolygon(p, w.poly)) return { kind: 'site' };
        if (st.layers.context) { const id = C.buildingAt(p); if (id) return { kind: 'building', id }; }
        if (st.layers.parcels) { const id = C.parcelAt(p); if (id) return { kind: 'parcel', id }; }
        return null;
    }

    // ------------------------------------------------------------ snapping
    function snapAt(wp, opts) {
        const st = store.getState();
        const w = work(st);
        const verts = [];
        if (snapOpt.vertex) {
            w.poly.forEach((p, i) => { if (i !== opts.exclude) verts.push(p); });
            if (w.draft) for (const p of currentRev(st).polygon) verts.push(p);
            const reach = (VERTEX_SNAP_PX / view.s) * 1.5;
            for (const p of C.snapVertices()) if (Math.abs(p[0] - wp[0]) <= reach && Math.abs(p[1] - wp[1]) <= reach) verts.push(p);
        }
        const res = C.snap(wp, {
            gridStep: snapOpt.grid ? 0.5 : 0,
            toleranceM: VERTEX_SNAP_PX / view.s,
            vertices: verts,
            orthoFrom: shiftDown && opts.orthoFrom ? opts.orthoFrom : null,
        });
        if (!res.kind) res.p = [r2(res.p[0]), r2(res.p[1])];
        return res;
    }
    const SNAP_LABEL = { vertex: '꼭짓점', ortho: '직교', grid: '그리드 0.5 m' };

    // ------------------------------------------------------------ drawing
    function request() { if (active && !raf) raf = requestAnimationFrame(draw); }

    function visibleRect() {
        const a = toW(0, H), b = toW(W, 0);
        return { e0: a[0], n0: a[1], e1: b[0], n1: b[1] };
    }
    const inView = (vr, e0, e1, n0, n1) => !(e1 < vr.e0 || e0 > vr.e1 || n1 < vr.n0 || n0 > vr.n1);

    // A non-finite vertex (NAN issue) breaks the line instead of corrupting the whole path.
    function pathPoly(poly, closed) {
        g.beginPath();
        let pen = false;
        const ok = poly.every(finiteP);
        poly.forEach((p) => {
            if (!finiteP(p)) { pen = false; return; }
            const s = toS(p);
            if (pen) g.lineTo(s[0], s[1]); else g.moveTo(s[0], s[1]);
            pen = true;
        });
        if (closed && ok) g.closePath();
    }
    function rectPath(e0, e1, n0, n1) {
        const a = toS([e0, n1]);
        g.rect(a[0], a[1], (e1 - e0) * view.s, (n1 - n0) * view.s);
    }

    function gridSteps() {
        const fine = [0.5, 1, 5, 10, 50, 100].find((s) => s * view.s >= 6) || 100;
        const coarse = [5, 10, 50, 100, 500, 1000].find((s) => s >= fine * 5 && s * view.s >= 40) || 1000;
        return { fine, coarse };
    }

    function drawGrid(vr) {
        const { fine, coarse } = gridSteps();
        const lines = (step, color, width) => {
            g.beginPath();
            const e0 = Math.floor(vr.e0 / step) * step, n0 = Math.floor(vr.n0 / step) * step;
            for (let e = e0; e <= vr.e1; e += step) { const x = Math.round(toS([e, 0])[0]) + 0.5; g.moveTo(x, 0); g.lineTo(x, H); }
            for (let n = n0; n <= vr.n1; n += step) { const y = Math.round(toS([0, n])[1]) + 0.5; g.moveTo(0, y); g.lineTo(W, y); }
            g.strokeStyle = color; g.lineWidth = width; g.stroke();
        };
        lines(fine, col.grid, 1);
        lines(coarse, col.gridMajor, 1);
        return { fine, coarse };
    }

    function drawCity(st, vr) {
        const L = st.layers;
        if (L.roads) {
            g.fillStyle = col.road;
            g.beginPath();
            for (const r of D.roads) if (inView(vr, r.e0, r.e1, r.n0, r.n1)) rectPath(r.e0, r.e1, r.n0, r.n1);
            g.fill();
            // blocks incl. sidewalk
            g.beginPath();
            for (const b of D.blocks) {
                const e0 = b.e0 - b.pad.w, e1 = b.e1 + b.pad.e, n0 = b.n0 - b.pad.s, n1 = b.n1 + b.pad.n;
                if (inView(vr, e0, e1, n0, n1)) rectPath(e0, e1, n0, n1);
            }
            g.fillStyle = col.block; g.fill();
            g.strokeStyle = col.mark; g.lineWidth = 1; g.stroke();
            if (view.s > 1.2) {
                g.save();
                g.setLineDash([3 * view.s, 3 * view.s]);
                g.beginPath();
                for (const m of D.markings) {
                    if (!m.dashed || !inView(vr, Math.min(m.e0, m.e1), Math.max(m.e0, m.e1), Math.min(m.n0, m.n1), Math.max(m.n0, m.n1))) continue;
                    const a = toS([m.e0, m.n0]), b = toS([m.e1, m.n1]);
                    g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
                }
                g.strokeStyle = col.mark; g.lineWidth = 1; g.stroke();
                g.restore();
            }
        }
        g.beginPath();
        for (const b of D.blocks) if (b.kind === 'park' && inView(vr, b.e0, b.e1, b.n0, b.n1)) rectPath(b.e0, b.e1, b.n0, b.n1);
        g.fillStyle = col.park; g.fill();

        if (L.parcels) {
            g.beginPath();
            for (const p of D.parcels) if (inView(vr, p.e0, p.e1, p.n0, p.n1)) rectPath(p.e0, p.e1, p.n0, p.n1);
            g.strokeStyle = col.parcel; g.lineWidth = 1; g.stroke();
        }
        if (L.context) {
            g.beginPath();
            const upper = [];
            for (const b of D.buildings) {
                b.parts.forEach((q, k) => {
                    if (!inView(vr, q.e0, q.e1, q.n0, q.n1)) return;
                    if (k === 0) rectPath(q.e0, q.e1, q.n0, q.n1); else upper.push(q);
                });
            }
            g.fillStyle = col.bldg; g.fill();
            g.strokeStyle = col.bldgLine; g.lineWidth = 1; g.stroke();
            if (upper.length) {
                g.save(); g.setLineDash([4, 3]); g.beginPath();
                for (const q of upper) rectPath(q.e0, q.e1, q.n0, q.n1);
                g.stroke(); g.restore();
            }
            if (view.s >= 3.2) {
                g.font = `10px ${col.mono}`; g.fillStyle = col.muted; g.textAlign = 'center'; g.textBaseline = 'middle';
                D.buildings.forEach((b) => {
                    const q = b.parts[0];
                    if (!inView(vr, q.e0, q.e1, q.n0, q.n1)) return;
                    const s = toS([(q.e0 + q.e1) / 2, (q.n0 + q.n1) / 2]);
                    g.fillText(`${b.floors}F`, s[0], s[1]);
                });
            }
        }
        if (L.parcels && view.s >= 6) {
            g.font = `9.5px ${col.mono}`; g.fillStyle = col.muted; g.textAlign = 'left'; g.textBaseline = 'top';
            D.parcels.forEach((p, i) => {
                if (!inView(vr, p.e0, p.e1, p.n0, p.n1)) return;
                const s = toS([p.e0, p.n1]);
                g.fillText('P' + String(i).padStart(3, '0'), s[0] + 4, s[1] + 4);
            });
        }
    }

    function drawSelectionObjects(st) {
        const sel = st.selection;
        const hl = (poly, fill, stroke, w) => { pathPoly(poly, true); if (fill) { g.fillStyle = fill; g.fill(); } g.strokeStyle = stroke; g.lineWidth = w; g.stroke(); };
        if (hover && hover.kind === 'parcel' && !(sel && sel.kind === 'parcel' && sel.id === hover.id)) hl(C.parcelPolygon(hover.id), null, col.ink, 1.25);
        if (hover && hover.kind === 'building') { const b = C.building(hover.id); if (b) hl(b.footprint, null, col.ink, 1.25); }
        if (sel && sel.kind === 'parcel') { const p = C.parcelPolygon(sel.id); if (p) hl(p, alpha(col.accent, 0.12), col.accent, 2); }
        if (sel && sel.kind === 'building') { const b = C.building(sel.id); if (b) hl(b.footprint, alpha(col.accent, 0.14), col.accent, 2); }
    }

    function orientSign(poly) { return C.signedArea(poly) >= 0 ? 1 : -1; }

    // Architectural dimension: offset dimension line, extension lines, 45° ticks, upright text.
    function drawDim(a, b, sign, color, offPx) {
        if (!finiteP(a) || !finiteP(b)) return;
        const A = toS(a), B = toS(b);
        const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy);
        if (L < 34) return;
        const ux = dx / L, uy = dy / L;
        // world outward normal for CCW is (dn, -de); in screen space y is flipped -> (uy, -ux)·sign... derive directly:
        const nx = -uy * sign, ny = ux * sign;
        const off = offPx;
        const a1 = [A[0] + nx * off, A[1] + ny * off], b1 = [B[0] + nx * off, B[1] + ny * off];
        g.beginPath();
        g.moveTo(A[0] + nx * 3, A[1] + ny * 3); g.lineTo(A[0] + nx * (off + 4), A[1] + ny * (off + 4));
        g.moveTo(B[0] + nx * 3, B[1] + ny * 3); g.lineTo(B[0] + nx * (off + 4), B[1] + ny * (off + 4));
        g.moveTo(a1[0], a1[1]); g.lineTo(b1[0], b1[1]);
        const tx = (ux - nx) * 3.2, ty = (uy - ny) * 3.2;
        g.moveTo(a1[0] - tx, a1[1] - ty); g.lineTo(a1[0] + tx, a1[1] + ty);
        g.moveTo(b1[0] - tx, b1[1] - ty); g.lineTo(b1[0] + tx, b1[1] + ty);
        g.strokeStyle = color; g.lineWidth = 1; g.stroke();
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const label = len.toFixed(2);
        let ang = Math.atan2(uy, ux);
        if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
        const mx = (a1[0] + b1[0]) / 2 + nx * 7, my = (a1[1] + b1[1]) / 2 + ny * 7;
        g.save();
        g.translate(mx, my); g.rotate(ang);
        g.font = `500 10.5px ${col.mono}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        const tw = g.measureText(label).width;
        g.fillStyle = alpha(col.paper, 0.9); g.fillRect(-tw / 2 - 2, -7, tw + 4, 14);
        g.fillStyle = color; g.fillText(label, 0, 0.5);
        g.restore();
    }

    function vertexLabel(poly, i, color, sign) {
        const n = poly.length;
        if (!finiteP(poly[i])) return;
        const p = toS(poly[i]);
        let ox = 10, oy = -10;
        if (n >= 3) {
            const a = toS(poly[(i - 1 + n) % n]), b = toS(poly[(i + 1) % n]);
            const u1 = [p[0] - a[0], p[1] - a[1]], u2 = [p[0] - b[0], p[1] - b[1]];
            const l1 = Math.hypot(...u1) || 1, l2 = Math.hypot(...u2) || 1;
            let bx = u1[0] / l1 + u2[0] / l2, by = u1[1] / l1 + u2[1] / l2;
            const bl = Math.hypot(bx, by);
            if (bl > 1e-3) {
                bx /= bl; by /= bl;
                // The bisector points away from the interior at a convex vertex and into it at a reflex one.
                // Screen y is flipped, so the world turn direction is the negated screen cross product.
                const crs = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]);
                const k = -crs * sign > 0 ? 13 : -13;
                ox = bx * k; oy = by * k;
            }
        }
        g.font = `500 10px ${col.mono}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = color;
        g.fillText('P' + (i + 1), p[0] + ox, p[1] + oy);
    }

    function areaLabel(poly, title, area, color, extra) {
        let c = C.centroid(poly);
        if (!C.pointInPolygon(c, poly)) {
            const tri = C.triangulate(poly);
            if (tri.length >= 3) { const a = poly[tri[0]], b = poly[tri[1]], d = poly[tri[2]]; c = [(a[0] + b[0] + d[0]) / 3, (a[1] + b[1] + d[1]) / 3]; }
        }
        const s = toS(c);
        const lines = [[title, `500 10px ${col.sans}`, col.muted], [(Number.isFinite(area) ? fmt(area, 1) : '—') + ' ㎡', `600 13px ${col.mono}`, color]];
        if (extra) lines.push([extra[0], `500 10.5px ${col.mono}`, extra[1]]);
        g.textAlign = 'center'; g.textBaseline = 'middle';
        let w = 0;
        for (const [t, f] of lines) { g.font = f; w = Math.max(w, g.measureText(t).width); }
        const h = lines.length * 15 + 6;
        g.fillStyle = alpha(col.paper, 0.86);
        g.fillRect(s[0] - w / 2 - 6, s[1] - h / 2, w + 12, h);
        lines.forEach(([t, f, c2], k) => { g.font = f; g.fillStyle = c2; g.fillText(t, s[0], s[1] - h / 2 + 10 + k * 15); });
    }

    function handle(p, size, fill, stroke, lw) {
        if (!finiteP(p)) return;
        const s = toS(p);
        g.beginPath(); g.rect(s[0] - size / 2, s[1] - size / 2, size, size);
        g.fillStyle = fill; g.fill(); g.strokeStyle = stroke; g.lineWidth = lw; g.stroke();
    }

    function drawAdopted(st, faded) {
        const r = currentRev(st), poly = r.polygon;
        g.save();
        g.globalAlpha = faded ? 0.6 : 1;
        pathPoly(poly, true);
        g.fillStyle = alpha(col.boundary, 0.05); g.fill();
        g.setLineDash([16, 3, 2, 3]);
        g.strokeStyle = col.boundary; g.lineWidth = 1.75; g.stroke();
        g.setLineDash([]);
        g.restore();
        if (faded) return;
        const sel = st.selection;
        const sign = orientSign(poly);
        poly.forEach((p, i) => {
            const on = sel && sel.kind === 'vertex' && sel.i === i, hv = hover && hover.kind === 'vertex' && hover.i === i;
            handle(p, on ? 9 : 6, on ? col.accent : col.paper, on || hv ? col.accent : col.boundary, 1.25);
        });
        if (sel && sel.kind === 'edge') { g.beginPath(); const a = toS(poly[sel.i]), b = toS(poly[(sel.i + 1) % poly.length]); g.moveTo(...a); g.lineTo(...b); g.strokeStyle = col.accent; g.lineWidth = 3; g.stroke(); }
        if (view.s >= 2.5) {
            for (let i = 0; i < poly.length; i++) drawDim(poly[i], poly[(i + 1) % poly.length], sign, col.muted, 18);
            for (let i = 0; i < poly.length; i++) vertexLabel(poly, i, col.boundary, sign);
        }
        areaLabel(poly, `채택 r${r.rev} · 대지면적`, r.area, col.ink);
    }

    function drawDraft(st) {
        const d = st.site.draft, poly = d.polygon, n = poly.length;
        const v = d.validation, sel = st.selection;
        const bad = !v.ok && d.closed;
        if (!n) return;
        const hasNaN = v.issues.some((is) => is.code === 'NAN');
        if (d.closed && n >= 3 && !hasNaN) {
            pathPoly(poly, true);
            g.fillStyle = alpha(bad ? col.warn : col.accent, bad ? 0.1 : 0.08); g.fill();
        }
        // validation highlights under the line
        const badEdges = new Set(), badVerts = new Set(), points = [];
        for (const is of v.issues) {
            (is.edges || []).forEach((e) => badEdges.add(e));
            (is.vertices || []).forEach((i) => badVerts.add(i));
            (is.points || []).forEach((p) => points.push(p));
        }
        if (badEdges.size) {
            g.beginPath();
            for (const e of badEdges) { if (!finiteP(poly[e]) || !finiteP(poly[(e + 1) % n])) continue; const a = toS(poly[e]), b = toS(poly[(e + 1) % n]); g.moveTo(...a); g.lineTo(...b); }
            g.strokeStyle = alpha(col.warn, 0.45); g.lineWidth = 7; g.lineCap = 'round'; g.stroke(); g.lineCap = 'butt';
        }
        pathPoly(poly, d.closed);
        g.strokeStyle = col.ink; g.lineWidth = 2; g.stroke();

        // rubber band while drawing
        const st2 = store.getState();
        if (!d.closed && st2.ui.tool === 'draw' && cursor && cursor.snap && !drag && finiteP(poly[n - 1])) {
            const last = toS(poly[n - 1]), c = toS(cursor.snap.p);
            g.save(); g.setLineDash([6, 4]);
            g.beginPath(); g.moveTo(...last); g.lineTo(...c); g.strokeStyle = col.ink; g.lineWidth = 1.25; g.stroke();
            if (n >= 2 && finiteP(poly[0])) { const f = toS(poly[0]); g.beginPath(); g.moveTo(...c); g.lineTo(...f); g.strokeStyle = alpha(col.muted, 0.6); g.lineWidth = 1; g.stroke(); }
            g.restore();
            drawDim(poly[n - 1], cursor.snap.p, 1, col.accent, 16);
        }

        const sign = d.closed ? orientSign(poly) : 1;
        if (view.s >= 1.5) for (let i = 0; i < (d.closed ? n : n - 1); i++) drawDim(poly[i], poly[(i + 1) % n], sign, badEdges.has(i) ? col.warn : col.ink, 18);

        if (sel && sel.kind === 'edge' && sel.i < n && finiteP(poly[sel.i]) && finiteP(poly[(sel.i + 1) % n])) {
            g.beginPath(); const a = toS(poly[sel.i]), b = toS(poly[(sel.i + 1) % n]); g.moveTo(...a); g.lineTo(...b);
            g.strokeStyle = col.accent; g.lineWidth = 3.5; g.stroke();
        } else if (hover && hover.kind === 'edge' && hover.i < n && finiteP(poly[hover.i]) && finiteP(poly[(hover.i + 1) % n])) {
            g.beginPath(); const a = toS(poly[hover.i]), b = toS(poly[(hover.i + 1) % n]); g.moveTo(...a); g.lineTo(...b);
            g.strokeStyle = alpha(col.accent, 0.6); g.lineWidth = 3; g.stroke();
        }
        // intersection markers
        for (const p of points) {
            const s = toS(p);
            g.beginPath(); g.arc(s[0], s[1], 8, 0, Math.PI * 2);
            g.fillStyle = alpha(col.warn, 0.2); g.fill(); g.strokeStyle = col.warn; g.lineWidth = 1.75; g.stroke();
            g.beginPath(); g.moveTo(s[0] - 4, s[1] - 4); g.lineTo(s[0] + 4, s[1] + 4); g.moveTo(s[0] + 4, s[1] - 4); g.lineTo(s[0] - 4, s[1] + 4); g.stroke();
        }
        // handles
        poly.forEach((p, i) => {
            const on = sel && sel.kind === 'vertex' && sel.i === i;
            const hv = hover && (hover.kind === 'vertex' || hover.kind === 'close') && hover.i === i;
            if (badVerts.has(i) && finiteP(p)) { const s = toS(p); g.beginPath(); g.arc(s[0], s[1], 9, 0, Math.PI * 2); g.strokeStyle = col.warn; g.lineWidth = 2; g.stroke(); }
            if (hover && hover.kind === 'close' && i === 0 && finiteP(p)) { const s = toS(p); g.beginPath(); g.arc(s[0], s[1], 11, 0, Math.PI * 2); g.strokeStyle = col.accent; g.lineWidth = 2; g.stroke(); }
            handle(p, on ? 10 : 8, on ? col.accent : col.paper, on || hv ? col.accent : col.ink, 1.5);
        });
        if (view.s >= 1.5) poly.forEach((_, i) => vertexLabel(poly, i, badVerts.has(i) ? col.warn : col.ink, sign));
        if (hasNaN) {
            const pts = poly.filter(finiteP);
            if (pts.length) areaLabel(pts, '초안 · 대지면적', NaN, col.warn, ['숫자가 아닌 좌표 · 면적 산정 불가', col.warn]);
        } else if (d.closed && n >= 3) {
            const base = currentRev(st);
            const crossing = v.issues.some((is) => is.code === 'SELF_INTERSECT');
            if (crossing) areaLabel(poly, '초안 · 대지면적', NaN, col.warn, ['자기교차 · 면적 산정 불가', col.warn]);
            else {
                const delta = v.area - base.area;
                areaLabel(poly, '초안 · 대지면적', v.area, bad ? col.warn : col.ink, [`Δ ${fmtSigned(delta, 1)} ㎡ (r${base.rev} 대비)`, Math.abs(delta) < 0.05 ? col.muted : delta > 0 ? col.accent : col.boundary]);
            }
        }
    }

    function drawSnap() {
        if (!cursor || !cursor.snap || !cursor.snap.kind || !cursor.showSnap) return;
        const sp = cursor.snap, s = toS(sp.p);
        g.save();
        g.strokeStyle = col.accent; g.lineWidth = 1.5;
        if (sp.kind === 'vertex') { g.strokeRect(s[0] - 7, s[1] - 7, 14, 14); }
        else if (sp.kind === 'ortho') {
            const f = toS(sp.target);
            g.setLineDash([2, 3]); g.beginPath();
            if (sp.axis === 'e') { g.moveTo(0, f[1]); g.lineTo(W, f[1]); } else { g.moveTo(f[0], 0); g.lineTo(f[0], H); }
            g.lineWidth = 1; g.stroke(); g.setLineDash([]);
            g.beginPath(); g.moveTo(s[0] - 6, s[1]); g.lineTo(s[0] + 6, s[1]); g.moveTo(s[0], s[1] - 6); g.lineTo(s[0], s[1] + 6); g.lineWidth = 1.5; g.stroke();
        } else { g.beginPath(); g.moveTo(s[0] - 4, s[1] - 4); g.lineTo(s[0] + 4, s[1] + 4); g.moveTo(s[0] + 4, s[1] - 4); g.lineTo(s[0] - 4, s[1] + 4); g.stroke(); }
        // tag next to cursor
        const label = SNAP_LABEL[sp.kind];
        g.font = `500 10.5px ${col.sans}`; g.textAlign = 'left'; g.textBaseline = 'middle';
        const tw = g.measureText(label).width;
        const tx = Math.min(cursor.x + 14, W - tw - 12), ty = Math.min(cursor.y + 18, H - 40);
        g.fillStyle = col.accent; g.fillRect(tx, ty - 8, tw + 10, 16);
        g.fillStyle = col.onAccent; g.fillText(label, tx + 5, ty + 0.5);
        g.restore();
    }

    function drawScaleBar() {
        const target = Math.min(140, W * 0.25);
        const L = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((m) => m * view.s >= target * 0.55) || 1000;
        const px = L * view.s;
        const x0 = W - px - 18, y0 = H - 40;
        g.save();
        for (let k = 0; k < 4; k++) {
            g.fillStyle = k % 2 ? col.paper : col.ink;
            g.fillRect(x0 + (px / 4) * k, y0, px / 4, 4);
        }
        g.strokeStyle = col.ink; g.lineWidth = 1; g.strokeRect(x0 + 0.5, y0 + 0.5, px - 1, 4);
        g.font = `10px ${col.mono}`; g.fillStyle = col.ink; g.textBaseline = 'bottom';
        g.textAlign = 'left'; g.fillText('0', x0, y0 - 2);
        g.textAlign = 'right'; g.fillText(`${L} m`, x0 + px, y0 - 2);
        g.restore();
    }

    function draw() {
        raf = 0;
        if (!active || !W) return;
        const st = store.getState();
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.fillStyle = col.paper; g.fillRect(0, 0, W, H);
        const vr = visibleRect();
        const steps = drawGrid(vr);
        drawCity(st, vr);
        drawSelectionObjects(st);
        if (st.layers.boundary) drawAdopted(st, !!st.site.draft);
        if (st.site.draft) drawDraft(st);
        drawSnap();
        drawScaleBar();
        ui.gridInfo = steps;
        updateFoot(st, steps);
    }

    // ------------------------------------------------------------ footer / toolbar state
    function updateFoot(st, steps) {
        st = st || store.getState();
        const r = currentRev(st);
        ui.lgAdopted.textContent = `채택 r${r.rev}`;
        const tool = st.ui.tool, d = st.site.draft;
        let hint;
        if (tool === 'draw') {
            hint = !d || d.closed
                ? '클릭: 새 경계 시작 · Shift: 직교'
                : `클릭: 점 추가 · 첫 점 클릭/Enter: 폐합 · Backspace: 마지막 점 삭제 · Esc: 취소 · Shift: 직교`;
        } else {
            hint = '드래그: 꼭짓점 이동 · 변 더블클릭: 꼭짓점 삽입 · Delete: 삭제 · 빈 곳 드래그/휠: 이동·확대';
        }
        if (steps) hint += ` · 그리드 ${steps.fine}/${steps.coarse} m`;
        if (ui.hint.textContent !== hint) ui.hint.textContent = hint;
    }

    function syncToolbar() {
        const st = store.getState();
        ui.sel.setAttribute('aria-pressed', String(st.ui.tool === 'select'));
        ui.draw.setAttribute('aria-pressed', String(st.ui.tool === 'draw'));
        ui.undo.disabled = !store.canUndo();
        ui.redo.disabled = !store.canRedo();
        ui.snapGrid.setAttribute('aria-pressed', String(snapOpt.grid));
        ui.snapVertex.setAttribute('aria-pressed', String(snapOpt.vertex));
        ui.ortho.classList.toggle('on', shiftDown);
        canvas.dataset.tool = st.ui.tool;
        const mobile = !!ctx.isMobile;
        ui.mobileNote.hidden = !mobile;
    }

    function updateCursorReadout() {
        if (!cursor) { ui.xy.textContent = 'E —  N —'; ui.snapKind.textContent = ''; return; }
        const p = cursor.snap ? cursor.snap.p : cursor.w;
        ui.xy.textContent = `E ${coord(p[0])}   N ${coord(p[1])} m`;
        ui.snapKind.textContent = cursor.snap && cursor.snap.kind && cursor.showSnap ? `스냅: ${SNAP_LABEL[cursor.snap.kind]}` : '';
    }

    function setCursorStyle() {
        const st = store.getState();
        let c = 'default';
        if (drag && drag.type === 'pan') c = 'grabbing';
        else if (spaceDown) c = 'grab';
        else if (drag && drag.type === 'vertex') c = 'move';
        else if (st.ui.tool === 'draw') c = 'crosshair';
        else if (hover && hover.kind === 'vertex') c = 'move';
        else if (hover && (hover.kind === 'edge' || hover.kind === 'parcel' || hover.kind === 'building')) c = 'pointer';
        canvas.style.cursor = c;
    }

    // ------------------------------------------------------------ interaction
    function startDrawIfNeeded() {
        const d = store.getState().site.draft;
        if (!d || d.closed) store.startDraft(null, 'DIRECT');
    }

    function drawClick(x, y) {
        const st = store.getState();
        const d = st.site.draft;
        if (d && !d.closed && d.polygon.length >= 3) {
            const f = toS(d.polygon[0]);
            if (Math.hypot(x - f[0], y - f[1]) <= VERTEX_SNAP_PX + 2) {
                store.edit({ type: 'close' });
                store.setTool('select');
                ctx.onStatus('경계를 폐합했습니다. 검증 결과를 확인하고 채택하세요.');
                return;
            }
        }
        startDrawIfNeeded();
        const d2 = store.getState().site.draft;
        const last = d2.polygon[d2.polygon.length - 1];
        const sp = snapAt(toW(x, y), { orthoFrom: last });
        // a double click (or a second click on the same snapped spot) must not create a duplicate vertex
        if (last && Math.hypot(sp.p[0] - last[0], sp.p[1] - last[1]) < C.LIMITS.duplicate) {
            ctx.onStatus('같은 위치에는 점을 다시 넣지 않습니다. 폐합하려면 첫 점을 누르거나 Enter를 누르세요.');
            return;
        }
        store.edit({ type: 'add', p: sp.p });
    }

    function selectAt(x, y, touch) {
        const h = hitTest(x, y, touch);
        if (!h) { store.select(null); return; }
        if (h.kind === 'vertex' || h.kind === 'edge') store.select({ kind: h.kind, i: h.i });
        else if (h.kind === 'site') store.select({ kind: 'site' });
        else store.select({ kind: h.kind, id: h.id });
    }

    function updateHover(x, y) {
        const st = store.getState();
        let h = null;
        if (st.ui.tool === 'draw') {
            const d = st.site.draft;
            if (d && !d.closed && d.polygon.length >= 3) {
                const f = toS(d.polygon[0]);
                if (Math.hypot(x - f[0], y - f[1]) <= VERTEX_SNAP_PX + 2) h = { kind: 'close', i: 0 };
            }
        } else h = hitTest(x, y, false);
        const key = (o) => (o ? `${o.kind}:${o.i ?? o.id ?? ''}` : '');
        if (key(h) !== key(hover)) { hover = h; request(); }
    }

    function onPointerDown(ev) {
        if (!active) return;
        canvas.focus({ preventScroll: true });
        const [x, y] = localXY(ev);
        pointers.set(ev.pointerId, { x, y });
        try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
        if (pointers.size === 2) {
            // pinch (touch): cancel any single-pointer gesture
            if (drag && drag.type === 'vertex' && drag.moved) store.endPreview(false);
            const [p1, p2] = [...pointers.values()];
            drag = { type: 'pinch', d0: Math.hypot(p2.x - p1.x, p2.y - p1.y), s0: view.s, mid: [(p1.x + p2.x) / 2, (p1.y + p2.y) / 2], w0: toW((p1.x + p2.x) / 2, (p1.y + p2.y) / 2) };
            return;
        }
        if (pointers.size > 2) return;
        const touch = ev.pointerType === 'touch';
        const st = store.getState();
        if (ev.button === 1 || ev.button === 2 || spaceDown) {
            ev.preventDefault();
            drag = { type: 'pan', x0: x, y0: y, e0: view.e, n0: view.n, moved: true };
            setCursorStyle();
            return;
        }
        if (ev.button !== 0) return;
        if (st.ui.tool === 'select' && !touch) {
            const h = hitTest(x, y, false);
            if (h && h.kind === 'vertex') {
                store.select({ kind: 'vertex', i: h.i });
                drag = { type: 'vertex', i: h.i, x0: x, y0: y, moved: false, base: work().poly.map((p) => p.slice()) };
                return;
            }
        }
        drag = { type: 'press', x0: x, y0: y, e0: view.e, n0: view.n, moved: false, touch };
    }

    function onPointerMove(ev) {
        if (!active) return;
        const [x, y] = localXY(ev);
        if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x, y });
        if (drag && drag.type === 'pinch' && pointers.size >= 2) {
            const [p1, p2] = [...pointers.values()];
            const dd = Math.hypot(p2.x - p1.x, p2.y - p1.y);
            view.s = Math.max(0.2, Math.min(400, drag.s0 * (dd / Math.max(1, drag.d0))));
            const mid = [(p1.x + p2.x) / 2, (p1.y + p2.y) / 2];
            view.e = drag.w0[0] - (mid[0] - W / 2) / view.s;
            view.n = drag.w0[1] + (mid[1] - H / 2) / view.s;
            request();
            return;
        }
        const st = store.getState();
        const w = toW(x, y);
        cursor = { x, y, w, snap: null, showSnap: false };
        if (drag && (drag.type === 'pan' || drag.type === 'press')) {
            if (drag.type === 'press' && Math.hypot(x - drag.x0, y - drag.y0) > DRAG_PX) { drag.type = 'pan'; drag.moved = true; setCursorStyle(); }
            if (drag.type === 'pan') {
                view.e = drag.e0 - (x - drag.x0) / view.s;
                view.n = drag.n0 + (y - drag.y0) / view.s;
                request();
                updateCursorReadout();
                return;
            }
        }
        if (drag && drag.type === 'vertex') {
            if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) <= DRAG_PX) return;
            drag.moved = true;
            const n = drag.base.length;
            const sp = snapAt(w, { exclude: drag.i, orthoFrom: drag.base[(drag.i - 1 + n) % n] });
            cursor.snap = sp; cursor.showSnap = true;
            const poly = drag.base.map((p) => p.slice());
            poly[drag.i] = sp.p;
            store.preview(poly);
            updateCursorReadout();
            setCursorStyle();
            return;
        }
        if (st.ui.tool === 'draw') {
            const d = st.site.draft;
            const last = d && !d.closed && d.polygon.length ? d.polygon[d.polygon.length - 1] : null;
            cursor.snap = snapAt(w, { orthoFrom: last });
            cursor.showSnap = true;
            request();
        }
        updateHover(x, y);
        updateCursorReadout();
        setCursorStyle();
    }

    function onPointerUp(ev) {
        if (!active) return;
        const [x, y] = localXY(ev);
        pointers.delete(ev.pointerId);
        try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
        const dg = drag;
        if (dg && dg.type === 'pinch') { if (pointers.size === 0) drag = null; return; }
        drag = null;
        if (!dg) return;
        if (dg.type === 'vertex') {
            if (dg.moved) {
                store.endPreview(true);
                const p = work().poly[dg.i];
                if (p) ctx.onStatus(`P${dg.i + 1} 이동 → E ${p[0].toFixed(2)}, N ${p[1].toFixed(2)} m`);
            }
        } else if (dg.type === 'press' && !dg.moved) {
            const st = store.getState();
            if (st.ui.tool === 'draw') drawClick(x, y);
            else selectAt(x, y, dg.touch);
        }
        setCursorStyle();
        request();
    }

    function onPointerCancel(ev) {
        pointers.delete(ev.pointerId);
        if (drag && drag.type === 'vertex' && drag.moved) store.endPreview(false);
        drag = null;
        request();
    }

    function onDblClick(ev) {
        if (!active) return;
        const st = store.getState();
        if (st.ui.tool !== 'select') return;
        const [x, y] = localXY(ev);
        const w = work(st);
        if (hitVertex(x, y, w.poly, HIT_VERTEX_PX) >= 0) return;
        const ed = hitEdge(x, y, w.poly, w.closed, HIT_EDGE_PX + 2);
        if (!ed) return;
        const a = w.poly[ed.i], b = w.poly[(ed.i + 1) % w.poly.length];
        const p = [r2(a[0] + (b[0] - a[0]) * ed.t), r2(a[1] + (b[1] - a[1]) * ed.t)];
        if (store.edit({ type: 'insert', edge: ed.i, p })) {
            store.select({ kind: 'vertex', i: ed.i + 1 });
            ctx.onStatus(`꼭짓점 P${ed.i + 2} 삽입 · 변 P${ed.i + 1}–P${ed.i + 3 > w.poly.length + 1 ? 1 : ed.i + 3} 사이`);
        }
    }

    function onWheel(ev) {
        if (!active) return;
        ev.preventDefault();
        const [x, y] = localXY(ev);
        const dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
        zoomAt(x, y, Math.exp(-dy * 0.0015));
    }

    function onLeave() { cursor = null; if (hover) hover = null; updateCursorReadout(); request(); }

    const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

    function onKeyDown(ev) {
        if (!active || typing(ev.target)) return;
        if (document.querySelector('.dialog:not([hidden])')) return;
        const st = store.getState();
        const d = st.site.draft;
        if (ev.key === 'Shift' && !shiftDown) { shiftDown = true; refreshSnapAtCursor(); syncToolbar(); return; }
        if (ev.key === ' ' && !ev.repeat) {
            if (ev.target === canvas || ev.target === document.body) ev.preventDefault();
            spaceDown = true; setCursorStyle(); return;
        }
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
        if (ev.key === 'Enter' && st.ui.tool === 'draw' && d && !d.closed) {
            ev.preventDefault();
            if (store.edit({ type: 'close' })) { store.setTool('select'); ctx.onStatus('경계를 폐합했습니다.'); }
            else ctx.onStatus('꼭짓점이 3개 이상이어야 폐합할 수 있습니다.');
            return;
        }
        if (ev.key === 'Escape') {
            if (drag && drag.type === 'vertex' && drag.moved) { store.endPreview(false); drag = null; request(); return; }
            if (st.ui.tool === 'draw') {
                if (d && !d.closed) {
                    // step back to the draft that existed before this drawing started; none -> drop the draft
                    let guard = 0;
                    while (store.canUndo() && !store.getState().site.draft.closed && guard++ < 1000) store.undo();
                    const left = store.getState().site.draft;
                    if (left && !left.closed) store.cancelDraft();
                    ctx.onStatus(left && left.closed ? '그리기를 취소하고 이전 초안으로 돌아갔습니다.' : '그리던 경계를 취소했습니다.');
                }
                store.setTool('select');
                return;
            }
            if (st.selection) store.select(null);
            return;
        }
        if (ev.key === 'Backspace' && st.ui.tool === 'draw' && d && !d.closed && d.polygon.length) {
            ev.preventDefault();
            store.edit({ type: 'remove', i: d.polygon.length - 1 });
            return;
        }
        const sel = st.selection;
        if ((ev.key === 'Delete' || ev.key === 'Backspace') && sel && sel.kind === 'vertex') {
            ev.preventDefault();
            const n = work(st).poly.length;
            if (store.edit({ type: 'remove', i: sel.i })) {
                store.select(n - 1 > 0 ? { kind: 'vertex', i: Math.min(sel.i, n - 2) } : null);
                ctx.onStatus(`꼭짓점 P${sel.i + 1} 삭제`);
            }
            return;
        }
        if (sel && sel.kind === 'vertex' && /^Arrow/.test(ev.key) && (ev.target === canvas || ev.target === document.body)) {
            ev.preventDefault();
            const step = ev.shiftKey ? 1 : 0.1;
            const p = work(st).poly[sel.i];
            if (!p) return;
            const dx = ev.key === 'ArrowRight' ? step : ev.key === 'ArrowLeft' ? -step : 0;
            const dyy = ev.key === 'ArrowUp' ? step : ev.key === 'ArrowDown' ? -step : 0;
            store.edit({ type: 'move', i: sel.i, p: [r2(p[0] + dx), r2(p[1] + dyy)] });
        }
    }
    function onKeyUp(ev) {
        if (ev.key === 'Shift') { shiftDown = false; refreshSnapAtCursor(); syncToolbar(); }
        if (ev.key === ' ') { spaceDown = false; setCursorStyle(); }
    }
    function onBlur() { shiftDown = false; spaceDown = false; syncToolbar(); }

    function refreshSnapAtCursor() {
        if (!cursor) return;
        const st = store.getState();
        if (st.ui.tool === 'draw') {
            const d = st.site.draft;
            const last = d && !d.closed && d.polygon.length ? d.polygon[d.polygon.length - 1] : null;
            cursor.snap = snapAt(cursor.w, { orthoFrom: last });
            cursor.showSnap = true;
            updateCursorReadout();
            request();
        }
    }

    // toolbar wiring (always on; buttons are inside the view)
    ui.sel.addEventListener('click', () => store.setTool('select'));
    ui.draw.addEventListener('click', () => { store.setTool('draw'); canvas.focus({ preventScroll: true }); });
    ui.undo.addEventListener('click', () => store.undo());
    ui.redo.addEventListener('click', () => store.redo());
    ui.fit.addEventListener('click', () => fit());
    ui.snapGrid.addEventListener('click', () => { snapOpt.grid = !snapOpt.grid; syncToolbar(); refreshSnapAtCursor(); });
    ui.snapVertex.addEventListener('click', () => { snapOpt.vertex = !snapOpt.vertex; syncToolbar(); refreshSnapAtCursor(); });

    function on(target, type, fn, opts) { target.addEventListener(type, fn, opts); cleanups.push(() => target.removeEventListener(type, fn, opts)); }

    let unsub = null, unTheme = null, ro = null;

    function onStore(st, prev) {
        if (!prev || st.ui.tool !== prev.ui.tool) { cursor && (cursor.snap = null); }
        if (prev && st.site.current !== prev.site.current && !st.site.draft) fit();
        syncToolbar();
        updateFoot(st, ui.gridInfo);
        setCursorStyle();
        request();
    }

    async function activate() {
        if (disposed) throw new Error('disposed');
        if (active) return;
        active = true;
        readColors();
        on(canvas, 'pointerdown', onPointerDown);
        on(canvas, 'pointermove', onPointerMove);
        on(canvas, 'pointerup', onPointerUp);
        on(canvas, 'pointercancel', onPointerCancel);
        on(canvas, 'pointerleave', onLeave);
        on(canvas, 'dblclick', onDblClick);
        on(canvas, 'wheel', onWheel, { passive: false });
        on(canvas, 'contextmenu', (e) => e.preventDefault());
        on(window, 'keydown', onKeyDown);
        on(window, 'keyup', onKeyUp);
        on(window, 'blur', onBlur);
        unsub = store.subscribe(onStore);
        unTheme = ctx.onThemeChange ? ctx.onThemeChange(() => { readColors(); request(); }) : null;
        if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(() => resize()); ro.observe(container); }
        else on(window, 'resize', resize);
        resize();
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (active) { readColors(); request(); } });
        if (!fitted) { fit(); fitted = true; }
        else if (!draftVisible()) fit();          // e.g. a parcel draft made on the MAP tab
        syncToolbar();
        updateCursorReadout();
        request();
    }

    function draftVisible() {
        const d = store.getState().site.draft;
        if (!d || !d.polygon.length) return true;
        const b = bbox(d.polygon);
        if (!Number.isFinite(b.e0)) return true;
        const vr = visibleRect();
        return b.e0 >= vr.e0 && b.e1 <= vr.e1 && b.n0 >= vr.n0 && b.n1 <= vr.n1;
    }

    function deactivate() {
        if (!active) return;
        if (drag && drag.type === 'vertex' && drag.moved) store.endPreview(true);
        active = false;
        drag = null; pointers.clear(); cursor = null; hover = null; spaceDown = false; shiftDown = false;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        while (cleanups.length) cleanups.pop()();
        if (unsub) { unsub(); unsub = null; }
        if (unTheme) { unTheme(); unTheme = null; }
        if (ro) { ro.disconnect(); ro = null; }
    }

    function dispose() { deactivate(); disposed = true; container.innerHTML = ''; }

    function worldToClient(p) {
        const r = canvas.getBoundingClientRect();
        const s = toS(p);
        return { x: r.left + s[0], y: r.top + s[1] };
    }

    return {
        activate, deactivate, dispose, fit, worldToClient,
        getView: () => ({ e: view.e, n: view.n, s: view.s, width: W, height: H }),
        setSnap: (o) => { Object.assign(snapOpt, o || {}); syncToolbar(); },
        redraw: () => { readColors(); request(); },
    };
}

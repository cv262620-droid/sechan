// OHSOLV Studio canvas test — shared core (no DOM, no framework).
// Geometry validation, triangulation, snapping, local-plane <-> lon/lat, GeoJSON of the synthetic city,
// a site-aware SITE_CORE-shaped object for the 3D adapters, and the command/undo/revision store.
//
// Coordinates: [e, n] in metres on a local plane (e = east, n = north). Polygons list each vertex once
// (no repeated closing point). Lon/lat is for display and MAP placement only; lengths and areas are
// always computed from local metres (M01 §7).
const STUDIO_CORE = (function () {
    'use strict';
    const D = SITE_DATA;

    // ---------------------------------------------------------------- geometry
    const finite = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
    const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

    function signedArea(poly) {
        let a = 0;
        for (let i = 0, n = poly.length; i < n; i++) {
            const p = poly[i], q = poly[(i + 1) % n];
            a += p[0] * q[1] - q[0] * p[1];
        }
        return a / 2;
    }
    const area = (poly) => Math.abs(signedArea(poly));

    function edgeLengths(poly, closed) {
        const n = poly.length, out = [];
        const m = closed === false ? n - 1 : n;
        for (let i = 0; i < m; i++) out.push(dist(poly[i], poly[(i + 1) % n]));
        return out;
    }
    const perimeter = (poly, closed) => (poly.length < 2 ? 0 : edgeLengths(poly, closed).reduce((s, l) => s + l, 0));

    function centroid(poly) {
        const n = poly.length;
        if (!n) return [0, 0];
        const A = signedArea(poly);
        if (Math.abs(A) < 1e-9) {
            let e = 0, nn = 0;
            for (const p of poly) { e += p[0]; nn += p[1]; }
            return [e / n, nn / n];
        }
        let cx = 0, cy = 0;
        for (let i = 0; i < n; i++) {
            const p = poly[i], q = poly[(i + 1) % n], f = p[0] * q[1] - q[0] * p[1];
            cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f;
        }
        return [cx / (6 * A), cy / (6 * A)];
    }

    // Counter-clockwise copy. Keeps vertex 0 in place so P1 stays P1 after normalisation.
    function toCCW(poly) {
        const c = poly.map((p) => [p[0], p[1]]);
        if (signedArea(c) >= 0) return c;
        return [c[0]].concat(c.slice(1).reverse());
    }

    // Same ring regardless of start vertex and orientation (tolerance 1 mm).
    function samePolygon(a, b, tol) {
        const t = tol ?? 0.001;
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return false;
        const n = a.length;
        const eq = (p, q) => finite(p) && finite(q) && Math.abs(p[0] - q[0]) <= t && Math.abs(p[1] - q[1]) <= t;
        for (let s = 0; s < n; s++) {
            if (!eq(a[0], b[s])) continue;
            let fw = true, bw = true;
            for (let k = 1; k < n && (fw || bw); k++) {
                if (fw && !eq(a[k], b[(s + k) % n])) fw = false;
                if (bw && !eq(a[k], b[(s - k + n) % n])) bw = false;
            }
            if (fw || bw) return true;
        }
        return false;
    }

    function isConvex(poly) {
        const n = poly.length;
        if (n < 3) return false;
        let sign = 0;
        for (let i = 0; i < n; i++) {
            const c = cross(poly[i], poly[(i + 1) % n], poly[(i + 2) % n]);
            if (Math.abs(c) < 1e-9) continue;
            const s = Math.sign(c);
            if (sign && s !== sign) return false;
            sign = s;
        }
        return true;
    }

    function pointInPolygon(p, poly) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const a = poly[i], b = poly[j];
            if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
        }
        return inside;
    }

    // Segment a-b vs c-d. Returns intersection point (first touching point for collinear overlaps) or null.
    function segSeg(a, b, c, d) {
        const EPS = 1e-9;
        const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
        const den = r[0] * s[1] - r[1] * s[0];
        const qp = [c[0] - a[0], c[1] - a[1]];
        if (Math.abs(den) < EPS) {
            if (Math.abs(qp[0] * r[1] - qp[1] * r[0]) > 1e-7) return null; // parallel, not collinear
            const rr = r[0] * r[0] + r[1] * r[1];
            if (rr < EPS) return null;
            const t0 = (qp[0] * r[0] + qp[1] * r[1]) / rr;
            const t1 = t0 + (s[0] * r[0] + s[1] * r[1]) / rr;
            const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(1, Math.max(t0, t1));
            if (lo > hi + 1e-9) return null;
            const t = (lo + hi) / 2;
            return [a[0] + r[0] * t, a[1] + r[1] * t];
        }
        const t = (qp[0] * s[1] - qp[1] * s[0]) / den, u = (qp[0] * r[1] - qp[1] * r[0]) / den;
        if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
        return [a[0] + r[0] * t, a[1] + r[1] * t];
    }

    // Non-adjacent edge crossings plus adjacent edges that fold back on each other.
    // Edge i runs from vertex i to vertex i+1. Returns [{ a, b, p }].
    function segmentIntersections(poly, closed) {
        const n = poly.length, out = [];
        if (n < 3) return out;
        const m = closed === false ? n - 1 : n;
        const E = (i) => [poly[i], poly[(i + 1) % n]];
        const adjacent = (i, j) => j === i + 1 || (closed !== false && i === 0 && j === m - 1);
        for (let i = 0; i < m; i++) {
            for (let j = i + 1; j < m; j++) {
                const [a, b] = E(i), [c, d] = E(j);
                if (adjacent(i, j)) {
                    // shared vertex: v = b when j = i+1, v = a when (0, m-1)
                    const v = j === i + 1 ? b : a;
                    const p = j === i + 1 ? a : b, q = j === i + 1 ? d : c;
                    const u = [p[0] - v[0], p[1] - v[1]], w = [q[0] - v[0], q[1] - v[1]];
                    const lu = Math.hypot(u[0], u[1]), lw = Math.hypot(w[0], w[1]);
                    if (lu < 1e-9 || lw < 1e-9) continue;
                    const crs = (u[0] * w[1] - u[1] * w[0]) / (lu * lw), dot = (u[0] * w[0] + u[1] * w[1]) / (lu * lw);
                    if (Math.abs(crs) < 1e-6 && dot > 0) out.push({ a: i, b: j, p: [v[0], v[1]] });
                    continue;
                }
                const p = segSeg(a, b, c, d);
                if (p) out.push({ a: i, b: j, p });
            }
        }
        return out;
    }

    const LIMITS = { duplicate: 0.01, tinyEdge: 0.1, zeroArea: 1 };
    const vLabel = (i) => `P${i + 1}`;
    const eLabel = (i, n) => `P${i + 1}–P${((i + 1) % n) + 1}`;

    function validate(poly, opts) {
        const closed = !opts || opts.closed !== false;
        const issues = [];
        const pts = Array.isArray(poly) ? poly : [];
        const n = pts.length;
        const bad = [];
        pts.forEach((p, i) => { if (!finite(p)) bad.push(i); });
        if (bad.length) {
            issues.push({ code: 'NAN', message: `숫자가 아닌 좌표: ${bad.map(vLabel).join(', ')}`, vertices: bad });
            return { ok: false, issues, area: 0, perimeter: 0, convex: false };
        }
        if (n < 3) issues.push({ code: 'TOO_FEW', message: `꼭짓점 3개 미만 (현재 ${n}개)` });
        if (!closed) issues.push({ code: 'NOT_CLOSED', message: '폐합되지 않은 경계 · 첫 점을 누르거나 Enter로 폐합' });
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                if (dist(pts[i], pts[j]) < LIMITS.duplicate) {
                    issues.push({ code: 'DUPLICATE_VERTEX', message: `중복 꼭짓점: ${vLabel(i)}, ${vLabel(j)} (간격 0.01 m 미만)`, vertices: [i, j] });
                }
            }
        }
        if (n >= 2) {
            const lens = edgeLengths(pts, closed);
            lens.forEach((l, i) => {
                if (l >= LIMITS.duplicate && l < LIMITS.tinyEdge) {
                    issues.push({ code: 'TINY_EDGE', message: `극소 변: ${eLabel(i, n)} = ${l.toFixed(3)} m (기준 0.1 m)`, edges: [i] });
                }
            });
        }
        const a = n >= 3 ? area(pts) : 0;
        const crossings = [];
        if (n >= 3) {
            // Edges meeting only at a duplicated vertex are already reported as DUPLICATE_VERTEX; do not repeat them as crossings.
            const dupAt = new Set();
            for (const is of issues) if (is.code === 'DUPLICATE_VERTEX') is.vertices.forEach((i) => dupAt.add(i));
            const touchesDup = (e, p) => [e, (e + 1) % n].some((i) => dupAt.has(i) && dist(pts[i], p) < LIMITS.duplicate);
            for (const x of segmentIntersections(pts, closed)) {
                if (dupAt.size && touchesDup(x.a, x.p) && touchesDup(x.b, x.p)) continue;
                crossings.push({
                    code: 'SELF_INTERSECT',
                    message: `자기교차: 변 ${eLabel(x.a, n)} × 변 ${eLabel(x.b, n)}`,
                    edges: [x.a, x.b], points: [x.p],
                });
            }
        }
        // The shoelace area of a self-intersecting ring is meaningless, so ZERO_AREA is only judged on simple rings.
        if (n >= 3 && !crossings.length && a < LIMITS.zeroArea) issues.push({ code: 'ZERO_AREA', message: `면적 1 ㎡ 미만 (${a.toFixed(2)} ㎡)` });
        issues.push(...crossings);
        return { ok: issues.length === 0, issues, area: a, perimeter: perimeter(pts, closed), convex: n >= 3 && isConvex(pts) };
    }

    // Ear clipping. Returns a flat list of vertex indices (into poly), triangles CCW in the e-n plane.
    function triangulate(poly) {
        const n = poly.length;
        if (n < 3) return [];
        let idx = [...Array(n).keys()];
        if (signedArea(poly) < 0) idx.reverse();
        const out = [];
        const inside = (p, a, b, c) => cross(a, b, p) >= -1e-12 && cross(b, c, p) >= -1e-12 && cross(c, a, p) >= -1e-12;
        let guard = 0;
        while (idx.length > 3 && guard++ < 10000) {
            let clipped = false;
            for (let k = 0; k < idx.length; k++) {
                const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
                const a = poly[i0], b = poly[i1], c = poly[i2];
                if (cross(a, b, c) <= 1e-12) continue; // reflex or degenerate
                let blocked = false;
                for (const j of idx) {
                    if (j === i0 || j === i1 || j === i2) continue;
                    const p = poly[j];
                    if ((p[0] === a[0] && p[1] === a[1]) || (p[0] === b[0] && p[1] === b[1]) || (p[0] === c[0] && p[1] === c[1])) continue;
                    if (inside(p, a, b, c)) { blocked = true; break; }
                }
                if (blocked) continue;
                out.push(i0, i1, i2);
                idx.splice(k, 1);
                clipped = true;
                break;
            }
            if (!clipped) { // degenerate input: drop a collinear vertex or fall back to a fan
                const k = idx.findIndex((_, k2) => Math.abs(cross(poly[idx[(k2 + idx.length - 1) % idx.length]], poly[idx[k2]], poly[idx[(k2 + 1) % idx.length]])) <= 1e-12);
                if (k >= 0) { idx.splice(k, 1); continue; }
                for (let k2 = 1; k2 < idx.length - 1; k2++) out.push(idx[0], idx[k2], idx[k2 + 1]);
                idx = [];
            }
        }
        if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
        return out;
    }

    // ---------------------------------------------------------------- snapping
    function snap(p, opts) {
        const o = opts || {};
        const tol = o.toleranceM ?? 0.5;
        if (o.vertices && o.vertices.length) {
            let best = null, bd = Infinity;
            for (let k = 0; k < o.vertices.length; k++) {
                const v = o.vertices[k];
                const d = dist(p, v);
                if (d < bd) { bd = d; best = k; }
            }
            if (best !== null && bd <= tol) {
                const v = o.vertices[best];
                return { p: [v[0], v[1]], kind: 'vertex', target: [v[0], v[1]], index: best };
            }
        }
        const g = o.gridStep || 0;
        const r = (v) => (g > 0 ? Math.round(v / g) * g : v);
        if (o.orthoFrom && finite(o.orthoFrom)) {
            const f = o.orthoFrom;
            const horizontal = Math.abs(p[0] - f[0]) >= Math.abs(p[1] - f[1]);
            const q = horizontal ? [r(p[0]), f[1]] : [f[0], r(p[1])];
            return { p: q, kind: 'ortho', target: [f[0], f[1]], axis: horizontal ? 'e' : 'n' };
        }
        if (g > 0) return { p: [r(p[0]), r(p[1])], kind: 'grid' };
        return { p: [p[0], p[1]], kind: null };
    }

    const rect = (e0, e1, n0, n1) => [[e0, n0], [e1, n0], [e1, n1], [e0, n1]];
    let snapCache = null;
    function snapVertices() {
        if (snapCache) return snapCache;
        const seen = new Set(), out = [];
        const add = (e, n) => {
            const k = `${Math.round(e * 100)},${Math.round(n * 100)}`;
            if (seen.has(k)) return;
            seen.add(k); out.push([e, n]);
        };
        for (const p of D.parcels) for (const v of rect(p.e0, p.e1, p.n0, p.n1)) add(v[0], v[1]);
        for (const b of D.blocks) for (const v of rect(b.e0, b.e1, b.n0, b.n1)) add(v[0], v[1]);
        for (const v of D.site.polygon) add(v[0], v[1]);
        snapCache = out;
        return out;
    }

    // ---------------------------------------------------------------- geo (display / MAP only)
    // Local tangent plane at the synthetic origin using WGS84 meridian (M) and prime-vertical (N) radii.
    const WGS84 = { a: 6378137, f: 1 / 298.257223563 };
    const ORIGIN = { lat: D.site.location.lat, lon: D.site.location.lon };
    const e2 = WGS84.f * (2 - WGS84.f);
    const phi0 = (ORIGIN.lat * Math.PI) / 180;
    const sin0 = Math.sin(phi0);
    const RM = (WGS84.a * (1 - e2)) / Math.pow(1 - e2 * sin0 * sin0, 1.5);
    const RN = WGS84.a / Math.sqrt(1 - e2 * sin0 * sin0);
    const GEO = {
        origin: ORIGIN,
        method: '국지 평면 근사 (기준점의 WGS84 자오선·묘유선 곡률반경)',
        radii: { meridian: RM, primeVertical: RN },
        // Measured by tools/test-studio-core.mjs against a Vincenty geodesic inside ±1 km.
        maxErrorM: 0.05,
    };
    const toLonLat = (p) => [ORIGIN.lon + ((p[0] / (RN * Math.cos(phi0))) * 180) / Math.PI, ORIGIN.lat + ((p[1] / RM) * 180) / Math.PI];
    const fromLonLat = (ll) => [(((ll[0] - ORIGIN.lon) * Math.PI) / 180) * RN * Math.cos(phi0), (((ll[1] - ORIGIN.lat) * Math.PI) / 180) * RM];

    const parcelId = (i) => `P${String(i).padStart(3, '0')}`;
    const buildingId = (i) => `BLD${String(i).padStart(3, '0')}`;
    const parcelIndex = (id) => (typeof id === 'string' && /^P\d{3}$/.test(id) ? Number(id.slice(1)) : -1);
    const buildingIndex = (id) => (typeof id === 'string' && /^BLD\d{3}$/.test(id) ? Number(id.slice(3)) : -1);

    function parcelPolygon(id) {
        const p = D.parcels[parcelIndex(id)];
        return p ? rect(p.e0, p.e1, p.n0, p.n1) : null;
    }
    function parcel(id) {
        const i = parcelIndex(id), p = D.parcels[i];
        if (!p) return null;
        const poly = rect(p.e0, p.e1, p.n0, p.n1);
        const bi = D.buildings.findIndex((b) => b.parcel === i);
        return { id, block: p.block, polygon: poly, area: area(poly), building: bi >= 0 ? buildingId(bi) : null, dataMode: 'SYNTHETIC' };
    }
    function parcelAt(pt) {
        for (let i = 0; i < D.parcels.length; i++) {
            const p = D.parcels[i];
            if (pt[0] >= p.e0 && pt[0] <= p.e1 && pt[1] >= p.n0 && pt[1] <= p.n1) return parcelId(i);
        }
        return null;
    }
    // Id of the synthetic parcel whose boundary this polygon is exactly (any start vertex / orientation), else null.
    function parcelOf(poly) {
        if (!Array.isArray(poly) || poly.length !== 4 || !poly.every(finite)) return null;
        const id = parcelAt(centroid(poly));
        return id && samePolygon(poly, parcelPolygon(id)) ? id : null;
    }

    function building(id) {
        const i = buildingIndex(id), b = D.buildings[i];
        if (!b) return null;
        const height = Math.max(...b.parts.map((q) => q.y1));
        const base = b.parts[0];
        return {
            id, parcel: parcelId(b.parcel), floors: b.floors, height, heightStatus: 'ASSUMED', dataMode: 'SYNTHETIC',
            footprint: rect(base.e0, base.e1, base.n0, base.n1), footprintArea: (base.e1 - base.e0) * (base.n1 - base.n0),
            parts: b.parts.map((q) => ({ polygon: rect(q.e0, q.e1, q.n0, q.n1), base: q.y0, height: q.y1 })),
        };
    }
    function buildingAt(pt) {
        for (let i = 0; i < D.buildings.length; i++) {
            for (const q of D.buildings[i].parts) {
                if (pt[0] >= q.e0 && pt[0] <= q.e1 && pt[1] >= q.n0 && pt[1] <= q.n1) return buildingId(i);
            }
        }
        return null;
    }

    const R7 = (v) => Math.round(v * 1e7) / 1e7;
    const ring = (poly) => { const r = toCCW(poly).map((p) => toLonLat(p).map(R7)); r.push(r[0].slice()); return [r]; };
    const feature = (poly, properties) => ({ type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: ring(poly) } });
    const fc = (features) => ({ type: 'FeatureCollection', features });

    let geoCache = null;
    function geojson() {
        if (geoCache) return geoCache;
        const C = D.city;
        geoCache = {
            roads: fc(D.roads.map((r, i) => feature(rect(Math.max(r.e0, C.eMin), Math.min(r.e1, C.eMax), Math.max(r.n0, C.nMin), Math.min(r.n1, C.nMax)),
                { id: `R${String(i).padStart(2, '0')}`, kind: r.kind, width: r.width }))),
            blocks: fc(D.blocks.map((b) => feature(rect(b.e0 - b.pad.w, b.e1 + b.pad.e, b.n0 - b.pad.s, b.n1 + b.pad.n),
                { id: b.id, kind: b.kind || 'urban' }))),
            parks: fc(D.blocks.filter((b) => b.kind === 'park').map((b) => feature(rect(b.e0, b.e1, b.n0, b.n1), { id: b.id }))),
            parcels: fc(D.parcels.map((p, i) => {
                const poly = rect(p.e0, p.e1, p.n0, p.n1);
                return feature(poly, { id: parcelId(i), area: Math.round(area(poly) * 10) / 10, block: p.block, dataMode: 'SYNTHETIC' });
            })),
            buildings: fc([].concat(...D.buildings.map((b, i) => {
                const total = Math.max(...b.parts.map((q) => q.y1));
                return b.parts.map((q, k) => feature(rect(q.e0, q.e1, q.n0, q.n1), {
                    id: buildingId(i), part: k, parcel: parcelId(b.parcel), base: q.y0, height: q.y1, totalHeight: total,
                    floors: b.floors, heightStatus: 'ASSUMED',
                }));
            }))),
        };
        return geoCache;
    }

    // ---------------------------------------------------------------- 3D (site-aware SITE_CORE)
    function emptyGeom() { return { positions: [], normals: [], indices: [], colors: null }; }

    function polysOverlap(a, b) {
        for (let i = 0; i < a.length; i++) {
            for (let j = 0; j < b.length; j++) {
                if (segSeg(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
            }
        }
        return pointInPolygon(a[0], b) || pointInPolygon(b[0], a);
    }

    function emptyMass(sitePoly) {
        const siteArea = sitePoly && sitePoly.length >= 3 ? area(sitePoly) : 0;
        return {
            params: {}, floors: [], roofSlab: emptyGeom(), rooftop: emptyGeom(),
            metrics: { siteArea, buildingArea: 0, gfa: 0, bcr: 0, far: 0, height: 0, floorsAbove: 0 },
        };
    }

    // Returns an object shaped like SITE_CORE whose engine origin is the centre of sitePoly.
    function makeEngineCore(sitePoly) {
        const S = SITE_CORE;
        const poly = toCCW(sitePoly);
        const [ce, cn] = centroid(poly);
        const local = poly.map(([e, n]) => [e - ce, n - cn]);
        const shiftRect = (o) => Object.assign({}, o, { e0: o.e0 - ce, e1: o.e1 - ce, n0: o.n0 - cn, n1: o.n1 - cn });
        const keepBuilding = (b) => !b.parts.some((q) => polysOverlap(rect(q.e0, q.e1, q.n0, q.n1), poly));
        const keepTree = (t) => !pointInPolygon([t[0], t[1]], poly);
        const data = Object.assign({}, D, {
            city: { eMin: D.city.eMin - ce, eMax: D.city.eMax - ce, nMin: D.city.nMin - cn, nMax: D.city.nMax - cn },
            site: Object.assign({}, D.site, { polygon: local }),
            roads: D.roads.map(shiftRect), blocks: D.blocks.map(shiftRect), parcels: D.parcels.map(shiftRect),
            buildings: D.buildings.filter(keepBuilding).map((b) => Object.assign({}, b, { parts: b.parts.map(shiftRect) })),
            trees: D.trees.filter(keepTree).map(([e, n, s]) => [e - ce, n - cn, s]),
            markings: D.markings.map(shiftRect),
        });
        const excluded = { buildings: D.buildings.length - data.buildings.length, trees: D.trees.length - data.trees.length };

        // engine space: x = e, y = up, z = -n  ->  shifting by (ce, cn) is x -= ce, z += cn
        const shiftGeom = (g) => {
            if (!g || !g.positions) return g;
            const p = g.positions.slice();
            for (let i = 0; i < p.length; i += 3) { p[i] -= ce; p[i + 2] += cn; }
            return Object.assign({}, g, { positions: p });
        };

        function treeGeoms(trees) {
            const trunks = emptyGeom(), crowns = emptyGeom();
            const tri = (g, a, b, c) => {
                const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
                const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
                const base = g.positions.length / 3;
                g.positions.push(...a, ...b, ...c);
                for (let k = 0; k < 3; k++) g.normals.push(nx / l, ny / l, nz / l);
                g.indices.push(base, base + 1, base + 2);
            };
            for (const [e, n, s] of trees) {
                const tr = 0.18 * s, th = 2.4 * s, ringPts = [];
                for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; ringPts.push([e + Math.cos(a) * tr, n + Math.sin(a) * tr]); }
                S.extrude(ringPts, 0.15, 0.15 + th, trunks, { noBottom: true });
                const cr = 1.8 * s, cy = 0.15 + th + 1.5 * s, hh = 2.0 * s;
                const topP = S.toEngine(e, n, cy + hh), botP = S.toEngine(e, n, cy - hh * 0.8), pts = [];
                for (let k = 0; k < 8; k++) {
                    const a = (k / 8) * Math.PI * 2 + (e * 0.37 + n * 0.11);
                    pts.push(S.toEngine(e + Math.cos(a) * cr, n + Math.sin(a) * cr, cy));
                }
                for (let k = 0; k < 8; k++) { const p = pts[k], q = pts[(k + 1) % 8]; tri(crowns, p, q, topP); tri(crowns, q, p, botP); }
            }
            return { trunks, crowns };
        }

        function buildContext() {
            const base = S.buildContext(); // world coordinates of the synthetic city
            const PLAT = base.platformHeight;
            const buildings = emptyGeom();
            for (const b of D.buildings) if (keepBuilding(b)) for (const q of b.parts) S.box(q.e0, q.e1, q.n0, q.n1, q.y0 + PLAT, q.y1 + PLAT, buildings, { noBottom: true });
            const { trunks, crowns } = treeGeoms(D.trees.filter(keepTree));
            const siteFill = emptyGeom();
            const tris = triangulate(poly);
            for (let k = 0; k < tris.length; k += 3) {
                const a = poly[tris[k]], b = poly[tris[k + 1]], c = poly[tris[k + 2]];
                const base3 = siteFill.positions.length / 3;
                siteFill.positions.push(...S.toEngine(a[0], a[1], PLAT + 0.02), ...S.toEngine(b[0], b[1], PLAT + 0.02), ...S.toEngine(c[0], c[1], PLAT + 0.02));
                siteFill.normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
                siteFill.indices.push(base3, base3 + 1, base3 + 2);
            }
            const out = {};
            for (const k of Object.keys(base)) out[k] = base[k];
            Object.assign(out, { buildings, trunks, crowns, siteFill });
            for (const k of ['asphalt', 'platforms', 'parks', 'buildings', 'markingsYellow', 'markingsWhite', 'siteFill', 'trunks', 'crowns', 'terrain']) out[k] = shiftGeom(out[k]);
            out.parcelLines = base.parcelLines.map((l) => [l[0] - ce, l[1], l[2] + cn, l[3] - ce, l[4], l[5] + cn]);
            out.siteOutline = local.concat([local[0]]).map(([e, n]) => S.toEngine(e, n, PLAT + 0.06));
            out.origin = [ce, cn];
            out.excluded = excluded;
            return out;
        }

        const core = Object.assign({}, S, {
            data,
            terrainHeight: (e, n) => S.terrainHeight(e + ce, n + cn),
            buildContext,
            buildMainMass: () => emptyMass(local),
            polygonArea: area,
            origin: [ce, cn],
            excluded,
            sitePolygon: local,
        });
        return core;
    }

    // ---------------------------------------------------------------- store
    const FORMAT = 'ohsolv-studio-test';
    const VERSION = 1;
    const clonePoly = (poly) => (poly || []).map((p) => [p[0], p[1]]);
    const round3 = (v) => Math.round(v * 1000) / 1000;

    function inputHash(poly) {
        const s = JSON.stringify(poly.map((p) => [round3(p[0]), round3(p[1])]));
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
        return 'fnv1a-' + h.toString(16).padStart(8, '0');
    }

    function makeRevision(rev, polygon, source, dataMode, note) {
        const poly = toCCW(polygon).map((p) => [round3(p[0]), round3(p[1])]);
        return {
            rev, polygon: poly, source, dataMode,
            area: area(poly), perimeter: perimeter(poly), inputHash: inputHash(poly),
            note: note || '', createdAt: new Date().toISOString(),
        };
    }

    function initialState() {
        const r1 = makeRevision(1, D.site.polygon, 'SYNTHETIC_SAMPLE', 'SYNTHETIC', '합성 샘플 대지 (42 × 30 m, 남동측 가각 3 m)');
        return {
            project: { id: 'TEST-SYNTHETIC-001', name: '합성 테스트 프로젝트', option: 'A', mode: 'SYNTHETIC' },
            site: { revisions: [r1], current: 1, draft: null },
            selection: null,
            layers: { boundary: true, roads: true, parcels: true, context: true, terrain: true },
            ui: { tab: '2D', engine: 'babylon', tool: 'select' },
            persistence: 'none',
        };
    }

    function makeDraft(polygon, closed, source, baseRev, history, future) {
        const poly = clonePoly(polygon);
        return { polygon: poly, closed: !!closed, source, baseRev, validation: validate(poly, { closed: !!closed }), history: history || [], future: future || [] };
    }

    const TABS = ['MAP', '2D', '3D'], ENGINES = ['babylon', 'playcanvas'], TOOLS = ['select', 'draw'];
    const LAYERS = ['boundary', 'roads', 'parcels', 'context', 'terrain'];
    const SOURCES = ['SYNTHETIC_SAMPLE', 'DIRECT', 'PARCEL', 'RESTORE'];
    const MODES = ['SYNTHETIC', 'USER_PROVIDED'];

    // Parse + validate a serialized store. Returns the saved object or throws with a Korean message.
    function deserialize(json) {
        let o;
        try { o = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { throw new Error('JSON 형식이 아닙니다: ' + e.message); }
        if (!o || typeof o !== 'object') throw new Error('JSON 객체가 아닙니다.');
        if (o.format !== FORMAT) throw new Error(`format이 "${FORMAT}"가 아닙니다.`);
        if (o.version !== VERSION) throw new Error(`지원하지 않는 version입니다 (${o.version}).`);
        const site = o.site;
        if (!site || !Array.isArray(site.revisions) || !site.revisions.length) throw new Error('site.revisions가 비어 있습니다.');
        const revs = [];
        const seen = new Set();
        for (const r of site.revisions) {
            if (!r || !Number.isInteger(r.rev) || r.rev < 1) throw new Error('리비전 번호가 올바르지 않습니다.');
            if (seen.has(r.rev)) throw new Error(`리비전 r${r.rev}가 중복됩니다.`);
            seen.add(r.rev);
            if (!SOURCES.includes(r.source)) throw new Error(`r${r.rev}: source 값이 올바르지 않습니다 (${r.source}).`);
            if (!MODES.includes(r.dataMode)) throw new Error(`r${r.rev}: dataMode 값이 올바르지 않습니다 (${r.dataMode}).`);
            const v = validate(r.polygon, { closed: true });
            if (!v.ok) throw new Error(`r${r.rev} 경계 검증 실패: ${v.issues[0].message}`);
            const poly = clonePoly(r.polygon);
            revs.push({
                rev: r.rev, polygon: poly, source: r.source, dataMode: r.dataMode, area: area(poly), perimeter: perimeter(poly),
                inputHash: inputHash(poly), note: typeof r.note === 'string' ? r.note.slice(0, 200) : '',
                createdAt: typeof r.createdAt === 'string' ? r.createdAt : null,
            });
            if (Number.isInteger(r.restoredFrom)) revs[revs.length - 1].restoredFrom = r.restoredFrom;
        }
        revs.sort((a, b) => a.rev - b.rev);
        if (!seen.has(site.current)) throw new Error(`현재 리비전 r${site.current}이 목록에 없습니다.`);
        // A broken draft never costs the adopted revisions: JSON writes NaN as null, so null comes back as NaN
        // (the draft then shows its NAN issue again); anything else unreadable drops only the draft.
        let draft = null;
        const warnings = [];
        if (site.draft) {
            const d = site.draft;
            const coord = (v) => (v === null ? NaN : typeof v === 'number' ? v : undefined);
            const poly = Array.isArray(d.polygon) ? d.polygon.map((p) => (Array.isArray(p) && p.length >= 2 ? [coord(p[0]), coord(p[1])] : null)) : null;
            if (!poly || poly.some((p) => !p || p[0] === undefined || p[1] === undefined)) {
                warnings.push('초안 좌표를 읽을 수 없어 초안만 버렸습니다. 리비전은 그대로입니다.');
            } else {
                draft = { polygon: poly, closed: !!d.closed, source: ['DIRECT', 'PARCEL'].includes(d.source) ? d.source : 'DIRECT', baseRev: seen.has(d.baseRev) ? d.baseRev : site.current };
            }
        }
        const base = initialState();
        const layers = Object.assign({}, base.layers);
        if (o.layers) for (const k of LAYERS) if (typeof o.layers[k] === 'boolean') layers[k] = o.layers[k];
        const ui = Object.assign({}, base.ui);
        if (o.ui) {
            if (TABS.includes(o.ui.tab)) ui.tab = o.ui.tab;
            if (ENGINES.includes(o.ui.engine)) ui.engine = o.ui.engine;
        }
        const project = Object.assign({}, base.project);
        if (o.project && typeof o.project.option === 'string') project.option = o.project.option.slice(0, 8);
        return { format: FORMAT, version: VERSION, project, site: { revisions: revs, current: site.current, draft }, layers, ui, warnings };
    }

    function createStore(saved) {
        let state = initialState();
        if (saved) {
            const s = saved.format ? saved : deserialize(saved);
            const d = s.site.draft;
            state = Object.assign({}, state, {
                project: Object.assign({}, state.project, s.project),
                site: { revisions: s.site.revisions, current: s.site.current, draft: d ? makeDraft(d.polygon, d.closed, d.source, d.baseRev) : null },
                layers: Object.assign({}, state.layers, s.layers),
                ui: Object.assign({}, state.ui, s.ui, { tool: 'select' }),
            });
        }
        const subs = new Set();
        let previewBase = null;

        const getState = () => state;
        function set(patch) {
            const prev = state;
            state = Object.assign({}, state, patch);
            for (const fn of Array.from(subs)) {
                try { fn(state, prev); } catch (e) { setTimeout(() => { throw e; }); }
            }
        }
        function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

        const currentRev = () => state.site.revisions.find((r) => r.rev === state.site.current);
        const snapshot = (d) => ({ polygon: clonePoly(d.polygon), closed: d.closed, source: d.source });

        function fixSelection(sel, poly) {
            if (!sel) return sel;
            if (sel.kind === 'vertex' && !(sel.i < poly.length)) return null;
            if (sel.kind === 'edge' && !(sel.i < poly.length)) return null;
            return sel;
        }

        function setDraft(draft) {
            const poly = draft ? draft.polygon : currentRev().polygon;
            set({ site: Object.assign({}, state.site, { draft }), selection: fixSelection(state.selection, poly) });
        }

        function startDraft(polygon, source) {
            commitPreviewIfAny();
            const src = source === 'PARCEL' ? 'PARCEL' : 'DIRECT';
            const old = state.site.draft;
            const history = old ? old.history.concat([snapshot(old)]) : [];
            const poly = polygon ? clonePoly(polygon) : [];
            set({
                site: Object.assign({}, state.site, { draft: makeDraft(poly, !!polygon && poly.length >= 3, src, state.site.current, history, []) }),
                selection: null,
            });
            return true;
        }

        // Editing the adopted boundary opens a DIRECT draft from it; the current selection is kept.
        function ensureDraft(forAdd) {
            if (state.site.draft) return;
            const sel = state.selection;
            if (forAdd) startDraft(null, 'DIRECT');
            else startDraft(currentRev().polygon, 'DIRECT');
            if (!forAdd && sel) set({ selection: sel });
        }

        function applyCmd(d, cmd) {
            const poly = clonePoly(d.polygon);
            let closed = d.closed;
            const n = poly.length;
            const okIdx = (i) => Number.isInteger(i) && i >= 0 && i < n;
            const okP = (p) => finite(p);
            switch (cmd.type) {
                case 'add':
                    if (closed || !okP(cmd.p)) return null;
                    poly.push([cmd.p[0], cmd.p[1]]);
                    break;
                case 'close':
                    if (closed || n < 3) return null;
                    closed = true;
                    break;
                case 'move':
                case 'setVertex':
                    if (!okIdx(cmd.i) || !Array.isArray(cmd.p)) return null;
                    poly[cmd.i] = [Number(cmd.p[0]), Number(cmd.p[1])];
                    break;
                case 'insert': {
                    if (!okIdx(cmd.edge) || !okP(cmd.p)) return null;
                    if (!closed && cmd.edge >= n - 1) return null;
                    poly.splice(cmd.edge + 1, 0, [cmd.p[0], cmd.p[1]]);
                    break;
                }
                case 'remove':
                    if (!okIdx(cmd.i)) return null;
                    poly.splice(cmd.i, 1);
                    if (poly.length < 3 && closed) closed = poly.length >= 3;
                    break;
                case 'setEdgeLength': {
                    const L = Number(cmd.length);
                    if (!okIdx(cmd.edge) || !(L > 0) || !Number.isFinite(L)) return null;
                    if (!closed && cmd.edge >= n - 1) return null;
                    const a = poly[cmd.edge], j = (cmd.edge + 1) % n, b = poly[j];
                    const l = dist(a, b);
                    if (l < 1e-9) return null;
                    poly[j] = [a[0] + ((b[0] - a[0]) / l) * L, a[1] + ((b[1] - a[1]) / l) * L];
                    break;
                }
                case 'replace':
                    if (!Array.isArray(cmd.polygon)) return null;
                    return { polygon: clonePoly(cmd.polygon), closed: cmd.closed === undefined ? cmd.polygon.length >= 3 : !!cmd.closed };
                default:
                    throw new Error('알 수 없는 편집 명령: ' + cmd.type);
            }
            return { polygon: poly, closed };
        }

        function edit(cmd) {
            commitPreviewIfAny();
            ensureDraft(cmd && cmd.type === 'add');
            const d = state.site.draft;
            const r = applyCmd(d, cmd);
            if (!r) return false;
            setDraft(makeDraft(r.polygon, r.closed, d.source, d.baseRev, d.history.concat([snapshot(d)]), []));
            return true;
        }

        function preview(polygon) {
            ensureDraft(false);
            const d = state.site.draft;
            if (!previewBase) previewBase = snapshot(d);
            const nd = makeDraft(polygon, d.closed, d.source, d.baseRev, d.history, d.future);
            nd.preview = true;
            setDraft(nd);
        }

        function endPreview(commit) {
            if (!previewBase) return false;
            const base = previewBase;
            previewBase = null;
            const d = state.site.draft;
            const same = JSON.stringify(base.polygon) === JSON.stringify(d.polygon);
            if (commit && !same) {
                setDraft(makeDraft(d.polygon, d.closed, d.source, d.baseRev, d.history.concat([base]), []));
                return true;
            }
            setDraft(makeDraft(base.polygon, base.closed, d.source, d.baseRev, d.history, d.future));
            return false;
        }
        function commitPreviewIfAny() { if (previewBase) endPreview(true); }

        const canUndo = () => !!(state.site.draft && state.site.draft.history.length);
        const canRedo = () => !!(state.site.draft && state.site.draft.future.length);

        function undo() {
            commitPreviewIfAny();
            const d = state.site.draft;
            if (!d || !d.history.length) return false;
            const h = d.history.slice(), prev = h.pop();
            setDraft(makeDraft(prev.polygon, prev.closed, prev.source, d.baseRev, h, [snapshot(d)].concat(d.future)));
            return true;
        }
        function redo() {
            commitPreviewIfAny();
            const d = state.site.draft;
            if (!d || !d.future.length) return false;
            const f = d.future.slice(), next = f.shift();
            setDraft(makeDraft(next.polygon, next.closed, next.source, d.baseRev, d.history.concat([snapshot(d)]), f));
            return true;
        }

        function cancelDraft() {
            previewBase = null;
            if (!state.site.draft) return false;
            const sel = state.selection;
            set({
                site: Object.assign({}, state.site, { draft: null }),
                selection: sel && (sel.kind === 'vertex' || sel.kind === 'edge') ? null : sel,
                ui: Object.assign({}, state.ui, { tool: 'select' }),
            });
            return true;
        }

        function nextRev() { return Math.max(...state.site.revisions.map((r) => r.rev)) + 1; }

        function adoptDraft(note) {
            commitPreviewIfAny();
            const d = state.site.draft;
            if (!d) throw new Error('채택할 초안이 없습니다.');
            const v = validate(d.polygon, { closed: d.closed });
            if (!v.ok) {
                const err = new Error('검증 오류로 채택할 수 없습니다: ' + v.issues.map((i) => i.message).join(' / '));
                err.issues = v.issues;
                throw err;
            }
            const base = currentRev();
            if (samePolygon(d.polygon, base.polygon)) {
                const err = new Error(`채택된 r${base.rev}과 같은 경계입니다. 바뀐 점이 없어 새 리비전을 만들지 않습니다.`);
                err.issues = [];
                throw err;
            }
            // SYNTHETIC only while the draft is still exactly a synthetic parcel; any user change makes it USER_PROVIDED.
            const pid = d.source === 'PARCEL' ? parcelOf(d.polygon) : null;
            const dataMode = pid ? 'SYNTHETIC' : 'USER_PROVIDED';
            const rev = nextRev();
            const r = makeRevision(rev, d.polygon, d.source, dataMode, note || (d.source === 'PARCEL' ? (pid ? `필지 ${pid} 선택으로 작성` : '필지 선택 후 수정') : '직접 경계 작성'));
            set({
                site: { revisions: state.site.revisions.concat([r]), current: rev, draft: null },
                selection: null,
                ui: Object.assign({}, state.ui, { tool: 'select' }),
            });
            return rev;
        }

        function restoreRevision(rev) {
            commitPreviewIfAny();
            const src = state.site.revisions.find((r) => r.rev === rev);
            if (!src) throw new Error(`r${rev} 리비전이 없습니다.`);
            const nr = nextRev();
            const r = makeRevision(nr, src.polygon, 'RESTORE', src.dataMode, `r${rev}에서 복원`);
            r.restoredFrom = rev;
            set({ site: { revisions: state.site.revisions.concat([r]), current: nr, draft: null }, selection: null });
            return nr;
        }

        function select(sel) { set({ selection: sel || null }); }
        function setLayer(name, on) {
            if (!LAYERS.includes(name)) return;
            set({ layers: Object.assign({}, state.layers, { [name]: !!on }) });
        }
        function setTab(t) { if (TABS.includes(t) && state.ui.tab !== t) set({ ui: Object.assign({}, state.ui, { tab: t }) }); }
        function setEngine(e) { if (ENGINES.includes(e) && state.ui.engine !== e) set({ ui: Object.assign({}, state.ui, { engine: e }) }); }
        function setTool(t) { if (TOOLS.includes(t) && state.ui.tool !== t) set({ ui: Object.assign({}, state.ui, { tool: t }) }); }
        function setPersistence(p) { if (state.persistence !== p) set({ persistence: p }); }

        // Replace the whole state with a deserialized object (JSON import). Not undoable.
        function load(saved) {
            const s = saved && saved.format ? saved : deserialize(saved);
            previewBase = null;
            const d = s.site.draft;
            set({
                project: Object.assign({}, state.project, s.project),
                site: { revisions: s.site.revisions, current: s.site.current, draft: d ? makeDraft(d.polygon, d.closed, d.source, d.baseRev) : null },
                selection: null,
                layers: Object.assign({}, state.layers, s.layers),
                ui: Object.assign({}, state.ui, { tool: 'select' }),
            });
        }

        function serialize() {
            const d = state.site.draft;
            return JSON.stringify({
                format: FORMAT, version: VERSION,
                note: '합성(SYNTHETIC) 테스트 데이터 · 브라우저 임시본 · 서버 저장 아님',
                project: state.project,
                site: {
                    revisions: state.site.revisions, current: state.site.current,
                    draft: d ? { polygon: d.polygon, closed: d.closed, source: d.source, baseRev: d.baseRev } : null,
                },
                layers: state.layers,
                ui: { tab: state.ui.tab, engine: state.ui.engine },
            });
        }

        return {
            getState, subscribe, startDraft, edit, preview, endPreview, undo, redo, canUndo, canRedo,
            cancelDraft, adoptDraft, restoreRevision, select, setLayer, setTab, setEngine, setTool, setPersistence,
            serialize, load, currentRevision: currentRev,
        };
    }

    return {
        // geometry
        area, signedArea, perimeter, edgeLengths, centroid, toCCW, isConvex, samePolygon, validate, triangulate,
        pointInPolygon, segmentIntersections, snap, snapVertices, LIMITS,
        // geo
        GEO, toLonLat, fromLonLat, geojson, parcelPolygon, parcelAt, parcelOf, parcel, building, buildingAt,
        // 3D
        makeEngineCore, emptyMass,
        // store
        createStore, deserialize, inputHash, FORMAT, VERSION,
    };
})();

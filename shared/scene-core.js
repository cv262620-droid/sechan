// Engine-agnostic scene core shared by the Babylon.js and PlayCanvas pages.
// Everything here is pure data + math: the two pages only turn these buffers into meshes.
//
// World coords (data): e = east (m), n = north (m), y = up (m). Origin = study site centre.
// Engine coords (returned geometry): right-handed, Y-up, x = e, y = y, z = -n (north = -Z).
// Triangles are counter-clockwise when seen from the side their normal points to (glTF/OpenGL).
const SITE_CORE = (function () {
    'use strict';
    const D = SITE_DATA;

    // ---------- helpers ----------
    const toEngine = (e, n, y) => [e, y || 0, -n];

    function polygonArea(poly) {
        let a = 0;
        for (let i = 0; i < poly.length; i++) {
            const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
            a += x0 * y1 - x1 * y0;
        }
        return Math.abs(a) / 2;
    }

    function emptyGeom() { return { positions: [], normals: [], indices: [], colors: null }; }

    function pushTri(g, a, b, c, nrm, col) {
        const base = g.positions.length / 3;
        g.positions.push(...a, ...b, ...c);
        g.normals.push(...nrm, ...nrm, ...nrm);
        if (col) { g.colors = g.colors || []; g.colors.push(...col, ...col, ...col); }
        g.indices.push(base, base + 1, base + 2);
    }

    function faceNormal(a, b, c) {
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1;
        return [nx / l, ny / l, nz / l];
    }

    function tri(g, a, b, c, col) { pushTri(g, a, b, c, faceNormal(a, b, c), col); }

    // Extrude a convex CCW (e, n) polygon between heights y0 and y1. Flat-shaded.
    function extrude(poly, y0, y1, g, opts) {
        g = g || emptyGeom();
        const o = opts || {};
        const col = o.color || null;
        const bot = poly.map(([e, n]) => toEngine(e, n, y0));
        const top = poly.map(([e, n]) => toEngine(e, n, y1));
        for (let i = 1; i < poly.length - 1; i++) {
            tri(g, top[0], top[i], top[i + 1], col);
            if (!o.noBottom) tri(g, bot[0], bot[i + 1], bot[i], col);
        }
        for (let i = 0; i < poly.length; i++) {
            const j = (i + 1) % poly.length;
            tri(g, bot[i], bot[j], top[j], col);
            tri(g, bot[i], top[j], top[i], col);
        }
        return g;
    }

    const rectPoly = (e0, e1, n0, n1) => [[e0, n0], [e1, n0], [e1, n1], [e0, n1]];

    function box(e0, e1, n0, n1, y0, y1, g, opts) {
        return extrude(rectPoly(e0, e1, n0, n1), y0, y1, g, opts);
    }

    // Flat horizontal quad (faces up)
    function quad(e0, e1, n0, n1, y, g, col) {
        g = g || emptyGeom();
        const a = toEngine(e0, n0, y), b = toEngine(e1, n0, y), c = toEngine(e1, n1, y), d = toEngine(e0, n1, y);
        tri(g, a, b, c, col); tri(g, a, c, d, col);
        return g;
    }

    // Offset a convex CCW polygon outward by d metres (used for slab edges).
    function offsetPolygon(poly, d) {
        const n = poly.length, lines = [];
        for (let i = 0; i < n; i++) {
            const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % n];
            const len = Math.hypot(x1 - x0, y1 - y0);
            const nx = (y1 - y0) / len, ny = -(x1 - x0) / len; // outward for CCW
            lines.push([x0 + nx * d, y0 + ny * d, x1 - x0, y1 - y0]);
        }
        const out = [];
        for (let i = 0; i < n; i++) {
            const A = lines[(i - 1 + n) % n], B = lines[i];
            const den = A[2] * B[3] - A[3] * B[2];
            const t = ((B[0] - A[0]) * B[3] - (B[1] - A[1]) * B[2]) / den;
            out.push([A[0] + A[2] * t, A[1] + A[3] * t]);
        }
        return out;
    }

    // ---------- terrain ----------
    const C = D.city;
    function terrainHeight(e, n) {
        const dx = Math.max(C.eMin - 40 - e, 0, e - (C.eMax + 40));
        const dz = Math.max(C.nMin - 40 - n, 0, n - (C.nMax + 40));
        const d = Math.hypot(dx, dz);
        if (d <= 0) return 0;
        const r = Math.min(1, d / 450), k = r * r * (3 - 2 * r);
        const north = 1 + 0.9 * Math.max(0, Math.min(1, n / 900));
        const base = 30 + 22 * Math.sin(e * 0.0105 + 1.3) * Math.cos(n * 0.0092 - 0.7)
            + 11 * Math.sin(e * 0.023 + n * 0.017 + 2.1) + 5 * Math.sin(e * 0.051 - n * 0.043 + 0.4);
        return Math.max(0, k * base * north);
    }

    // Smooth-shaded height grid with vertex colours (flat ground -> greener, darker hills).
    function terrainGeometry() {
        const half = 1100, step = 25, cx = 20, cn = 6, N = Math.round((2 * half) / step);
        const g = { positions: [], normals: [], indices: [], colors: [] };
        const h = (e, n) => terrainHeight(e, n);
        for (let j = 0; j <= N; j++) {
            for (let i = 0; i <= N; i++) {
                const e = cx - half + i * step, n = cn - half + j * step;
                const y = h(e, n) - 0.05;
                g.positions.push(...toEngine(e, n, y));
                const he = h(e + 1, n) - h(e - 1, n), hn = h(e, n + 1) - h(e, n - 1);
                // normal of y = f(e, n) in engine space (x = e, z = -n)
                const nx = -he / 2, nz = hn / 2, l = Math.hypot(nx, 1, nz);
                g.normals.push(nx / l, 1 / l, nz / l);
                const t = Math.min(1, y / 60);
                g.colors.push(0.62 - 0.22 * t, 0.66 - 0.12 * t, 0.55 - 0.2 * t, 1);
            }
        }
        const W = N + 1;
        for (let j = 0; j < N; j++) {
            for (let i = 0; i < N; i++) {
                const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
                // grid rows go north (-z); keep CCW seen from above
                g.indices.push(a, b, d, a, d, c);
            }
        }
        return g;
    }

    // ---------- trees ----------
    function treeGeometries() {
        const trunks = emptyGeom(), crowns = emptyGeom();
        const sides = 6;
        for (const [e, n, s] of D.trees) {
            const tr = 0.18 * s, th = 2.4 * s;
            const ring = [];
            for (let k = 0; k < sides; k++) {
                const a = (k / sides) * Math.PI * 2;
                ring.push([e + Math.cos(a) * tr, n + Math.sin(a) * tr]);
            }
            extrude(ring, 0.15, 0.15 + th, trunks, { noBottom: true });
            // crown: 8-sided bicone
            const cr = 1.8 * s, cy = 0.15 + th + 1.5 * s, hh = 2.0 * s;
            const topP = toEngine(e, n, cy + hh), botP = toEngine(e, n, cy - hh * 0.8);
            const pts = [];
            for (let k = 0; k < 8; k++) {
                const a = (k / 8) * Math.PI * 2 + (e * 0.37 + n * 0.11);
                pts.push(toEngine(e + Math.cos(a) * cr, n + Math.sin(a) * cr, cy));
            }
            for (let k = 0; k < 8; k++) {
                const p = pts[k], q = pts[(k + 1) % 8];
                tri(crowns, p, q, topP);
                tri(crowns, q, p, botP);
            }
        }
        return { trunks, crowns };
    }

    // ---------- context (everything except the planned building) ----------
    function buildContext() {
        const PLAT = 0.15;
        const asphalt = quad(C.eMin, C.eMax, C.nMin, C.nMax, 0.01);
        const platforms = emptyGeom();
        for (const b of D.blocks) {
            box(b.e0 - b.pad.w, b.e1 + b.pad.e, b.n0 - b.pad.s, b.n1 + b.pad.n, 0, PLAT, platforms, { noBottom: true });
        }
        const parks = emptyGeom();
        for (const b of D.blocks) if (b.kind === 'park') quad(b.e0, b.e1, b.n0, b.n1, PLAT + 0.01, parks);

        const buildings = emptyGeom();
        for (const b of D.buildings) for (const p of b.parts) box(p.e0, p.e1, p.n0, p.n1, p.y0 + PLAT, p.y1 + PLAT, buildings, { noBottom: true });

        const markingsYellow = emptyGeom(), markingsWhite = emptyGeom();
        for (const m of D.markings) {
            const g = m.color === 'yellow' ? markingsYellow : markingsWhite;
            const horizontal = m.n0 === m.n1;
            const a0 = horizontal ? m.e0 : m.n0, a1 = horizontal ? m.e1 : m.n1;
            const seg = m.dashed ? 3 : a1 - a0, gap = m.dashed ? 3 : 0;
            for (let a = a0 + 1; a < a1 - 1; a += seg + gap) {
                const b = Math.min(a + seg, a1 - 1);
                if (horizontal) quad(a, b, m.n0 - 0.08, m.n0 + 0.08, 0.03, g);
                else quad(m.e0 - 0.08, m.e0 + 0.08, a, b, 0.03, g);
            }
        }

        // Parcel boundaries as line segments [x0,y0,z0,x1,y1,z1] in engine space
        const parcelLines = [];
        const Y = PLAT + 0.03;
        for (const p of D.parcels) {
            const r = rectPoly(p.e0, p.e1, p.n0, p.n1);
            for (let i = 0; i < 4; i++) {
                const [a, b] = [r[i], r[(i + 1) % 4]];
                parcelLines.push([...toEngine(a[0], a[1], Y), ...toEngine(b[0], b[1], Y)]);
            }
        }

        const sitePoly = D.site.polygon;
        const siteFill = emptyGeom();
        for (let i = 1; i < sitePoly.length - 1; i++) {
            tri(siteFill, toEngine(sitePoly[0][0], sitePoly[0][1], PLAT + 0.02),
                toEngine(sitePoly[i][0], sitePoly[i][1], PLAT + 0.02), toEngine(sitePoly[i + 1][0], sitePoly[i + 1][1], PLAT + 0.02));
        }
        // Closed outline as a list of points (first point repeated at the end)
        const siteOutline = sitePoly.concat([sitePoly[0]]).map(([e, n]) => toEngine(e, n, PLAT + 0.06));

        const { trunks, crowns } = treeGeometries();
        return { asphalt, platforms, parks, buildings, markingsYellow, markingsWhite, parcelLines, siteFill, siteOutline, trunks, crowns, terrain: terrainGeometry(), platformHeight: PLAT };
    }

    // ---------- planned building (parametric mass) ----------
    const PODIUM_POLY = [[-18.5, -12.5], [13.5, -12.5], [17.5, -8.5], [17.5, 9.5], [-18.5, 9.5]];
    const TOWER_POLY = [[-14, -6], [10, -6], [10, 9.5], [-14, 9.5]];
    const ROOFTOP_POLY = [[-6, 2], [2, 2], [2, 8], [-6, 8]];
    const MASS_DEFAULTS = { podiumFloors: 3, towerFloors: 12, podiumFH: 4.2, towerFH: 3.9 };
    const MASS_LIMITS = {
        podiumFloors: { min: 1, max: 5, step: 1 },
        towerFloors: { min: 0, max: 30, step: 1 },
        podiumFH: { min: 3.6, max: 5.4, step: 0.1 },
        towerFH: { min: 3.3, max: 4.5, step: 0.1 },
    };
    const SLAB = 0.35;

    function buildMainMass(params) {
        const p = Object.assign({}, MASS_DEFAULTS, params || {});
        const base = 0.15; // sits on the block platform
        const floors = [];
        let y = 0, level = 1;
        const add = (poly, fh, kind, use) => {
            const y0 = base + y, y1 = y0 + fh;
            floors.push({
                level, label: level + 'F', kind, use,
                footprint: poly, area: polygonArea(poly),
                y0, y1, floorLevel: y, height: fh,
                slab: extrude(offsetPolygon(poly, 0.12), y0, y0 + SLAB),
                body: extrude(poly, y0 + SLAB, y1, null, { noBottom: true }),
            });
            y += fh; level++;
        };
        for (let i = 0; i < p.podiumFloors; i++) add(PODIUM_POLY, p.podiumFH, 'podium', '근린생활시설');
        for (let i = 0; i < p.towerFloors; i++) add(TOWER_POLY, p.towerFH, 'tower', '업무시설');
        const topPoly = floors.length ? floors[floors.length - 1].footprint : PODIUM_POLY;
        const roofSlab = extrude(offsetPolygon(topPoly, 0.12), base + y, base + y + 0.6);
        const rooftop = extrude(ROOFTOP_POLY, base + y + 0.6, base + y + 4.5, null, { noBottom: true });

        const siteArea = polygonArea(D.site.polygon);
        const buildingArea = Math.max(...floors.map((f) => f.area));
        const gfa = floors.reduce((s, f) => s + f.area, 0);
        return {
            params: p, floors, roofSlab, rooftop,
            metrics: {
                siteArea, buildingArea, gfa,
                bcr: (buildingArea / siteArea) * 100,
                far: (gfa / siteArea) * 100,
                height: y, // ground floor level to roof slab, rooftop structure excluded
                floorsAbove: floors.length,
            },
        };
    }

    // ---------- sun (NOAA general solar position, ~0.5 deg accuracy) ----------
    const SUN_PRESETS = {
        winter: { month: 12, day: 22, label: '동지' },
        equinox: { month: 3, day: 20, label: '춘·추분' },
        summer: { month: 6, day: 21, label: '하지' },
    };

    function dayOfYear(year, month, day) {
        const md = [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        let n = day;
        for (let i = 0; i < month - 1; i++) n += md[i];
        return n;
    }

    // hour = local clock time in decimal hours (KST by default)
    function solarPosition(opts) {
        const loc = D.site.location;
        const year = opts.year || 2026, lat = (opts.lat ?? loc.lat) * Math.PI / 180;
        const lon = opts.lon ?? loc.lon, tz = opts.tz ?? loc.tz;
        const N = dayOfYear(year, opts.month, opts.day);
        const g = (2 * Math.PI / 365) * (N - 1 + (opts.hour - tz - 12) / 24);
        const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
        const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
            + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
        const tst = opts.hour * 60 + eqt + 4 * lon - 60 * tz;
        const ha = (tst / 4 - 180) * Math.PI / 180;
        const cosZ = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
        const zen = Math.acos(Math.max(-1, Math.min(1, cosZ)));
        const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) + Math.PI;
        return { altitude: 90 - zen * 180 / Math.PI, azimuth: ((az * 180 / Math.PI) % 360 + 360) % 360, declination: decl * 180 / Math.PI };
    }

    // Unit vector pointing from the ground TOWARD the sun, engine space.
    function sunVector(altitudeDeg, azimuthDeg) {
        const a = altitudeDeg * Math.PI / 180, z = azimuthDeg * Math.PI / 180;
        const e = Math.sin(z) * Math.cos(a), n = Math.cos(z) * Math.cos(a), u = Math.sin(a);
        return toEngine(e, n, u);
    }

    // Ray (engine space) vs the planned building's floors. Convex prism clipping (Cyrus-Beck).
    // Returns { level, distance, point } of the nearest floor hit, or null.
    function pickFloor(origin, dir, mass) {
        let best = null;
        // engine -> world: e = x, n = -z, y = y
        const oe = origin[0], on = -origin[2], oy = origin[1];
        const de = dir[0], dn = -dir[2], dy = dir[1];
        for (const f of mass.floors) {
            let t0 = 0, t1 = Infinity;
            const planes = [];
            const poly = f.footprint;
            for (let i = 0; i < poly.length; i++) {
                const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
                const nx = y1 - y0, ny = -(x1 - x0); // outward for CCW
                planes.push([nx, 0, ny, -(nx * x0 + ny * y0)]);
            }
            planes.push([0, 1, 0, -f.y1], [0, -1, 0, f.y0]);
            let ok = true;
            for (const [a, b, c, d] of planes) {
                const num = -(a * oe + b * oy + c * on + d), den = a * de + b * dy + c * dn;
                if (Math.abs(den) < 1e-12) { if (num < 0) { ok = false; break; } continue; }
                const t = num / den;
                if (den < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
                if (t0 > t1) { ok = false; break; }
            }
            if (ok && (!best || t0 < best.distance)) {
                best = { level: f.level, distance: t0, point: [origin[0] + dir[0] * t0, origin[1] + dir[1] * t0, origin[2] + dir[2] * t0] };
            }
        }
        return best;
    }

    function fmt(v, digits) {
        return v.toLocaleString('ko-KR', { minimumFractionDigits: digits ?? 2, maximumFractionDigits: digits ?? 2 });
    }

    return {
        data: D, toEngine, polygonArea, extrude, box, quad, offsetPolygon,
        terrainHeight, buildContext, buildMainMass, MASS_DEFAULTS, MASS_LIMITS,
        SUN_PRESETS, solarPosition, sunVector, pickFloor, fmt,
    };
})();

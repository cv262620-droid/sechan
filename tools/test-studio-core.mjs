// Node unit tests for shared/studio-core.js (no browser).
// Usage: node tools/test-studio-core.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = ['shared/scene-data.js', 'shared/scene-core.js', 'shared/studio-core.js'].map((p) => readFileSync(join(root, p), 'utf8')).join('\n');
const C = new Function(`${src}\nreturn STUDIO_CORE;`)();

let failed = 0, passed = 0;
function ok(cond, name, detail) {
    if (cond) { passed++; return; }
    failed++;
    console.log(`FAIL ${name}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`);
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const codes = (poly, opts) => C.validate(poly, opts).issues.map((i) => i.code);

// ---------- geometry ----------
const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
ok(near(C.area(sq), 100) && near(C.perimeter(sq), 40), 'square area/perimeter');
ok(near(C.area(sq.slice().reverse()), 100) && C.signedArea(sq.slice().reverse()) < 0, 'CW square area positive, signed negative');
const L = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
ok(near(C.area(L), 64), 'concave L area');
const tri = C.triangulate(L);
let tsum = 0;
for (let k = 0; k < tri.length; k += 3) tsum += C.area([L[tri[k]], L[tri[k + 1]], L[tri[k + 2]]]);
ok(tri.length === 12 && near(tsum, 64, 1e-9), 'ear clipping of concave L covers its area', { n: tri.length / 3, tsum });
ok(C.validate(L).ok && !C.validate(L).convex && C.validate(sq).convex, 'validate L ok + convex flags');
const site = C.createStore().getState().site.revisions[0];
ok(near(site.area, 1255.5) && site.polygon.length === 5, 'r1 = synthetic sample 1,255.5 m2', site.area);

// ---------- validation codes ----------
ok(codes([[0, 0], [10, 10], [10, 0], [0, 10]]).includes('SELF_INTERSECT'), 'bow-tie -> SELF_INTERSECT');
const bowIssue = C.validate([[0, 0], [10, 10], [10, 0], [0, 10]]).issues.find((i) => i.code === 'SELF_INTERSECT');
ok(bowIssue && near(bowIssue.points[0][0], 5) && near(bowIssue.points[0][1], 5), 'intersection point reported', bowIssue);
ok(codes([[0, 0], [1, 0]], { closed: false }).join() === 'TOO_FEW,NOT_CLOSED', 'open 2-point polyline');
ok(codes([[0, 0], [10, 0], [10, 0.05], [10, 10], [0, 10]]).join() === 'TINY_EDGE', 'tiny edge');
ok(codes([[0, 0], [10, 0], [10, 0.001], [0, 10]]).includes('DUPLICATE_VERTEX'), 'duplicate vertex');
ok(codes([[0, 0], [NaN, 0], [0, 10]]).join() === 'NAN', 'NaN coordinate');
ok(codes([[0, 0], [10, 0], [20, 0.01]]).includes('ZERO_AREA'), 'near-zero area');
ok(codes([[0, 0], [10, 0], [5, 0], [5, 5]]).includes('SELF_INTERSECT'), 'fold-back spike');

// ---------- snapping (vertex > ortho > grid) ----------
const sv = C.snapVertices();
const s1 = C.snap([-20.97, -14.95], { gridStep: 0.5, toleranceM: 0.2, vertices: sv, orthoFrom: [0, 0] });
ok(s1.kind === 'vertex' && near(s1.p[0], -21) && near(s1.p[1], -15), 'vertex snap wins', s1);
const s2 = C.snap([5.3, 0.4], { gridStep: 0.5, toleranceM: 0.2, vertices: [], orthoFrom: [0, 0] });
ok(s2.kind === 'ortho' && near(s2.p[0], 5.5) && near(s2.p[1], 0), 'ortho snap', s2);
const s3 = C.snap([5.26, 0.74], { gridStep: 0.5, toleranceM: 0.2, vertices: [] });
ok(s3.kind === 'grid' && near(s3.p[0], 5.5) && near(s3.p[1], 0.5), 'grid snap', s3);

// ---------- store: undo/redo, preview, adopt, restore ----------
const s = C.createStore();
s.startDraft(null, 'DIRECT');
for (const p of [[0, 0], [20, 0], [20, 15], [10, 20], [0, 15]]) s.edit({ type: 'add', p });
ok(!s.getState().site.draft.closed && s.getState().site.draft.validation.issues.some((i) => i.code === 'NOT_CLOSED'), 'open draft flagged NOT_CLOSED');
s.edit({ type: 'close' });
ok(s.getState().site.draft.validation.ok && near(s.getState().site.draft.validation.area, 350), 'closed draft valid 350 m2');
s.preview([[0, 0], [22, 0], [20, 15], [10, 20], [0, 15]]);
s.preview([[0, 0], [25, 0], [20, 15], [10, 20], [0, 15]]);
const hBefore = s.getState().site.draft.history.length;
s.endPreview(true);
ok(s.getState().site.draft.history.length === hBefore + 1, 'drag preview commits as one undo step');
s.undo();
ok(s.getState().site.draft.polygon[1][0] === 20, 'undo drag');
s.redo();
ok(s.getState().site.draft.polygon[1][0] === 25, 'redo drag');
s.undo();
s.edit({ type: 'setEdgeLength', edge: 0, length: 30 });
ok(near(s.getState().site.draft.polygon[1][0], 30) && s.canRedo() === false, 'setEdgeLength moves the end vertex; redo cleared');
s.edit({ type: 'insert', edge: 0, p: [15, 0] });
ok(s.getState().site.draft.polygon.length === 6, 'insert vertex');
s.edit({ type: 'remove', i: 1 });
ok(s.getState().site.draft.polygon.length === 5, 'remove vertex');
s.edit({ type: 'setVertex', i: 4, p: [0, 14] });
ok(s.getState().site.draft.polygon[4][1] === 14, 'setVertex');
const rev = s.adoptDraft('test');
const st = s.getState();
ok(rev === 2 && st.site.current === 2 && st.site.draft === null && st.site.revisions.length === 2, 'adopt -> r2, r1 kept');
ok(st.site.revisions[1].dataMode === 'USER_PROVIDED' && st.site.revisions[1].source === 'DIRECT', 'adopted dataMode USER_PROVIDED');
s.startDraft([[0, 0], [10, 10], [10, 0], [0, 10]], 'DIRECT');
let threw = false;
try { s.adoptDraft(); } catch (e) { threw = Array.isArray(e.issues); }
ok(threw && s.getState().site.current === 2, 'invalid draft cannot be adopted');
s.cancelDraft();
const r3 = s.restoreRevision(1);
ok(r3 === 3 && s.getState().site.revisions.length === 3 && s.getState().site.revisions[2].source === 'RESTORE', 'restore creates a new revision');
ok(s.getState().site.revisions[2].inputHash === s.getState().site.revisions[0].inputHash, 'restored polygon hash equals r1');
const p = C.createStore();
p.startDraft(C.parcelPolygon('P078'), 'PARCEL');
p.adoptDraft();
ok(p.getState().site.revisions[1].dataMode === 'SYNTHETIC' && near(p.getState().site.revisions[1].area, 713), 'unedited parcel draft stays SYNTHETIC');

// ---------- QA regressions ----------
ok(codes([[0, 0], [20, 15], [20, 0], [0, 15]]).join() === 'SELF_INTERSECT', 'symmetric bow-tie: SELF_INTERSECT only, no misleading ZERO_AREA');
ok(codes([[0, 0], [20, 0], [20, 0], [20, 15], [0, 15]]).join() === 'DUPLICATE_VERTEX', 'exact duplicate vertex is not also reported as a crossing');
ok(codes([[0, 0], [10, 0], [5, 5], [10, 10], [0, 10], [5, 5]]).join() === 'DUPLICATE_VERTEX', 'pinch point (two rings touching) reported once as DUPLICATE_VERTEX');
ok(codes([[0, 0], [10, 0], [10, 10], [0, 10], [0, 10.004], [12, -2]]).includes('SELF_INTERSECT'), 'real crossing next to a duplicate is still reported');
ok(C.samePolygon([[0, 0], [1, 0], [1, 1]], [[1, 1], [0, 0], [1, 0]]) && C.samePolygon([[0, 0], [1, 0], [1, 1]], [[0, 0], [1, 1], [1, 0]]), 'samePolygon ignores start vertex and orientation');
ok(!C.samePolygon([[0, 0], [1, 0], [1, 1]], [[0, 0], [1, 0], [1, 1.01]]), 'samePolygon sees a 1 cm change');
{
    const q = C.createStore();
    q.startDraft([[0, 0], [20, 0], [20, 15], [0, 15]], 'DIRECT');
    q.startDraft(C.parcelPolygon('P078'), 'PARCEL');          // parcel draft over an existing draft
    const r = q.adoptDraft();
    const rv = q.getState().site.revisions.find((x) => x.rev === r);
    ok(rv.dataMode === 'SYNTHETIC' && /P078/.test(rv.note), 'parcel draft started over another draft stays SYNTHETIC', rv);
    q.startDraft(C.parcelPolygon('P075'), 'PARCEL');
    q.edit({ type: 'move', i: 0, p: [C.parcelPolygon('P075')[0][0] - 1, C.parcelPolygon('P075')[0][1]] });
    const r2 = q.adoptDraft();
    ok(q.getState().site.revisions.find((x) => x.rev === r2).dataMode === 'USER_PROVIDED', 'edited parcel draft becomes USER_PROVIDED');
    q.edit({ type: 'move', i: 1, p: q.currentRevision().polygon[1] });  // auto-draft, unchanged geometry
    let same = null;
    try { q.adoptDraft(); } catch (e) { same = e.message; }
    ok(same && /같은 경계/.test(same) && q.getState().site.current === r2, 'unchanged draft is not adopted as a duplicate revision', same);
    q.cancelDraft();
    q.startDraft([[0, 0], [20, 0], [20, 15], [0, 15]], 'DIRECT');
    q.edit({ type: 'setVertex', i: 1, p: ['abc', 0] });
    ok(q.getState().site.draft.validation.issues[0].code === 'NAN', 'garbage coordinate -> NAN issue');
    const js = q.serialize();
    let back2 = null;
    try { back2 = C.createStore(C.deserialize(js)); } catch (e) { back2 = e; }
    ok(back2 && back2.getState && back2.getState().site.revisions.length === 3 && back2.getState().site.draft.validation.issues[0].code === 'NAN',
        'NaN draft survives the temp copy (revisions kept, NAN shown again)');
    const broken = JSON.parse(js); broken.site.draft.polygon[0] = ['x', 1];
    const d3 = C.deserialize(JSON.stringify(broken));
    ok(d3.site.revisions.length === 3 && d3.site.draft === null && d3.warnings.length === 1, 'unreadable draft drops only the draft');
}

// ---------- serialization round trip ----------
s.startDraft(null, 'DIRECT');
s.edit({ type: 'add', p: [1, 1] });
const json = s.serialize();
const back = C.createStore(C.deserialize(json));
ok(back.serialize() === json, 'serialize -> deserialize -> serialize is stable');
ok(back.getState().site.draft && back.getState().site.draft.polygon.length === 1, 'draft survives round trip');
const bad = JSON.parse(json);
bad.site.revisions[0].polygon = [[0, 0], [1, 1], [1, 0], [0, 1]];
let badThrew = false;
try { C.deserialize(JSON.stringify(bad)); } catch (e) { badThrew = /검증 실패/.test(e.message); }
ok(badThrew, 'deserialize rejects an invalid revision polygon');
let fmtThrew = false;
try { C.deserialize('{"format":"x"}'); } catch (e) { fmtThrew = true; }
ok(fmtThrew, 'deserialize rejects a foreign format');

// ---------- geo: round trip and distance error within ±1 km ----------
function vincenty(lat1, lon1, lat2, lon2) {
    const a = 6378137, f = 1 / 298.257223563, b = a * (1 - f), rad = Math.PI / 180;
    const Lg = (lon2 - lon1) * rad, U1 = Math.atan((1 - f) * Math.tan(lat1 * rad)), U2 = Math.atan((1 - f) * Math.tan(lat2 * rad));
    const sU1 = Math.sin(U1), cU1 = Math.cos(U1), sU2 = Math.sin(U2), cU2 = Math.cos(U2);
    let lam = Lg, sS, cS, sig, c2A, c2Sm;
    for (let it = 0; it < 200; it++) {
        const sL = Math.sin(lam), cL = Math.cos(lam);
        sS = Math.sqrt((cU2 * sL) ** 2 + (cU1 * sU2 - sU1 * cU2 * cL) ** 2);
        if (sS === 0) return 0;
        cS = sU1 * sU2 + cU1 * cU2 * cL; sig = Math.atan2(sS, cS);
        const sA = (cU1 * cU2 * sL) / sS; c2A = 1 - sA * sA; c2Sm = c2A ? cS - (2 * sU1 * sU2) / c2A : 0;
        const Cc = (f / 16) * c2A * (4 + f * (4 - 3 * c2A)), prev = lam;
        lam = Lg + (1 - Cc) * f * sA * (sig + Cc * sS * (c2Sm + Cc * cS * (-1 + 2 * c2Sm * c2Sm)));
        if (Math.abs(lam - prev) < 1e-13) break;
    }
    const u2 = (c2A * (a * a - b * b)) / (b * b), A = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2))), B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
    const dS = B * sS * (c2Sm + (B / 4) * (cS * (-1 + 2 * c2Sm * c2Sm) - (B / 6) * c2Sm * (-3 + 4 * sS * sS) * (-3 + 4 * c2Sm * c2Sm)));
    return b * A * (sig - dS);
}
let maxRT = 0, maxD = 0;
for (let e = -1000; e <= 1000; e += 100) {
    for (let n = -1000; n <= 1000; n += 100) {
        const ll = C.toLonLat([e, n]), q = C.fromLonLat(ll);
        maxRT = Math.max(maxRT, Math.hypot(q[0] - e, q[1] - n));
        maxD = Math.max(maxD, Math.abs(vincenty(C.GEO.origin.lat, C.GEO.origin.lon, ll[1], ll[0]) - Math.hypot(e, n)));
    }
}
ok(maxRT < 1e-6, 'lon/lat round trip < 1 µm', maxRT);
ok(maxD <= C.GEO.maxErrorM, `distance error vs Vincenty within GEO.maxErrorM (${C.GEO.maxErrorM} m)`, maxD);

// ---------- GeoJSON + 3D core ----------
const g = C.geojson();
ok(g.parcels.features.length === 198 && g.parcels.features[0].properties.id === 'P000', 'parcel features with ids');
ok(g.buildings.features.every((f) => f.properties.heightStatus === 'ASSUMED'), 'building heights ASSUMED');
const ring = g.parcels.features[0].geometry.coordinates[0];
ok(ring.length === 5 && ring[0][0] === ring[4][0] && ring[0][1] === ring[4][1], 'closed GeoJSON rings');
ok(C.parcelAt([-30, 0]) === 'P078' && C.buildingAt([-30, 0]) === 'BLD075', 'parcelAt / buildingAt');
const ec = C.makeEngineCore(C.parcelPolygon('P078'));
const ctx = ec.buildContext();
ok(near(ctx.origin[0], -32.5) && near(ctx.origin[1], 0.5) && ctx.excluded.buildings === 1, 'engine core recentres and excludes the building on the site', { origin: ctx.origin, excluded: ctx.excluded });
ok(ctx.siteOutline.length === 5 && ctx.siteFill.indices.length === 6, 'site outline + fill for a 4-vertex site');
const em = C.emptyMass(site.polygon);
ok(em.floors.length === 0 && near(em.metrics.siteArea, 1255.5), 'emptyMass carries site area only');

console.log(`${passed} passed, ${failed} failed (GEO max distance error ${maxD.toFixed(4)} m over ±1 km)`);
process.exit(failed ? 1 : 0);

// Generates shared/scene-data.js: the deterministic city context (roads, blocks, parcels,
// context buildings, street trees) shared by the Babylon.js and PlayCanvas pages.
// World coordinates: e = east (m), n = north (m). Origin = centre of the study site.
// Run: node tools/gen-scene-data.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED = 20261005;

function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rng = mulberry32(SEED);
const rand = (a, b) => a + (b - a) * rng();
const r1 = (v) => Math.round(v * 10) / 10;

// Road centre lines with total width (carriageway + both sidewalks), in metres.
// sidewalk = width of each sidewalk inside that total.
const ROADS_EW = [ // run along e, positioned by n
    { n: -231, w: 8, sw: 2 }, { n: -133, w: 10, sw: 2.5 }, { n: -21, w: 12, sw: 3 },
    { n: 51, w: 8, sw: 2 }, { n: 141, w: 10, sw: 2.5 }, { n: 243, w: 8, sw: 2 },
];
const ROADS_NS = [ // run along n, positioned by e
    { e: -271, w: 8, sw: 2 }, { e: -171, w: 10, sw: 2.5 }, { e: -71, w: 10, sw: 2.5 },
    { e: 25, w: 8, sw: 2 }, { e: 119, w: 12, sw: 3 }, { e: 221, w: 8, sw: 2 }, { e: 311, w: 8, sw: 2 },
];
const CITY = {
    eMin: ROADS_NS[0].e - ROADS_NS[0].w / 2, eMax: ROADS_NS.at(-1).e + ROADS_NS.at(-1).w / 2,
    nMin: ROADS_EW[0].n - ROADS_EW[0].w / 2, nMax: ROADS_EW.at(-1).n + ROADS_EW.at(-1).w / 2,
};

// Study site: 42 m x 30 m with a 3 m corner cut at the south-east road corner. CCW.
const SITE_POLY = [[-21, -15], [18, -15], [21, -12], [21, 15], [-21, 15]];

const roads = [
    ...ROADS_EW.map((r) => ({ kind: 'ew', e0: CITY.eMin, e1: CITY.eMax, n0: r.n - r.w / 2, n1: r.n + r.w / 2, sidewalk: r.sw, width: r.w })),
    ...ROADS_NS.map((r) => ({ kind: 'ns', e0: r.e - r.w / 2, e1: r.e + r.w / 2, n0: CITY.nMin, n1: CITY.nMax, sidewalk: r.sw, width: r.w })),
];

// Blocks = rectangles between consecutive roads (lot area, excluding sidewalks).
// pad = sidewalk widths around the block, so the raised paving platform can include them.
const blocks = [];
for (let i = 0; i < ROADS_NS.length - 1; i++) {
    for (let j = 0; j < ROADS_EW.length - 1; j++) {
        const W = ROADS_NS[i], E = ROADS_NS[i + 1], S = ROADS_EW[j], N = ROADS_EW[j + 1];
        blocks.push({
            id: `B${i}${j}`,
            e0: W.e + W.w / 2, e1: E.e - E.w / 2, n0: S.n + S.w / 2, n1: N.n - N.w / 2,
            pad: { w: W.sw, e: E.sw, s: S.sw, n: N.sw },
        });
    }
}
const studyBlock = blocks.find((b) => b.e0 <= -21 && b.e1 >= 21 && b.n0 <= -15 && b.n1 >= 15);
const parkBlock = blocks.find((b) => b.e0 === -166 && b.n0 === 55);
studyBlock.kind = 'study';
parkBlock.kind = 'park';

// Parcels
const parcels = [];
function splitRow(b, n0, n1) {
    let e = b.e0;
    while (b.e1 - e > 0.1) {
        let w = rand(16, 32);
        if (b.e1 - (e + w) < 12) w = b.e1 - e;
        parcels.push({ block: b.id, e0: r1(e), e1: r1(e + w), n0: r1(n0), n1: r1(n1) });
        e += w;
    }
}
for (const b of blocks) {
    if (b.kind === 'park') continue;
    if (b.kind === 'study') {
        // Hand-placed parcels around the study site (block e -66..21, n -15..47).
        for (const p of [
            [-66, -44, -15, 16], [-44, -21, -15, 16], [-66, -40, 16, 47],
            [-40, -21, 16, 47], [-21, 0, 15, 47], [0, 21, 15, 47],
        ]) parcels.push({ block: b.id, e0: p[0], e1: p[1], n0: p[2], n1: p[3] });
        continue;
    }
    const D = b.n1 - b.n0;
    const rows = Math.max(1, Math.round(D / 45));
    for (let k = 0; k < rows; k++) splitRow(b, b.n0 + (D * k) / rows, b.n0 + (D * (k + 1)) / rows);
}

// Context buildings: one per parcel (some parcels stay open as parking / pocket parks).
const buildings = [];
const openParcels = [];
for (const p of parcels) {
    const near = Math.hypot((p.e0 + p.e1) / 2, (p.n0 + p.n1) / 2);
    if (rng() < 0.08) { openParcels.push(p); continue; }
    const sb = () => rand(1.5, 4);
    const fp = { e0: p.e0 + sb(), e1: p.e1 - sb(), n0: p.n0 + sb(), n1: p.n1 - sb() };
    if (fp.e1 - fp.e0 < 8 || fp.n1 - fp.n0 < 8) { openParcels.push(p); continue; }
    // Taller along the 12 m arterials, lower on the outskirts.
    const arterial = Math.min(Math.abs((p.n0 + p.n1) / 2 + 21), Math.abs((p.e0 + p.e1) / 2 - 119)) < 70;
    let floors = 2 + Math.floor(Math.pow(rng(), arterial ? 1.2 : 2.2) * (arterial ? 20 : 13));
    if (near > 330) floors = Math.min(floors, 6);
    const fh = 3.3;
    const area = (fp.e1 - fp.e0) * (fp.n1 - fp.n0);
    const parts = [];
    if (area > 700 && floors >= 9) {
        const podium = 3;
        parts.push({ e0: r1(fp.e0), e1: r1(fp.e1), n0: r1(fp.n0), n1: r1(fp.n1), y0: 0, y1: r1(podium * 4.0) });
        const t = { e0: fp.e0 + 5, e1: fp.e1 - 5, n0: fp.n0 + 5, n1: fp.n1 - 5 };
        parts.push({ e0: r1(t.e0), e1: r1(t.e1), n0: r1(t.n0), n1: r1(t.n1), y0: r1(podium * 4.0), y1: r1(podium * 4.0 + (floors - podium) * fh) });
    } else {
        parts.push({ e0: r1(fp.e0), e1: r1(fp.e1), n0: r1(fp.n0), n1: r1(fp.n1), y0: 0, y1: r1(floors * fh) });
    }
    buildings.push({ parcel: parcels.indexOf(p), floors, parts });
}

// Street trees: along each block's sidewalk, 1.2 m in from the curb, every ~10 m.
const trees = [];
function treeLine(a0, a1, fixed, axis) {
    for (let a = a0 + 6; a <= a1 - 6; a += 10) {
        const s = r1(rand(0.85, 1.2));
        trees.push(axis === 'e' ? [r1(a), r1(fixed), s] : [r1(fixed), r1(a), s]);
    }
}
for (const b of blocks) {
    // Curb lines are the block edge pushed out by the sidewalk width.
    treeLine(b.e0, b.e1, b.n0 - b.pad.s + 1.2, 'e');
    treeLine(b.e0, b.e1, b.n1 + b.pad.n - 1.2, 'e');
    treeLine(b.n0, b.n1, b.e0 - b.pad.w + 1.2, 'n');
    treeLine(b.n0, b.n1, b.e1 + b.pad.e - 1.2, 'n');
}
for (let k = 0; k < 140; k++) { // park block
    trees.push([r1(rand(parkBlock.e0 + 4, parkBlock.e1 - 4)), r1(rand(parkBlock.n0 + 4, parkBlock.n1 - 4)), r1(rand(0.9, 1.6))]);
}
for (const p of openParcels) { // a few trees on open parcels
    const c = Math.max(1, Math.floor(((p.e1 - p.e0) * (p.n1 - p.n0)) / 260));
    for (let k = 0; k < c; k++) trees.push([r1(rand(p.e0 + 3, p.e1 - 3)), r1(rand(p.n0 + 3, p.n1 - 3)), r1(rand(0.8, 1.2))]);
}

// Road markings: centre lines of every road segment between intersections (dashed if < 10 m).
const markings = [];
for (const r of ROADS_EW) for (let i = 0; i < ROADS_NS.length - 1; i++) {
    markings.push({ e0: ROADS_NS[i].e + ROADS_NS[i].w / 2, e1: ROADS_NS[i + 1].e - ROADS_NS[i + 1].w / 2, n0: r.n, n1: r.n, color: r.w >= 10 ? 'yellow' : 'white', dashed: r.w < 10 });
}
for (const r of ROADS_NS) for (let j = 0; j < ROADS_EW.length - 1; j++) {
    markings.push({ e0: r.e, e1: r.e, n0: ROADS_EW[j].n + ROADS_EW[j].w / 2, n1: ROADS_EW[j + 1].n - ROADS_EW[j + 1].w / 2, color: r.w >= 10 ? 'yellow' : 'white', dashed: r.w < 10 });
}

const data = {
    seed: SEED,
    city: CITY,
    site: { polygon: SITE_POLY, label: '계획 대지 (가상)', location: { lat: 37.5665, lon: 126.978, tz: 9 } },
    roads, blocks, parcels, buildings, trees, markings,
};

const json = JSON.stringify(data);
writeFileSync(join(root, 'shared/scene-data.js'),
    `// GENERATED by tools/gen-scene-data.mjs (seed ${SEED}). Do not edit by hand.\n` +
    `// World coords: e = east (m), n = north (m), origin = study site centre.\n` +
    `const SITE_DATA = ${json};\n`);
console.log(`blocks=${blocks.length} parcels=${parcels.length} buildings=${buildings.length} parts=${buildings.reduce((s, b) => s + b.parts.length, 0)} trees=${trees.length} markings=${markings.length} bytes=${json.length}`);

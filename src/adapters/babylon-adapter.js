// Babylon.js renderer adapter for the mass-study page (contract: docs/SPEC.md).
// Classic UMD build -> global BABYLON. Geometry comes ready-made from SITE_CORE in engine space
// (right-handed, Y-up, x = east, z = -north, CCW front faces), so the scene runs with
// useRightHandedSystem = true and every material declares CounterClockWiseSideOrientation.
// Colours: StandardMaterial lights in gamma space, so the spec's sRGB hex values are used as-is.
async function createBabylonAdapter(canvas, core) {
    'use strict';
    const B = window.BABYLON;
    if (!B) throw new Error('BABYLON global not found (babylon.js not loaded)');

    const DEG = Math.PI / 180;
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const hex = (h) => B.Color3.FromHexString(h);
    const COLORS = {
        sky: '#dde4ea', asphalt: '#5b5f63', platform: '#d9d6cf', park: '#9fb38a',
        markYellow: '#e2b83b', markWhite: '#f2f2ee', parcel: '#9a968d', siteFill: '#efe6c8',
        siteLine: '#d2352b', building: '#eceae4', trunk: '#6b5a48', crown: '#6f8f5a',
        podium: '#c98d4b', tower: '#d9a35f', slab: '#5a4636', rooftop: '#b9b2a6', highlight: '#2f7de1',
    };
    const EYE_MIN_Y = 1.7;                // camera never goes below eye height above the platform
    const BETA_MAX = 88 * DEG;            // polar-angle limit for orbiting (spec)
    const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null; // live, read per frame
    const reducedMotion = () => !!(motionQuery && motionQuery.matches);
    const isSmallOrTouch = () => (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
        || Math.min(window.screen?.width || 1e4, window.screen?.height || 1e4) < 700;

    // ---------- engine / scene ----------
    // loseContextOnDispose: dispose() releases the WebGL context right away, so repeated create/dispose
    // (engine switching, rebuilds) never runs into the browser's active-context limit (~16 in Chrome).
    const engine = new B.Engine(canvas, true, {
        antialias: true, stencil: false, preserveDrawingBuffer: false,
        adaptToDeviceRatio: true, limitDeviceRatio: 2, powerPreference: 'high-performance',
        loseContextOnDispose: true,
    }, true);
    const scene = new B.Scene(engine);
    scene.useRightHandedSystem = true;
    const skyColor = hex(COLORS.sky);
    scene.clearColor = new B.Color4(skyColor.r, skyColor.g, skyColor.b, 1);
    scene.ambientColor = new B.Color3(0, 0, 0);
    scene.fogMode = B.Scene.FOGMODE_LINEAR;
    scene.fogColor = skyColor.clone();
    scene.fogStart = 320; scene.fogEnd = 1300;
    // The UI does its own picking through core.pickFloor: skip Babylon's per-move raycasts.
    scene.skipPointerMovePicking = true;
    scene.skipPointerDownPicking = true;
    scene.skipPointerUpPicking = true;
    const instrumentation = new B.SceneInstrumentation(scene); // resets engine draw-call counter per frame

    // ---------- materials (one shared material per colour) ----------
    function makeMaterial(name, color, opts) {
        const o = opts || {};
        const m = new B.StandardMaterial(name, scene);
        m.diffuseColor = color ? hex(color) : new B.Color3(1, 1, 1);
        m.specularColor = new B.Color3(0, 0, 0);
        m.emissiveColor = new B.Color3(0, 0, 0);
        m.sideOrientation = B.Material.CounterClockWiseSideOrientation; // core buffers are CCW (glTF/GL)
        m.backFaceCulling = true;
        // Decals sit 1-6 cm above the surface below. Use only the constant polygon-offset term: the
        // slope-scaled one (zOffset) grows huge at grazing angles and lets asphalt bleed over platforms.
        if (o.units) m.zOffsetUnits = o.units;
        return m;
    }
    const MAT = {
        terrain: makeMaterial('terrain', null),
        asphalt: makeMaterial('asphalt', COLORS.asphalt, { units: -2 }),   // 6 cm above flat terrain
        platform: makeMaterial('platform', COLORS.platform),
        park: makeMaterial('park', COLORS.park, { units: -4 }),             // 1 cm above platform
        markYellow: makeMaterial('markYellow', COLORS.markYellow, { units: -4 }),
        markWhite: makeMaterial('markWhite', COLORS.markWhite, { units: -4 }),
        siteFill: makeMaterial('siteFill', COLORS.siteFill, { units: -4 }),
        siteLine: makeMaterial('siteLine', COLORS.siteLine, { units: -8 }),
        building: makeMaterial('building', COLORS.building),
        trunk: makeMaterial('trunk', COLORS.trunk),
        crown: makeMaterial('crown', COLORS.crown),
        mass: makeMaterial('mass', null), // planned building: per-vertex colours (podium/tower/slab/rooftop/highlight)
    };
    // The red boundary should read as a drawn line, not a lit surface.
    MAT.siteLine.disableLighting = true;
    MAT.siteLine.emissiveColor = hex(COLORS.siteLine);

    // ---------- lights & shadows ----------
    const hemi = new B.HemisphericLight('sky', new B.Vector3(0, 1, 0), scene);
    hemi.specular = new B.Color3(0, 0, 0);
    const sun = new B.DirectionalLight('sun', new B.Vector3(0, -1, 0.5).normalize(), scene);
    sun.specular = new B.Color3(0, 0, 0);
    sun.autoUpdateExtends = true;       // fit the ortho frustum to the casters' bounds
    sun.autoCalcShadowZBounds = true;
    sun.shadowOrthoScale = 0.02;
    const caps = engine.getCaps();
    const mapSize = Math.min(caps.maxTextureSize || 4096, isSmallOrTouch() ? 2048 : 4096);
    const shadowGen = new B.ShadowGenerator(mapSize, sun);
    shadowGen.usePercentageCloserFiltering = true;
    shadowGen.filteringQuality = B.ShadowGenerator.QUALITY_MEDIUM;
    // Acne control. The light frustum spans the whole city (~600-750 m wide, ~450-750 m deep), so a 4096 texel
    // is ~0.15-0.18 m. A world-space normal bias of ~2 texels plus a small depth bias keeps lit roofs and
    // low-sun walls clean (09:30 winter is the worst case). forceBackFacesOnly has no visible effect here.
    const texelScale = 4096 / mapSize;
    shadowGen.bias = 0.0004;
    shadowGen.normalBias = 0.32 * texelScale;
    const shadowMap = shadowGen.getShadowMap();
    // Static scene: render the shadow map only when sun / mass / layers change.
    shadowMap.refreshRate = B.RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    const refreshShadows = () => shadowMap.resetRefreshCounter();

    // ---------- camera ----------
    const camera = new B.ArcRotateCamera('cam', Math.PI / 3, 58 * DEG, 240, new B.Vector3(0, 18, 0), scene);
    camera.minZ = 1; camera.maxZ = 6000;
    camera.fov = 0.8;
    camera.lowerRadiusLimit = 15; camera.upperRadiusLimit = 900;
    camera.lowerBetaLimit = 0.002; camera.upperBetaLimit = BETA_MAX;
    camera.inertia = 0.85;
    camera.angularSensibilityX = 1200; camera.angularSensibilityY = 1200;
    camera.wheelDeltaPercentage = 0.01;
    camera.useNaturalPinchZoom = true;
    camera.panningInertia = 0.85;
    camera.panningDistanceLimit = 1000;
    camera.panningOriginTarget = new B.Vector3(0, 0, 0);
    // Ground-plane ("map") panning: screen drags slide the target over the ground, never under it.
    // Local +Z is backwards in a right-handed view space, hence -1 so up/forward add up.
    camera.mapPanning = true;
    camera.panningAxis = new B.Vector3(1, 1, -1);
    camera.attachControl(true);
    canvas.style.outline = 'none'; // Babylon focuses the canvas on pointerdown; no focus ring over the scene
    // Shift+left drag and middle drag pan as well (right drag pans by default).
    const inputMap = camera.movement && camera.movement.input;
    if (inputMap && inputMap.addEntry) {
        inputMap.addEntry({ source: 'pointer', button: 0, modifiers: { shift: true }, interaction: 'pan' });
        inputMap.addEntry({ source: 'pointer', button: 1, interaction: 'pan' });
    }

    // ---------- framing: centre the subject in the part of the canvas the UI panel leaves free ----------
    // Lens shift (off-axis projection): only the image slides; the eye, the orbit pivot, picking rays and the
    // compass heading stay exact, and the pedestrian eye never moves. The UI reports the covered strip through
    // setViewInset({left, bottom}) (CSS px): shift right by left/2, up by bottom/2 (eases on sheet expand/collapse).
    const lens = { x: 0, y: 0, tx: 0, ty: 0 }; // current / goal shift in CSS px, +x = right, +y = up
    const inset = { left: 0, bottom: 0 };
    function measureLens() {
        const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
        lens.tx = clamp(inset.left, 0, w * 0.5) / 2;
        lens.ty = clamp(inset.bottom, 0, h * 0.8) / 2;
    }
    let lensBusy = false;
    camera.onProjectionMatrixChangedObservable.add((cam) => {
        if (lensBusy || (!lens.x && !lens.y)) return;
        lensBusy = true;
        try {
            // the matrix was just recomputed and cached, so this returns it without recomputing
            const P = cam.getProjectionMatrix();
            const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
            P.addAtIndex(8, -2 * lens.x / w);   // NDC x += 2·shift/width  (RH: w' = -z)
            P.addAtIndex(9, -2 * lens.y / h);
        } finally { lensBusy = false; }
    });
    function stepLens(dtMs, instant) {
        const k = instant ? 1 : 1 - Math.exp(-Math.max(0, dtMs) / 120);
        let x = lens.x + (lens.tx - lens.x) * k, y = lens.y + (lens.ty - lens.y) * k;
        if (Math.abs(lens.tx - x) < 0.25) x = lens.tx;
        if (Math.abs(lens.ty - y) < 0.25) y = lens.ty;
        if (x === lens.x && y === lens.y) return;
        lens.x = x; lens.y = y;
        camera.getProjectionMatrix(true); // recompute -> observer re-applies the shift
    }

    // Ground height the camera must stay above. The terrain mesh is a 25 m grid (core terrainGeometry: half 1100,
    // step 25, centre e 20 / n 6) whose flat triangles can sit metres above the analytic core.terrainHeight between
    // grid points, so take the highest corner of the grid cell under (e, n) as well.
    function groundUnder(e, n) {
        const G = 25, E0 = 20 - 1100, N0 = 6 - 1100;
        const i = Math.floor((e - E0) / G), j = Math.floor((n - N0) / G);
        let h = core.terrainHeight(e, n);
        for (let di = 0; di <= 1; di++) for (let dj = 0; dj <= 1; dj++) h = Math.max(h, core.terrainHeight(E0 + (i + di) * G, N0 + (j + dj) * G));
        return h;
    }

    // ---------- mesh helpers ----------
    function meshFromGeom(name, g, mat, opts) {
        const o = opts || {};
        const mesh = new B.Mesh(name, scene);
        const vd = new B.VertexData();
        vd.positions = g.positions instanceof Float32Array ? g.positions : new Float32Array(g.positions);
        vd.normals = g.normals instanceof Float32Array ? g.normals : new Float32Array(g.normals);
        const nVerts = vd.positions.length / 3;
        vd.indices = nVerts > 65535 ? new Uint32Array(g.indices) : new Uint16Array(g.indices);
        if (g.colors) vd.colors = g.colors instanceof Float32Array ? g.colors : new Float32Array(g.colors);
        vd.applyToMesh(mesh, !!o.updatable);
        mesh.material = mat;
        mesh.isPickable = false;
        mesh.receiveShadows = !!o.receive;
        if (o.cast) shadowGen.addShadowCaster(mesh, false);
        if (!o.dynamic) {
            mesh.freezeWorldMatrix();
            mesh.doNotSyncBoundingInfo = true;
        }
        return mesh;
    }

    // Flat red band (miter-joined) along a closed engine-space polyline; reads as a thick line from any distance.
    function bandGeometry(points, width, lift) {
        const pts = points.slice();
        if (pts.length > 1) {
            const a = pts[0], b = pts[pts.length - 1];
            if (Math.hypot(a[0] - b[0], a[2] - b[2]) < 1e-6) pts.pop();
        }
        const n = pts.length, h = width / 2;
        const dir = (p, q) => { const dx = q[0] - p[0], dz = q[2] - p[2], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
        const inner = [], outer = [];
        for (let i = 0; i < n; i++) {
            const p = pts[i], d0 = dir(pts[(i - 1 + n) % n], p), d1 = dir(p, pts[(i + 1) % n]);
            const n0 = [-d0[1], d0[0]], n1 = [-d1[1], d1[0]];
            let mx = n0[0] + n1[0], mz = n0[1] + n1[1];
            const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
            const k = h / Math.max(0.3, mx * n0[0] + mz * n0[1]);
            const y = p[1] + lift;
            outer.push([p[0] + mx * k, y, p[2] + mz * k]);
            inner.push([p[0] - mx * k, y, p[2] - mz * k]);
        }
        const g = { positions: [], normals: [], indices: [], colors: null };
        const tri = (a, b, c) => {
            // keep every triangle CCW seen from above (+Y normal)
            const cy = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
            const base = g.positions.length / 3;
            if (cy >= 0) g.positions.push(...a, ...b, ...c); else g.positions.push(...a, ...c, ...b);
            g.normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
            g.indices.push(base, base + 1, base + 2);
        };
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            tri(outer[i], outer[j], inner[j]);
            tri(outer[i], inner[j], inner[i]);
        }
        return g;
    }

    // ---------- scene state ----------
    const layers = { context: [], trees: [], terrain: [] };
    let massMesh = null, massBaseColors = null, massRanges = null, currentMass = null, highlightLevel = null;
    let parcelLines = null;
    const frameStats = { drawCalls: 0, triangles: 0, frames: 0 };
    let firstFrameResolve = null;
    let paused = false;                  // pause(): render loop stopped (no rAF, no GPU work) until resume()
    let started = false, initPending = false;
    const renderFrame = () => scene.render();

    // ---------- planned building (one mesh, per-vertex colours so highlight = colour-buffer update) ----------
    function buildMassMesh(mass) {
        const parts = [];
        const colorOf = { podium: hex(COLORS.podium), tower: hex(COLORS.tower), slab: hex(COLORS.slab), rooftop: hex(COLORS.rooftop) };
        for (const f of mass.floors) {
            parts.push({ g: f.slab, c: colorOf.slab, level: f.level });
            parts.push({ g: f.body, c: f.kind === 'podium' ? colorOf.podium : colorOf.tower, level: f.level });
        }
        // roof slab: dark band on its edges like every slab, but its top face takes the top floor's body
        // colour so the mass still reads warm orange in the plan (top) view
        const topFloor = mass.floors[mass.floors.length - 1];
        const roofTop = topFloor && topFloor.kind === 'tower' ? colorOf.tower : colorOf.podium;
        parts.push({ g: mass.roofSlab, c: colorOf.slab, cUp: roofTop, level: null });
        parts.push({ g: mass.rooftop, c: colorOf.rooftop, level: null });
        let nv = 0, ni = 0;
        for (const p of parts) { nv += p.g.positions.length / 3; ni += p.g.indices.length; }
        const positions = new Float32Array(nv * 3), normals = new Float32Array(nv * 3), colors = new Float32Array(nv * 4);
        const indices = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
        const ranges = new Map();
        let vo = 0, io = 0;
        for (const p of parts) {
            const n = p.g.positions.length / 3;
            positions.set(p.g.positions, vo * 3);
            normals.set(p.g.normals, vo * 3);
            for (let i = 0; i < n; i++) {
                const c = p.cUp && p.g.normals[i * 3 + 1] > 0.5 ? p.cUp : p.c;
                colors.set([c.r, c.g, c.b, 1], (vo + i) * 4);
            }
            for (let i = 0; i < p.g.indices.length; i++) indices[io + i] = p.g.indices[i] + vo;
            if (p.level != null) {
                const r = ranges.get(p.level);
                if (r) r[1] = vo + n; else ranges.set(p.level, [vo, vo + n]);
            }
            vo += n; io += p.g.indices.length;
        }
        return { positions, normals, colors, indices, ranges };
    }

    function applyHighlight() {
        if (!massMesh) return;
        const colors = massBaseColors.slice();
        const r = highlightLevel != null ? massRanges.get(highlightLevel) : null;
        if (r) {
            const c = hex(COLORS.highlight);
            for (let i = r[0]; i < r[1]; i++) colors.set([c.r, c.g, c.b, 1], i * 4);
        }
        massMesh.updateVerticesData(B.VertexBuffer.ColorKind, colors);
    }

    // Boxes the orbit camera may not enter (podium / tower+roof AABBs, padded): the preset targets sit inside
    // the mass, so zooming toward them would otherwise end inside the building. Same rule as the PlayCanvas page.
    let massBoxes = [];
    function computeMassBoxes(mass) {
        const PAD = 4; // m: zoom stops a few metres off the facade / roof
        const boxes = [];
        const roofTop = mass.floors.length ? mass.floors[mass.floors.length - 1].y1 + 4.5 : 0;
        for (const kind of ['podium', 'tower']) {
            const fl = mass.floors.filter((f) => f.kind === kind);
            if (!fl.length) continue;
            const b = { x0: Infinity, x1: -Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
            for (const f of fl) {
                for (const [e, n] of f.footprint) {
                    b.x0 = Math.min(b.x0, e); b.x1 = Math.max(b.x1, e);
                    b.z0 = Math.min(b.z0, -n); b.z1 = Math.max(b.z1, -n);
                }
                b.y1 = Math.max(b.y1, f.y1);
            }
            if (fl[fl.length - 1] === mass.floors[mass.floors.length - 1]) b.y1 = roofTop;
            boxes.push({ lo: [b.x0 - PAD, -1e3, b.z0 - PAD], hi: [b.x1 + PAD, b.y1 + PAD, b.z1 + PAD] });
        }
        return boxes;
    }
    // Smallest radius >= r that puts the eye outside every box along the target->camera ray.
    function radiusOutsideMass(o, u, r) {
        for (let pass = 0; pass < 3; pass++) {
            let moved = false;
            for (const b of massBoxes) {
                let t0 = -Infinity, t1 = Infinity;
                for (let k = 0; k < 3; k++) {
                    if (Math.abs(u[k]) < 1e-9) { if (o[k] < b.lo[k] || o[k] > b.hi[k]) { t0 = Infinity; break; } continue; }
                    const a = (b.lo[k] - o[k]) / u[k], c = (b.hi[k] - o[k]) / u[k];
                    t0 = Math.max(t0, Math.min(a, c)); t1 = Math.min(t1, Math.max(a, c));
                }
                if (t0 < t1 && r > t0 && r < t1) { r = t1; moved = true; }
            }
            if (!moved) break;
        }
        return r;
    }

    function setMass(mass) {
        currentMass = mass;
        massBoxes = computeMassBoxes(mass);
        const data = buildMassMesh(mass);
        if (massMesh) {
            shadowGen.removeShadowCaster(massMesh, false);
            massMesh.dispose(false, false); // geometry + buffers go, shared material stays
            massMesh = null;
        }
        massRanges = data.ranges;
        if (!data.positions.length) {
            // empty mass (no floors, e.g. STUDIO_CORE.emptyMass): no mesh at all
            massBaseColors = null;
            highlightLevel = null;
            refreshShadows();
            return;
        }
        const mesh = new B.Mesh('plannedMass', scene);
        mesh.setVerticesData(B.VertexBuffer.PositionKind, data.positions, false);
        mesh.setVerticesData(B.VertexBuffer.NormalKind, data.normals, false);
        mesh.setVerticesData(B.VertexBuffer.ColorKind, data.colors, true); // updatable for highlight
        mesh.setIndices(data.indices);
        mesh.material = MAT.mass;
        mesh.isPickable = false;
        mesh.receiveShadows = true;
        mesh.freezeWorldMatrix();
        shadowGen.addShadowCaster(mesh, false);
        massMesh = mesh;
        massBaseColors = data.colors;
        massRanges = data.ranges;
        if (highlightLevel != null && !massRanges.has(highlightLevel)) highlightLevel = null;
        if (highlightLevel != null) applyHighlight();
        refreshShadows();
    }

    function setHighlight(level) {
        highlightLevel = level == null ? null : level;
        applyHighlight();
    }

    // ---------- sun ----------
    function setSun(o) {
        const v = o.vector, alt = o.altitude;
        // light travels from the sun to the ground: direction = -vector
        sun.direction = new B.Vector3(-v[0], -v[1], -v[2]);
        sun.position = new B.Vector3(v[0] * 800, v[1] * 800, v[2] * 800);
        const day = clamp(alt / 6, 0, 1);                        // fade in over the first 6 degrees
        const warm = clamp((alt - 2) / 20, 0, 1);                 // 0 = horizon (warm), 1 = high sun (neutral)
        sun.diffuse = new B.Color3(1.0, 0.80 + 0.17 * warm, 0.62 + 0.30 * warm);
        // A lit roof should show its spec colour: sky (up faces) + sun·sin(alt) stays <= ~1.0. Above ~31 deg the
        // cap holds the horizontal contribution at 0.32, otherwise summer roofs, site fill and platforms clip to white
        // (StandardMaterial clamps light x diffuseColor after the product, so plain-colour meshes can overshoot).
        const sinA = Math.max(0.05, Math.sin(Math.max(alt, 0) * DEG));
        sun.intensity = alt > 0 ? Math.min(0.62, 0.32 / sinA) * day : 0;
        const k = 0.42 + 0.58 * clamp(alt / 12, 0, 1);            // dimmer sky at dusk / night
        hemi.diffuse = new B.Color3(0.68 * k, 0.70 * k, 0.73 * k);
        hemi.groundColor = new B.Color3(0.52 * k, 0.50 * k, 0.47 * k);
        // sky, fog and the unlit parcel lines follow the daylight so night does not look like smog
        const sk = 0.35 + 0.65 * clamp((alt + 4) / 14, 0, 1);
        const sky = hex(COLORS.sky).scale(sk);
        scene.clearColor = new B.Color4(sky.r, sky.g, sky.b, 1);
        scene.fogColor = sky;
        if (parcelLines) parcelLines.color = hex(COLORS.parcel).scale(0.45 + 0.55 * k);
        if (alt > 0) refreshShadows();
    }

    // ---------- camera presets & transitions ----------
    const azToAlpha = (azDeg) => (azDeg - 90) * DEG; // camera position azimuth (north = 0, cw) -> ArcRotate alpha
    function presetState(name) {
        const aspect = engine.getRenderWidth() / Math.max(1, engine.getRenderHeight());
        const portrait = aspect < 1 ? Math.min(1.6, Math.sqrt(1 / aspect)) : 1;
        switch (name) {
            case 'pedestrian': {
                // eye 1.6 m above the sidewalk across the SE intersection (e 31, n -31), looking at the tower
                const eye = core.toEngine(31, -31, 0.15 + 1.6), tgt = [0, 22, 0];
                const dx = eye[0] - tgt[0], dy = eye[1] - tgt[1], dz = eye[2] - tgt[2];
                const r = Math.hypot(dx, dy, dz);
                return { alpha: Math.atan2(dz, dx), beta: Math.acos(dy / r), radius: r, target: tgt, fov: 70 * DEG };
            }
            case 'top': {
                // near-orthographic plan: long lens from high up so walls barely lean; ~220 m across the shorter side
                const half = 110, r = aspect >= 1 ? 600 : 850;
                const fov = 2 * Math.atan(half / (r * Math.min(1, aspect)));
                return { alpha: azToAlpha(180), beta: 0.002, radius: r, target: [0, 0, 0], fov };
            }
            case 'north':
                return { alpha: azToAlpha(0), beta: (90 - 18) * DEG, radius: 170 * portrait, target: [0, 15, 0], fov: 0.8 };
            case 'aerial':
            default:
                return { alpha: azToAlpha(150), beta: (90 - 32) * DEG, radius: 240 * portrait, target: [0, 18, 0], fov: 0.8 };
        }
    }
    let tween = null;
    let viewMode = 'aerial';
    function applyCamState(s) {
        camera.alpha = s.alpha; camera.beta = s.beta; camera.radius = s.radius; camera.fov = s.fov;
        camera.target.set(s.target[0], s.target[1], s.target[2]);
    }
    function stopCameraMotion() {
        camera.inertialAlphaOffset = 0; camera.inertialBetaOffset = 0; camera.inertialRadiusOffset = 0;
        camera.inertialPanningX = 0; camera.inertialPanningY = 0;
    }
    // Optional framing override (docs/SPEC.md): { target:[x,y,z], azimuth, elevation, distance, fov } in engine
    // coordinates / degrees / metres replaces those preset fields (e.g. a site-aware aerial in the Studio).
    function applyOverride(to, o) {
        if (Array.isArray(o.target) && o.target.length === 3 && o.target.every(Number.isFinite)) to.target = o.target.slice();
        if (Number.isFinite(o.azimuth)) to.alpha = azToAlpha(o.azimuth);
        if (Number.isFinite(o.elevation)) to.beta = clamp((90 - o.elevation) * DEG, 0.002, Math.PI - 0.01);
        if (Number.isFinite(o.distance)) to.radius = clamp(o.distance, camera.lowerRadiusLimit, camera.upperRadiusLimit);
        if (Number.isFinite(o.fov)) to.fov = clamp(o.fov, 5, 120) * DEG;
        return to;
    }
    function setView(name, override) {
        const to = presetState(name);
        if (override) applyOverride(to, override);
        viewMode = name === 'pedestrian' ? 'pedestrian' : 'orbit';
        stopCameraMotion();
        if (reducedMotion() || !scene.activeCamera) { tween = null; applyCamState(to); updateBetaLimit(); return; }
        // shortest way around for alpha
        let a0 = camera.alpha;
        const d = to.alpha - a0;
        a0 += Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
        camera.alpha = a0;
        tween = {
            from: { alpha: a0, beta: camera.beta, radius: camera.radius, fov: camera.fov, target: [camera.target.x, camera.target.y, camera.target.z] },
            to, t0: performance.now(), dur: 700,
        };
    }
    function stepTween() {
        if (!tween) return;
        const t = clamp((performance.now() - tween.t0) / tween.dur, 0, 1);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        const f = tween.from, g = tween.to, L = (a, b) => a + (b - a) * e;
        // radius interpolated geometrically so zooming feels even
        applyCamState({
            alpha: L(f.alpha, g.alpha), beta: L(f.beta, g.beta), fov: L(f.fov, g.fov),
            radius: f.radius * Math.pow(g.radius / f.radius, e),
            target: [L(f.target[0], g.target[0]), L(f.target[1], g.target[1]), L(f.target[2], g.target[2])],
        });
        if (t >= 1) tween = null;
    }
    // Polar angle <= 88 deg (spec). The pedestrian preset looks UP at the tower from eye level, so in that
    // mode the limit becomes "eye never below 1.7 m above the platform" instead. No clamp mid-transition.
    function updateBetaLimit() {
        if (tween) { camera.upperBetaLimit = Math.PI - 0.01; return; }
        if (viewMode === 'pedestrian') {
            const r = Math.max(camera.radius, 1e-3);
            const betaEye = Math.acos(clamp((EYE_MIN_Y - camera.target.y) / r, -1, 1));
            camera.upperBetaLimit = clamp(betaEye + 1e-4, BETA_MAX, 150 * DEG);
        } else camera.upperBetaLimit = BETA_MAX;
    }
    const cancelTween = () => { tween = null; };
    canvas.addEventListener('pointerdown', cancelTween);
    canvas.addEventListener('wheel', cancelTween, { passive: true });

    scene.onBeforeRenderObservable.add(() => {
        stepLens(engine.getDeltaTime(), reducedMotion());
        stepTween();
        // keep the target on/above the ground
        if (camera.target.y < 0) camera.target.y = 0;
        updateBetaLimit();
        if (!tween) {
            // eye stays >= 1.7 m above the outer terrain hills under it (the polar limit alone allows dipping into them)
            const t = camera.target;
            const eyeFloor = () => {
                const sb = Math.sin(camera.beta);
                const camE = t.x + camera.radius * Math.cos(camera.alpha) * sb, camN = -(t.z + camera.radius * Math.sin(camera.alpha) * sb);
                return groundUnder(camE, camN) + EYE_MIN_Y;
            };
            let floorY = eyeFloor();
            if (t.y + camera.radius * Math.cos(camera.beta) < floorY) {
                const b = Math.acos(clamp((floorY - t.y) / Math.max(camera.radius, 1e-3), -1, 1));
                camera.upperBetaLimit = Math.min(camera.upperBetaLimit, b);
                if (camera.beta > b) { camera.beta = b; camera.inertialBetaOffset = 0; }
                // target panned out under a hill deeper than the orbit radius: even looking straight down the eye
                // would sit inside the hill, so back the eye out instead (zoom-in stops at the hillside)
                floorY = eyeFloor();
                const cb = Math.cos(camera.beta);
                if (cb > 0.5 && t.y + camera.radius * cb < floorY) {
                    camera.radius = Math.min(camera.upperRadiusLimit, (floorY - t.y) / cb + 0.01);
                    if (camera.inertialRadiusOffset > 0) camera.inertialRadiusOffset = 0; // >0 = zooming in
                }
            }
        }
        // never inside the planned building (also covers a mass that just grew around the eye)
        if (massBoxes.length) {
            const sb = Math.sin(camera.beta), t = camera.target;
            const u = [Math.cos(camera.alpha) * sb, Math.cos(camera.beta), Math.sin(camera.alpha) * sb];
            const rOut = radiusOutsideMass([t.x, t.y, t.z], u, camera.radius);
            if (rOut > camera.radius) {
                camera.radius = Math.min(rOut, camera.upperRadiusLimit);
                if (camera.inertialRadiusOffset > 0) camera.inertialRadiusOffset = 0; // >0 = zooming in
            }
        }
        const r = Math.max(camera.radius, 1e-3);
        // distance-scaled panning so the ground roughly follows the cursor at any zoom
        if (camera.movement) {
            const h = Math.max(1, canvas.clientHeight || engine.getRenderHeight());
            const worldPerPx = (2 * r * Math.tan(camera.fov / 2)) / h;
            const sens = camera.panningSensibility || 1000;
            camera.movement.panSpeed = worldPerPx * sens * (1 - camera.panningInertia);
        }
        // fog follows the zoom so the subject stays crisp and the far hills melt into the sky
        scene.fogStart = Math.max(320, r * 1.2);
        scene.fogEnd = scene.fogStart + 1000;
    });
    scene.onAfterRenderObservable.add(() => {
        frameStats.drawCalls = instrumentation.drawCallsCounter.current;
        // Count here, for the frame just drawn: adding/disposing a mesh (setMass) empties the scene's
        // active-mesh list until the next frame, so counting on demand in stats() could read 0.
        let tris = 0;
        const active = scene.getActiveMeshes();
        for (let i = 0; i < active.length; i++) {
            const m = active.data[i];
            if (!(m instanceof B.LinesMesh)) tris += m.getTotalIndices() / 3;
        }
        frameStats.triangles = tris;
        frameStats.frames++;
        if (firstFrameResolve) { const f = firstFrameResolve; firstFrameResolve = null; initPending = false; f(); }
        if (paused && !initPending) engine.stopRenderLoop(renderFrame); // pause() asked during init: stop after the first frame
    });

    // ---------- resize ----------
    function resize() {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        if (Math.abs(engine.getHardwareScalingLevel() - 1 / dpr) > 1e-6) engine.setHardwareScalingLevel(1 / dpr);
        engine.resize();
    }
    const onLayout = () => { resize(); measureLens(); };
    let ro = null;
    if (window.ResizeObserver) {
        ro = new ResizeObserver(onLayout);
        ro.observe(canvas.parentElement || canvas);
        if (canvas.parentElement) ro.observe(canvas);
    }
    window.addEventListener('resize', onLayout);

    // ---------- adapter ----------
    const adapter = {
        engineName: 'Babylon.js',
        engineVersion: String(B.Engine.Version),

        async init() {
            resize();
            measureLens();
            stepLens(0, true); // first frame already framed; later panel changes ease in
            const ctx = core.buildContext();
            const terrain = meshFromGeom('terrain', ctx.terrain, MAT.terrain);
            layers.terrain.push(terrain);
            meshFromGeom('asphalt', ctx.asphalt, MAT.asphalt, { receive: true });
            meshFromGeom('platforms', ctx.platforms, MAT.platform, { receive: true });
            meshFromGeom('parks', ctx.parks, MAT.park, { receive: true });
            meshFromGeom('markingsYellow', ctx.markingsYellow, MAT.markYellow, { receive: true });
            meshFromGeom('markingsWhite', ctx.markingsWhite, MAT.markWhite, { receive: true });
            meshFromGeom('siteFill', ctx.siteFill, MAT.siteFill, { receive: true });
            meshFromGeom('siteBoundary', bandGeometry(ctx.siteOutline, 0.8, 0.01), MAT.siteLine);
            layers.context.push(meshFromGeom('buildings', ctx.buildings, MAT.building, { receive: true, cast: true }));
            layers.trees.push(meshFromGeom('trunks', ctx.trunks, MAT.trunk, { receive: true, cast: true }));
            layers.trees.push(meshFromGeom('crowns', ctx.crowns, MAT.crown, { receive: true, cast: true }));

            // parcel lines: thin 1px line system (fog-aware colour shader)
            const lines = ctx.parcelLines.map((s) => [new B.Vector3(s[0], s[1], s[2]), new B.Vector3(s[3], s[4], s[5])]);
            const parcel = B.MeshBuilder.CreateLineSystem('parcelLines', { lines, useVertexAlpha: false }, scene);
            parcel.color = hex(COLORS.parcel);
            parcel.isPickable = false;
            if (parcel.material) parcel.material.zOffsetUnits = -6;
            parcelLines = parcel;
            parcel.freezeWorldMatrix();
            parcel.doNotSyncBoundingInfo = true;

            // default sun + mass so every shader variant is compiled before the first frame
            const s0 = core.SUN_PRESETS.winter;
            const p0 = core.solarPosition({ month: s0.month, day: s0.day, hour: 12.5 });
            setSun({ vector: core.sunVector(p0.altitude, p0.azimuth), altitude: p0.altitude, azimuth: p0.azimuth });
            if (!currentMass) setMass(core.buildMainMass());
            applyCamState(presetState('aerial'));

            initPending = true;
            started = true;
            engine.runRenderLoop(renderFrame);
            await scene.whenReadyAsync();
            await new Promise((resolve) => { firstFrameResolve = resolve; });
        },

        setMass,
        setSun,
        setView,

        setViewInset(o) {
            inset.left = Math.max(0, Number(o && o.left) || 0);
            inset.bottom = Math.max(0, Number(o && o.bottom) || 0);
            measureLens();
        },

        setLayer(name, visible) {
            const v = !!visible;
            if (name === 'shadows') {
                sun.shadowEnabled = v;
                if (v) refreshShadows();
                return;
            }
            const list = layers[name];
            if (!list) return;
            for (const m of list) m.setEnabled(v);
            if (name !== 'terrain') refreshShadows();
        },

        setHighlight,

        screenToRay(clientX, clientY) {
            const rect = canvas.getBoundingClientRect();
            const w = engine.getRenderWidth(), h = engine.getRenderHeight(), s = engine.getHardwareScalingLevel();
            // Babylon expects CSS px scaled by the hardware scaling level; map through the exact render size
            const x = ((clientX - rect.left) / Math.max(1, rect.width)) * w * s;
            const y = ((clientY - rect.top) / Math.max(1, rect.height)) * h * s;
            const ray = scene.createPickingRay(x, y, B.Matrix.Identity(), camera, false);
            const d = ray.direction.normalize();
            // createPickingRay starts on the near plane; report the eye so pickFloor distances are from the camera
            const o = camera.globalPosition;
            return { origin: [o.x, o.y, o.z], dir: [d.x, d.y, d.z] };
        },

        cameraHeading() {
            // view direction = target - position; azimuth north = 0, clockwise (x = east, z = -north)
            const fx = camera.target.x - camera.position.x, fz = camera.target.z - camera.position.z;
            let az;
            if (Math.hypot(fx, fz) < 1e-6 * Math.max(1, camera.radius)) az = camera.alpha / DEG + 270;
            else az = Math.atan2(fx, -fz) / DEG;
            return ((az % 360) + 360) % 360;
        },

        stats() {
            // frames: frames drawn since creation (stops increasing while paused)
            return { fps: paused ? 0 : Math.round(engine.getFps() * 10) / 10, drawCalls: frameStats.drawCalls, triangles: frameStats.triangles, frames: frameStats.frames };
        },

        // Optional (docs/SPEC.md): stop the render loop entirely while the view is hidden; resume() restarts it.
        // Idempotent. A pause during init() takes effect right after the first frame (init still resolves).
        pause() {
            if (paused) return;
            paused = true;
            if (!initPending) engine.stopRenderLoop(renderFrame);
        },
        resume() {
            if (!paused) return;
            paused = false;
            if (started) engine.runRenderLoop(renderFrame); // before init() there is no loop to restart
        },

        dispose() {
            paused = true;
            engine.stopRenderLoop();
            canvas.removeEventListener('pointerdown', cancelTween);
            canvas.removeEventListener('wheel', cancelTween);
            window.removeEventListener('resize', onLayout);
            if (ro) ro.disconnect();
            instrumentation.dispose();
            scene.dispose();
            engine.dispose();
        },

        // debug handles (not part of the contract)
        _babylon: { engine, scene, camera, sun, hemi, shadowGen },
    };
    return adapter;
}

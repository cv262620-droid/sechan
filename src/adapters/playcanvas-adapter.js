// PlayCanvas renderer adapter for the mass-study page (contract: docs/SPEC.md).
// Engine-only classic build -> global `pc`. SITE_CORE geometry is already in PlayCanvas' native
// frame (right-handed, Y-up, x = east, z = -north, CCW front faces), so buffers go in unchanged.
// Colour pipeline: StandardMaterial colours (and vertex colours, via vertexColorGamma) are sRGB and
// get linearised; lighting runs in linear space; the camera applies TONEMAP_LINEAR (exposure 1, i.e.
// none) and gamma-encodes (GAMMA_SRGB). Light levels below are tuned so a lit roof shows its spec
// colour and shaded faces sit at ~0.68 of it (close to the Babylon page's gamma-space look).
async function createPlayCanvasAdapter(canvas, core) {
    'use strict';
    const pc = window.pc;
    if (!pc) throw new Error('pc global not found (playcanvas.min.js not loaded)');

    const DEG = Math.PI / 180;
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const COLORS = {
        sky: '#dde4ea', asphalt: '#5b5f63', platform: '#d9d6cf', park: '#9fb38a',
        markYellow: '#e2b83b', markWhite: '#f2f2ee', parcel: '#9a968d', siteFill: '#efe6c8',
        siteLine: '#d2352b', building: '#eceae4', trunk: '#6b5a48', crown: '#6f8f5a',
        podium: '#c98d4b', tower: '#d9a35f', slab: '#5a4636', rooftop: '#b9b2a6', highlight: '#2f7de1',
    };
    // Lighting, in linear units multiplying the (linearised) albedo.
    const LIGHTING = {
        sunK: 0.5, sunCap: 0.9,               // sun = min(cap, K / sin(alt)) -> lit roofs ~ spec colour
        ambient: [0.395, 0.405, 0.425],       // sky + ground average: what a shaded wall gets
        fill: [0.045, 0.05, 0.06],            // extra sky light on up-facing faces (hemisphere approx.)
    };
    const EYE_MIN_Y = 1.7;                    // camera never below eye height
    const EL_MAX = 89.9;                      // degrees above horizon (top view)
    const EL_MIN = 2;                         // spec: polar angle <= 88 deg
    const DIST_MIN = 15, DIST_MAX = 900;
    const FOV = 46;                           // vertical, degrees
    const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    // phones / tablets: smaller shadow map (window size, not window.screen: headless reports 800x600)
    const smallScreen = () => (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
        || Math.min(window.innerWidth || 1e4, window.innerHeight || 1e4) < 560;

    const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const color = (h) => { const [r, g, b] = hexRgb(h); return new pc.Color(r, g, b); };
    const toSrgb = (v) => Math.pow(Math.max(0, v), 1 / 2.2); // PlayCanvas linearises with pow 2.2

    // ---------- device / app ----------
    const device = await pc.createGraphicsDevice(canvas, {
        deviceTypes: [pc.DEVICETYPE_WEBGL2], antialias: true, alpha: false, stencil: false,
        powerPreference: 'high-performance',
    });
    const dpr = () => Math.min(2, window.devicePixelRatio || 1);
    device.maxPixelRatio = dpr(); // default is min(1, dpr): would render at 1x on retina

    const appOptions = new pc.AppOptions();
    appOptions.graphicsDevice = device;
    appOptions.componentSystems = [pc.RenderComponentSystem, pc.CameraComponentSystem, pc.LightComponentSystem];
    appOptions.resourceHandlers = [];
    const app = new pc.AppBase(canvas);
    app.init(appOptions);
    // The page's CSS owns the canvas box; RESOLUTION_AUTO makes every render match the drawing
    // buffer to clientWidth/Height x maxPixelRatio. (No setCanvasFillMode: it writes style sizes.)
    app.setCanvasResolution(pc.RESOLUTION_AUTO);

    const scene = app.scene;
    scene.clusteredLightingEnabled = false; // two directional lights only: plain forward lighting
    scene.exposure = 1;
    const sky = color(COLORS.sky);
    const SKY_DAY = hexRgb(COLORS.sky), SKY_NIGHT = hexRgb('#3b4148');
    scene.fog.type = pc.FOG_LINEAR;
    scene.fog.color = sky.clone();
    scene.fog.start = 320;
    scene.fog.end = 1320;

    // ---------- materials (one shared material per colour) ----------
    const BLACK = new pc.Color(0, 0, 0);
    const materials = [];
    function makeMaterial(name, hex, opts) {
        const o = opts || {};
        const m = new pc.StandardMaterial();
        m.name = name;
        m.useMetalness = false;
        m.specular = BLACK.clone();   // black specular -> no specular code path at all
        m.useSkybox = false;
        if (o.unlit) {
            m.useLighting = false;
            m.diffuse = BLACK.clone();
            m.emissive = color(hex);
        } else {
            m.diffuse = hex ? color(hex) : new pc.Color(1, 1, 1);
        }
        if (o.vertexColors) {
            m.diffuseVertexColor = true;
            m.vertexColorGamma = true; // buffers hold sRGB-ish values (like the spec hex colours)
        }
        if (o.bias) { m.depthBias = o.bias; m.slopeDepthBias = o.bias; } // decal layers win depth ties
        m.update();
        materials.push(m);
        return m;
    }
    const MAT = {
        terrain: makeMaterial('terrain', null, { vertexColors: true }),
        asphalt: makeMaterial('asphalt', COLORS.asphalt),
        platform: makeMaterial('platform', COLORS.platform),
        park: makeMaterial('park', COLORS.park, { bias: -1 }),
        markYellow: makeMaterial('markYellow', COLORS.markYellow, { bias: -2 }),
        markWhite: makeMaterial('markWhite', COLORS.markWhite, { bias: -2 }),
        siteFill: makeMaterial('siteFill', COLORS.siteFill, { bias: -2 }),
        siteLine: makeMaterial('siteLine', COLORS.siteLine, { unlit: true, bias: -4 }),
        parcel: makeMaterial('parcel', COLORS.parcel, { unlit: true }),
        building: makeMaterial('building', COLORS.building),
        trunk: makeMaterial('trunk', COLORS.trunk),
        crown: makeMaterial('crown', COLORS.crown),
        mass: makeMaterial('mass', null, { vertexColors: true }), // per-vertex: podium/tower/slab/rooftop/highlight
    };

    // ---------- camera ----------
    const camEnt = new pc.Entity('camera');
    camEnt.addComponent('camera', {
        clearColor: sky.clone(), fov: FOV, nearClip: 1, farClip: 6000,
    });
    camEnt.camera.toneMapping = pc.TONEMAP_LINEAR;
    camEnt.camera.gammaCorrection = pc.GAMMA_SRGB;
    app.root.addChild(camEnt);

    // ---------- lights ----------
    // A directional light shines along its entity's -Y axis: rotate +Y onto the sun vector.
    const caps = device.maxTextureSize || 4096;
    const shadowRes = Math.min(caps, smallScreen() ? 2048 : 4096);
    const sunEnt = new pc.Entity('sun');
    sunEnt.addComponent('light', {
        type: 'directional', castShadows: true, shadowResolution: shadowRes, shadowDistance: 450,
        shadowType: pc.SHADOW_PCF3_32F, numCascades: 1, cascadeBlend: 0.2,
        shadowBias: 0.3, normalOffsetBias: 0.15, affectSpecularity: false,
        shadowUpdateMode: pc.SHADOWUPDATE_REALTIME,
    });
    app.root.addChild(sunEnt);
    // Sky fill: shadowless light straight down. ambient (all faces) + fill (up faces) ~ hemisphere light.
    const fillEnt = new pc.Entity('skyFill');
    fillEnt.addComponent('light', { type: 'directional', castShadows: false, affectSpecularity: false });
    app.root.addChild(fillEnt); // identity rotation: shines along -Y

    // PlayCanvas quirk: intensity < 1 is applied before linearisation ((c*I)^2.2), >= 1 after.
    // Set colours from a target *linear* RGB so both cases give the intended light.
    function setLightLinear(light, rgbLin) {
        const m = Math.max(rgbLin[0], rgbLin[1], rgbLin[2]);
        if (m <= 0) { light.intensity = 0; return; }
        const s = m > 1 ? m : 1;
        light.color = new pc.Color(toSrgb(rgbLin[0] / s), toSrgb(rgbLin[1] / s), toSrgb(rgbLin[2] / s));
        light.intensity = s;
    }
    const setAmbientLinear = (rgbLin) => { scene.ambientLight = new pc.Color(toSrgb(rgbLin[0]), toSrgb(rgbLin[1]), toSrgb(rgbLin[2])); };

    // ---------- mesh helpers ----------
    const f32 = (a) => (a instanceof Float32Array ? a : new Float32Array(a));
    function makeMesh(g, primitive) {
        const mesh = new pc.Mesh(device);
        const pos = f32(g.positions);
        const nv = pos.length / 3;
        mesh.setPositions(pos);
        if (g.normals && g.normals.length) mesh.setNormals(f32(g.normals));
        if (g.colors32) mesh.setColors32(g.colors32);
        else if (g.colors) {
            const c = new Uint8Array(g.colors.length);
            for (let i = 0; i < c.length; i++) c[i] = Math.round(clamp(g.colors[i], 0, 1) * 255);
            mesh.setColors32(c);
        }
        if (g.indices) mesh.setIndices(nv > 65535 ? new Uint32Array(g.indices) : new Uint16Array(g.indices));
        mesh.update(primitive == null ? pc.PRIMITIVE_TRIANGLES : primitive);
        return mesh;
    }
    function addEntity(name, mesh, mat, opts) {
        const o = opts || {};
        const e = new pc.Entity(name);
        const mi = new pc.MeshInstance(mesh, mat);
        e.addComponent('render', { meshInstances: [mi], castShadows: !!o.cast, receiveShadows: !!o.receive });
        app.root.addChild(e);
        return e;
    }

    // Flat band (miter-joined, centred on the line) along a closed engine-space polyline.
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
        const g = { positions: [], normals: [], indices: [] };
        const tri = (a, b, c) => {
            // CCW seen from above (+Y normal): cross(b-a, c-a).y > 0
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

    function lineGeometry(segments) {
        const positions = new Float32Array(segments.length * 6), normals = new Float32Array(segments.length * 6);
        for (let i = 0; i < segments.length; i++) {
            positions.set(segments[i], i * 6);
            normals.set([0, 1, 0, 0, 1, 0], i * 6);
        }
        return { positions, normals, indices: null };
    }

    // ---------- scene state ----------
    const layers = { context: [], trees: [], terrain: [] };
    const allEntities = [];
    let shadowsOn = true, sunUp = true;
    let massEntity = null, massData = null, currentMass = null, highlightLevel = null;

    // ---------- planned building: one mesh, per-vertex colours ----------
    function buildMassData(mass) {
        const rgb = (h) => hexRgb(h).map((v) => Math.round(v * 255));
        const C = { podium: rgb(COLORS.podium), tower: rgb(COLORS.tower), slab: rgb(COLORS.slab), rooftop: rgb(COLORS.rooftop) };
        const parts = [];
        for (const f of mass.floors) {
            parts.push({ g: f.slab, c: C.slab, level: f.level });
            parts.push({ g: f.body, c: f.kind === 'podium' ? C.podium : C.tower, level: f.level });
        }
        parts.push({ g: mass.roofSlab, c: C.slab, level: null });
        parts.push({ g: mass.rooftop, c: C.rooftop, level: null });
        let nv = 0, ni = 0;
        for (const p of parts) { nv += p.g.positions.length / 3; ni += p.g.indices.length; }
        const positions = new Float32Array(nv * 3), normals = new Float32Array(nv * 3), colors = new Uint8Array(nv * 4);
        const indices = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
        const ranges = new Map();
        let vo = 0, io = 0;
        for (const p of parts) {
            const n = p.g.positions.length / 3;
            positions.set(p.g.positions, vo * 3);
            normals.set(p.g.normals, vo * 3);
            for (let i = 0; i < n; i++) colors.set([p.c[0], p.c[1], p.c[2], 255], (vo + i) * 4);
            for (let i = 0; i < p.g.indices.length; i++) indices[io + i] = p.g.indices[i] + vo;
            if (p.level != null) {
                const r = ranges.get(p.level);
                if (r) r[1] = vo + n; else ranges.set(p.level, [vo, vo + n]);
            }
            vo += n; io += p.g.indices.length;
        }
        return { positions, normals, colors, indices, ranges };
    }

    function rebuildMassEntity() {
        if (massEntity) { massEntity.destroy(); massEntity = null; } // destroys mesh instances + GPU buffers
        if (!massData) return;
        let colors32 = massData.colors;
        const r = highlightLevel != null ? massData.ranges.get(highlightLevel) : null;
        if (r) {
            colors32 = massData.colors.slice();
            const c = hexRgb(COLORS.highlight).map((v) => Math.round(v * 255));
            for (let i = r[0]; i < r[1]; i++) colors32.set([c[0], c[1], c[2], 255], i * 4);
        }
        const mesh = makeMesh({ positions: massData.positions, normals: massData.normals, colors32, indices: massData.indices });
        massEntity = addEntity('plannedMass', mesh, MAT.mass, { cast: true, receive: true });
    }

    // Boxes the orbit camera may not enter (podium / tower+roof AABBs, padded): the preset targets sit
    // inside the mass, so wheel-zooming toward them would otherwise end with the camera inside the building.
    let massBoxes = [];
    function computeMassBoxes(mass) {
        const PAD = 4; // m: zoom stops a few metres off the facade / roof
        const boxes = [];
        const roofTop = mass.floors.length ? mass.floors[mass.floors.length - 1].y1 + 4.5 : 0;
        for (const kind of ['podium', 'tower']) {
            const fl = mass.floors.filter((f) => f.kind === kind);
            if (!fl.length) continue;
            const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
            for (const f of fl) {
                for (const [e, n] of f.footprint) {
                    b.x0 = Math.min(b.x0, e); b.x1 = Math.max(b.x1, e);
                    b.z0 = Math.min(b.z0, -n); b.z1 = Math.max(b.z1, -n);
                }
                b.y0 = Math.min(b.y0, f.y0); b.y1 = Math.max(b.y1, f.y1);
            }
            if (fl[fl.length - 1] === mass.floors[mass.floors.length - 1]) b.y1 = roofTop;
            boxes.push({ x0: b.x0 - PAD, x1: b.x1 + PAD, y0: -1e3, y1: b.y1 + PAD, z0: b.z0 - PAD, z1: b.z1 + PAD });
        }
        return boxes;
    }
    // Push s.dist out along the target->camera ray until the eye is outside every mass box.
    function keepOutOfMass(s) {
        const ce = Math.cos(s.el * DEG);
        const u = [Math.sin(s.az * DEG) * ce, Math.sin(s.el * DEG), -Math.cos(s.az * DEG) * ce], o = [s.tx, s.ty, s.tz];
        for (let pass = 0; pass < 3; pass++) {
            let moved = false;
            for (const b of massBoxes) {
                let t0 = -Infinity, t1 = Infinity;
                const lo = [b.x0, b.y0, b.z0], hi = [b.x1, b.y1, b.z1];
                for (let k = 0; k < 3; k++) {
                    if (Math.abs(u[k]) < 1e-9) { if (o[k] < lo[k] || o[k] > hi[k]) { t0 = Infinity; break; } continue; }
                    const a = (lo[k] - o[k]) / u[k], c = (hi[k] - o[k]) / u[k];
                    t0 = Math.max(t0, Math.min(a, c)); t1 = Math.min(t1, Math.max(a, c));
                }
                if (t0 < t1 && s.dist > t0 && s.dist < t1) { s.dist = t1; moved = true; }
            }
            if (!moved) break;
        }
        return s;
    }

    function setMass(mass) {
        currentMass = mass;
        massBoxes = computeMassBoxes(mass);
        massData = buildMassData(mass);
        if (highlightLevel != null && !massData.ranges.has(highlightLevel)) highlightLevel = null;
        rebuildMassEntity();
    }

    function setHighlight(level) {
        const next = level == null ? null : level;
        if (next === highlightLevel) return;
        highlightLevel = next;
        rebuildMassEntity();
    }

    // ---------- sun ----------
    const UP = new pc.Vec3(0, 1, 0);
    function applyShadowState() { sunEnt.light.castShadows = shadowsOn && sunUp; }
    function setSun(o) {
        const v = o.vector, alt = o.altitude;
        sunUp = alt > 0;
        const dir = new pc.Vec3(v[0], v[1], v[2]).normalize();
        sunEnt.setRotation(new pc.Quat().setFromDirections(UP, dir));
        const day = clamp(alt / 6, 0, 1);                   // fade in over the first 6 degrees
        const warm = clamp((alt - 2) / 30, 0, 1);           // 0 = horizon (warm), 1 = high sun (neutral)
        const tint = [1.0, 0.84 + 0.14 * warm, 0.70 + 0.27 * warm]; // linear multipliers
        const sinA = Math.max(0.05, Math.sin(Math.max(alt, 0) * DEG));
        const I = sunUp ? Math.min(LIGHTING.sunCap, LIGHTING.sunK / sinA) * day : 0;
        sunEnt.enabled = sunUp;
        if (sunUp) setLightLinear(sunEnt.light, tint.map((c) => c * I));
        const k = 0.25 + 0.75 * clamp((alt + 2) / 14, 0, 1); // dimmer sky light at dusk / night
        setAmbientLinear(LIGHTING.ambient.map((c) => c * k));
        setLightLinear(fillEnt.light, LIGHTING.fill.map((c) => c * k));
        // background + fog colour follow the sky so far hills still melt into it at dusk
        const s = clamp((alt + 4) / 14, 0, 1);
        const bg = new pc.Color(...SKY_NIGHT.map((c, i) => c + (SKY_DAY[i] - c) * s));
        camEnt.camera.clearColor = bg;
        scene.fog.color = bg.clone();
        applyShadowState();
    }

    // ---------- camera: orbit / pan / zoom controller ----------
    // State: target (tx,ty,tz), az = azimuth of the camera *position* seen from the target
    // (north = 0, clockwise, deg), el = elevation above the target (deg), dist (m), fov (deg).
    const cur = { tx: 0, ty: 18, tz: 0, az: 150, el: 32, dist: 240, fov: FOV };
    const goal = Object.assign({}, cur);
    let tween = null;

    function minElevation(s) {
        // allow looking up from below the target only while the eye stays above EYE_MIN_Y over the
        // ground under the camera (the outer terrain rises into hills beyond the city blocks)
        const ce = Math.cos(Math.max(s.el, 0) * DEG);
        const camE = s.tx + s.dist * Math.sin(s.az * DEG) * ce, camN = -(s.tz - s.dist * Math.cos(s.az * DEG) * ce);
        const floorY = Math.max(EYE_MIN_Y, core.terrainHeight(camE, camN) + EYE_MIN_Y);
        const sEye = clamp((floorY - s.ty) / Math.max(s.dist, 1e-3), -1, 1);
        return Math.max(Math.min(EL_MIN, Math.max(-60, Math.asin(sEye) / DEG)), Math.asin(sEye) / DEG);
    }
    function constrain(s) {
        s.dist = clamp(s.dist, DIST_MIN, DIST_MAX);
        s.ty = clamp(s.ty, 0, 300);
        s.tx = clamp(s.tx, -1000, 1000);
        s.tz = clamp(s.tz, -1000, 1000);
        s.el = clamp(s.el, minElevation(s), EL_MAX);
        return keepOutOfMass(s);
    }
    // ---- framing: keep the orbit target centred in the part of the canvas the UI panel leaves free ----
    // (desktop side panel -> shift right; phone bottom sheet -> shift up). Uses the camera's lens shift
    // (projectionOffset, half-frustum units), so position/heading/elevation stay exactly as the presets say.
    const panelEl = document.getElementById('panel');
    const shiftGoal = { x: 0, y: 0 }, shiftCur = { x: 0, y: 0 };
    const shiftVec = new pc.Vec2();
    function measureShift() {
        shiftGoal.x = 0; shiftGoal.y = 0;
        if (!panelEl) return;
        const c = canvas.getBoundingClientRect(), p = panelEl.getBoundingClientRect();
        const W = c.width, H = c.height;
        if (W < 1 || H < 1 || p.width < 1 || p.height < 1) return;
        let x0 = c.left, x1 = c.right, y0 = c.top, y1 = c.bottom;
        // side panel anchored top-left (any height: sections may be collapsed) vs phone bottom sheet
        const sidePanel = p.left - c.left < 0.2 * W && p.right - c.left < 0.75 * W && p.top - c.top < 0.3 * H;
        const bottomSheet = !sidePanel && c.bottom - p.bottom < 0.15 * H && p.width > 0.6 * W && p.height < 0.8 * H;
        if (sidePanel) x0 = Math.max(x0, p.right);
        else if (bottomSheet) y1 = Math.min(y1, p.top);
        else return;
        const cx = (x0 + x1) / 2 - c.left, cy = (y0 + y1) / 2 - c.top;
        shiftGoal.x = clamp(-(cx - W / 2) / (W / 2), -0.6, 0.6);
        shiftGoal.y = clamp((cy - H / 2) / (H / 2), -0.6, 0.6);
    }
    function stepShift(dt, instant) {
        const k = instant || reducedMotion() ? 1 : 1 - Math.exp(-dt * 10);
        for (const a of ['x', 'y']) {
            const d = shiftGoal[a] - shiftCur[a];
            shiftCur[a] = Math.abs(d) < 1e-4 ? shiftGoal[a] : shiftCur[a] + d * k;
        }
    }

    const qYaw = new pc.Quat(), qPitch = new pc.Quat(), qCam = new pc.Quat();
    const RIGHT = new pc.Vec3(1, 0, 0);
    function applyCamera(s) {
        const az = s.az * DEG, el = s.el * DEG;
        const ce = Math.cos(el);
        camEnt.setPosition(s.tx + s.dist * Math.sin(az) * ce, s.ty + s.dist * Math.sin(el), s.tz - s.dist * Math.cos(az) * ce);
        // look along heading h = az + 180: yaw about +Y by -h, then pitch down by el about local X
        qYaw.setFromAxisAngle(UP, -(s.az + 180));
        qPitch.setFromAxisAngle(RIGHT, -s.el);
        qCam.mul2(qYaw, qPitch);
        camEnt.setRotation(qCam);
        const cam = camEnt.camera;
        if (Math.abs(cam.fov - s.fov) > 1e-4) cam.fov = s.fov;
        const off = cam.projectionOffset;
        if (off.x !== shiftCur.x || off.y !== shiftCur.y) cam.projectionOffset = shiftVec.set(shiftCur.x, shiftCur.y);
        cam.nearClip = clamp(s.dist * 0.015, 0.3, 4);
        // fog follows the zoom: subject stays crisp, far hills melt into the sky
        scene.fog.start = Math.max(320, s.dist * 1.2);
        scene.fog.end = scene.fog.start + 1000;
        // The shadow map covers the bounding sphere of the view-frustum slice [near, shadowDistance]:
        // reach past the target only as far as the view actually shows ground (less when looking down).
        // Shadows fade out over the last 20 % of shadowDistance (cascadeBlend): keep the target and
        // its surroundings in front of that band (matters in the top view, where the ground sits at depth = dist).
        const light = sunEnt.light;
        const sd = clamp(Math.max(s.dist * (1 + 1.2 * Math.cos(Math.max(0, s.el) * DEG)) + 100, (s.dist + 60) / 0.8), 150, 1400);
        light.shadowDistance = sd;
        // normal-offset bias follows the shadow texel size (same sphere estimate PlayCanvas uses)
        const t = Math.tan((s.fov * DEG) / 2), aspect = device.width > 0 && device.height > 0 ? device.width / device.height : 1.6;
        const radius = Math.hypot(sd * t * aspect * (1 + Math.abs(shiftCur.x)), sd * t * (1 + Math.abs(shiftCur.y)), (sd - cam.nearClip) / 2);
        light.normalOffsetBias = clamp((1.6 * radius) / light.shadowResolution, 0.05, 0.6);
    }

    function presetState(name) {
        const w = Math.max(1, canvas.clientWidth || device.width), h = Math.max(1, canvas.clientHeight || device.height);
        const aspect = w / h;
        const portrait = aspect < 1 ? Math.min(1.6, Math.sqrt(1 / aspect)) : 1;
        switch (name) {
            case 'pedestrian': {
                // eye 1.6 m above the sidewalk across the SE intersection (e 31, n -31), looking at the tower
                const eye = core.toEngine(31, -31, 0.15 + 1.6), t = [0, 22, 0];
                const dx = eye[0] - t[0], dy = eye[1] - t[1], dz = eye[2] - t[2];
                const d = Math.hypot(dx, dy, dz);
                return { tx: t[0], ty: t[1], tz: t[2], az: Math.atan2(dx, -dz) / DEG, el: Math.asin(dy / d) / DEG, dist: d, fov: 70 };
            }
            case 'top': {
                const half = 110; // ~220 m across the shorter screen side
                const d = half / (Math.tan(FOV * DEG / 2) * Math.min(1, aspect));
                return { tx: 0, ty: 0, tz: 0, az: 180, el: EL_MAX, dist: d, fov: FOV };
            }
            case 'north':
                return { tx: 0, ty: 15, tz: 0, az: 0, el: 18, dist: 170 * portrait, fov: FOV };
            case 'aerial':
            default:
                return { tx: 0, ty: 18, tz: 0, az: 150, el: 32, dist: 240 * portrait, fov: FOV };
        }
    }

    function setView(name) {
        const to = presetState(name);
        // presets bypass the generic limits (pedestrian dist/elevation are deliberate)
        if (reducedMotion()) {
            tween = null;
            Object.assign(cur, to); Object.assign(goal, to);
            applyCamera(cur);
            return;
        }
        const from = Object.assign({}, cur);
        to.az = from.az + ((((to.az - from.az) % 360) + 540) % 360 - 180); // shortest way round
        tween = { from, to, t0: performance.now(), dur: 700 };
    }
    function stepTween() {
        if (!tween) return false;
        const t = clamp((performance.now() - tween.t0) / tween.dur, 0, 1);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        const f = tween.from, g = tween.to, L = (a, b) => a + (b - a) * e;
        Object.assign(cur, {
            tx: L(f.tx, g.tx), ty: L(f.ty, g.ty), tz: L(f.tz, g.tz),
            az: L(f.az, g.az), el: L(f.el, g.el), fov: L(f.fov, g.fov),
            dist: f.dist * Math.pow(g.dist / f.dist, e), // geometric: zoom feels even
        });
        Object.assign(goal, cur);
        if (t >= 1) tween = null;
        return true;
    }
    function cancelTween() {
        if (!tween) return;
        tween = null;
        Object.assign(goal, cur);
    }

    function updateCamera(dt) {
        stepShift(dt);
        if (!stepTween()) {
            constrain(goal);
            const k = reducedMotion() ? 1 : 1 - Math.exp(-dt * 14);
            for (const key of ['tx', 'ty', 'tz', 'az', 'el', 'dist', 'fov']) {
                const d = goal[key] - cur[key];
                cur[key] = Math.abs(d) < 1e-5 ? goal[key] : cur[key] + d * k;
            }
        }
        applyCamera(keepOutOfMass(cur)); // also covers tweens and a mass that just grew around the eye
    }

    // ---- input (pointer events; the UI's own click handling is never blocked) ----
    if (!canvas.style.touchAction) canvas.style.touchAction = 'none';
    const pointers = new Map();
    let drag = null;   // { mode: 'orbit' | 'pan' }
    let pinch = null;  // { span, mx, my }
    const viewH = () => Math.max(1, canvas.clientHeight || 1);
    function orbitBy(dx, dy) {
        goal.az += dx * 0.3;
        goal.el = goal.el + dy * 0.25;
    }
    function panBy(dx, dy) {
        // ground-plane ("map") panning: the ground under the cursor follows it
        const s = (2 * cur.dist * Math.tan(cur.fov * DEG / 2)) / viewH();
        const h = (cur.az + 180) * DEG;
        const fx = Math.sin(h), fz = -Math.cos(h);       // horizontal forward
        const rx = Math.cos(h), rz = Math.sin(h);        // horizontal right
        const sv = s / Math.max(0.35, Math.sin(Math.max(cur.el, 0) * DEG));
        goal.tx += -rx * dx * s + fx * dy * sv;
        goal.tz += -rz * dx * s + fz * dy * sv;
    }
    function zoomBy(factor) { goal.dist = clamp(goal.dist * factor, DIST_MIN, DIST_MAX); }
    function pinchState() {
        const [a, b] = [...pointers.values()];
        return { span: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    }
    function onPointerDown(e) {
        cancelTween();
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
        if (pointers.size === 1) {
            const pan = e.button === 2 || e.button === 1 || e.shiftKey;
            drag = { mode: pan ? 'pan' : 'orbit' };
            pinch = null;
        } else if (pointers.size === 2) {
            drag = null;
            pinch = pinchState();
        }
    }
    function onPointerMove(e) {
        const p = pointers.get(e.pointerId);
        if (!p) return;
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        p.x = e.clientX; p.y = e.clientY;
        if (pointers.size === 1 && drag) {
            if (drag.mode === 'pan' || e.shiftKey && e.pointerType === 'mouse' && (e.buttons & 1)) panBy(dx, dy);
            else orbitBy(dx, dy);
        } else if (pointers.size === 2 && pinch) {
            const s = pinchState();
            if (s.span > 1 && pinch.span > 1) zoomBy(pinch.span / s.span);
            panBy(s.mx - pinch.mx, s.my - pinch.my);
            pinch = s;
        }
    }
    function onPointerUp(e) {
        if (!pointers.delete(e.pointerId)) return;
        if (pointers.size === 1) { drag = { mode: 'orbit' }; pinch = null; }  // remaining finger orbits
        else if (pointers.size === 0) { drag = null; pinch = null; }
        else if (pointers.size === 2) pinch = pinchState();
    }
    function onWheel(e) {
        e.preventDefault(); // keep the page from scrolling / zooming
        cancelTween();
        let d = e.deltaY;
        if (e.deltaMode === 1) d *= 16; else if (e.deltaMode === 2) d *= 100;
        zoomBy(Math.exp(clamp(d, -300, 300) * 0.0015));
    }
    const onContextMenu = (e) => e.preventDefault(); // right-drag pans
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('lostpointercapture', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);

    // ---------- frame loop hooks ----------
    let firstFrameResolve = null, framesRendered = 0;
    app.on('update', (dt) => updateCamera(dt));
    app.on('frameend', () => {
        framesRendered++;
        if (firstFrameResolve && framesRendered >= 2) { const f = firstFrameResolve; firstFrameResolve = null; f(); }
    });

    // ---------- resize ----------
    function resize() {
        const r = dpr();
        if (device.maxPixelRatio !== r) device.maxPixelRatio = r;
        if (canvas.clientWidth > 0 && canvas.clientHeight > 0) app.updateCanvasSize();
        measureShift();
    }
    let ro = null;
    if (window.ResizeObserver) {
        ro = new ResizeObserver(resize);
        ro.observe(canvas.parentElement || canvas);
        if (canvas.parentElement) ro.observe(canvas);
        if (panelEl) ro.observe(panelEl); // phone sheet expand/collapse, panel width changes
    }
    window.addEventListener('resize', resize);

    // ---------- adapter ----------
    let started = false;
    const adapter = {
        engineName: 'PlayCanvas',
        engineVersion: String(pc.version || ''),

        async init() {
            resize();
            const ctx = core.buildContext();
            const add = (name, g, mat, o, prim) => { const e = addEntity(name, makeMesh(g, prim), mat, o); allEntities.push(e); return e; };
            layers.terrain.push(add('terrain', ctx.terrain, MAT.terrain, {}));
            add('asphalt', ctx.asphalt, MAT.asphalt, { receive: true });
            add('platforms', ctx.platforms, MAT.platform, { receive: true });
            add('parks', ctx.parks, MAT.park, { receive: true });
            add('markingsYellow', ctx.markingsYellow, MAT.markYellow, { receive: true });
            add('markingsWhite', ctx.markingsWhite, MAT.markWhite, { receive: true });
            add('siteFill', ctx.siteFill, MAT.siteFill, { receive: true });
            add('parcelLines', lineGeometry(ctx.parcelLines), MAT.parcel, {}, pc.PRIMITIVE_LINES);
            add('siteBoundary', bandGeometry(ctx.siteOutline, 0.8, 0.01), MAT.siteLine, {});
            layers.context.push(add('buildings', ctx.buildings, MAT.building, { cast: true, receive: true }));
            layers.trees.push(add('trunks', ctx.trunks, MAT.trunk, { cast: true, receive: true }));
            layers.trees.push(add('crowns', ctx.crowns, MAT.crown, { cast: true, receive: true }));

            // default sun + mass so every shader variant exists before the first frame
            const s0 = core.SUN_PRESETS.winter;
            const p0 = core.solarPosition({ month: s0.month, day: s0.day, hour: 12.5 });
            setSun({ vector: core.sunVector(p0.altitude, p0.azimuth), altitude: p0.altitude, azimuth: p0.azimuth });
            if (!currentMass) setMass(core.buildMainMass());
            const a = presetState('aerial');
            Object.assign(cur, a); Object.assign(goal, a);
            measureShift();
            stepShift(0, true);
            applyCamera(cur);

            const first = new Promise((resolve) => { firstFrameResolve = resolve; });
            if (!started) { started = true; app.start(); }
            await first;
        },

        setMass,
        setSun,
        setView,

        setLayer(name, visible) {
            const v = !!visible;
            if (name === 'shadows') { shadowsOn = v; applyShadowState(); return; }
            const list = layers[name];
            if (!list) return;
            for (const e of list) e.enabled = v;
        },

        setHighlight,

        screenToRay(clientX, clientY) {
            const rect = canvas.getBoundingClientRect();
            const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
            const nx = ((clientX - rect.left) / w) * 2 - 1;
            const ny = 1 - ((clientY - rect.top) / h) * 2;
            const cam = camEnt.camera;
            // the projection uses the drawing-buffer aspect (canvas px); fall back to the CSS box
            const aspect = device.width > 0 && device.height > 0 ? device.width / device.height : w / h;
            const t = Math.tan((cam.fov * DEG) / 2);
            const off = cam.projectionOffset; // lens shift (see measureShift): NDC x = proj - offset
            const local = new pc.Vec3((nx + off.x) * t * aspect, (ny + off.y) * t, -1);
            const d = camEnt.getRotation().transformVector(local, new pc.Vec3()).normalize();
            const o = camEnt.getPosition();
            return { origin: [o.x, o.y, o.z], dir: [d.x, d.y, d.z] };
        },

        cameraHeading() {
            // direction the camera looks toward: opposite of its position azimuth
            return (((cur.az + 180) % 360) + 360) % 360;
        },

        stats() {
            let tris = 0;
            for (const e of allEntities.concat(massEntity ? [massEntity] : [])) {
                if (!e.enabled || !e.render) continue;
                for (const mi of e.render.meshInstances) {
                    if (!mi.visibleThisFrame) continue;
                    const prim = mi.mesh && mi.mesh.primitive[0];
                    if (prim && prim.type === pc.PRIMITIVE_TRIANGLES) tris += prim.count / 3;
                }
            }
            const st = app.stats;
            return { fps: st.frame.fps, drawCalls: st.drawCalls.total, triangles: tris };
        },

        dispose() {
            canvas.removeEventListener('pointerdown', onPointerDown);
            canvas.removeEventListener('pointermove', onPointerMove);
            canvas.removeEventListener('pointerup', onPointerUp);
            canvas.removeEventListener('pointercancel', onPointerUp);
            canvas.removeEventListener('lostpointercapture', onPointerUp);
            canvas.removeEventListener('wheel', onWheel);
            canvas.removeEventListener('contextmenu', onContextMenu);
            window.removeEventListener('resize', resize);
            if (ro) ro.disconnect();
            app.destroy();
        },

        // debug handles (not part of the contract)
        _pc: { app, device, camEnt, sunEnt, fillEnt, materials, cur, goal, massEntity: () => massEntity },
    };
    return adapter;
}

// three.js renderer adapter for the mass-study page (contract: docs/SPEC.md).
// three is ESM-only: the adapter loads build/three.module.js from jsDelivr with a dynamic import (no import
// map, no addons: the orbit controller below is our own, a port of the PlayCanvas page's). The module promise
// is cached on window so a second adapter (or a retry after dispose) reuses the same three instance.
// SITE_CORE geometry is already in three's native frame (right-handed, Y-up, x = east, z = -north, CCW front
// faces), so buffers go in unchanged.
// Colour pipeline: hex and vertex colours are linearised here with a 2.2 power law and the patched shaders encode
// with pow 1/2.2 (like PlayCanvas' gamma 2.2), so output = albedo x light level exactly as on the Babylon page;
// lighting runs in linear space, NoToneMapping, outputColorSpace = sRGB (background / fog uniforms only). Light
// levels reproduce the Babylon page's gamma-space model (hemisphere sky 0.70 / walls 0.60, sun
// min(0.62, 0.32/sin alt)) exactly like the PlayCanvas page does; MeshLambertMaterial's BRDF is albedo/PI, so
// every light carries intensity PI. Fog is patched to Babylon's linear *radial* fog (three: smoothstep on depth).
async function createThreeAdapter(canvas, core) {
    'use strict';
    const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js';
    if (!window.__threeModulePromise) {
        window.__threeModulePromise = import(THREE_URL).catch((err) => {
            window.__threeModulePromise = null; // allow a retry
            throw new Error('three.js 모듈을 CDN에서 불러오지 못했습니다 (' + ((err && err.message) || err) + '). 네트워크에서 CDN에 접근할 수 있는지 확인하세요.');
        });
    }
    const THREE = await window.__threeModulePromise;

    const DEG = Math.PI / 180;
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const COLORS = {
        sky: '#dde4ea', asphalt: '#5b5f63', platform: '#d9d6cf', park: '#9fb38a',
        markYellow: '#e2b83b', markWhite: '#f2f2ee', parcel: '#9a968d', siteFill: '#efe6c8',
        siteLine: '#d2352b', building: '#eceae4', trunk: '#6b5a48', crown: '#6f8f5a',
        podium: '#c98d4b', tower: '#d9a35f', slab: '#5a4636', rooftop: '#b9b2a6', highlight: '#2f7de1',
    };
    // Reference lighting in *gamma space* (same numbers as the Babylon / PlayCanvas pages): hemisphere sky colour
    // (up faces) and ground colour; a vertical wall gets their average. Converted to linear in setSun.
    const HEMI = { sky: [0.68, 0.70, 0.73], ground: [0.52, 0.50, 0.47] };
    const EYE_MIN_Y = 1.7;                    // camera never below eye height
    const EL_MAX = 89.9;                      // degrees above horizon (top view)
    const EL_MIN = 2;                         // spec: polar angle <= 88 deg
    const DIST_MIN = 15, DIST_MAX = 900;
    const FOV = 0.8 / DEG;                    // vertical, degrees (0.8 rad, same as the other pages)
    const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    // phones / tablets: smaller shadow map (window size, not window.screen: headless reports 800x600)
    const smallScreen = () => (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
        || Math.min(window.innerWidth || 1e4, window.innerHeight || 1e4) < 560;

    const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    // Pure 2.2 power law both ways (as on the PlayCanvas page), not three's piecewise sRGB curve: the Babylon page
    // multiplies in gamma space (albedo x L), and pow(lin(a) x lin(L), 1/2.2) = a x L holds only for a power law.
    // With the exact sRGB curve dark products (asphalt in shade, dusk) came out up to 6/255 darker.
    // Output encoding: see GAMMA_OUT in the shader patch below. Background / fog colours bypass it (three converts
    // those uniforms to sRGB itself), so they keep exact hex values.
    const lin = (c) => Math.pow(Math.max(0, c), 2.2);
    const srgbColor = (h) => new THREE.Color().setRGB(...hexRgb(h).map(lin)); // hex -> linear (2.2) working values

    // ---------- renderer / scene ----------
    const renderer = new THREE.WebGLRenderer({
        canvas, antialias: true, alpha: false, stencil: false, powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping; // the other pages apply none either (PlayCanvas: linear, exposure 1)
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap; // r186: PCFSoftShadowMap was removed; PCF = HW compare + Vogel disk
    renderer.shadowMap.autoUpdate = false;        // static scene: redraw the shadow map only when sun/mass/layers change
    const dpr = () => Math.min(2, window.devicePixelRatio || 1);
    renderer.setPixelRatio(dpr());

    const scene = new THREE.Scene();
    const SKY_DAY = hexRgb(COLORS.sky);
    scene.background = new THREE.Color().setRGB(...SKY_DAY, THREE.SRGBColorSpace);
    scene.fog = new THREE.Fog(scene.background.clone(), 320, 1320);

    // Babylon's fog: linear in *radial* distance (three: smoothstep over view depth). The view-space position
    // is interpolated and its length taken per fragment: a per-vertex length() would interpolate wrongly across
    // the huge asphalt / platform triangles (hundreds of metres) and fog their middles. Same patch on every
    // material -> identical onBeforeCompile source -> shared program cache key.
    // Also swaps the output encoding (linearToOutputTexel = exact sRGB OETF) for pow 1/2.2, the inverse of lin().
    const GAMMA_OUT = 'gl_FragColor.rgb = pow( max( gl_FragColor.rgb, vec3( 0.0 ) ), vec3( 1.0 / 2.2 ) );';
    function linearRadialFog(shader) {
        shader.fragmentShader = shader.fragmentShader.replace('#include <colorspace_fragment>', GAMMA_OUT);
        shader.vertexShader = shader.vertexShader
            .replace('#include <fog_pars_vertex>', '#include <fog_pars_vertex>\n#ifdef USE_FOG\n\tvarying vec3 vFogViewPos;\n#endif')
            .replace('#include <fog_vertex>', '#include <fog_vertex>\n#ifdef USE_FOG\n\tvFogViewPos = mvPosition.xyz;\n#endif');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <fog_pars_fragment>', '#include <fog_pars_fragment>\n#ifdef USE_FOG\n\tvarying vec3 vFogViewPos;\n#endif')
            .replace('#include <fog_fragment>',
                '#ifdef USE_FOG\n\tgl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, clamp( ( length( vFogViewPos ) - fogNear ) / ( fogFar - fogNear ), 0.0, 1.0 ) );\n#endif');
    }

    // ---------- materials (one shared material per colour) ----------
    const materials = [];
    function makeMaterial(name, hex, opts) {
        const o = opts || {};
        const params = { name };
        if (o.vertexColors) params.vertexColors = true; else params.color = srgbColor(hex);
        const m = o.unlit ? new THREE.MeshBasicMaterial(params) : new THREE.MeshLambertMaterial(params);
        // Decals sit 1-6 cm above the surface below: constant polygon offset only (the slope term grows huge at
        // grazing angles and lets the asphalt bleed over the platforms; same choice as the Babylon page).
        if (o.units) { m.polygonOffset = true; m.polygonOffsetFactor = 0; m.polygonOffsetUnits = o.units; }
        m.onBeforeCompile = linearRadialFog;
        materials.push(m);
        return m;
    }
    const MAT = {
        terrain: makeMaterial('terrain', null, { vertexColors: true }),
        asphalt: makeMaterial('asphalt', COLORS.asphalt, { units: -2 }),   // 6 cm above flat terrain
        platform: makeMaterial('platform', COLORS.platform),
        park: makeMaterial('park', COLORS.park, { units: -4 }),             // 1 cm above platform
        markYellow: makeMaterial('markYellow', COLORS.markYellow, { units: -4 }),
        markWhite: makeMaterial('markWhite', COLORS.markWhite, { units: -4 }),
        siteFill: makeMaterial('siteFill', COLORS.siteFill, { units: -4 }),
        siteLine: makeMaterial('siteLine', COLORS.siteLine, { unlit: true, units: -8 }), // drawn line, not a lit surface
        building: makeMaterial('building', COLORS.building),
        trunk: makeMaterial('trunk', COLORS.trunk),
        crown: makeMaterial('crown', COLORS.crown),
        mass: makeMaterial('mass', null, { vertexColors: true }), // per-vertex: podium/tower/slab/rooftop/highlight
    };
    // Parity with the Babylon page (StandardMaterial clamps the light total at 1 before applying vertex colours)
    // and the PlayCanvas page: the planned mass never renders brighter than its spec colours, so sunlit faces show
    // exactly #c98d4b / #d9a35f. Lambert: direct + indirect = albedo x L per channel, hence
    // min(albedo x L, albedo) = albedo x min(L, 1); L_linear <= 1 <=> L_gamma <= 1.
    MAT.mass.onBeforeCompile = function massLightClamp(shader) {
        linearRadialFog(shader);
        shader.fragmentShader = shader.fragmentShader.replace(
            'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
            'vec3 outgoingLight = min( reflectedLight.directDiffuse + reflectedLight.indirectDiffuse, diffuseColor.rgb ) + totalEmissiveRadiance;');
    };
    const parcelMat = new THREE.LineBasicMaterial({ name: 'parcel', color: srgbColor(COLORS.parcel) });
    parcelMat.onBeforeCompile = linearRadialFog;
    materials.push(parcelMat);

    // ---------- camera ----------
    const camera = new THREE.PerspectiveCamera(FOV, 1.6, 1, 6000);
    camera.rotation.order = 'YXZ';

    // ---------- lights ----------
    // HemisphereLight = Babylon's hemispheric light (mix(ground, sky, 0.5 + 0.5 n.up)); DirectionalLight = sun.
    const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, Math.PI);
    hemi.position.set(0, 1, 0);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, Math.PI);
    sun.castShadow = true;
    const caps = renderer.capabilities.maxTextureSize || 4096;
    const mapSize = Math.min(caps, smallScreen() ? 2048 : 4096);
    sun.shadow.mapSize.set(mapSize, mapSize);
    sun.shadow.radius = 1.5;               // Vogel-disk radius in texels (soft PCF edge)
    scene.add(sun);
    scene.add(sun.target);

    // ---------- geometry helpers ----------
    function srgbToLinearColors(src, nVerts) {
        const stride = src.length / nVerts; // RGBA (terrain) or RGB
        const out = new Float32Array(nVerts * 3);
        for (let i = 0; i < nVerts; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = lin(clamp(src[i * stride + k], 0, 1));
        return out;
    }
    function makeGeometry(g) {
        const geo = new THREE.BufferGeometry();
        const pos = g.positions instanceof Float32Array ? g.positions : new Float32Array(g.positions);
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        if (g.normals && g.normals.length) geo.setAttribute('normal', new THREE.BufferAttribute(g.normals instanceof Float32Array ? g.normals : new Float32Array(g.normals), 3));
        if (g.colorsLinear) geo.setAttribute('color', new THREE.BufferAttribute(g.colorsLinear, 3));
        else if (g.colors) geo.setAttribute('color', new THREE.BufferAttribute(srgbToLinearColors(g.colors, pos.length / 3), 3));
        if (g.indices) geo.setIndex(new THREE.BufferAttribute(pos.length / 3 > 65535 ? new Uint32Array(g.indices) : new Uint16Array(g.indices), 1));
        geo.computeBoundingSphere();
        return geo;
    }
    function addObject(obj, opts) {
        const o = opts || {};
        obj.castShadow = !!o.cast;
        obj.receiveShadow = !!o.receive;
        obj.matrixAutoUpdate = false;  // static: identity world matrix, never recomputed
        obj.updateMatrix();
        scene.add(obj);
        return obj;
    }

    // Flat band (miter-joined, centred on the line) along a closed engine-space polyline: a "thick line" that
    // reads at any distance (WebGL lines are 1 px). Same geometry as the other pages.
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

    // ---------- scene state ----------
    const layers = { context: [], trees: [], terrain: [] };
    let shadowsOn = true, sunUp = true;
    let massMesh = null, massBase = null, massRanges = null, currentMass = null, highlightLevel = null;
    const refreshShadows = () => { renderer.shadowMap.needsUpdate = true; };

    // ---------- planned building: one mesh, per-vertex (linear) colours; highlight = colour-buffer update ----------
    function buildMassData(mass) {
        const rgb = (h) => hexRgb(h).map(lin);
        const C = { podium: rgb(COLORS.podium), tower: rgb(COLORS.tower), slab: rgb(COLORS.slab), rooftop: rgb(COLORS.rooftop) };
        const parts = [];
        for (const f of mass.floors) {
            parts.push({ g: f.slab, c: C.slab, level: f.level });
            parts.push({ g: f.body, c: f.kind === 'podium' ? C.podium : C.tower, level: f.level });
        }
        // roof slab: dark band on its edges like every slab, its top face in the top floor's body colour
        // (same as the other pages) so the mass reads warm orange in the plan view
        const topFloor = mass.floors[mass.floors.length - 1];
        parts.push({ g: mass.roofSlab, c: C.slab, cUp: topFloor && topFloor.kind === 'tower' ? C.tower : C.podium, level: null });
        parts.push({ g: mass.rooftop, c: C.rooftop, level: null });
        let nv = 0, ni = 0;
        for (const p of parts) { nv += p.g.positions.length / 3; ni += p.g.indices.length; }
        const positions = new Float32Array(nv * 3), normals = new Float32Array(nv * 3), colors = new Float32Array(nv * 3);
        const indices = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
        const ranges = new Map();
        let vo = 0, io = 0;
        for (const p of parts) {
            const n = p.g.positions.length / 3;
            positions.set(p.g.positions, vo * 3);
            normals.set(p.g.normals, vo * 3);
            for (let i = 0; i < n; i++) colors.set(p.cUp && p.g.normals[i * 3 + 1] > 0.5 ? p.cUp : p.c, (vo + i) * 3);
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
        const attr = massMesh.geometry.getAttribute('color');
        attr.array.set(massBase);
        const r = highlightLevel != null ? massRanges.get(highlightLevel) : null;
        if (r) {
            const c = hexRgb(COLORS.highlight).map(lin);
            for (let i = r[0]; i < r[1]; i++) attr.array.set(c, i * 3);
        }
        attr.needsUpdate = true;
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
            const b = { x0: Infinity, x1: -Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
            for (const f of fl) {
                for (const [e, n] of f.footprint) {
                    b.x0 = Math.min(b.x0, e); b.x1 = Math.max(b.x1, e);
                    b.z0 = Math.min(b.z0, -n); b.z1 = Math.max(b.z1, -n);
                }
                b.y1 = Math.max(b.y1, f.y1);
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
        const d = buildMassData(mass);
        const geo = makeGeometry({ positions: d.positions, normals: d.normals, colorsLinear: d.colors.slice(), indices: d.indices });
        geo.computeBoundingBox();
        if (massMesh) {
            massMesh.geometry.dispose(); // GPU buffers go; the shared material stays
            massMesh.geometry = geo;
        } else {
            massMesh = new THREE.Mesh(geo, MAT.mass);
            massMesh.name = 'plannedMass';
            massMesh.castShadow = true;
            massMesh.receiveShadow = true;
            massMesh.matrixAutoUpdate = false;
            massMesh.updateMatrix();
            scene.add(massMesh);
        }
        massBase = d.colors;
        massRanges = d.ranges;
        if (highlightLevel != null && !massRanges.has(highlightLevel)) highlightLevel = null;
        if (highlightLevel != null) applyHighlight();
        fitShadowCamera();
        refreshShadows();
    }

    function setHighlight(level) {
        const next = level == null ? null : level;
        if (next === highlightLevel) return;
        highlightLevel = next;
        applyHighlight();
    }

    // ---------- shadow camera: orthographic box fitted to the city in light space ----------
    // Static and view-independent (like the Babylon page's autoUpdateExtends): the box covers the ground of every
    // city block (receivers) and every caster top (context roofs, tree height, the planned mass), so shadows are
    // sharp across the whole city, not only around the site. ~600 x 500 m at 4096 px -> 0.15-0.2 m texels.
    let shadowPts = null;            // flat [x,y,z,...] of the static points (city ground corners + building roofs)
    function collectShadowPoints(ctx) {
        const pts = [];
        const box = new THREE.Box3().setFromArray(ctx.platforms.positions);
        for (const x of [box.min.x - 2, box.max.x + 2]) for (const z of [box.min.z - 2, box.max.z + 2]) for (const y of [0, 12]) pts.push(x, y, z);
        const p = ctx.buildings.positions, nrm = ctx.buildings.normals;
        for (let i = 0; i < p.length; i += 3) if (nrm[i + 1] > 0.5) pts.push(p[i], p[i + 1], p[i + 2]); // roof vertices
        return pts;
    }
    const _v = new THREE.Vector3(), _sunDir = new THREE.Vector3(0, 1, 0);
    function fitShadowCamera() {
        if (!shadowPts) return;
        const D = 1500;
        sun.position.copy(_sunDir).multiplyScalar(D);
        sun.target.position.set(0, 0, 0);
        sun.updateMatrixWorld();
        sun.target.updateMatrixWorld();
        const cam = sun.shadow.camera;
        cam.position.copy(sun.position);
        cam.lookAt(sun.target.position);
        cam.updateMatrixWorld();
        const inv = cam.matrixWorldInverse;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        const take = (x, y, z) => {
            _v.set(x, y, z).applyMatrix4(inv);
            if (_v.x < x0) x0 = _v.x; if (_v.x > x1) x1 = _v.x;
            if (_v.y < y0) y0 = _v.y; if (_v.y > y1) y1 = _v.y;
            if (_v.z < z0) z0 = _v.z; if (_v.z > z1) z1 = _v.z;
        };
        for (let i = 0; i < shadowPts.length; i += 3) take(shadowPts[i], shadowPts[i + 1], shadowPts[i + 2]);
        const bb = massMesh && massMesh.geometry.boundingBox;
        if (bb) for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) take(x, y, z);
        const pad = 1;
        cam.left = x0 - pad; cam.right = x1 + pad; cam.bottom = y0 - pad; cam.top = y1 + pad;
        cam.near = Math.max(0.5, -z1 - 5); cam.far = -z0 + 5;   // view space looks down -Z
        cam.updateProjectionMatrix();
        // Acne vs peter-panning: offset the lookup ~1 texel along the normal (world m) plus a few cm of depth.
        const texel = Math.max(cam.right - cam.left, cam.top - cam.bottom) / mapSize;
        sun.shadow.normalBias = 1.2 * texel;
        sun.shadow.bias = -0.04 / (cam.far - cam.near); // three adds bias to the [0,1] ortho depth
    }

    // ---------- sun ----------
    function applyShadowState() {
        const on = shadowsOn && sunUp;
        if (sun.castShadow !== on) sun.castShadow = on;
        if (on) refreshShadows();
    }
    function setSun(o) {
        const v = o.vector, alt = o.altitude;
        sunUp = alt > 0;
        _sunDir.set(v[0], v[1], v[2]).normalize();
        // Same gamma-space model as the Babylon page, converted so the *rendered* colours match (as on the
        // PlayCanvas page): Babylon shows albedo_srgb x L_gamma; here output = (albedo_lin x L_lin)^(1/2.2), so L_lin = L_gamma^2.2.
        const day = clamp(alt / 6, 0, 1);                        // fade in over the first 6 degrees
        const warm = clamp((alt - 2) / 20, 0, 1);                 // 0 = horizon (warm), 1 = high sun (neutral)
        const tint = [1.0, 0.80 + 0.17 * warm, 0.62 + 0.30 * warm];
        const sinA = Math.max(0.05, Math.sin(Math.max(alt, 0) * DEG));
        const Ib = sunUp ? Math.min(0.62, 0.32 / sinA) * day : 0; // Babylon sun intensity (gamma space)
        const k = 0.42 + 0.58 * clamp(alt / 12, 0, 1);            // dimmer sky at dusk / night
        const up = HEMI.sky.map((c) => c * k), wall = HEMI.sky.map((c, i) => (c + HEMI.ground[i]) / 2 * k);
        // hemisphere: up faces get lin(up), walls (n.up = 0) the average = lin(wall) -> ground = 2 lin(wall) - lin(up)
        hemi.color.setRGB(...up.map(lin));
        hemi.groundColor.setRGB(...up.map((c, i) => Math.max(0, 2 * lin(wall[i]) - lin(c))));
        // sun: exact match on lit horizontal faces, per channel: lin(up + Ib.sin.tint) - lin(up) = sun_lin.sin
        if (sunUp) sun.color.setRGB(...up.map((c, i) => (lin(c + Ib * sinA * tint[i]) - lin(c)) / sinA));
        sun.intensity = sunUp ? Math.PI : 0;
        // background + fog colour follow the daylight so far hills still melt into it at dusk
        const sk = 0.35 + 0.65 * clamp((alt + 4) / 14, 0, 1);
        scene.background.setRGB(...SKY_DAY.map((c) => c * sk), THREE.SRGBColorSpace);
        scene.fog.color.copy(scene.background);
        // unlit parcel lines dim with the sky light
        parcelMat.color.setRGB(...hexRgb(COLORS.parcel).map((c) => lin(c * (0.45 + 0.55 * k))));
        if (sunUp) fitShadowCamera();
        applyShadowState();
    }

    // ---------- camera: orbit / pan / zoom controller (port of the PlayCanvas page's) ----------
    // State: target (tx,ty,tz), az = azimuth of the camera *position* seen from the target
    // (north = 0, clockwise, deg), el = elevation above the target (deg), dist (m), fov (deg).
    const cur = { tx: 0, ty: 18, tz: 0, az: 150, el: 32, dist: 240, fov: FOV };
    const goal = Object.assign({}, cur);
    let tween = null;

    // Ground height the camera must stay above (same rule as the other pages). The terrain mesh is a 25 m grid
    // (core terrainGeometry: half 1100, step 25, centre e 20 / n 6) whose flat triangles sit up to ~6 m above the
    // analytic core.terrainHeight between grid points, so take the highest corner of the grid cell under (e, n).
    function groundUnder(e, n) {
        const G = 25, E0 = 20 - 1100, N0 = 6 - 1100;
        const i = Math.floor((e - E0) / G), j = Math.floor((n - N0) / G);
        let h = core.terrainHeight(e, n);
        for (let di = 0; di <= 1; di++) for (let dj = 0; dj <= 1; dj++) h = Math.max(h, core.terrainHeight(E0 + (i + di) * G, N0 + (j + dj) * G));
        return h;
    }
    function eyeFloor(s) {
        const ce = Math.cos(Math.max(s.el, 0) * DEG);
        const camE = s.tx + s.dist * Math.sin(s.az * DEG) * ce, camN = -(s.tz - s.dist * Math.cos(s.az * DEG) * ce);
        return Math.max(EYE_MIN_Y, groundUnder(camE, camN) + EYE_MIN_Y);
    }
    function minElevation(s) {
        // allow looking up from below the target only while the eye stays above EYE_MIN_Y over the
        // ground under the camera (the outer terrain rises into hills beyond the city blocks)
        const sEye = clamp((eyeFloor(s) - s.ty) / Math.max(s.dist, 1e-3), -1, 1);
        return Math.max(Math.min(EL_MIN, Math.max(-60, Math.asin(sEye) / DEG)), Math.asin(sEye) / DEG);
    }
    function constrain(s) {
        s.dist = clamp(s.dist, DIST_MIN, DIST_MAX);
        s.ty = clamp(s.ty, 0, 300);
        s.tx = clamp(s.tx, -1000, 1000);
        s.tz = clamp(s.tz, -1000, 1000);
        s.el = clamp(s.el, minElevation(s), EL_MAX);
        // target panned out under a hill deeper than the orbit distance: even looking straight down the eye would
        // sit inside the hill, so back the eye out instead (zoom-in stops at the hillside)
        const floorY = eyeFloor(s), sinEl = Math.sin(s.el * DEG);
        if (sinEl > 0.5 && s.ty + s.dist * sinEl < floorY) s.dist = Math.min(DIST_MAX, (floorY - s.ty) / sinEl + 0.01);
        return keepOutOfMass(s);
    }

    // ---- framing: keep the orbit target centred in the part of the canvas the UI panel leaves free ----
    // The UI reports the covered strip through setViewInset({left, bottom}) in CSS px (desktop side panel ->
    // shift right by left/2; phone bottom sheet -> shift up by bottom/2). Lens shift via setViewOffset
    // (off-axis projection), so the eye, heading, elevation and picking rays stay exactly as the presets say.
    const inset = { left: 0, bottom: 0 };
    const shiftGoal = { x: 0, y: 0 }, shiftCur = { x: 0, y: 0 };   // CSS px, +x = right, +y = up
    const viewW = () => Math.max(1, canvas.clientWidth || 1), viewH = () => Math.max(1, canvas.clientHeight || 1);
    function measureShift() {
        shiftGoal.x = clamp(inset.left, 0, viewW() * 0.5) / 2;
        shiftGoal.y = clamp(inset.bottom, 0, viewH() * 0.8) / 2;
    }
    function stepShift(dt, instant) {
        const k = instant || reducedMotion() ? 1 : 1 - Math.exp(-dt * 10);
        for (const a of ['x', 'y']) {
            const d = shiftGoal[a] - shiftCur[a];
            shiftCur[a] = Math.abs(d) < 0.05 ? shiftGoal[a] : shiftCur[a] + d * k;
        }
    }

    const proj = { w: 0, h: 0, sx: NaN, sy: NaN, fov: NaN, near: NaN };
    function applyCamera(s) {
        const az = s.az * DEG, el = s.el * DEG;
        const ce = Math.cos(el);
        camera.position.set(s.tx + s.dist * Math.sin(az) * ce, s.ty + s.dist * Math.sin(el), s.tz - s.dist * Math.cos(az) * ce);
        // look along heading h = az + 180: yaw about +Y by -h, then pitch down by el about local X (order YXZ)
        camera.rotation.set(-el, -(s.az + 180) * DEG, 0, 'YXZ');
        camera.updateMatrixWorld();
        const near = clamp(s.dist * 0.015, 0.3, 4);
        const w = viewW(), h = viewH();
        if (w !== proj.w || h !== proj.h || shiftCur.x !== proj.sx || shiftCur.y !== proj.sy || s.fov !== proj.fov || near !== proj.near) {
            Object.assign(proj, { w, h, sx: shiftCur.x, sy: shiftCur.y, fov: s.fov, near });
            camera.fov = s.fov;
            camera.near = near;
            camera.setViewOffset(w, h, -shiftCur.x, shiftCur.y, w, h); // sets aspect = w/h, updates the projection
        }
        // fog follows the zoom: subject stays crisp, far hills melt into the sky (same rule as the other pages)
        scene.fog.near = Math.max(320, s.dist * 1.2);
        scene.fog.far = scene.fog.near + 1000;
    }

    function presetState(name) {
        const w = viewW(), h = viewH();
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
                // near-orthographic plan (same as the other pages): long lens from 600 m (850 m portrait) so
                // walls barely lean; ~220 m across the shorter screen side
                const half = 110, d = aspect >= 1 ? 600 : 850;
                const fov = 2 * Math.atan(half / (d * Math.min(1, aspect))) / DEG;
                return { tx: 0, ty: 0, tz: 0, az: 180, el: EL_MAX, dist: d, fov };
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

    // ---------- resize ----------
    let sizeKey = '';
    function resize() {
        const w = canvas.clientWidth, h = canvas.clientHeight, r = dpr();
        if (w > 0 && h > 0) {
            const key = w + 'x' + h + '@' + r;
            if (key !== sizeKey) {
                sizeKey = key;
                if (renderer.getPixelRatio() !== r) renderer.setPixelRatio(r);
                renderer.setSize(w, h, false); // the page's CSS owns the canvas box
            }
        }
        measureShift();
    }
    let ro = null;
    if (window.ResizeObserver) {
        ro = new ResizeObserver(resize);
        ro.observe(canvas.parentElement || canvas);
        if (canvas.parentElement) ro.observe(canvas);
    }
    window.addEventListener('resize', resize);

    // ---------- frame loop ----------
    let firstFrameResolve = null, framesRendered = 0, lastT = 0, running = false;
    const frameStats = { drawCalls: 0, triangles: 0, fps: 0 };
    let fpsT0 = 0, fpsFrames = 0;
    function frame(t) {
        const dt = lastT ? clamp((t - lastT) / 1000, 0, 0.1) : 1 / 60;
        lastT = t;
        resize();
        updateCamera(dt);
        renderer.render(scene, camera);
        const info = renderer.info.render;
        frameStats.drawCalls = info.calls;
        frameStats.triangles = info.triangles;
        fpsFrames++;
        if (!fpsT0) fpsT0 = t;
        else if (t - fpsT0 >= 500) { frameStats.fps = (fpsFrames * 1000) / (t - fpsT0); fpsT0 = t; fpsFrames = 0; }
        framesRendered++;
        if (firstFrameResolve && framesRendered >= 2) { const f = firstFrameResolve; firstFrameResolve = null; f(); }
    }

    // ---------- adapter ----------
    const adapter = {
        engineName: 'three.js',
        engineVersion: 'r' + THREE.REVISION,

        async init() {
            resize();
            const ctx = core.buildContext();
            const mesh = (name, g, mat, o) => { const m = new THREE.Mesh(makeGeometry(g), mat); m.name = name; return addObject(m, o); };
            layers.terrain.push(mesh('terrain', ctx.terrain, MAT.terrain, {}));
            mesh('asphalt', ctx.asphalt, MAT.asphalt, { receive: true });
            mesh('platforms', ctx.platforms, MAT.platform, { receive: true });
            mesh('parks', ctx.parks, MAT.park, { receive: true });
            mesh('markingsYellow', ctx.markingsYellow, MAT.markYellow, { receive: true });
            mesh('markingsWhite', ctx.markingsWhite, MAT.markWhite, { receive: true });
            mesh('siteFill', ctx.siteFill, MAT.siteFill, { receive: true });
            mesh('siteBoundary', bandGeometry(ctx.siteOutline, 0.8, 0.01), MAT.siteLine, {});
            layers.context.push(mesh('buildings', ctx.buildings, MAT.building, { cast: true, receive: true }));
            layers.trees.push(mesh('trunks', ctx.trunks, MAT.trunk, { cast: true, receive: true }));
            layers.trees.push(mesh('crowns', ctx.crowns, MAT.crown, { cast: true, receive: true }));
            // parcel lines: thin 1 px LineSegments
            const lp = new Float32Array(ctx.parcelLines.length * 6);
            ctx.parcelLines.forEach((s, i) => lp.set(s, i * 6));
            const lgeo = new THREE.BufferGeometry();
            lgeo.setAttribute('position', new THREE.BufferAttribute(lp, 3));
            lgeo.computeBoundingSphere();
            addObject(new THREE.LineSegments(lgeo, parcelMat), {}).name = 'parcelLines';
            shadowPts = collectShadowPoints(ctx);

            // default sun + mass so every shader variant exists before the first frame
            const s0 = core.SUN_PRESETS.winter;
            const p0 = core.solarPosition({ month: s0.month, day: s0.day, hour: 12.5 });
            if (!currentMass) setMass(core.buildMainMass());
            setSun({ vector: core.sunVector(p0.altitude, p0.azimuth), altitude: p0.altitude, azimuth: p0.azimuth });
            const a = presetState('aerial');
            Object.assign(cur, a); Object.assign(goal, a);
            measureShift();
            stepShift(0, true);
            applyCamera(cur);

            // compile every program off the critical path where KHR_parallel_shader_compile exists
            // (without it compileAsync only warns and polls: the first render compiles instead)
            if (renderer.extensions.has('KHR_parallel_shader_compile')) {
                try { await renderer.compileAsync(scene, camera); } catch (err) { /* compile-on-render */ }
            }
            const first = new Promise((resolve) => { firstFrameResolve = resolve; });
            if (!running) { running = true; renderer.setAnimationLoop(frame); }
            await first;
        },

        setMass,
        setSun,
        setView,

        setViewInset(o) {
            inset.left = Math.max(0, Number(o && o.left) || 0);
            inset.bottom = Math.max(0, Number(o && o.bottom) || 0);
            measureShift();
        },

        setLayer(name, visible) {
            const v = !!visible;
            if (name === 'shadows') { shadowsOn = v; applyShadowState(); return; }
            const list = layers[name];
            if (!list) return;
            for (const m of list) m.visible = v;
            if (name !== 'terrain') refreshShadows(); // casters changed
        },

        setHighlight,

        screenToRay(clientX, clientY) {
            const rect = canvas.getBoundingClientRect();
            const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
            const ndc = new THREE.Vector3(((clientX - rect.left) / w) * 2 - 1, 1 - ((clientY - rect.top) / h) * 2, 0.5);
            camera.updateMatrixWorld();
            // projectionMatrixInverse includes the lens shift (setViewOffset), so the ray matches the image
            const o = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
            const d = ndc.unproject(camera).sub(o).normalize();
            return { origin: [o.x, o.y, o.z], dir: [d.x, d.y, d.z] };
        },

        cameraHeading() {
            // direction the camera looks toward: opposite of its position azimuth
            return (((cur.az + 180) % 360) + 360) % 360;
        },

        stats() {
            // renderer.info of the last frame (a frame that redrew the shadow map also counts its caster draws)
            return { fps: Math.round(frameStats.fps * 10) / 10, drawCalls: frameStats.drawCalls, triangles: frameStats.triangles };
        },

        dispose() {
            running = false;
            renderer.setAnimationLoop(null);
            canvas.removeEventListener('pointerdown', onPointerDown);
            canvas.removeEventListener('pointermove', onPointerMove);
            canvas.removeEventListener('pointerup', onPointerUp);
            canvas.removeEventListener('pointercancel', onPointerUp);
            canvas.removeEventListener('lostpointercapture', onPointerUp);
            canvas.removeEventListener('wheel', onWheel);
            canvas.removeEventListener('contextmenu', onContextMenu);
            window.removeEventListener('resize', resize);
            if (ro) ro.disconnect();
            scene.traverse((obj) => { if (obj.geometry) obj.geometry.dispose(); });
            for (const m of materials) m.dispose();
            sun.shadow.dispose();
            scene.clear();
            renderer.dispose();
            if (firstFrameResolve) { const f = firstFrameResolve; firstFrameResolve = null; f(); }
        },

        // debug handles (not part of the contract)
        _three: { THREE, renderer, scene, camera, sun, hemi, materials, cur, goal, massMesh: () => massMesh },
    };
    return adapter;
}

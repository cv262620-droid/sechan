// MAP view — MapLibre GL JS 5.24.0, loaded from jsDelivr the first time the tab is activated.
// No basemap: the style is built inline (background + GeoJSON sources only; no glyphs, sprite or
// tiles, so the map never fetches anything). Context = STUDIO_CORE.geojson() (synthetic city);
// overlays = the store's adopted site revision (red line) and draft (dashed line).
// Lon/lat are display-only reference values (STUDIO_CORE.toLonLat); nothing is measured in degrees.
//
// createMapView(container, store, ctx) → {
//   activate(): Promise   first call loads MapLibre, builds the map, fits it to the adopted site,
//                         resolves after the first 'idle'; later calls resize and re-sync, keep camera
//   deactivate()          stops camera animation and hover work; store/theme changes wait for activate
//   dispose()             map.remove(), unsubscribes, removes DOM
//   fit(animate?)         fit to the adopted site
//   setMode('2d'|'2.5d'), getMode()   building display (fill ↔ fill-extrusion + pitch)
//   map, loadMs           (getters, for tests)
// }
// ctx: { onStatus?(text, kind: 'loading'|'ready'|'error'), isMobile?: boolean | () => boolean }
function createMapView(container, store, ctx) {
    'use strict';
    ctx = ctx || {};
    const CORE = STUDIO_CORE;
    const LIB_URL = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js';
    const LOAD_TIMEOUT_MS = 45000;
    const FIT_MAX_ZOOM = 18.6;
    const PITCH_25D = 55, ZOOM_25D = 18.1;
    const ORIGIN = (CORE.GEO && CORE.GEO.origin) || { lat: 37.5665, lon: 126.978 };
    const isMobile = () => (typeof ctx.isMobile === 'function' ? !!ctx.isMobile() : !!ctx.isMobile);
    const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const status = (text, kind) => { try { if (ctx.onStatus) ctx.onStatus(text, kind); } catch (e) { /* status is cosmetic */ } };

    // Light/dark defaults; each key can be overridden by a CSS custom property (first token found wins).
    const PALETTE = {
        light: {
            bg: '#e4e3dd', road: '#f8f8f5', block: '#dbd9d1', park: '#c8d7bb', parcel: '#9d9b93', hover: '#2560c4',
            building: '#b9b6ad', buildingLine: '#8a877f', buildingHover: '#9fb2d8', extrusion: '#c3c0b7',
            site: '#d0241a', draft: '#1e2226', select: '#2560c4', vertex: '#ffffff',
        },
        dark: {
            bg: '#111316', road: '#2b3035', block: '#1b1f23', park: '#1c2a20', parcel: '#4c555d', hover: '#77a6ef',
            building: '#363c43', buildingLine: '#59616a', buildingHover: '#40597f', extrusion: '#4b525a',
            site: '#ff5a4e', draft: '#ecece7', select: '#77a6ef', vertex: '#1b1e21',
        },
    };
    const TOKENS = {
        bg: ['--map-bg'], road: ['--map-road'], block: ['--map-block'], park: ['--map-park'], parcel: ['--map-parcel'],
        hover: ['--map-hover', '--accent'], building: ['--map-building'], buildingLine: ['--map-building-line'],
        buildingHover: ['--map-building-hover'], extrusion: ['--map-extrusion'], site: ['--map-site'],
        draft: ['--map-draft'], select: ['--map-select', '--accent'], vertex: ['--map-vertex'],
    };

    let map = null, lib = null, loaded = false, active = false, disposed = false;
    let mode = '2d';
    let bootPromise = null, wakeBoot = null, loadMs = null;
    let unsubscribe = null, ro = null, mo = null, mq = null, hoverRaf = 0, hoverPoint = null;
    let siteMarker = null, siteMarkerOn = false, labelGeo = null, palette = null, paletteKey = '';
    let storeDirty = true, themeDirty = true;
    const last = { site: null, draft: null, sel: null, layers: null };
    const selected = { parcels: [], buildings: [] };
    let siteSelected = false, hover = null;
    let probeCtx = null, modeBtns = null;   // declared before the constructor code below uses them

    injectStyleOnce();

    // ---------- DOM ----------
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    const root = el('div', 'mv-root');
    const mapDiv = el('div', 'mv-map');
    const chip = el('div', 'mv-chip');
    chip.setAttribute('role', 'note');
    const o = ORIGIN;
    chip.innerHTML =
        '<div><b class="mv-badge">SYNTHETIC</b>합성 데이터 · 배경지도 없음(아티팩트 보안 정책)</div>' +
        `<div>기준점 ${o.lat.toFixed(4)}N ${o.lon.toFixed(4)}E는 실제 필지와 무관</div>` +
        '<div class="mv-legend"><span><i class="lg-site"></i>채택 대지</span><span><i class="lg-draft"></i>초안</span>' +
        '<span><i class="lg-bldg"></i>주변 건물 · 높이 ASSUMED</span></div>';
    const msg = el('div', 'mv-msg');
    msg.hidden = true;
    root.append(mapDiv, chip, msg);
    if (isMobile()) root.classList.add('mv-mobile');
    container.appendChild(root);

    // ---------- static context data (synthetic) ----------
    const gj = CORE.geojson() || {};
    const ctxData = {
        roads: indexed(gj.roads), blocks: indexed(gj.blocks), parks: indexed(gj.parks),
        parcels: indexed(gj.parcels), buildings: indexed(gj.buildings),
    };
    const maxBounds = boundsOfCollections([gj.roads, gj.blocks, gj.parcels, gj.buildings], 1.0);

    // ---------- store subscription ----------
    unsubscribe = store.subscribe(() => {
        storeDirty = true;
        if (active && loaded) sync();
    });

    // ---------- theme ----------
    const onTheme = () => {
        themeDirty = true;
        if (active && loaded) sync();
        else updateChrome(readPalette());
    };
    if (window.matchMedia) {
        mq = window.matchMedia('(prefers-color-scheme: dark)');
        if (mq.addEventListener) mq.addEventListener('change', onTheme); else if (mq.addListener) mq.addListener(onTheme);
    }
    if (window.MutationObserver) {
        mo = new MutationObserver(onTheme);
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
        if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    }
    updateChrome(readPalette());

    // ---------- size ----------
    const onResize = () => {
        root.classList.toggle('mv-narrow', root.clientWidth > 0 && root.clientWidth < 560);
        if (active && map && mapDiv.clientWidth > 0 && mapDiv.clientHeight > 0) map.resize();
    };
    if (window.ResizeObserver) { ro = new ResizeObserver(onResize); ro.observe(root); }
    else window.addEventListener('resize', onResize);

    // ================= lifecycle =================
    function activate() {
        if (disposed) return Promise.reject(new Error('map view disposed'));
        active = true;
        if (wakeBoot) { const w = wakeBoot; wakeBoot = null; w(); }
        if (map && loaded) {
            onResize();
            map.resize();
            sync();
            return Promise.resolve();
        }
        if (!bootPromise) {
            bootPromise = boot().catch((err) => {
                bootPromise = null;
                if (map && !loaded) { try { map.remove(); } catch (e) { /* half-built */ } map = null; }
                if (disposed) throw err;
                showError(err);
                status('MAP: ' + errorText(err), 'error');
                throw err;
            });
        }
        return bootPromise;
    }

    function deactivate() {
        active = false;
        if (hoverRaf) { cancelAnimationFrame(hoverRaf); hoverRaf = 0; }
        hoverPoint = null;
        if (map) {
            map.stop();
            if (loaded) setHover(null);
            map.getCanvas().style.cursor = '';
        }
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        deactivate();
        if (unsubscribe) { try { unsubscribe(); } catch (e) { /* ignore */ } unsubscribe = null; }
        if (mq) { if (mq.removeEventListener) mq.removeEventListener('change', onTheme); else if (mq.removeListener) mq.removeListener(onTheme); }
        if (mo) mo.disconnect();
        if (ro) ro.disconnect(); else window.removeEventListener('resize', onResize);
        if (siteMarker) { siteMarker.remove(); siteMarker = null; siteMarkerOn = false; }
        if (map) { try { map.remove(); } catch (e) { /* already gone */ } map = null; }
        loaded = false;
        root.remove();
    }

    async function boot() {
        const t0 = performance.now();
        if (!window.maplibregl) {
            showMessage('지도 라이브러리 불러오는 중…', 'MapLibre GL JS 5.24.0 · 처음 한 번만 받습니다');
            status('MAP: MapLibre 5.24.0 불러오는 중…', 'loading');
        }
        lib = await ensureLib();
        if (disposed) throw new Error('map view disposed');
        if (!active) await new Promise((r) => { wakeBoot = r; });   // tab left while loading → build on return
        await waitForSize();
        if (disposed) throw new Error('map view disposed');
        showMessage('지도 준비 중…', '합성 도로·필지·주변 건물 배치');
        createMap();
        await new Promise((resolve, reject) => {
            const onErr = (e) => { if (!loaded) reject((e && e.error) || new Error('지도 스타일을 불러오지 못했습니다')); };
            map.once('error', onErr);
            map.once('load', () => { map.off('error', onErr); resolve(); });
        });
        onLoad();
        await whenIdle(8000);
        if (disposed) return;
        loadMs = Math.round(performance.now() - t0);
        hideMessage();
        status(`MAP 준비 · ${loadMs} ms · 합성 데이터, 배경지도 없음`, 'ready');
    }

    function ensureLib() {
        if (window.maplibregl && window.maplibregl.Map) return Promise.resolve(window.maplibregl);
        let timer = 0;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('MapLibre 스크립트 응답 없음(시간 초과)')), LOAD_TIMEOUT_MS);
        });
        return Promise.race([loadScript(LIB_URL), timeout]).then(() => {
            clearTimeout(timer);
            if (!window.maplibregl || !window.maplibregl.Map) throw new Error('지도 라이브러리를 받았지만 maplibregl 객체가 없습니다');
            return window.maplibregl;
        }, (err) => {
            clearTimeout(timer);
            const e = new Error('지도 라이브러리(MapLibre GL JS 5.24.0)를 cdn.jsdelivr.net에서 받지 못했습니다');
            e.cause = err;
            throw e;
        });
    }

    function waitForSize() {
        return new Promise((resolve) => {
            let n = 0;
            const tick = () => {
                if (disposed || (mapDiv.clientWidth > 0 && mapDiv.clientHeight > 0) || ++n > 30) resolve();
                else requestAnimationFrame(tick);
            };
            tick();
        });
    }

    function whenIdle(ms) {
        return new Promise((resolve) => {
            let done = false;
            const fin = () => { if (!done) { done = true; resolve(); } };
            map.once('idle', fin);
            setTimeout(fin, ms);
        });
    }

    // ================= map construction =================
    function createMap() {
        const s = store.getState();
        palette = readPalette();
        paletteKey = JSON.stringify(palette);
        themeDirty = false;
        const rev = currentRevision(s);
        const w = mapDiv.clientWidth || 800, h = mapDiv.clientHeight || 600;
        const opts = {
            container: mapDiv,
            style: buildStyle(s),
            minZoom: 14.5, maxZoom: 21.5,
            pitch: mode === '2.5d' ? PITCH_25D : 0, maxPitch: mode === '2.5d' ? 70 : 0,
            attributionControl: false, maplibreLogo: false,
            trackResize: false, renderWorldCopies: false, fadeDuration: 0,
            boxZoom: false, dragRotate: true, pitchWithRotate: true,
            canvasContextAttributes: { antialias: true },
            locale: {
                'Map.Title': '합성 지도', 'Marker.Title': '표식',
                'NavigationControl.ZoomIn': '확대', 'NavigationControl.ZoomOut': '축소',
                'NavigationControl.ResetBearing': '드래그로 회전, 클릭하면 북쪽을 위로',
                'ScaleControl.Meters': 'm', 'ScaleControl.Kilometers': 'km',
            },
        };
        if (maxBounds) opts.maxBounds = maxBounds;
        const b = rev ? polyBounds(rev.polygon) : null;
        if (b) { opts.bounds = b; opts.fitBoundsOptions = { padding: fitPadding(w, h), maxZoom: FIT_MAX_ZOOM }; }
        else { opts.center = [ORIGIN.lon, ORIGIN.lat]; opts.zoom = 17; }
        try {
            map = new lib.Map(opts);
        } catch (err) {
            map = null;
            throw new Error('WebGL을 쓸 수 없어 지도를 만들지 못했습니다 (' + errorText(err) + ')');
        }
        map.on('error', (e) => {
            const err = e && e.error;
            console.error('[MAP]', (err && err.message) || err);
        });
        map.addControl(new lib.NavigationControl({ visualizePitch: true }), 'top-right');
        map.addControl(modeControl(), 'top-right');
        map.addControl(new lib.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');
    }

    function onLoad() {
        loaded = true;
        map.on('click', onClick);
        map.on('mousemove', onMouseMove);
        map.on('mouseout', onMouseOut);
        map.on('zoom', placeSiteLabel);
        map.on('pitchend', placeSiteLabel);
        storeDirty = true;
        sync();
    }

    function buildStyle(s) {
        const P = palette, paint = paints(P);
        const L = s.layers || {};
        const on = (k) => L[k] !== false;
        const ctxOn = on('context');
        const src = (data) => ({ type: 'geojson', data, tolerance: 0.2 });
        const isPoly = ['==', ['geometry-type'], 'Polygon'];
        const layer = (id, type, source, extra) => Object.assign({ id, type, source, paint: paint[id] }, extra || {});
        const vis = (v) => ({ layout: { visibility: v ? 'visible' : 'none' } });
        const rev = currentRevision(s);
        last.site = siteKey(rev);
        const d = s.site && s.site.draft;
        last.draft = draftKey(d);
        return {
            version: 8,
            name: 'OHSOLV synthetic context (no basemap)',
            sources: {
                roads: src(ctxData.roads.fc), blocks: src(ctxData.blocks.fc), parks: src(ctxData.parks.fc),
                parcels: src(ctxData.parcels.fc), buildings: src(ctxData.buildings.fc),
                site: src(siteFC(rev)), draft: src(draftFC(d)),
            },
            layers: [
                { id: 'bg', type: 'background', paint: paint.bg },
                layer('roads', 'fill', 'roads', vis(on('roads'))),
                layer('blocks', 'fill', 'blocks'),
                layer('parks', 'fill', 'parks'),
                layer('parcels-fill', 'fill', 'parcels', vis(on('parcels'))),
                layer('parcels-line', 'line', 'parcels', vis(on('parcels'))),
                layer('bldg-fill', 'fill', 'buildings', vis(ctxOn && mode === '2d')),
                layer('bldg-line', 'line', 'buildings', vis(ctxOn && mode === '2d')),
                layer('site-fill', 'fill', 'site', vis(on('boundary'))),
                layer('site-line', 'line', 'site', { layout: { visibility: on('boundary') ? 'visible' : 'none', 'line-join': 'miter' } }),
                layer('draft-fill', 'fill', 'draft', { filter: isPoly }),
                layer('draft-line', 'line', 'draft', { filter: ['!=', ['geometry-type'], 'Point'], layout: { 'line-join': 'miter' } }),
                layer('draft-vertex', 'circle', 'draft', { filter: ['==', ['geometry-type'], 'Point'] }),
                // last: extrusions are depth-tested, so they hide the ground overlays behind them in 2.5D
                layer('bldg-3d', 'fill-extrusion', 'buildings', vis(ctxOn && mode === '2.5d')),
            ],
        };
    }

    function paints(P) {
        const SEL = ['boolean', ['feature-state', 'selected'], false];
        const HOV = ['boolean', ['feature-state', 'hover'], false];
        const z = (lo, hi) => ['interpolate', ['linear'], ['zoom'], 15, lo, 19, hi];
        return {
            bg: { 'background-color': P.bg },
            roads: { 'fill-color': P.road },
            blocks: { 'fill-color': P.block },
            parks: { 'fill-color': P.park },
            'parcels-fill': {
                'fill-color': ['case', SEL, P.select, P.hover],
                'fill-opacity': ['case', SEL, 0.2, HOV, 0.13, 0],
            },
            'parcels-line': {
                'line-color': ['case', SEL, P.select, HOV, P.hover, P.parcel],
                'line-width': ['interpolate', ['linear'], ['zoom'], 15, ['case', SEL, 2, HOV, 1.2, 0.5], 19, ['case', SEL, 3, HOV, 2, 1]],
            },
            'bldg-fill': { 'fill-color': ['case', SEL, P.select, HOV, P.buildingHover, P.building] },
            'bldg-line': {
                'line-color': ['case', SEL, P.select, P.buildingLine],
                'line-width': ['interpolate', ['linear'], ['zoom'], 15, ['case', SEL, 1.5, 0.3], 19, ['case', SEL, 2.5, 0.8]],
            },
            'bldg-3d': {
                'fill-extrusion-color': ['case', SEL, P.select, HOV, P.buildingHover, P.extrusion],
                'fill-extrusion-height': ['coalesce', ['to-number', ['get', 'height'], 0], 0],
                'fill-extrusion-base': ['coalesce', ['to-number', ['get', 'base'], 0], 0],
                'fill-extrusion-opacity': 0.92,
                'fill-extrusion-vertical-gradient': true,
            },
            'site-fill': { 'fill-color': P.site, 'fill-opacity': (siteSelected ? 0.1 : 0) + (P.dark ? 0.12 : 0.08) },
            'site-line': { 'line-color': P.site, 'line-width': siteSelected ? z(2.5, 4.5) : z(1.6, 3) },
            'draft-fill': { 'fill-color': P.draft, 'fill-opacity': 0.06 },
            'draft-line': { 'line-color': P.draft, 'line-width': z(1.4, 2.4), 'line-dasharray': [2.2, 1.6] },
            'draft-vertex': {
                'circle-radius': z(2.2, 4), 'circle-color': P.vertex,
                'circle-stroke-color': P.draft, 'circle-stroke-width': 1.5,
            },
        };
    }

    // ================= sync with store / theme =================
    function sync() {
        if (!map || !loaded) return;
        if (themeDirty) {
            themeDirty = false;
            const P = readPalette(), key = JSON.stringify(P);
            if (key !== paletteKey) {
                palette = P; paletteKey = key;
                applyPaint();
                updateChrome(P);
                if (siteMarker) siteMarker.getElement().style.background = P.site;
            }
        }
        if (!storeDirty) return;
        storeDirty = false;
        const s = store.getState();
        const rev = currentRevision(s);
        const sk = siteKey(rev);
        if (sk !== last.site || !siteMarker) {
            last.site = sk;
            map.getSource('site').setData(siteFC(rev));
            updateSiteMarker(rev, s);
        }
        const d = s.site && s.site.draft;
        const dk = draftKey(d);
        if (dk !== last.draft) { last.draft = dk; map.getSource('draft').setData(draftFC(d)); }
        const lk = JSON.stringify(s.layers || {}) + mode;
        if (lk !== last.layers) { last.layers = lk; applyLayers(s.layers || {}); }
        const selk = JSON.stringify(s.selection || null);
        if (selk !== last.sel) { last.sel = selk; applySelection(s.selection); }
    }

    function applyPaint(only) {
        const all = paints(palette);
        for (const id of Object.keys(all)) {
            if (only && only.indexOf(id) < 0) continue;
            if (!map.getLayer(id)) continue;
            for (const prop of Object.keys(all[id])) map.setPaintProperty(id, prop, all[id][prop]);
        }
    }

    function applyLayers(L) {
        const on = (k) => L[k] !== false;
        const vis = (id, v) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none'); };
        vis('roads', on('roads'));
        vis('parcels-fill', on('parcels'));
        vis('parcels-line', on('parcels'));
        const c = on('context');
        vis('bldg-fill', c && mode === '2d');
        vis('bldg-line', c && mode === '2d');
        vis('bldg-3d', c && mode === '2.5d');
        vis('site-fill', on('boundary'));
        vis('site-line', on('boundary'));
        if (siteMarker) siteMarker.getElement().hidden = !on('boundary');
        if (hover && ((hover.src === 'parcels' && !on('parcels')) || (hover.src === 'buildings' && !c))) setHover(null);
    }

    function applySelection(sel) {
        const want = {
            parcels: sel && sel.kind === 'parcel' ? ctxData.parcels.byId.get(String(sel.id)) || [] : [],
            buildings: sel && sel.kind === 'building' ? ctxData.buildings.byId.get(String(sel.id)) || [] : [],
        };
        for (const src of ['parcels', 'buildings']) {
            for (const i of selected[src]) map.setFeatureState({ source: src, id: i }, { selected: false });
            for (const i of want[src]) map.setFeatureState({ source: src, id: i }, { selected: true });
            selected[src] = want[src];
        }
        const ss = !!(sel && sel.kind === 'site');
        if (ss !== siteSelected) { siteSelected = ss; applyPaint(['site-fill', 'site-line']); }
    }

    function updateSiteMarker(rev, s) {
        if (!rev || !rev.polygon || rev.polygon.length < 3) {
            if (siteMarker) { siteMarker.remove(); siteMarker = null; siteMarkerOn = false; }
            labelGeo = null;
            return;
        }
        let minE = Infinity, maxE = -Infinity, maxN = -Infinity;
        for (const [e, n] of rev.polygon) { minE = Math.min(minE, e); maxE = Math.max(maxE, e); maxN = Math.max(maxN, n); }
        const c = CORE.centroid(rev.polygon);
        labelGeo = {
            poly: rev.polygon,
            inside: CORE.pointInPolygon(c, rev.polygon) ? ll(c) : null,
            top: ll([(minE + maxE) / 2, maxN]),
            mode: null,
        };
        const area = typeof rev.area === 'number' ? rev.area : CORE.area(rev.polygon);
        const text = `대지 r${rev.rev} · ${area.toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}㎡`;
        if (!siteMarker) {
            const elm = el('div', 'mv-label');
            elm.style.background = palette.site;
            siteMarker = new lib.Marker({ element: elm, anchor: 'center' });
        }
        const elm = siteMarker.getElement();
        if (elm.textContent !== text) elm.textContent = text;
        siteMarker.setLngLat(labelGeo.top);
        if (!siteMarkerOn) { siteMarker.addTo(map); siteMarkerOn = true; }
        elm.hidden = (s.layers || {}).boundary === false;
        placeSiteLabel();
    }

    function placeSiteLabel() {
        if (!siteMarker || !siteMarkerOn || !labelGeo || !map) return;
        const elm = siteMarker.getElement();
        let fits = false;
        if (labelGeo.inside) {
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const p of labelGeo.poly) {
                const q = map.project(ll(p));
                x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
            }
            fits = x1 - x0 > (elm.offsetWidth || 130) + 32 && y1 - y0 > (elm.offsetHeight || 20) + 32;
        }
        const m = fits ? 'inside' : 'top';
        if (m === labelGeo.mode) return;
        labelGeo.mode = m;
        siteMarker.setLngLat(fits ? labelGeo.inside : labelGeo.top);
        siteMarker.setOffset(fits ? [0, 0] : [0, -((elm.offsetHeight || 20) / 2 + 6)]);
    }

    // ================= interaction =================
    function pick(point) {
        const layers = [mode === '2.5d' ? 'bldg-3d' : 'bldg-fill', 'site-fill', 'parcels-fill']
            .filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
        if (!layers.length) return null;
        const hits = map.queryRenderedFeatures(point, { layers });
        // priority: building > adopted site > parcel (the site sits on/over parcels)
        const b = hits.find((f) => f.layer.id === 'bldg-fill' || f.layer.id === 'bldg-3d');
        if (b) return { kind: 'building', src: 'buildings', id: ctxData.buildings.ids[b.id] };
        if (hits.some((f) => f.layer.id === 'site-fill')) return { kind: 'site' };
        const p = hits.find((f) => f.layer.id === 'parcels-fill');
        if (p) return { kind: 'parcel', src: 'parcels', id: ctxData.parcels.ids[p.id] };
        return null;
    }

    function onClick(e) {
        if (!active) return;
        const hit = pick(e.point);
        if (!hit) store.select(null);
        else if (hit.kind === 'site') store.select({ kind: 'site' });
        else store.select({ kind: hit.kind, id: hit.id });
    }

    function onMouseMove(e) {
        if (!active || isMobile()) return;
        hoverPoint = e.point;
        if (!hoverRaf) hoverRaf = requestAnimationFrame(runHover);
    }

    function runHover() {
        hoverRaf = 0;
        if (!active || !map || !loaded || !hoverPoint || map.isMoving()) return;
        const hit = pick(hoverPoint);
        setHover(hit && hit.src ? hit : null);
        map.getCanvas().style.cursor = hit ? 'pointer' : '';
    }

    function onMouseOut() {
        hoverPoint = null;
        if (loaded) setHover(null);
        if (map) map.getCanvas().style.cursor = '';
    }

    function setHover(hit) {
        const next = hit ? { src: hit.src, key: String(hit.id) } : null;
        if (hover && next && hover.src === next.src && hover.key === next.key) return;
        if (hover) for (const i of ctxData[hover.src].byId.get(hover.key) || []) map.setFeatureState({ source: hover.src, id: i }, { hover: false });
        hover = next;
        if (hover) for (const i of ctxData[hover.src].byId.get(hover.key) || []) map.setFeatureState({ source: hover.src, id: i }, { hover: true });
    }

    function fit(animate) {
        if (!map) return;
        const rev = currentRevision(store.getState());
        const b = rev && polyBounds(rev.polygon);
        if (!b) return;
        map.fitBounds(b, {
            padding: fitPadding(mapDiv.clientWidth, mapDiv.clientHeight), maxZoom: FIT_MAX_ZOOM,
            bearing: map.getBearing(), pitch: map.getPitch(), duration: animate && !reduceMotion() ? 450 : 0,
        });
    }

    function setMode(m) {
        if (m !== '2d' && m !== '2.5d') return;
        mode = m;
        updateModeButtons();
        if (!map || !loaded) return;
        last.layers = null;
        storeDirty = true;
        sync();
        const duration = reduceMotion() ? 0 : 500;
        if (m === '2.5d') {
            map.setMaxPitch(70);
            map.easeTo({ pitch: PITCH_25D, zoom: Math.min(map.getZoom(), ZOOM_25D), duration });
        } else {
            map.easeTo({ pitch: 0, duration });
            const lock = () => { if (mode === '2d' && map) map.setMaxPitch(0); };
            if (duration) map.once('moveend', lock); else lock();
        }
    }

    // custom control: [2D][2.5D] building display + fit to site
    function modeControl() {
        let box = null;
        return {
            onAdd() {
                box = el('div', 'maplibregl-ctrl maplibregl-ctrl-group mv-ctrl');
                box.setAttribute('role', 'group');
                box.setAttribute('aria-label', '건물 표시');
                const mk = (label, title, fn) => {
                    const b = document.createElement('button');
                    b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
                    b.innerHTML = label;
                    b.addEventListener('click', fn);
                    box.appendChild(b);
                    return b;
                };
                modeBtns = {
                    '2d': mk('2D', '주변 건물 2D 평면 표시', () => setMode('2d')),
                    '2.5d': mk('2.5D', '주변 건물 2.5D 높이 표시 (높이 ASSUMED, 합성 가정값)', () => setMode('2.5d')),
                };
                mk('<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5">' +
                    '<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/><rect x="5.5" y="5.5" width="5" height="5" stroke-dasharray="1.6 1.2"/></svg>',
                    '채택 대지에 맞춤', () => fit(true));
                updateModeButtons();
                return box;
            },
            onRemove() { if (box) box.remove(); modeBtns = null; },
        };
    }

    function updateModeButtons() {
        if (!modeBtns) return;
        for (const k of Object.keys(modeBtns)) modeBtns[k].setAttribute('aria-pressed', String(k === mode));
    }

    // ================= helpers =================
    function currentRevision(s) {
        const site = s && s.site;
        if (!site || !site.revisions || !site.revisions.length) return null;
        return site.revisions.find((r) => r.rev === site.current) || site.revisions[site.revisions.length - 1];
    }

    function siteKey(rev) { return rev ? rev.rev + ':' + JSON.stringify(rev.polygon) : ''; }
    function draftKey(d) { return d && d.polygon ? (d.closed ? 'c' : 'o') + JSON.stringify(d.polygon) : ''; }

    function ll(p) { return CORE.toLonLat(p); }

    function siteFC(rev) {
        const f = [];
        if (rev && rev.polygon && rev.polygon.length >= 3) {
            const ring = rev.polygon.map(ll);
            ring.push(ring[0]);
            f.push({ type: 'Feature', properties: { rev: rev.rev }, geometry: { type: 'Polygon', coordinates: [ring] } });
        }
        return { type: 'FeatureCollection', features: f };
    }

    function draftFC(d) {
        const f = [];
        const poly = d && d.polygon ? d.polygon.filter((p) => p && isFinite(p[0]) && isFinite(p[1])) : [];
        if (poly.length >= 2) {
            const coords = poly.map(ll);
            if (d.closed && poly.length >= 3) {
                f.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords.concat([coords[0]])] } });
            } else {
                f.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
            }
        }
        poly.forEach((p, i) => f.push({ type: 'Feature', properties: { i }, geometry: { type: 'Point', coordinates: ll(p) } }));
        return { type: 'FeatureCollection', features: f };
    }

    function polyBounds(poly) {
        if (!poly || !poly.length) return null;
        let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
        for (const p of poly) {
            const [lon, lat] = ll(p);
            a = Math.min(a, lon); b = Math.min(b, lat); c = Math.max(c, lon); d = Math.max(d, lat);
        }
        return isFinite(a) ? [[a, b], [c, d]] : null;
    }

    function fitPadding(w, h) {
        const m = Math.min(w || 0, h || 0);
        const pad = Math.round(Math.max(24, m * (isMobile() || m < 500 ? 0.22 : 0.3)));
        return Math.max(0, Math.min(pad, Math.floor(m / 2) - 30));
    }

    // FeatureCollection with numeric feature ids (for feature-state); the original id stays in properties.id.
    function indexed(fc) {
        const ids = [], byId = new Map();
        const features = ((fc && fc.features) || []).map((f, i) => {
            const props = Object.assign({}, f.properties);
            const pid = props.id != null ? props.id : (f.id != null ? f.id : i);
            ids.push(pid);
            const k = String(pid);
            if (!byId.has(k)) byId.set(k, []);
            byId.get(k).push(i);
            return { type: 'Feature', id: i, properties: props, geometry: f.geometry };
        });
        return { fc: { type: 'FeatureCollection', features }, ids, byId };
    }

    function boundsOfCollections(list, grow) {
        let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
        const visit = (co) => {
            if (typeof co[0] === 'number') { a = Math.min(a, co[0]); b = Math.min(b, co[1]); c = Math.max(c, co[0]); d = Math.max(d, co[1]); }
            else for (const x of co) visit(x);
        };
        for (const fc of list) for (const f of (fc && fc.features) || []) if (f.geometry) visit(f.geometry.coordinates);
        if (!isFinite(a)) return null;
        const dx = (c - a) * grow, dy = (d - b) * grow;
        return [[a - dx, b - dy], [c + dx, d + dy]];
    }

    // Palette from CSS custom properties (resolved to rgb via a 1×1 canvas so any CSS colour syntax works).
    function toRGB(v) {
        if (!v || (window.CSS && CSS.supports && !CSS.supports('color', v))) return null;
        if (!probeCtx) {
            const cv = document.createElement('canvas');
            cv.width = cv.height = 1;
            probeCtx = cv.getContext('2d', { willReadFrequently: true });
            if (!probeCtx) return v;
        }
        probeCtx.clearRect(0, 0, 1, 1);
        probeCtx.fillStyle = '#000';
        probeCtx.fillStyle = v;
        probeCtx.fillRect(0, 0, 1, 1);
        const px = probeCtx.getImageData(0, 0, 1, 1).data;
        return px[3] === 255 ? `rgb(${px[0]},${px[1]},${px[2]})` : `rgba(${px[0]},${px[1]},${px[2]},${(px[3] / 255).toFixed(3)})`;
    }

    function isDarkTheme(cs) {
        const bg = cs.getPropertyValue('--map-bg').trim();
        const rgb = bg && toRGB(bg);
        if (rgb) {
            const m = rgb.match(/\d+(\.\d+)?/g).map(Number);
            return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255 < 0.45;
        }
        const t = document.documentElement.getAttribute('data-theme');
        if (t === 'dark') return true;
        if (t === 'light') return false;
        return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }

    function readPalette() {
        const cs = getComputedStyle(root);
        const dark = isDarkTheme(cs);
        const base = dark ? PALETTE.dark : PALETTE.light;
        const P = { dark };
        for (const k of Object.keys(base)) {
            let v = null;
            for (const t of TOKENS[k]) {
                const raw = cs.getPropertyValue(t).trim();
                if (raw && (v = toRGB(raw))) break;
            }
            P[k] = v || base[k];
        }
        return P;
    }

    function updateChrome(P) {
        root.classList.toggle('mv-dark', !!P.dark);
        root.style.setProperty('--mv-bg', P.bg);
        root.style.setProperty('--mv-site', P.site);
        root.style.setProperty('--mv-draft', P.draft);
        root.style.setProperty('--mv-bldg', P.building);
        root.style.setProperty('--mv-bldg-line', P.buildingLine);
    }

    function showMessage(title, sub, retry) {
        msg.innerHTML = '';
        const card = el('div', 'mv-card');
        const t = el('p', 'mv-msg-title'); t.textContent = title;
        card.appendChild(t);
        for (const line of [].concat(sub || [])) { const p = el('p', 'mv-msg-sub'); p.textContent = line; card.appendChild(p); }
        if (retry) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'mv-retry'; b.textContent = '다시 시도';
            b.addEventListener('click', () => { activate().catch(() => { /* message already shown */ }); });
            card.appendChild(b);
        }
        msg.appendChild(card);
        msg.hidden = false;
    }

    function hideMessage() { msg.hidden = true; msg.innerHTML = ''; }

    function showError(err) {
        showMessage('지도를 표시하지 못했습니다', [errorText(err), '네트워크를 확인한 뒤 다시 시도하세요. 2D·3D 탭은 그대로 쓸 수 있습니다.'], true);
    }

    function errorText(err) { return (err && err.message) || String(err || '알 수 없는 오류'); }

    function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

    function loadScript(src) {
        if (typeof window.__loadScript !== 'function') {
            const cache = new Map();
            window.__loadScript = function (url) {
                if (!cache.has(url)) {
                    cache.set(url, new Promise((resolve, reject) => {
                        const s = document.createElement('script');
                        s.src = url;
                        s.async = true;
                        s.onload = () => resolve();
                        s.onerror = () => { cache.delete(url); s.remove(); reject(new Error('스크립트를 불러오지 못했습니다: ' + url)); };
                        (document.head || document.documentElement).appendChild(s);
                    }));
                }
                return cache.get(url);
            };
        }
        return Promise.resolve(window.__loadScript(src));
    }

    function injectStyleOnce() {
        if (document.getElementById('mv-style')) return;
        const st = document.createElement('style');
        st.id = 'mv-style';
        st.textContent = `
.mv-root{position:absolute;inset:0;overflow:hidden;background:var(--mv-bg,#e4e3dd);
  font-family:var(--font-body,system-ui,-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif);
  --mv-panel:rgb(250 250 247/.93);--mv-fg:#1e2226;--mv-fg-soft:#5c6268;--mv-line:#c7c9c6;--mv-accent:#2560c4;--mv-on-accent:#fff;
  --mv-badge-bg:#1e2226;--mv-badge-fg:#fff}
.mv-root.mv-dark{--mv-panel:rgb(27 30 33/.93);--mv-fg:#e4e5e1;--mv-fg-soft:#9ba1a6;--mv-line:#3a4046;--mv-accent:#77a6ef;--mv-on-accent:#0c1420;
  --mv-badge-bg:#e4e5e1;--mv-badge-fg:#1b1e21}
.mv-root .mv-map{position:absolute;inset:0}
.mv-root .mv-chip{position:absolute;right:8px;bottom:8px;z-index:3;max-width:min(372px,calc(100% - 140px));padding:6px 9px;
  background:var(--map-chip-bg,var(--mv-panel));color:var(--map-chip-fg,var(--mv-fg));border:1px solid var(--mv-line);border-radius:3px;
  font-size:11px;line-height:1.5;word-break:keep-all;overflow-wrap:break-word;box-shadow:0 1px 2px rgb(0 0 0/.08)}
.mv-root .mv-badge{display:inline-block;margin-right:6px;padding:1px 4px;border-radius:2px;background:var(--mv-badge-bg);color:var(--mv-badge-fg);
  font:600 10px/1.3 var(--font-mono,ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace);letter-spacing:.04em;vertical-align:1px}
.mv-root .mv-legend{display:flex;flex-wrap:wrap;gap:1px 12px;margin-top:4px;padding-top:4px;border-top:1px solid var(--mv-line);color:var(--mv-fg-soft)}
.mv-root .mv-legend span{white-space:nowrap}
.mv-root .mv-legend i{display:inline-block;width:18px;height:0;margin-right:5px;vertical-align:middle}
.mv-root .mv-legend .lg-site{border-top:2.5px solid var(--mv-site)}
.mv-root .mv-legend .lg-draft{border-top:2px dashed var(--mv-draft)}
.mv-root .mv-legend .lg-bldg{width:11px;height:9px;background:var(--mv-bldg);border:1px solid var(--mv-bldg-line)}
.mv-root.mv-narrow .mv-chip{left:8px;max-width:none;font-size:10.5px;padding:5px 8px}
.mv-root.mv-narrow .mv-legend{display:none}
.mv-root.mv-narrow .maplibregl-ctrl-bottom-left{top:0;bottom:auto}
.mv-root.mv-narrow .maplibregl-ctrl-bottom-left .maplibregl-ctrl{margin:10px 0 0 10px}
.mv-root .mv-msg{position:absolute;inset:0;z-index:5;display:grid;place-items:center;padding:16px;background:var(--mv-bg);color:var(--mv-fg);text-align:center}
.mv-root .mv-msg[hidden]{display:none}
.mv-root .mv-card{max-width:380px;word-break:keep-all;overflow-wrap:break-word;line-height:1.5}
.mv-root .mv-msg p{margin:0}
.mv-root .mv-msg-title{font-size:13px;font-weight:600}
.mv-root .mv-msg .mv-msg-sub{margin-top:4px;font-size:12px;color:var(--mv-fg-soft)}
.mv-root .mv-retry{margin-top:12px;padding:6px 14px;border:1px solid var(--mv-fg);border-radius:3px;background:transparent;color:var(--mv-fg);font:inherit;font-size:12px;cursor:pointer}
.mv-root .mv-ctrl{display:flex;flex-direction:column}
.mv-root .mv-ctrl button{width:auto;min-width:29px;padding:0 6px;color:var(--mv-fg);display:flex;align-items:center;justify-content:center;
  font:600 11px/1 var(--font-mono,ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace);letter-spacing:.02em}
.mv-root.mv-dark .maplibregl-ctrl-group{background:#262a2e;box-shadow:0 0 0 1px #3a4046}
.mv-root.mv-dark .maplibregl-ctrl-group button+button{border-top-color:#3a4046}
.mv-root.mv-dark .maplibregl-ctrl button .maplibregl-ctrl-icon{filter:invert(1) hue-rotate(180deg) brightness(.92)}
.mv-root.mv-dark .maplibregl-ctrl button:not(:disabled):hover{background-color:rgb(255 255 255/.07)}
.mv-root.mv-dark .maplibregl-ctrl-scale{background:rgb(27 30 33/.8);color:#e4e5e1;border-color:#9ba1a6}
.mv-root .mv-ctrl button[aria-pressed="true"],
.mv-root.mv-root .maplibregl-ctrl.mv-ctrl button[aria-pressed="true"]:not(:disabled):hover{background:var(--mv-accent);color:var(--mv-on-accent)}
.mv-root .mv-label{pointer-events:none;padding:3px 6px;border-radius:2px;color:#fff;white-space:nowrap;
  font:600 11px/1.2 var(--font-body,system-ui,sans-serif);box-shadow:0 1px 2px rgb(0 0 0/.3)}
.mv-root .mv-label[hidden]{display:none}
`;
        (document.head || document.documentElement).appendChild(st);
    }

    return {
        activate, deactivate, dispose,
        fit: (animate) => fit(animate !== false),
        setMode, getMode: () => mode,
        get map() { return map; },
        get loadMs() { return loadMs; },
    };
}

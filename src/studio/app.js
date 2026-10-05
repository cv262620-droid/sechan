// OHSOLV Studio canvas test — workbench shell: boot, persistence, tabs + view registry, LEFT / TOP / RIGHT / BOTTOM,
// shortcuts, JSON copy/paste, narrow-screen drawers and the window.__studio test API.
(function () {
    'use strict';
    const C = STUDIO_CORE;
    const LS_KEY = 'ohsolv-studio-test:v1';
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmt = (v, d) => (Number.isFinite(v) ? v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
    const signed = (v, d) => (v > 0 ? '+' : v < 0 ? '−' : '±') + fmt(Math.abs(v), d);
    const coordTxt = (v) => (Number.isFinite(v) ? (v < 0 ? '−' : '') + Math.abs(v).toFixed(2) : '숫자 아님');
    const hms = (t) => [t.getHours(), t.getMinutes(), t.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':');
    const time = (iso) => { if (!iso) return '—'; const t = new Date(iso); return Number.isNaN(+t) ? '—' : hms(t); };
    const SOURCE_KO = { SYNTHETIC_SAMPLE: '합성 샘플', DIRECT: '직접 작성', PARCEL: '필지 선택', RESTORE: '복원' };
    const modeChip = (m) => (m === 'USER_PROVIDED' ? '<span class="chip chip--user">USER_PROVIDED</span>' : '<span class="chip chip--synth">SYNTHETIC</span>');

    // ------------------------------------------------------------ storage (browser temp copy, not a server save)
    let storageOK = true, lastWritten = null, lastWriteAt = null;
    function lsGet() { try { return window.localStorage.getItem(LS_KEY); } catch (e) { storageOK = false; return null; } }
    function lsSet(v) { try { window.localStorage.setItem(LS_KEY, v); return true; } catch (e) { storageOK = false; return false; } }

    let bootNote = null, saved = null;
    const raw = lsGet();
    if (raw) {
        try {
            saved = C.deserialize(raw);
            bootNote = '브라우저 임시본을 불러왔습니다.' + (saved.warnings && saved.warnings.length ? ' ' + saved.warnings.join(' ') : '');
            lastWritten = raw;
        } catch (e) {
            // keep the unreadable copy aside so the next temp write does not destroy it
            let kept = false;
            try { window.localStorage.setItem(LS_KEY + ':unreadable', raw); kept = true; } catch (e2) { /* storage blocked */ }
            bootNote = '임시본을 읽지 못해 초기 상태로 시작했습니다. ' + e.message + (kept ? ' (읽지 못한 임시본은 따로 보관했습니다.)' : '');
        }
    }
    const store = C.createStore(saved);
    store.setTab('2D');                      // first screen is always 2D (M01 §6)
    if (saved) store.setPersistence('local-temp');

    // ------------------------------------------------------------ narrow / theme context
    const mqNarrow = window.matchMedia('(max-width: 900px)');
    const themeFns = new Set();
    function notifyTheme() { requestAnimationFrame(() => { for (const fn of Array.from(themeFns)) { try { fn(); } catch (e) { console.warn(e); } } }); }
    try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', notifyTheme); } catch (e) { /* old browsers */ }
    try { new MutationObserver(notifyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); } catch (e) { /* ignore */ }

    function tokens() {
        const cs = getComputedStyle(document.documentElement);
        const out = {};
        for (const k of ['bg', 'panel', 'ink', 'muted', 'line', 'accent', 'boundary', 'warn', 'ok', 'cv-paper', 'cv-road', 'cv-block', 'cv-parcel', 'cv-bldg', 'font-ui', 'font-mono']) {
            out[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = cs.getPropertyValue('--' + k).trim();
        }
        out.mode = (cs.getPropertyValue('color-scheme') || '').includes('dark') ? 'dark' : 'light';
        return out;
    }

    const ctx = {
        onStatus(text, kind) { setStatus(text, kind); },
        tokens,
        get theme() { return tokens(); },
        get isMobile() { return mqNarrow.matches; },
        onThemeChange(fn) { themeFns.add(fn); return () => themeFns.delete(fn); },
    };

    // ------------------------------------------------------------ status, toast
    const statusEl = $('status-text');
    function setStatus(text, kind) {
        statusEl.textContent = text || '';
        statusEl.dataset.kind = kind || '';
    }
    let toastTimer = 0;
    function toast(text) {
        const t = $('toast');
        t.textContent = text; t.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
    }

    // ------------------------------------------------------------ views
    const registry = { '2D': () => window.createPlanView, MAP: () => window.createMapView, '3D': () => window.create3DView };
    const TAB_INFO = {
        '2D': () => '로컬 평면 좌표 (m) · 수평투영 면적',
        MAP: () => '위경도는 표시용 참고값 · 기준점 37.5665N 126.9780E',
        '3D': (st) => `채택된 r${st.site.current} 기준 · 초안은 반영 안 함`,
    };
    const TAB_STATUS = {
        '2D': (st) => `2D 도면 · 채택 r${st.site.current}${st.site.draft ? ' · 초안 편집 중' : ''}`,
        MAP: () => '지도 · 합성 필지를 눌러 선택하세요.',
        '3D': (st) => `3D · 채택 r${st.site.current} 기준`,
    };
    const views = {};
    const waiters = {};
    function waiter(name) {
        if (!waiters[name]) { let res; const p = new Promise((r) => { res = r; }); waiters[name] = { promise: p, resolve: res, done: false }; }
        return waiters[name];
    }
    function settle(name, result) { const w = waiter(name); if (!w.done) { w.done = true; w.resolve(result); } }
    let activeTab = null;

    function phCard(html) { return `<div class="placeholder"><div class="ph-card">${html}</div></div>`; }

    function render3DPlaceholder(host) {
        const st = store.getState();
        const r = st.site.revisions.find((x) => x.rev === st.site.current);
        host.innerHTML = phCard(`
          <div class="row"><span class="chip chip-ko chip--na">미구현</span><span class="chip chip--synth">SYNTHETIC</span></div>
          <h2>3D 뷰는 다음 단계에서 연결됩니다</h2>
          <p>채택된 대지와 주변 합성 건물·도로·원경 지형을 기초 3D로 보여줄 자리입니다. 엔진은 이 탭을 처음 열 때 불러옵니다.</p>
          <dl>
            <dt>기준 리비전</dt><dd>r${r.rev} · ${fmt(r.area, 1)} ㎡</dd>
            <dt>엔진</dt><dd>Babylon.js 9.29.0 (기본) · PlayCanvas 2.23.0</dd>
            <dt>초안</dt><dd>${st.site.draft ? '있음 · 3D에는 반영하지 않음' : '없음'}</dd>
          </dl>
          <div class="field"><label for="ph-engine">사용할 엔진 (다음 단계에서 적용)</label>
            <select class="input" id="ph-engine"><option value="babylon">Babylon.js 9.29.0</option><option value="playcanvas">PlayCanvas 2.23.0</option></select></div>`);
        const sel = host.querySelector('#ph-engine');
        sel.value = st.ui.engine;
        sel.addEventListener('change', () => store.setEngine(sel.value));
    }

    function renderMissing(name, host) {
        if (name === '3D') return render3DPlaceholder(host);
        host.innerHTML = phCard(`
          <div class="row"><span class="chip chip-ko chip--error">불러오기 실패</span></div>
          <h2>${name === 'MAP' ? '지도 뷰를 불러오지 못했습니다' : '도면 뷰를 불러오지 못했습니다'}</h2>
          <p>이 빌드에 ${name} 뷰 모듈이 들어 있지 않습니다. 2D 도면에서 대지 작성은 계속할 수 있습니다.</p>`);
    }

    function renderError(name, host, err) {
        let ov = host.querySelector(':scope > .placeholder');
        if (!ov) { ov = document.createElement('div'); host.appendChild(ov); }
        ov.outerHTML = phCard(`
          <div class="row"><span class="chip chip-ko chip--error">불러오기 실패</span></div>
          <h2>${name === 'MAP' ? '지도 뷰를 불러오지 못했습니다' : name === '3D' ? '3D 뷰를 불러오지 못했습니다' : '도면 뷰를 불러오지 못했습니다'}</h2>
          <p>${name === 'MAP' ? 'MapLibre GL JS를 불러오거나 지도를 만드는 중에 문제가 생겼습니다.' : '뷰를 시작하는 중에 문제가 생겼습니다.'} 다른 탭은 그대로 쓸 수 있습니다.</p>
          <div class="err">${esc(err && err.message ? err.message : String(err))}</div>
          <div class="row"><button type="button" class="btn btn--sm" id="retry-${name}">다시 시도</button></div>`);
        const btn = host.querySelector('#retry-' + name);
        if (btn) btn.addEventListener('click', () => {
            const v = views[name];
            if (v && v.inst) { try { v.inst.dispose(); } catch (e) { /* ignore */ } }
            delete views[name];
            host.innerHTML = '';
            if (activeTab === name) activateView(name);
        });
    }

    async function activateView(name) {
        const host = $('view-' + name);
        let v = views[name];
        if (!v) {
            const factory = registry[name]();
            if (typeof factory !== 'function') {
                views[name] = { inst: null, state: 'missing' };
                renderMissing(name, host);
                setStatus(name === '3D' ? '3D 뷰는 다음 단계에서 연결됩니다.' : `${name} 뷰를 불러오지 못했습니다.`, 'info');
                settle(name, { ok: false, reason: 'missing' });
                return;
            }
            try {
                v = views[name] = { inst: factory(host, store, ctx), state: 'loading' };
            } catch (e) {
                views[name] = { inst: null, state: 'error', error: e };
                console.warn(`[studio] ${name} view factory failed`, e);
                renderError(name, host, e);
                settle(name, { ok: false, error: e.message });
                return;
            }
        }
        if (!v.inst || v.state === 'error') return;
        try {
            await v.inst.activate();
            v.state = 'ready';
            if (activeTab !== name) v.inst.deactivate();
            settle(name, { ok: true });
        } catch (e) {
            v.state = 'error';
            console.warn(`[studio] ${name} view failed to activate`, e);
            renderError(name, host, e);
            setStatus(`${name} 뷰를 불러오지 못했습니다.`, 'error');
            settle(name, { ok: false, error: e && e.message });
        }
    }

    function showTab(name) {
        if (activeTab === name) return;
        const prev = activeTab;
        activeTab = name;
        for (const t of ['MAP', '2D', '3D']) {
            const tab = $('tab-' + t), host = $('view-' + t);
            const on = t === name;
            tab.setAttribute('aria-selected', String(on));
            tab.tabIndex = on ? 0 : -1;
            host.hidden = !on;
        }
        $('status-tab').textContent = name;
        if (prev && views[prev] && views[prev].inst && views[prev].state !== 'error') {
            try { views[prev].inst.deactivate(); } catch (e) { console.warn(e); }
        }
        renderTabInfo(store.getState());
        // replace the previous tab's message; a view may override it while it loads
        if (prev) setStatus(TAB_STATUS[name](store.getState()), 'info');
        activateView(name);
    }

    function renderTabInfo(st) {
        $('tab-info-text').textContent = TAB_INFO[activeTab || '2D'](st);
    }

    // ------------------------------------------------------------ TOP
    function renderTop(st) {
        const d = st.site.draft;
        $('top-option').textContent = `안 ${st.project.option}`;
        $('top-project').textContent = st.project.name;
        $('top-rev').innerHTML = `site r${st.site.current}${d ? ' <span class="chip chip-ko chip--draft">초안</span>' : ''}`;
        const chip = $('save-chip'), t = $('save-time');
        if (!storageOK) {
            chip.textContent = '임시본 사용 불가 · 서버 저장 아님';
            chip.className = 'chip chip-ko chip--error';
            t.textContent = '브라우저 저장소 차단';
        } else {
            chip.textContent = '브라우저 임시본 · 서버 저장 아님';
            chip.className = 'chip chip-ko chip--na';
            t.textContent = lastWriteAt ? `임시 기록 ${lastWriteAt}` : st.persistence === 'local-temp' ? '임시본에서 복원' : '기록 없음';
        }
    }

    // ------------------------------------------------------------ LEFT
    let lastRevs = null, lastRevSig = '';
    function renderLeft(st) {
        for (const inp of document.querySelectorAll('[data-layer]')) inp.checked = !!st.layers[inp.dataset.layer];
        const revSig = `${st.site.current}|${!!st.site.draft}`;
        if (st.site.revisions === lastRevs && revSig === lastRevSig) return;
        lastRevs = st.site.revisions; lastRevSig = revSig;
        const list = $('rev-list');
        const revs = st.site.revisions.slice().reverse();
        $('rev-count').textContent = `${revs.length}개`;
        const hasDraft = !!st.site.draft;
        list.innerHTML = revs.map((r) => {
            const cur = r.rev === st.site.current;
            return `<li class="rev" data-current="${cur}" id="rev-${r.rev}">
              <span class="rn">r${r.rev}</span>
              <div class="meta">
                <div class="l1">${cur ? '<span class="chip chip-ko chip--current">현재</span>' : ''}${modeChip(r.dataMode)}<span class="sub">${SOURCE_KO[r.source] || r.source}</span></div>
                <div class="l2">${fmt(r.area, 1)} ㎡ · ${r.polygon.length}점 · ${time(r.createdAt)}</div>
                ${r.note ? `<div class="l3">${esc(r.note)}</div>` : ''}
              </div>
              ${cur ? '' : `<div class="act"><button type="button" class="btn btn--sm" id="btn-restore-${r.rev}" data-restore="${r.rev}" ${hasDraft ? 'disabled title="초안을 먼저 채택하거나 취소하세요"' : ''}>이 리비전으로 복원</button></div>`}
            </li>`;
        }).join('');
    }

    // ------------------------------------------------------------ RIGHT (Inspector)
    function currentRev(st) { return st.site.revisions.find((r) => r.rev === st.site.current); }
    function workPoly(st) { const d = st.site.draft; return d ? d.polygon : currentRev(st).polygon; }
    const lonlatTxt = (p) => { const ll = C.toLonLat(p); return Number.isFinite(ll[0]) && Number.isFinite(ll[1]) ? `${ll[1].toFixed(6)}N ${ll[0].toFixed(6)}E` : '—'; };

    function draftCard(st) {
        const d = st.site.draft;
        if (!d) return '';
        const v = d.validation, base = currentRev(st);
        const n = d.polygon.length;
        const delta = v.area - base.area;
        const pct = base.area ? (delta / base.area) * 100 : 0;
        const measurable = d.closed && n >= 3 && !v.issues.some((is) => is.code === 'SELF_INTERSECT' || is.code === 'NAN');
        const hasNaN = v.issues.some((is) => is.code === 'NAN');
        const unchanged = v.ok && C.samePolygon(d.polygon, base.polygon);
        const canAdopt = v.ok && !unchanged;
        const src = d.source === 'PARCEL' ? '필지 선택' : '직접 작성';
        const issues = v.issues.map((is, k) => `<li><button type="button" class="issue" id="issue-${k}" data-issue="${k}"><span class="code">${is.code}</span><span>${esc(is.message)}</span></button></li>`).join('');
        return `<section class="insp-sec" aria-labelledby="dc-title">
          <div class="draft-card" data-valid="${v.ok}" id="draft-card">
            <div class="dc-h"><strong id="dc-title">초안</strong><span class="chip chip-ko chip--draft">초안</span><span class="chip chip-ko chip--plain">${src}</span>
              ${v.ok ? '<span class="chip chip-ko chip--adopted">검증 통과</span>' : `<span class="chip chip-ko chip--error">검증 오류 ${v.issues.length}</span>`}</div>
            <div class="dc-b">
              ${v.ok ? '<div class="issue-ok"><span class="dot"></span>폐합 · 자기교차 없음 · 면적 정상</div>' : `<ul class="issues" aria-label="검증 오류">${issues}</ul>`}
              ${unchanged ? `<div class="note-box" id="dc-unchanged">채택된 r${base.rev}과 같은 경계입니다. 꼭짓점을 고친 뒤 채택하세요.</div>` : ''}
              <div class="diff" aria-label="채택 대지 대비 면적 차이">
                <span>채택 r${base.rev} 대지면적</span><span>${fmt(base.area, 1)} ㎡</span>
                <span>초안 대지면적</span><span>${measurable ? fmt(v.area, 1) + ' ㎡' : '—'}</span>
                <span>차이</span><span class="delta ${measurable && delta > 0.05 ? 'pos' : measurable && delta < -0.05 ? 'neg' : ''}">${measurable ? `${signed(delta, 1)} ㎡ (${signed(pct, 1)}%)` : '—'}</span>
                <span>꼭짓점 · 둘레</span><span>${n}점 · ${hasNaN ? '—' : fmt(v.perimeter, 2) + ' m'}</span>
              </div>
              <div class="field"><label for="adopt-note">채택 메모 (선택)</label><input class="input" id="adopt-note" type="text" maxlength="80" placeholder="예: 북측 경계 0.5 m 조정" style="font-family:var(--font-ui)"></div>
              <div class="dc-actions">
                <button type="button" class="btn" id="btn-draft-cancel">취소</button>
                <button type="button" class="btn btn--primary" id="btn-draft-adopt" ${canAdopt ? '' : `disabled aria-describedby="${unchanged ? 'dc-unchanged' : 'adopt-why'}"`}>채택 → r${Math.max(...st.site.revisions.map((r) => r.rev)) + 1}</button>
              </div>
              ${v.ok ? '' : '<div class="adopt-why" id="adopt-why">검증 오류를 고쳐야 채택할 수 있습니다.</div>'}
            </div>
          </div>
        </section>`;
    }

    function vertexTable(st) {
        const poly = workPoly(st), d = st.site.draft;
        const rows = poly.map((p, i) => `<tr><th scope="row"><button type="button" class="vt-btn" id="vt-${i}" data-vertex="${i}">P${i + 1}</button></th><td>${coordTxt(p[0])}</td><td>${coordTxt(p[1])}</td></tr>`).join('');
        return `<div class="vt-wrap"><table class="vt" aria-label="꼭짓점 좌표 (m)"><thead><tr><th scope="col">${d ? '초안' : `r${st.site.current}`}</th><th scope="col">E (m)</th><th scope="col">N (m)</th></tr></thead><tbody>${rows || '<tr><td colspan="3">꼭짓점 없음</td></tr>'}</tbody></table></div>`;
    }

    function siteSummary(st) {
        const r = currentRev(st);
        const c = C.centroid(r.polygon);
        return `<section class="insp-sec" aria-labelledby="sum-h">
          <h3 id="sum-h">현재 대지 <span class="mono">r${r.rev}</span>${modeChip(r.dataMode)}</h3>
          <dl class="kv">
            <dt>대지면적</dt><dd class="big">${fmt(r.area, 1)} ㎡</dd>
            <dt>공부상 면적</dt><dd class="txt">없음 (합성)</dd>
            <dt>둘레</dt><dd>${fmt(r.perimeter, 2)} m</dd>
            <dt>꼭짓점</dt><dd>${r.polygon.length}점</dd>
            <dt>중심 (로컬)</dt><dd>E ${coordTxt(c[0])} · N ${coordTxt(c[1])}</dd>
            <dt>중심 (참고)</dt><dd>${lonlatTxt(c)}</dd>
            <dt>출처</dt><dd class="txt">${SOURCE_KO[r.source] || r.source}${r.restoredFrom ? ` (r${r.restoredFrom})` : ''}</dd>
            <dt>inputHash</dt><dd>${r.inputHash}</dd>
            <dt>작성</dt><dd>${time(r.createdAt)}</dd>
          </dl>
          ${r.note ? `<div class="note-box">${esc(r.note)}</div>` : ''}
          <div class="note-box">면적은 로컬 평면 좌표(m)의 수평투영 면적입니다. 위경도는 표시용 참고값입니다.</div>
        </section>
        <section class="insp-sec" aria-labelledby="vt-h"><h3 id="vt-h" class="eyebrow" style="font-size:var(--fs-xs)">꼭짓점 좌표</h3>${vertexTable(st)}</section>`;
    }

    function interiorAngle(poly, i) {
        const n = poly.length;
        if (n < 3) return NaN;
        const p = poly[i], a = poly[(i - 1 + n) % n], b = poly[(i + 1) % n];
        const v1 = [a[0] - p[0], a[1] - p[1]], v2 = [b[0] - p[0], b[1] - p[1]];
        let ang = Math.atan2(v2[0] * v1[1] - v2[1] * v1[0], v2[0] * v1[0] + v2[1] * v1[1]) * 180 / Math.PI;
        if (C.signedArea(poly) < 0) ang = -ang;
        return (ang + 360) % 360;
    }

    function vertexPanel(st, i) {
        const poly = workPoly(st), d = st.site.draft, n = poly.length;
        const p = poly[i];
        if (!p) return siteSummary(st);
        const closed = d ? d.closed : true;
        const prevLen = (closed || i > 0) && n > 1 ? Math.hypot(p[0] - poly[(i - 1 + n) % n][0], p[1] - poly[(i - 1 + n) % n][1]) : NaN;
        const nextLen = (closed || i < n - 1) && n > 1 ? Math.hypot(poly[(i + 1) % n][0] - p[0], poly[(i + 1) % n][1] - p[1]) : NaN;
        return `<section class="insp-sec" aria-labelledby="v-h">
          <h3 id="v-h">꼭짓점 <span class="mono">P${i + 1}</span>${d ? '<span class="chip chip-ko chip--draft">초안</span>' : `<span class="chip chip-ko chip--plain">채택 r${st.site.current}</span>`}</h3>
          <div class="edit-grid">
            <div class="field"><label for="insp-v-e">E 동 (m)</label><div class="input-unit"><input class="input" id="insp-v-e" type="text" inputmode="decimal" value="${Number.isFinite(p[0]) ? p[0].toFixed(2) : ''}" placeholder="숫자 아님" autocomplete="off"><span class="u">m</span></div></div>
            <div class="field"><label for="insp-v-n">N 북 (m)</label><div class="input-unit"><input class="input" id="insp-v-n" type="text" inputmode="decimal" value="${Number.isFinite(p[1]) ? p[1].toFixed(2) : ''}" placeholder="숫자 아님" autocomplete="off"><span class="u">m</span></div></div>
          </div>
          <div class="adopt-why" id="insp-v-err" role="alert"></div>
          <dl class="kv">
            <dt>위경도 (참고)</dt><dd>${lonlatTxt(p)}</dd>
            <dt>이전 변</dt><dd>${Number.isFinite(prevLen) ? fmt(prevLen, 2) + ' m' : '—'}</dd>
            <dt>다음 변</dt><dd>${Number.isFinite(nextLen) ? fmt(nextLen, 2) + ' m' : '—'}</dd>
            <dt>내각</dt><dd>${closed && n >= 3 ? fmt(interiorAngle(poly, i), 1) + '°' : '—'}</dd>
          </dl>
          <div class="row-btns">
            <button type="button" class="btn btn--sm" id="insp-v-prev" ${n < 2 ? 'disabled' : ''}>이전 점</button>
            <button type="button" class="btn btn--sm" id="insp-v-next" ${n < 2 ? 'disabled' : ''}>다음 점</button>
            <button type="button" class="btn btn--sm" id="insp-v-del">꼭짓점 삭제 <span class="key">Del</span></button>
          </div>
          ${d ? '' : '<div class="note-box">채택된 경계를 고치면 초안이 만들어지고, 채택해야 새 리비전이 됩니다.</div>'}
        </section>
        <section class="insp-sec"><h3 class="eyebrow" style="font-size:var(--fs-xs)">꼭짓점 좌표</h3>${vertexTable(st)}</section>`;
    }

    function edgePanel(st, i) {
        const poly = workPoly(st), d = st.site.draft, n = poly.length;
        const a = poly[i], b = poly[(i + 1) % n];
        if (!a || !b) return siteSummary(st);
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const az = ((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI + 360) % 360;
        const j = (i + 1) % n;
        return `<section class="insp-sec" aria-labelledby="e-h">
          <h3 id="e-h">변 <span class="mono">P${i + 1}–P${j + 1}</span>${d ? '<span class="chip chip-ko chip--draft">초안</span>' : `<span class="chip chip-ko chip--plain">채택 r${st.site.current}</span>`}</h3>
          <div class="field"><label for="insp-e-len">변 길이 (m)</label><div class="input-unit"><input class="input" id="insp-e-len" type="text" inputmode="decimal" value="${len.toFixed(2)}" autocomplete="off"><span class="u">m</span></div></div>
          <div class="adopt-why" id="insp-e-err" role="alert"></div>
          <div class="note-box">길이를 바꾸면 끝점(P${j + 1})을 변 방향으로 옮깁니다. 시작점은 그대로입니다.</div>
          <dl class="kv">
            <dt>방위각 (북 기준)</dt><dd>${fmt(az, 2)}°</dd>
            <dt>시작 P${i + 1}</dt><dd>${coordTxt(a[0])}, ${coordTxt(a[1])}</dd>
            <dt>끝 P${j + 1}</dt><dd>${coordTxt(b[0])}, ${coordTxt(b[1])}</dd>
          </dl>
          <div class="row-btns">
            <button type="button" class="btn btn--sm" id="insp-e-prev">이전 변</button>
            <button type="button" class="btn btn--sm" id="insp-e-next">다음 변</button>
            <button type="button" class="btn btn--sm" id="insp-e-insert">중점에 꼭짓점 삽입</button>
          </div>
        </section>`;
    }

    function parcelPanel(st, id) {
        const p = C.parcel(id);
        if (!p) return siteSummary(st);
        const b = p.building ? C.building(p.building) : null;
        const c = C.centroid(p.polygon);
        return `<section class="insp-sec" aria-labelledby="p-h">
          <h3 id="p-h">필지 <span class="mono">${esc(id)}</span><span class="chip chip--synth">SYNTHETIC</span></h3>
          <dl class="kv">
            <dt>블록</dt><dd>${esc(p.block)}</dd>
            <dt>면적 (합성)</dt><dd class="big">${fmt(p.area, 1)} ㎡</dd>
            <dt>공부상 면적</dt><dd class="txt">없음 (합성)</dd>
            <dt>꼭짓점</dt><dd>${p.polygon.length}점</dd>
            <dt>중심 (로컬)</dt><dd>E ${coordTxt(c[0])} · N ${coordTxt(c[1])}</dd>
            <dt>중심 (참고)</dt><dd>${lonlatTxt(c)}</dd>
            <dt>건물</dt><dd>${b ? `<button type="button" class="linkish" id="insp-p-bldg" data-building="${b.id}">${b.id}</button> · ${b.floors}F` : '없음'}</dd>
          </dl>
          <button type="button" class="btn btn--primary" id="btn-parcel-draft">이 필지로 대지 초안 만들기</button>
          ${st.site.draft ? '<div class="note-box">지금 초안을 이 필지 경계로 바꿉니다. Ctrl+Z로 되돌릴 수 있습니다.</div>' : '<div class="note-box">초안은 채택해야 새 리비전이 됩니다. 실제 필지와 무관한 합성 경계입니다.</div>'}
        </section>`;
    }

    function buildingPanel(st, id) {
        const b = C.building(id);
        if (!b) return siteSummary(st);
        return `<section class="insp-sec" aria-labelledby="b-h">
          <h3 id="b-h">주변 건물 <span class="mono">${esc(id)}</span><span class="chip chip--synth">SYNTHETIC</span></h3>
          <dl class="kv">
            <dt>높이</dt><dd class="big">${fmt(b.height, 1)} m <span class="chip chip--assumed">ASSUMED</span></dd>
            <dt>층수 (합성)</dt><dd>${b.floors}F</dd>
            <dt>바닥 외곽 면적</dt><dd>${fmt(b.footprintArea, 1)} ㎡</dd>
            <dt>매스 구성</dt><dd>${b.parts.length === 1 ? '단일' : `저층부 + 상부 ${b.parts.length - 1}`}</dd>
            <dt>필지</dt><dd><button type="button" class="linkish" id="insp-b-parcel" data-parcel="${b.parcel}">${b.parcel}</button></dd>
          </dl>
          <div class="note-box">높이·층수는 합성 가정값(ASSUMED)입니다. 실제 건물 자료가 아닙니다.</div>
        </section>`;
    }

    function inspectorBody(st) {
        const s = st.selection;
        if (!s || s.kind === 'site') return siteSummary(st);
        if (s.kind === 'vertex') return vertexPanel(st, s.i);
        if (s.kind === 'edge') return edgePanel(st, s.i);
        if (s.kind === 'parcel') return parcelPanel(st, s.id);
        if (s.kind === 'building') return buildingPanel(st, s.id);
        return siteSummary(st);
    }

    let lastDraftSig = '', lastBodySig = '';
    function renderInspector(st) {
        const d = st.site.draft;
        const focusId = document.activeElement && document.activeElement.id;
        const draftSig = d ? JSON.stringify([d.polygon, d.closed, d.source, d.validation.issues.length, st.site.current, st.site.revisions.length]) : '';
        if (draftSig !== lastDraftSig) {
            const note = $('adopt-note');
            const keepNote = note ? note.value : '';
            $('insp-draft').innerHTML = draftCard(st);
            const n2 = $('adopt-note');
            if (n2) n2.value = keepNote;
            lastDraftSig = draftSig;
        }
        const bodySig = JSON.stringify([st.selection, d ? [d.polygon, d.closed] : null, st.site.current, st.site.revisions.length]);
        if (bodySig !== lastBodySig) {
            $('insp-body').innerHTML = inspectorBody(st);
            lastBodySig = bodySig;
        }
        if (focusId && document.activeElement !== $(focusId) && $(focusId)) {
            const el = $(focusId);
            el.focus({ preventScroll: true });
            if (el.select && el.tagName === 'INPUT' && el.id !== 'adopt-note') el.select();
        }
    }

    // ------------------------------------------------------------ batched render
    let renderRaf = 0;
    function scheduleRender() { if (!renderRaf) renderRaf = requestAnimationFrame(renderAll); }
    function renderAll() {
        renderRaf = 0;
        const st = store.getState();
        renderTop(st); renderLeft(st); renderInspector(st); renderTabInfo(st);
        if (views['3D'] && views['3D'].state === 'missing' && activeTab === '3D') {
            const host = $('view-3D');
            const sig = `${st.site.current}|${!!st.site.draft}|${st.ui.engine}`;
            if (host.dataset.sig !== sig) { host.dataset.sig = sig; render3DPlaceholder(host); }
        }
        $('btn-drawer-right').classList.toggle('has-sel', !!(st.selection || st.site.draft));
    }

    // ------------------------------------------------------------ persistence
    let saveTimer = 0;
    function schedulePersist() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(persistNow, 400);
    }
    function persistNow() {
        const st = store.getState();
        if (st.site.draft && st.site.draft.preview) { schedulePersist(); return; }
        const json = store.serialize();
        if (json === lastWritten) return;
        if (lsSet(json)) {
            lastWritten = json;
            lastWriteAt = hms(new Date());
            store.setPersistence('local-temp');
        }
        scheduleRender();
    }

    store.subscribe((st, prev) => {
        if (st.ui.tab !== prev.ui.tab) showTab(st.ui.tab);
        if (st.ui.tool !== prev.ui.tool && st.ui.tool === 'draw') setStatus('그리기 · 2D에서 클릭해 꼭짓점을 추가하고, 첫 점을 다시 누르거나 Enter로 폐합합니다.', 'info');
        if (st.site !== prev.site || st.layers !== prev.layers || st.ui.tab !== prev.ui.tab || st.ui.engine !== prev.ui.engine || st.project !== prev.project) schedulePersist();
        scheduleRender();
    });

    // ------------------------------------------------------------ actions
    function goDraw() {
        store.setTab('2D');
        store.setTool('draw');
        closeDrawers();
        const cv = document.getElementById('p2-canvas');
        if (cv) cv.focus({ preventScroll: true });
    }

    function adopt() {
        const note = ($('adopt-note') && $('adopt-note').value.trim()) || undefined;
        try {
            const rev = store.adoptDraft(note);
            const r = currentRev(store.getState());
            toast(`r${rev} 채택 · 대지면적 ${fmt(r.area, 1)} ㎡ (브라우저 임시본)`);
            setStatus(`채택 완료 · 새 리비전 r${rev} · 이전 리비전은 목록에 그대로 남습니다.`, 'ok');
        } catch (e) {
            setStatus(e.message, 'error');
        }
    }

    function parseNum(s) {
        const v = Number(String(s).replace(/,/g, '').replace(/−/g, '-').trim());
        return String(s).trim() === '' ? NaN : v;
    }

    // Inspector events (delegated)
    $('inspector').addEventListener('click', (ev) => {
        const t = ev.target.closest('button');
        if (!t || t.disabled) return;
        const st = store.getState();
        const sel = st.selection;
        const n = workPoly(st).length;
        switch (t.id) {
            case 'btn-draft-cancel': store.cancelDraft(); setStatus('초안을 취소했습니다. 채택된 리비전은 그대로입니다.', 'info'); return;
            case 'btn-draft-adopt': adopt(); return;
            case 'insp-v-prev': store.select({ kind: 'vertex', i: (sel.i - 1 + n) % n }); return;
            case 'insp-v-next': store.select({ kind: 'vertex', i: (sel.i + 1) % n }); return;
            case 'insp-v-del':
                if (store.edit({ type: 'remove', i: sel.i })) { store.select(n - 1 > 0 ? { kind: 'vertex', i: Math.min(sel.i, n - 2) } : null); setStatus(`꼭짓점 P${sel.i + 1} 삭제`); }
                return;
            case 'insp-e-prev': store.select({ kind: 'edge', i: (sel.i - 1 + n) % n }); return;
            case 'insp-e-next': store.select({ kind: 'edge', i: (sel.i + 1) % n }); return;
            case 'insp-e-insert': {
                const poly = workPoly(st), a = poly[sel.i], b = poly[(sel.i + 1) % n];
                const p = [Math.round(((a[0] + b[0]) / 2) * 100) / 100, Math.round(((a[1] + b[1]) / 2) * 100) / 100];
                if (store.edit({ type: 'insert', edge: sel.i, p })) store.select({ kind: 'vertex', i: sel.i + 1 });
                return;
            }
            case 'btn-parcel-draft': {
                const id = sel && sel.id;
                const poly = C.parcelPolygon(id);
                if (!poly) return;
                store.startDraft(poly, 'PARCEL');
                toast(`필지 ${id} 경계로 초안을 만들었습니다`);
                setStatus(`필지 ${id} 초안 · 2D에서 다듬거나 바로 채택하세요.`, 'info');
                return;
            }
            default: break;
        }
        if (t.dataset.issue !== undefined) {
            const d = st.site.draft, is = d && d.validation.issues[Number(t.dataset.issue)];
            if (!is) return;
            if (is.edges && is.edges.length) store.select({ kind: 'edge', i: is.edges[0] });
            else if (is.vertices && is.vertices.length) store.select({ kind: 'vertex', i: is.vertices[0] });
            return;
        }
        if (t.dataset.vertex !== undefined) { store.select({ kind: 'vertex', i: Number(t.dataset.vertex) }); return; }
        if (t.dataset.building) { store.select({ kind: 'building', id: t.dataset.building }); return; }
        if (t.dataset.parcel) { store.select({ kind: 'parcel', id: t.dataset.parcel }); }
    });

    $('inspector').addEventListener('change', (ev) => {
        const t = ev.target;
        const st = store.getState();
        const sel = st.selection;
        if (t.id === 'insp-v-e' || t.id === 'insp-v-n') {
            const e = parseNum($('insp-v-e').value), n = parseNum($('insp-v-n').value);
            if (!Number.isFinite(e) || !Number.isFinite(n)) { $('insp-v-err').textContent = '숫자로 입력하세요 (예: 12.50).'; return; }
            $('insp-v-err').textContent = '';
            store.edit({ type: 'setVertex', i: sel.i, p: [Math.round(e * 1000) / 1000, Math.round(n * 1000) / 1000] });
            setStatus(`P${sel.i + 1} 좌표 → E ${e.toFixed(2)}, N ${n.toFixed(2)} m`);
        } else if (t.id === 'insp-e-len') {
            const L = parseNum(t.value);
            if (!(L > 0)) { $('insp-e-err').textContent = '0보다 큰 길이를 입력하세요.'; return; }
            $('insp-e-err').textContent = '';
            store.edit({ type: 'setEdgeLength', edge: sel.i, length: L });
            setStatus(`변 P${sel.i + 1} 길이 → ${L.toFixed(2)} m`);
        }
    });
    $('inspector').addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && ev.target.id === 'adopt-note') { ev.preventDefault(); const b = $('btn-draft-adopt'); if (b && !b.disabled) adopt(); }
    });

    // LEFT events
    $('left').addEventListener('change', (ev) => {
        const t = ev.target;
        if (t.dataset.layer) store.setLayer(t.dataset.layer, t.checked);
    });
    $('left').addEventListener('click', (ev) => {
        const t = ev.target.closest('button');
        if (!t || t.disabled) return;
        if (t.id === 'btn-path-draw') { goDraw(); return; }
        if (t.id === 'btn-path-map') { store.setTab('MAP'); closeDrawers(); setStatus('지도에서 합성 필지를 눌러 선택하세요.', 'info'); return; }
        if (t.dataset.restore) {
            const rev = Number(t.dataset.restore);
            try {
                const nr = store.restoreRevision(rev);
                toast(`복원 완료 · r${rev} 경계 → 새 리비전 r${nr}`);
                setStatus(`r${rev} 경계로 새 리비전 r${nr} 생성 · 기존 리비전은 지우지 않습니다.`, 'ok');
            } catch (e) { setStatus(e.message, 'error'); }
        }
    });

    // Tabs
    for (const name of ['MAP', '2D', '3D']) $('tab-' + name).addEventListener('click', () => store.setTab(name));
    document.querySelector('.tabbar').addEventListener('keydown', (ev) => {
        const order = ['MAP', '2D', '3D'];
        const i = order.indexOf(activeTab);
        let j = -1;
        if (ev.key === 'ArrowRight') j = (i + 1) % 3; else if (ev.key === 'ArrowLeft') j = (i + 2) % 3; else if (ev.key === 'Home') j = 0; else if (ev.key === 'End') j = 2;
        if (j < 0) return;
        ev.preventDefault();
        store.setTab(order[j]);
        $('tab-' + order[j]).focus();
    });

    // ------------------------------------------------------------ drawers (<= 900px)
    const wb = $('studio'), scrim = $('scrim');
    function openDrawer(side) {
        wb.dataset.drawer = side;
        scrim.hidden = false;
        $('btn-drawer-left').setAttribute('aria-expanded', String(side === 'left'));
        $('btn-drawer-right').setAttribute('aria-expanded', String(side === 'right'));
    }
    function closeDrawers() {
        if (!wb.dataset.drawer) return;
        wb.dataset.drawer = '';
        if ($('dlg').hidden) scrim.hidden = true;
        $('btn-drawer-left').setAttribute('aria-expanded', 'false');
        $('btn-drawer-right').setAttribute('aria-expanded', 'false');
    }
    $('btn-drawer-left').addEventListener('click', () => (wb.dataset.drawer === 'left' ? closeDrawers() : openDrawer('left')));
    $('btn-drawer-right').addEventListener('click', () => (wb.dataset.drawer === 'right' ? closeDrawers() : openDrawer('right')));
    $('btn-close-right').addEventListener('click', closeDrawers);
    scrim.addEventListener('click', () => { if (!$('dlg').hidden) closeDialog(); else closeDrawers(); });
    mqNarrow.addEventListener('change', () => { closeDrawers(); notifyTheme(); });

    // ------------------------------------------------------------ JSON copy / paste
    let dlgMode = null, dlgReturn = null;
    function openDialog(mode, text, message) {
        dlgMode = mode;
        dlgReturn = document.activeElement;
        const ta = $('dlg-text');
        $('dlg-err').textContent = '';
        if (mode === 'export') {
            $('dlg-title').textContent = 'JSON 내보내기';
            $('dlg-desc').textContent = message || '아래 내용을 선택해 복사하세요. 리비전 목록과 초안이 들어 있습니다.';
            $('dlg-label').textContent = '현재 상태 JSON (읽기 전용)';
            ta.readOnly = true; ta.value = text;
            $('dlg-ok').textContent = '전체 선택'; $('dlg-cancel').textContent = '닫기';
        } else {
            $('dlg-title').textContent = 'JSON 붙여넣기';
            $('dlg-desc').textContent = '복사해 둔 JSON을 붙여넣으세요. 불러오면 지금 리비전 목록과 초안을 붙여넣은 내용으로 바꿉니다.';
            $('dlg-label').textContent = 'JSON';
            ta.readOnly = false; ta.value = ''; ta.placeholder = '{"format":"ohsolv-studio-test","version":1, ...}';
            $('dlg-ok').textContent = '불러오기'; $('dlg-cancel').textContent = '취소';
        }
        $('dlg').hidden = false; scrim.hidden = false;
        ta.focus();
        if (mode === 'export') ta.select();
    }
    function closeDialog() {
        $('dlg').hidden = true;
        if (!wb.dataset.drawer) scrim.hidden = true;
        dlgMode = null;
        if (dlgReturn && dlgReturn.focus) dlgReturn.focus();
    }
    function exportJson() {
        const st = store.getState();
        const json = JSON.stringify(JSON.parse(store.serialize()), null, 2);
        const done = () => { toast(`JSON 복사 완료 · 리비전 ${st.site.revisions.length}개, 현재 r${st.site.current}`); setStatus('JSON을 클립보드에 복사했습니다. 서버에는 저장하지 않습니다.', 'ok'); };
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(json).then(done, () => openDialog('export', json, '클립보드 접근이 막혀 있습니다. 아래 내용을 선택해 복사하세요.'));
                return;
            }
        } catch (e) { /* fall through */ }
        openDialog('export', json, '이 환경에서는 클립보드를 쓸 수 없습니다. 아래 내용을 선택해 복사하세요.');
    }
    function importJson() {
        const text = $('dlg-text').value;
        try {
            const savedObj = C.deserialize(text);
            store.load(savedObj);
            closeDialog();
            const st = store.getState();
            toast(`JSON 불러오기 완료 · 리비전 ${st.site.revisions.length}개, 현재 r${st.site.current}`);
            setStatus('붙여넣은 JSON으로 리비전 목록을 바꿨습니다.' + (savedObj.warnings && savedObj.warnings.length ? ' ' + savedObj.warnings.join(' ') : ''), 'ok');
        } catch (e) {
            $('dlg-err').textContent = '불러올 수 없습니다. ' + e.message;
        }
    }
    for (const id of ['btn-export', 'btn-export-m']) $(id).addEventListener('click', exportJson);
    for (const id of ['btn-import', 'btn-import-m']) $(id).addEventListener('click', () => { closeDrawers(); openDialog('import'); });
    $('dlg-close').addEventListener('click', closeDialog);
    $('dlg-cancel').addEventListener('click', closeDialog);
    $('dlg-ok').addEventListener('click', () => {
        if (dlgMode === 'import') importJson();
        else { const ta = $('dlg-text'); ta.focus(); ta.select(); }
    });
    $('dlg').addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') { ev.preventDefault(); closeDialog(); return; }
        if (ev.key === 'Tab') { // keep focus inside the dialog
            const f = Array.from($('dlg').querySelectorAll('button, textarea')).filter((x) => !x.disabled);
            const first = f[0], last = f[f.length - 1];
            if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
            else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
        }
    });

    // ------------------------------------------------------------ shortcuts
    const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    window.addEventListener('keydown', (ev) => {
        if (!$('dlg').hidden) return;
        if (typing(ev.target)) return;
        const mod = ev.ctrlKey || ev.metaKey;
        const k = (ev.key || '').toLowerCase();
        if (mod && k === 'z') { ev.preventDefault(); if (ev.shiftKey) store.redo(); else store.undo(); return; }
        if (mod && k === 'y') { ev.preventDefault(); store.redo(); return; }
        if (mod || ev.altKey) return;
        if (ev.key === 'Escape' && wb.dataset.drawer) { closeDrawers(); return; }
        if (k === 'd') { ev.preventDefault(); goDraw(); }
        else if (k === 'v') { store.setTool('select'); }
        else if (k === 'f') { const v = views[activeTab]; if (v && v.inst && v.inst.fit) v.inst.fit(); }
    });

    // ------------------------------------------------------------ test API + boot
    const api = {
        ready: false,
        store,
        core: C,
        ctx,
        setTab(name) { store.setTab(name); return waiter(name).promise; },
        viewReady(name) { return waiter(name).promise; },
        view(name) { return views[name] ? views[name].inst : null; },
        persistNow,
    };
    window.__studio = api;

    renderAll();
    showTab(store.getState().ui.tab);
    setStatus(bootNote || '합성 샘플 대지 r1을 표시합니다. 그리기(D)로 경계를 새로 작성할 수 있습니다.', 'info');
    if (bootNote) toast(bootNote);
    waiter('2D').promise.then(() => { api.ready = true; });
})();

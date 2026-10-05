# OHSOLV Studio 캔버스 테스트 — MAP / 2D / 3D · 대지 생성 기초

위키 기준: [D-H01] OHSOLV Studio(Workbench UI 기준), V2-C00 공통 코어(C00-01 Workbench, C00-02 UI 규칙, C00-04 저장, C00-05 변경·Undo, §6 경량화),
V2-M01 대지 생성(M01-01 직접 경계 작성, §5 Workflow, §6 UI 역할, §8 실패 처리, §10 초기 범위).
이 테스트는 **합성(SYNTHETIC) 데이터로 만든 단일 HTML 프로토타입**이다. 실제 필지·이태원동 133-6 값·서버 저장·로그인·DXF·주소 조회는 범위 밖이며 화면에서 그렇게 표시한다.

## 범위

| 포함 | 제외(화면에 "미구현"/"범위 밖"으로 표시) |
|---|---|
| Workbench 셸: TOP(프로젝트·안·siteRevision·저장 상태) / LEFT(6개 모듈 + 대지 생성 내부 패널) / CENTER(MAP·2D·3D 탭) / RIGHT(선택 기반 Inspector) / BOTTOM(AI 요청창, 비활성 표시) | 로그인, 서버 저장, 다른 5개 모듈 기능 |
| M01-01 직접 경계 작성: 폐합 폴리곤 작성, 꼭짓점 이동·삽입·삭제, 선택, 스냅(그리드·기존 필지 꼭짓점·직교), 치수 입력(변 길이·꼭짓점 좌표), Undo/Redo | 구멍(hole), 곡선, 복수 필지 |
| 채택 전 검사(M01 §8): 폐합 실패·자기교차·0면적·NaN·꼭짓점 3개 미만·중복 꼭짓점·극소 변 | DXF/DWG 불러오기, 주소·공공데이터 조회 |
| Preview → 취소/채택 → 새 siteRevision. 이전 리비전 보존, "이 리비전으로 복원" = 새 리비전 생성(C00-05) | 서버 Revision·충돌 처리 |
| MAP: 합성 도로·블록·필지·주변 건물을 위경도로 배치(MapLibre GL JS 5.24.0, 배경지도 없음), 필지 클릭 → Inspector → "이 필지로 대지 초안 만들기" | 실제 배경지도 타일(아티팩트 CSP가 외부 fetch 차단) |
| 3D: 채택된 대지 + 주변 합성 건물·도로·원경 지형의 기초 3D. 엔진은 3D 탭을 처음 열 때 로드(Babylon.js 기본, PlayCanvas 선택) | 정밀 지형(M01-04 후속), 매스(M03 모듈) |
| 브라우저 임시본(localStorage) + JSON 복사/붙여넣기 | 서버 저장. 화면에 "저장됨"이라 쓰지 않는다(C00-04: 서버 확인 Revision만 저장됨) |

## 데이터 표시 규칙(위키 원칙)
- 모든 자료에 모드 표시: `SYNTHETIC`(합성 샘플), `USER_PROVIDED`(사용자가 직접 그린 경계). 주변 건물 높이는 `ASSUMED`(합성 가정값).
- 좌표: 계산은 로컬 평면 좌표(m, e=동·n=북). 위경도는 표시·MAP 배치용 참고값이며 위경도 숫자로 길이·면적을 계산하지 않는다(M01 §7).
- 합성 기준점: 37.5665N, 126.9780E. **실제 지형·필지와 무관**하다고 MAP에 명시.
- 면적은 수평투영 면적(신발끈 공식). 공부상 면적 필드는 "없음(합성)".

## 파일 구조

| 경로 | 내용 | 담당 |
|---|---|---|
| `shared/studio-core.js` | `STUDIO_CORE` — 기하 검증·삼각분할·스냅·지오 변환·GeoJSON·3D용 site-aware core·스토어(명령/Undo/리비전/직렬화) | core |
| `tools/test-studio-core.mjs` | node 단위시험 (사각형·오목 다각형 면적, 자기교차, Undo/Redo, 채택·복원, 직렬화 왕복, 지오 왕복 오차) | core |
| `src/studio.html` | 페이지 조립(include 마커) | ui |
| `src/studio/head.html` | 폰트 `<link>` + `<style>`(토큰·레이아웃) + `<style><!--@include node_modules/maplibre-gl/dist/maplibre-gl.css--></style>` | ui |
| `src/studio/body.html` | Workbench 마크업 | ui |
| `src/studio/app.js` | 부팅, 탭·뷰 레지스트리, LEFT/TOP/RIGHT/BOTTOM, 단축키, `window.__studio` 테스트 API | ui |
| `src/studio/plan2d.js` | `createPlanView(container, store, ctx)` — Canvas2D 대지 도면 편집기 | ui |
| `src/studio/map.js` | `createMapView(container, store, ctx)` — MapLibre 지연 로드 | map |
| `src/studio/view3d.js` | `create3DView(container, store, ctx)` — 엔진 지연 로드 + 어댑터 | 3D (2단계) |
| `tools/smoke-studio.mjs` | 헤드리스 시험: 탭별 스크린샷·편집 시나리오·모바일 | ui |

페이지 조립(`src/studio.html`):
```html
<title>OHSOLV Studio 대지 캔버스</title>
<!--@include src/studio/head.html-->
<!--@include src/studio/body.html-->
<script data-inline="shared/scene-data.js,shared/scene-core.js,shared/studio-core.js,src/studio/plan2d.js,src/studio/map.js,src/studio/view3d.js,src/adapters/babylon-adapter.js,src/adapters/playcanvas-adapter.js,src/studio/app.js"></script>
```
(1단계에서는 view3d.js와 어댑터 줄이 없을 수 있다. 없는 파일은 넣지 않는다 — build가 실패한다.)
엔진·지도 라이브러리는 **동적 `<script>` 주입**으로 필요할 때 로드한다:
`https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js`, `https://cdn.jsdelivr.net/npm/babylonjs@9.29.0/babylon.js`, `https://cdn.jsdelivr.net/npm/playcanvas@2.23.0/build/playcanvas.min.js`.
`tools/smoke.mjs`의 라우팅처럼 시험에서는 이 URL을 `node_modules`로 대체한다.

## STUDIO_CORE API (shared/studio-core.js)

좌표 `[e, n]`(m). 폴리곤은 닫힘점 반복 없이 꼭짓점 배열.

기하
- `area(poly)`, `signedArea(poly)`, `perimeter(poly)`, `edgeLengths(poly)`, `centroid(poly)`, `toCCW(poly)`
- `validate(poly, {closed})` → `{ ok, issues:[{code, message(한국어), vertices?:[i], edges?:[i]}], area, perimeter, convex }`
  code: `TOO_FEW`, `NOT_CLOSED`, `NAN`, `DUPLICATE_VERTEX`(< 0.01 m), `TINY_EDGE`(< 0.1 m), `ZERO_AREA`(< 1 ㎡), `SELF_INTERSECT`
- `triangulate(poly)` → 삼각형 인덱스(ear clipping, 단순 다각형·오목 지원)
- `pointInPolygon(p, poly)`, `segmentIntersections(poly)`
- `snap(p, {gridStep, toleranceM, vertices, orthoFrom})` → `{ p, kind: 'vertex'|'ortho'|'grid'|null, target? }` (우선순위 vertex > ortho > grid)
- `snapVertices()` → 합성 필지·블록 꼭짓점 목록(스냅 대상)

지오(표시·MAP 전용)
- `GEO = { origin:{lat:37.5665, lon:126.978}, method, maxErrorM }` — WGS84 반경을 쓴 국지 평면 근사. `maxErrorM`은 단위시험으로 1 km 범위 실측한 최대 왕복/거리 오차.
- `toLonLat([e,n])`, `fromLonLat([lon,lat])`
- `geojson()` → `{ roads, blocks, parks, parcels(properties: id, area, block), buildings(properties: id, height, floors, heightStatus:'ASSUMED') }` (FeatureCollection, lon/lat)
- `parcelPolygon(id)`, `parcelAt([e,n])`

3D용
- `makeEngineCore(sitePoly)` → SITE_CORE와 같은 모양의 객체(어댑터에 그대로 전달). 원점을 대지 중심으로 옮긴 엔진 좌표를 만든다:
  `buildContext()`는 대지 안에 들어오는 주변 건물·가로수를 제외하고, `siteFill`(삼각분할)·`siteOutline`을 이 대지로 바꾼다. `origin:[ce,cn]`, `excluded:{buildings:n, trees:n}` 포함.
- `emptyMass(sitePoly)` → 층 없는 mass(`floors:[]`, 빈 roofSlab/rooftop, metrics는 대지면적만) — 어댑터 `setMass`용.

스토어 — `createStore(saved?)` (구독형, 프레임워크 없음)
```js
state = {
  project: { id: 'TEST-SYNTHETIC-001', name: '합성 테스트 프로젝트', option: 'A', mode: 'SYNTHETIC' },
  site: {
    revisions: [{ rev: 1, polygon, source: 'SYNTHETIC_SAMPLE'|'DIRECT'|'PARCEL'|'RESTORE', dataMode: 'SYNTHETIC'|'USER_PROVIDED',
                  area, perimeter, inputHash, note, createdAt }],
    current: 1,
    draft: null | { polygon, closed, source, baseRev, validation, history:[], future:[] },
  },
  selection: null | { kind:'vertex', i } | { kind:'edge', i } | { kind:'parcel', id } | { kind:'building', id } | { kind:'site' },
  layers: { boundary:true, roads:true, parcels:true, context:true, terrain:true },
  ui: { tab:'2D', engine:'babylon', tool:'select'|'draw' },
  persistence: 'none'|'local-temp',   // 서버 저장 없음
}
store.getState(); store.subscribe(fn) → unsubscribe
store.startDraft(polygon|null, source)      // null + 'DIRECT' = 빈 초안(그리기 모드)
store.edit(cmd)                              // 한 명령 = Undo 한 단계
   cmd: {type:'add', p} | {type:'close'} | {type:'move', i, p} | {type:'insert', edge, p} | {type:'remove', i}
        | {type:'setVertex', i, p} | {type:'setEdgeLength', edge, length} | {type:'replace', polygon}
store.preview(polygon)                       // 드래그 중 시각 초안(히스토리 미기록)
store.endPreview(commit:boolean)             // 드래그 종료 → commit이면 한 명령으로 기록
store.undo(); store.redo(); store.canUndo(); store.canRedo()
store.cancelDraft(); store.adoptDraft(note?) → rev | throws(검증 실패)
store.restoreRevision(rev)                   // 새 리비전 생성
store.select(sel); store.setLayer(name, on); store.setTab(t); store.setEngine(e); store.setTool(t)
store.serialize() → JSON 문자열; STUDIO_CORE.deserialize(json) → saved 객체(검증 실패 시 throws)
```
초기 상태: 리비전 1 = `SITE_DATA.site.polygon`(SYNTHETIC_SAMPLE, 42×30 m, 가각 3 m, 1,255.5 ㎡).

## 화면 기준(C00-01/02, M01 §6)

- **TOP**: "OHSOLV Studio" · 프로젝트명 · 안 A · `site r{n}` · 저장 상태 칩("브라우저 임시본 · 서버 저장 아님") · JSON 내보내기/가져오기 · 데이터 모드 칩 `SYNTHETIC`.
- **LEFT**: 6개 모듈(대지 생성 · 대지 분석 · 매스 생성 · 기획설계 · 사업성 · 법규 검토). 대지 생성만 활성, 나머지는 "미구현" 상태 칩(가짜 결과 없음).
  대지 생성 내부 패널: 입력 경로(직접 작성 / 필지 선택(MAP) / 파일 불러오기 — 미구현), 레이어 토글(경계·도로·필지·주변 건물·원경 지형 — 표시만 바꾸고 값은 안 바꿈), 리비전 목록.
- **CENTER**: 탭 MAP / 2D / 3D. 처음 화면은 2D(채택된 r1 표시). 탭 전환 시 비활성 뷰는 렌더 루프·리스너를 멈춘다.
- **RIGHT Inspector**: 선택 대상에 따라 바뀐다. 선택 없음 → 현재 대지 요약(면적·둘레·꼭짓점 수·중심 좌표(로컬 m + 위경도 참고)·모드·리비전·inputHash).
  꼭짓점 → 좌표 숫자 입력. 변 → 길이 숫자 입력. 필지 → 합성 필지 정보 + "이 필지로 대지 초안 만들기". 주변 건물 → 높이(ASSUMED)·층수.
  초안이 있으면 상단에 초안 카드: 검증 결과 목록, 채택 대지 대비 면적 차이(±㎡), [취소] [채택].
- **BOTTOM**: "OHSOLV AI Command — 이 테스트에서는 비활성" 접힌 바.
- 좁은 화면(≤ 900 px): 열람 중심. LEFT/RIGHT는 서랍(drawer)로 접고 CENTER 우선. 정밀 편집은 데스크톱 기준이라고 표시(C00-02).

2D 편집기(plan2d.js)
- 배경: 합성 필지선(옅게)·블록·도로·주변 건물 외곽(레이어 따름), 0.5/5/10 m 그리드(줌에 따라), 방위표, 축척 막대.
- 채택 대지: 빨간 1점쇄선 경계 + 꼭짓점. 초안: 진한 실선 + 꼭짓점 핸들 + 변 길이 치수 + 면적 표시. 검증 문제 위치(자기교차 지점, 극소 변)는 경고색.
- 도구: 선택(꼭짓점/변 선택·드래그 이동, 변 더블클릭 = 꼭짓점 삽입, Delete = 꼭짓점 삭제), 그리기(클릭 = 점 추가, 첫 점 클릭/Enter = 폐합, Esc = 취소, Backspace = 마지막 점 삭제).
  스냅: 꼭짓점(화면 10 px 이내) > 직교(Shift) > 그리드 0.5 m. 스냅 종류를 커서 옆에 표시.
- 이동: 휠 줌(커서 기준), 가운데/오른쪽 드래그 또는 Space+드래그 팬, "대지에 맞춤" 버튼. 터치: 한 손가락 팬·핀치 줌(열람).
- 단축키: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z(Ctrl+Y), D(그리기), V(선택), F(맞춤). 입력창 포커스 중에는 단축키 무시.

MAP(map.js)
- MapLibre 5.24.0을 처음 활성화 때 로드. 스타일은 인라인(배경 단색 + GeoJSON 소스만, glyphs 없음 → 텍스트 레이어 금지; 라벨이 필요하면 HTML Marker).
- 레이어: 블록(보도 포함), 도로, 공원, 필지(호버 강조), 주변 건물(2D 채움 ↔ 2.5D fill-extrusion 토글, 높이 ASSUMED), 채택 대지(빨간 선), 초안(점선).
- 필지 클릭 → `store.select({kind:'parcel', id})`, 건물 클릭 → `{kind:'building', id}`. 선택 강조.
- 우측 하단 안내: "합성 데이터 · 배경지도 없음(아티팩트 보안 정책) · 기준점 37.5665N 126.9780E는 실제 필지와 무관".
- NavigationControl, ScaleControl(미터). 활성화 시 대지에 맞춤. 비활성 시 resize/애니메이션 중지, 재활성 시 `map.resize()`.

3D(view3d.js, 2단계)
- 탭 활성 시 선택 엔진 스크립트를 지연 로드 → `createXxxAdapter(canvas, STUDIO_CORE.makeEngineCore(채택 대지))` → `init()` → `setMass(emptyMass)` → 태양(춘·추분 14:00) → `aerial`.
- 리비전이 바뀌면 다음 활성화 때(또는 활성 중이면 즉시) 어댑터를 dispose 후 재생성. 탭 비활성 시 렌더 정지(`pause()` 있으면 사용, 없으면 dispose).
- 엔진 선택(Babylon.js / PlayCanvas)과 로드 시간·드로우콜 표시. "채택된 리비전 r{n} 기준" 표시(초안은 3D에 반영 안 함).

## 시험 API
`window.__studio = { ready, store, core: STUDIO_CORE, setTab(name), viewReady(name) → Promise }`

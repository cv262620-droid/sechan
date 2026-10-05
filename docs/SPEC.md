# 가상대지 매스 스터디 — Babylon.js vs PlayCanvas

같은 장면(계획 건물 매스 + 주변 건물 + 주변 대지)을 두 웹 3D 엔진으로 각각 렌더링해 비교하는 테스트.
데이터·계산은 엔진과 무관한 공통 모듈에 두고, 엔진별 코드는 "렌더러 어댑터"만 맡는다.

## 파일 구조

| 경로 | 역할 | 수정 주체 |
|---|---|---|
| `tools/gen-scene-data.mjs` → `shared/scene-data.js` | 도로·블록·필지·주변 건물·가로수 데이터 (시드 고정, 생성물) | 사람/오케스트레이터 |
| `shared/scene-core.js` | `SITE_CORE`: 지오메트리 버퍼, 지형, 매스 파라미터·면적 산정, 태양 위치, 층 피킹 | 사람/오케스트레이터 |
| `shared/ui-head.html` | `<link>` 폰트 + `<style>` (UI 토큰·레이아웃) | UI 담당 |
| `shared/ui-body.html` | 패널·오버레이 마크업 + `<canvas id="scene">` | UI 담당 |
| `shared/ui-controller.js` | `startApp(createAdapter)` — UI 이벤트 ↔ SITE_CORE ↔ 어댑터 연결, `window.__app` 테스트 API | UI 담당 |
| `src/adapters/babylon-adapter.js` | `createBabylonAdapter(canvas, core)` | Babylon 담당 |
| `src/adapters/playcanvas-adapter.js` | `createPlayCanvasAdapter(canvas, core)` | PlayCanvas 담당 |
| `src/babylon.html`, `src/playcanvas.html` | 페이지 조립 (include 마커) | 통합 담당 |
| `tools/build.mjs` → `dist/*.html` | include 해석해 자기완결 HTML 생성 | — |
| `tools/smoke.mjs` | 헤드리스 Chromium(SwiftShader) 렌더 테스트 + 스크린샷(`.shots/`) | — |

명령: `node tools/build.mjs babylon && node tools/smoke.mjs babylon` (playcanvas 동일).
엔진은 CDN `https://cdn.jsdelivr.net/npm/babylonjs@9.29.0/babylon.js`, `https://cdn.jsdelivr.net/npm/playcanvas@2.23.0/build/playcanvas.min.js`
에서 로드한다(smoke 테스트는 이 URL을 `node_modules`로 대체). 다른 외부 리소스는 Google Fonts 외 금지.
게시 대상은 claude.ai Artifact: 페이지는 `<!doctype>/<html>/<head>/<body>` 없이 내용만 쓴다(호스트가 감쌈).

## 좌표계 (중요)

- 데이터(월드): `e` = 동(m), `n` = 북(m), `y` = 위(m). 원점 = 계획 대지 중심.
- `SITE_CORE`가 돌려주는 지오메트리는 **엔진 좌표**: 오른손 좌표계, Y-up, `x = e`, `y = y`, `z = -n` (북쪽 = -Z).
  삼각형은 법선 방향에서 볼 때 반시계(CCW, glTF/OpenGL 관례). 법선은 버퍼에 포함됨.
- Babylon.js: `scene.useRightHandedSystem = true` 로 두 엔진이 같은 버퍼를 그대로 쓴다.
  (초기 프로브에서 RH 모드 + 기본 재질로 일부 면이 컬링돼 보였음 → 재질의 sideOrientation / 컬링 설정을 스크린샷으로 확인할 것.)
- PlayCanvas: 기본이 오른손 Y-up이므로 그대로. 방향광은 엔티티의 **-Y 축** 방향으로 비춘다.
- 평면(Top) 뷰에서 북쪽이 화면 위, 동쪽이 오른쪽이어야 한다. 정오(동지 12:30)에 그림자는 북쪽(화면 위)으로 떨어져야 한다.

## SITE_CORE API (shared/scene-core.js)

- `buildContext()` → `{ terrain(colors 포함, RGBA), asphalt, platforms, parks, buildings, markingsYellow, markingsWhite, siteFill, trunks, crowns, parcelLines: [[x0,y0,z0,x1,y1,z1],...], siteOutline: [[x,y,z],...](닫힌 폴리라인), platformHeight }`
  각 지오메트리 = `{ positions:number[], normals:number[], indices:number[], colors:number[]|null }` (flat shading, 정점 비공유).
- `buildMainMass(params)` → `{ params, floors:[{level,label,kind:'podium'|'tower',use,footprint,area,y0,y1,floorLevel,height,slab,body}], roofSlab, rooftop, metrics:{siteArea,buildingArea,gfa,bcr,far,height,floorsAbove} }`
  `MASS_DEFAULTS = {podiumFloors:3, towerFloors:12, podiumFH:4.2, towerFH:3.9}`, `MASS_LIMITS`로 슬라이더 범위.
- `solarPosition({month, day, hour})` → `{altitude, azimuth(북=0, 시계방향), declination}` (서울 37.5665N 126.978E, KST).
  `SUN_PRESETS = {winter:동지 12/22, equinox:춘·추분 3/20, summer:하지 6/21}`. 검증: 동지 남중고도 29.0° @12:30.
- `sunVector(alt, az)` → 엔진 좌표에서 **지면→태양** 단위벡터. 광선 방향은 그 반대.
- `pickFloor(origin, dir, mass)` → 엔진 좌표 광선으로 계획 건물 층 판정 `{level, distance, point}` | null. (엔진 레이캐스트 대신 이것을 쓴다 → 두 엔진 동일 결과.)
- `fmt(v, digits)` 한국어 숫자 포맷.

## 어댑터 계약 (엔진 담당이 구현)

```js
// 전역 함수로 노출. canvas = <canvas id="scene">, core = SITE_CORE
async function createXxxAdapter(canvas, core) { ...; return adapter; }

adapter = {
  engineName: 'Babylon.js' | 'PlayCanvas' | 'three.js',
  engineVersion: string,            // 런타임에서 읽기 (BABYLON.Engine.Version / pc.version / 'r' + THREE.REVISION)
  async init(),                     // 주변 장면 전체 생성(지형, 아스팔트, 블록 플랫폼, 공원, 노면표시, 필지선, 대지 채움+경계선, 주변 건물, 가로수),
                                    // 조명·그림자·카메라(초기 'aerial')·렌더 루프 시작. 첫 프레임이 실제로 그려진 뒤 resolve.
  setMass(mass),                    // buildMainMass() 결과로 계획 건물 메시 재생성(이전 것 dispose). floors[].slab/body, roofSlab, rooftop.
                                    // 빈 매스(floors = [], 빈 roofSlab/rooftop — STUDIO_CORE.emptyMass)도 받는다: 메시 없음, 오류 없음,
                                    // 강조·카메라(매스 상자) 제한은 그대로 동작.
  setSun({ vector, altitude, azimuth }), // vector = sunVector(). altitude <= 0 이면 직사광 끄고 그림자 없음(어두운 환경광).
                                    // 고도가 낮을수록 약간 따뜻한 색, 환경광은 하늘/지면 반구광.
  setView(name, override?),         // 'aerial' | 'pedestrian' | 'top' | 'north' — 부드러운 카메라 전환(≤ 0.8 s, prefers-reduced-motion이면 즉시)
                                    // override(선택): { target:[x,y,z], azimuth, elevation, distance, fov } (엔진 좌표·도·m)가 있으면
                                    // 그 필드만 프리셋 값을 대신한다(시점 이름의 동작 — 보행자 제한 등 — 은 그대로). 매스 스터디는 쓰지 않음,
                                    // Studio 3D가 대지마다 가리지 않는 조감·보행자·북측 시점을 계산해 넘긴다.
  setLayer(name, visible),          // 'context'(주변 건물) | 'trees' | 'shadows' | 'terrain'(외곽 지형)
  setHighlight(level | null),       // 해당 층 slab+body 강조색, null이면 해제
  setViewInset({ left, bottom }),   // (선택) UI 패널이 덮는 캔버스 영역(CSS px). 데스크톱 = 왼쪽 패널 오른쪽 끝, 폰 = 하단 시트 높이.
                                    // 렌즈 시프트(off-axis 투영)로 화면 중심을 left/2 오른쪽, bottom/2 위로 옮긴다.
                                    // 눈 위치·궤도 중심·방위·피킹 광선은 바뀌지 않아야 함(screenToRay에 시프트 반영). 변경은 부드럽게(reduced-motion이면 즉시).
                                    // UI가 init() 전에 한 번, 이후 패널/캔버스 크기가 바뀔 때마다 호출.
  screenToRay(clientX, clientY),    // → { origin:[x,y,z], dir:[x,y,z] } 엔진 좌표 (UI가 core.pickFloor로 판정)
  cameraHeading(),                  // 카메라가 바라보는 방향의 방위각(북=0, 시계방향, 도) — UI 방위표 회전용
  stats(),                          // → { fps, drawCalls, triangles|null, frames? } frames = 지금까지 그린 프레임 수(일시정지 중엔 그대로)
  pause(), resume(),                // (선택) pause: 렌더 루프를 완전히 멈춘다(rAF·프레임 작업·GPU 작업 없음). resume: 다시 시작.
                                    // 둘 다 여러 번 불러도 안전. init() 중 pause는 첫 프레임 뒤에 적용(init은 그대로 resolve).
                                    // Studio 3D 탭이 숨을 때 pause, 다시 보일 때 resume.
  dispose()                         // 렌더 루프·리스너·GPU 자원 해제 + WebGL 컨텍스트를 즉시 놓는다(WEBGL_lose_context:
                                    // Babylon은 엔진 옵션 loseContextOnDispose, PlayCanvas는 app.destroy() 뒤 loseContext(),
                                    // three는 renderer.forceContextLoss()). 엔진 전환·리비전 재생성처럼 만들고 버리기를 반복해도
                                    // 브라우저의 활성 컨텍스트 한도(Chrome ≈ 16)에 걸려 살아 있는 뷰가 끊기지 않게.
}
```

카메라 조작: 마우스 왼쪽 드래그 = 궤도 회전, 오른쪽 드래그(또는 Shift+왼쪽) = 이동, 휠 = 줌, 터치: 한 손가락 회전·두 손가락 핀치 줌/이동.
지면 아래로 내려가지 않게 제한(극각 ≤ 88°), 줌 범위 약 15–900 m. 클릭(드래그 아님)은 UI가 처리하므로 어댑터는 canvas 이벤트를 막지 않는다.
추가 제한(세 엔진 동일):
- `pedestrian` 시점은 위를 올려다봐야 하므로(극각 ≈ 115°) 이 시점에서만 극각 제한 대신 "눈높이 ≥ 지면 + 1.7 m" 제한을 쓴다.
- 눈은 외곽 지형(`core.terrainHeight`) 위 1.7 m 아래로 내려가지 않는다(원경 언덕 속으로 들어가지 않게).
  궤도 중심(target)을 언덕 밑으로 이동한 경우(예: target (−600, 0, 700), 거리 15 m)는 앙각을 올려도 눈이 언덕 속에 남으므로,
  앙각이 30°를 넘으면 거리를 늘려 눈을 언덕 위로 꺼낸다(줌인이 언덕 표면에서 멈춤).
- 눈은 계획 건물 안으로 들어가지 않는다: 저층부·고층부(+옥탑) AABB를 4 m 키운 상자 밖으로, target→카메라 광선을 따라 거리를 늘린다
  (프리셋 target이 매스 안에 있어 줌인하면 건물 속으로 들어가기 때문).

카메라 프리셋(엔진 좌표, target 기준):
- `aerial`: target (0, 18, 0), 방위 150°(남남동에서 바라봄), 앙각 32°, 거리 240 m
- `pedestrian`: 눈높이 1.6 m, 동남측 교차로 건너편 보도 (e 31, n -31) → target (0, 22, 0) 근처, 시야각 넓게(≈ 70°)
- `top`: 바로 위에서 내려다봄, 북쪽이 화면 위, 대지 주변 ≈ 220 m 범위가 보이게. 원근 카메라, 거리 600 m(세로 화면 850 m),
  화면 짧은 변에 220 m가 들어가도록 FOV를 좁힘(≈ 20°) → 거의 정사영 평면도. 나머지 시점의 세로 FOV = 0.8 rad(45.8°), 보행자 70°.
- `north`: 북측(방위 0°)에서 바라봄, 앙각 18°, 거리 170 m — 북측 일영 확인용

## 장면 표현 (두 엔진 동일하게)

- 하늘/배경: 맑은 낮 하늘 느낌의 옅은 청회색 (단색 또는 간단한 그라디언트 OK). 원경 지형이 안개(선형/지수 fog)로 하늘에 녹아들게.
- 색(sRGB 기준 권장값, 두 엔진이 비슷해 보이도록 감마/톤매핑 차이를 보정):
  지형 = 정점색, 아스팔트 `#5b5f63`, 블록 플랫폼(보도·필지 바닥) `#d9d6cf`, 공원 `#9fb38a`, 노면표시 노랑 `#e2b83b` / 흰색 `#f2f2ee`,
  필지선 `#9a968d`(얇게), 대지 채움 `#efe6c8`, 대지경계선 빨강 `#d2352b`(굵게 보이도록 — 선 두께가 1px 고정이면 얇은 띠 메시로),
  주변 건물 `#eceae4`(무광 흰 모형 느낌), 가로수 줄기 `#6b5a48`, 수관 `#6f8f5a`,
  계획 건물: 저층부 body `#c98d4b`, 고층부 body `#d9a35f`(따뜻한 오렌지 계열 매스 모형), slab 띠 `#5a4636`, 옥탑 `#b9b2a6`, 강조(선택 층) `#2f7de1`.
  `roofSlab`은 옆면 = slab 색, 윗면(법선 y > 0.5) = 최상층 body 색(평면도에서 매스가 오렌지로 읽히게).
  계획 건물은 직사광을 받아도 위 색보다 밝아지지 않는다(조명 합 ≤ 1로 클램프).
- 조명 기준(감마 공간 값, Babylon StandardMaterial 기준; PlayCanvas는 선형 공간이라 L_linear = L_gamma^2.2로 변환해 같은 결과):
  반구광 하늘 `(0.68, 0.70, 0.73)` / 지면 `(0.52, 0.50, 0.47)`(수직 벽 = 평균 0.60), 태양 세기 `min(0.62, 0.32 / sin 고도)`,
  색온도 `(1, 0.80 + 0.17w, 0.62 + 0.30w)`, `w = clamp((고도 − 2°) / 20°)`. 황혼에는 반구광 × `0.42 + 0.58·clamp(고도/12°)`,
  하늘·안개 색 × `0.35 + 0.65·clamp((고도 + 4°)/14°)`. 결과: 햇빛 받는 수평면 ≈ 사양 색, 그늘진 벽 ≈ 사양 색 × 0.6.
- 오버레이 높이: 공원 +1 cm, 대지 채움·노면표시 +2 cm, 필지선 +3 cm, 대지경계 띠 +7 cm(플랫폼 기준), 평지 지형은 아스팔트보다 6 cm 아래.
  간격이 작으므로 각 엔진은 polygon offset(상수 항만; 기울기 항은 비스듬한 시점에서 과해짐)으로 z-fighting을 막는다.
- 대지경계 띠 폭 0.8 m(무광, 조명 영향 없음).
- 그림자: 대지 주변 반경 ≈ 200 m 안에서 선명하게(그림자맵 2048 이상, PCF/소프트). 주변 건물·계획 건물·가로수가 그림자를 드리우고 받음.
  (Babylon은 도시 전체를 덮는 맵을 변경 시에만 렌더, PlayCanvas는 카메라 시야에 맞춘 맵을 매 프레임 렌더 — 멀리 있는 블록은 그림자가 흐려짐.)
- 안티앨리어싱 켜기. devicePixelRatio는 최대 2로 제한.
- 성능 목표: 데스크톱 60 fps. 주변 건물·가로수·노면표시는 병합 메시(드로우콜 최소화).

## 테스트 API (UI 컨트롤러가 노출)

`window.__app = { ready, metrics(), stats(), setMass(partialParams), setSun({preset, hour}), setView(name), setLayer(name, visible), selectFloor(level|null), state() }`
`ready`는 `adapter.init()`이 끝나고 계획 건물·태양까지 적용된 뒤 `true`.

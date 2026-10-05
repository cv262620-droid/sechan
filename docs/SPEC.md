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
  engineName: 'Babylon.js' | 'PlayCanvas',
  engineVersion: string,            // 런타임에서 읽기 (BABYLON.Engine.Version / pc.version)
  async init(),                     // 주변 장면 전체 생성(지형, 아스팔트, 블록 플랫폼, 공원, 노면표시, 필지선, 대지 채움+경계선, 주변 건물, 가로수),
                                    // 조명·그림자·카메라(초기 'aerial')·렌더 루프 시작. 첫 프레임이 실제로 그려진 뒤 resolve.
  setMass(mass),                    // buildMainMass() 결과로 계획 건물 메시 재생성(이전 것 dispose). floors[].slab/body, roofSlab, rooftop.
  setSun({ vector, altitude, azimuth }), // vector = sunVector(). altitude <= 0 이면 직사광 끄고 그림자 없음(어두운 환경광).
                                    // 고도가 낮을수록 약간 따뜻한 색, 환경광은 하늘/지면 반구광.
  setView(name),                    // 'aerial' | 'pedestrian' | 'top' | 'north' — 부드러운 카메라 전환(≤ 0.8 s, prefers-reduced-motion이면 즉시)
  setLayer(name, visible),          // 'context'(주변 건물) | 'trees' | 'shadows' | 'terrain'(외곽 지형)
  setHighlight(level | null),       // 해당 층 slab+body 강조색, null이면 해제
  screenToRay(clientX, clientY),    // → { origin:[x,y,z], dir:[x,y,z] } 엔진 좌표 (UI가 core.pickFloor로 판정)
  cameraHeading(),                  // 카메라가 바라보는 방향의 방위각(북=0, 시계방향, 도) — UI 방위표 회전용
  stats(),                          // → { fps, drawCalls, triangles|null }
  dispose()                         // 선택
}
```

카메라 조작: 마우스 왼쪽 드래그 = 궤도 회전, 오른쪽 드래그(또는 Shift+왼쪽) = 이동, 휠 = 줌, 터치: 한 손가락 회전·두 손가락 핀치 줌/이동.
지면 아래로 내려가지 않게 제한(극각 ≤ 88°), 줌 범위 약 15–900 m. 클릭(드래그 아님)은 UI가 처리하므로 어댑터는 canvas 이벤트를 막지 않는다.

카메라 프리셋(엔진 좌표, target 기준):
- `aerial`: target (0, 18, 0), 방위 150°(남남동에서 바라봄), 앙각 32°, 거리 240 m
- `pedestrian`: 눈높이 1.6 m, 동남측 교차로 건너편 보도 (e 31, n -31) → target (0, 22, 0) 근처, 시야각 넓게(≈ 70°)
- `top`: 바로 위에서 내려다봄, 북쪽이 화면 위, 대지 주변 ≈ 220 m 범위가 보이게
- `north`: 북측(방위 0°)에서 바라봄, 앙각 18°, 거리 170 m — 북측 일영 확인용

## 장면 표현 (두 엔진 동일하게)

- 하늘/배경: 맑은 낮 하늘 느낌의 옅은 청회색 (단색 또는 간단한 그라디언트 OK). 원경 지형이 안개(선형/지수 fog)로 하늘에 녹아들게.
- 색(sRGB 기준 권장값, 두 엔진이 비슷해 보이도록 감마/톤매핑 차이를 보정):
  지형 = 정점색, 아스팔트 `#5b5f63`, 블록 플랫폼(보도·필지 바닥) `#d9d6cf`, 공원 `#9fb38a`, 노면표시 노랑 `#e2b83b` / 흰색 `#f2f2ee`,
  필지선 `#9a968d`(얇게), 대지 채움 `#efe6c8`, 대지경계선 빨강 `#d2352b`(굵게 보이도록 — 선 두께가 1px 고정이면 얇은 띠 메시로),
  주변 건물 `#eceae4`(무광 흰 모형 느낌), 가로수 줄기 `#6b5a48`, 수관 `#6f8f5a`,
  계획 건물: 저층부 body `#c98d4b`, 고층부 body `#d9a35f`(따뜻한 오렌지 계열 매스 모형), slab 띠 `#5a4636`, 옥탑 `#b9b2a6`, 강조(선택 층) `#2f7de1`.
- 그림자: 대지 주변 반경 ≈ 200 m 안에서 선명하게(그림자맵 2048 이상, PCF/소프트). 주변 건물·계획 건물·가로수가 그림자를 드리우고 받음.
- 안티앨리어싱 켜기. devicePixelRatio는 최대 2로 제한.
- 성능 목표: 데스크톱 60 fps. 주변 건물·가로수·노면표시는 병합 메시(드로우콜 최소화).

## 테스트 API (UI 컨트롤러가 노출)

`window.__app = { ready, metrics(), stats(), setMass(partialParams), setSun({preset, hour}), setView(name) }`
`ready`는 `adapter.init()`이 끝나고 계획 건물·태양까지 적용된 뒤 `true`.

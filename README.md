# 가상대지 매스 스터디 — 웹 3D 엔진 비교

가상의 대지 위에 계획 건물 매스를 올리고 주변 건물·주변 대지(도로, 블록, 필지, 가로수, 원경 지형)와 함께 보는 웹 3D 테스트.
같은 데이터·UI를 **Babylon.js**, **PlayCanvas**, **three.js**로 각각 렌더링해 비교한다. 모든 데이터는 생성된 가상 데이터다.

- 매스: 저층부/고층부 층수·층고 슬라이더 → 대지면적, 건축면적, 연면적, 건폐율, 용적률, 최고높이 즉시 산정
- 일영: 동지 / 춘·추분 / 하지, 06:00–19:00 태양 위치(서울 기준)와 그림자, 재생
- 보기: 조감(aerial) · 보행자 · 평면(top) · 북측 시점, 레이어(주변 건물·가로수·그림자·원경 지형), 층 클릭 → 층 정보
- 문서:
  - [docs/SPEC.md](docs/SPEC.md): 계약·좌표·색·카메라 규칙
  - [docs/COMPARISON.md](docs/COMPARISON.md): 세 엔진 측정 비교·실무 노트·OHSOLV Studio 관점 검토 자료
  - [docs/STUDIO-SPEC.md](docs/STUDIO-SPEC.md): OHSOLV Studio 캔버스 테스트 명세

## 페이지

| 페이지 | 원본 → 결과 | 엔진(CDN) | 내용 |
|---|---|---|---|
| Babylon.js 매스 스터디 | `src/babylon.html` → `dist/babylon.html` | Babylon.js 9.29.0 (`<script>`) | 매스 스터디 |
| PlayCanvas 매스 스터디 | `src/playcanvas.html` → `dist/playcanvas.html` | PlayCanvas 2.23.0 (`<script>`) | 매스 스터디 |
| three.js 매스 스터디 | `src/three.html` → `dist/three.html` | three.js r186 (ESM 동적 `import()`) | 매스 스터디 |
| OHSOLV Studio 대지 캔버스 | `src/studio.html` → `dist/studio.html` | MapLibre GL JS 5.24.0, 3D 탭은 세 엔진 중 선택(Babylon.js 기본, 모두 처음 쓸 때 로드) | MAP / 2D / 3D 탭, 대지 경계 작성·검사·채택·리비전 |

세 매스 스터디 페이지는 UI·데이터·계산이 같고 렌더러 어댑터만 다르다.
Studio는 합성 데이터로 만든 별도 프로토타입이다. 같은 세 어댑터를 페이지에 넣고, 3D 탭에서 같은 채택 대지를 세 엔진으로 바꿔 볼 수 있다.

## 구조

```
shared/scene-data.js        도로·블록·필지·주변 건물·가로수 데이터 (생성물, 직접 수정 금지)
shared/scene-core.js        SITE_CORE: 지오메트리 버퍼, 지형, 매스·면적 산정, 태양 위치, 층 피킹 (엔진 무관)
shared/ui-head.html         UI 스타일(토큰·레이아웃)
shared/ui-body.html         패널·오버레이 마크업 + <canvas id="scene">
shared/ui-controller.js     startApp(createAdapter): UI ↔ SITE_CORE ↔ 어댑터, window.__app 테스트 API
shared/studio-core.js       STUDIO_CORE: 기하 검증·삼각분할·스냅·지오 변환·스토어(Undo/리비전), makeEngineCore(대지 → 3D용 코어)
src/adapters/babylon-adapter.js     Babylon.js 9.29.0 렌더러 어댑터
src/adapters/playcanvas-adapter.js  PlayCanvas 2.23.0 렌더러 어댑터
src/adapters/three-adapter.js       three.js r186 렌더러 어댑터 (three.module.js를 CDN에서 import)
src/adapters/mock-adapter.js        Canvas2D 목업 어댑터 (WebGL 없이 UI만 시험, src/_mock.html)
src/babylon.html, src/playcanvas.html, src/three.html   매스 스터디 페이지 조립(include 마커)
src/studio.html             Studio 페이지 조립
src/studio/                 Studio UI: head.html, body.html, app.js(셸·탭·테스트 API), plan2d.js(2D), map.js(MAP), view3d.js(3D)
tools/build.mjs             src/*.html → dist/*.html (자기완결 HTML, 엔진·지도 라이브러리만 CDN)
tools/smoke.mjs             매스 스터디 헤드리스 렌더 테스트 + 스크린샷(.shots/)
tools/smoke-studio.mjs      Studio 헤드리스 테스트(탭별 스크린샷·편집 시나리오·모바일)
tools/test-studio-core.mjs  STUDIO_CORE 단위시험(node)
tools/gen-scene-data.mjs    scene-data.js 생성기(시드 고정)
```

## 빌드·테스트

```sh
npm install                                        # babylonjs, playcanvas, three, maplibre-gl, playwright (dev)
node tools/build.mjs                               # 모든 페이지 → dist/   (특정 페이지: node tools/build.mjs three)
node tools/smoke.mjs babylon playcanvas three      # 매스 스터디 렌더 테스트, 오류 있으면 exit 1
node tools/test-studio-core.mjs                    # Studio 코어 단위시험
node tools/build.mjs studio && node tools/smoke-studio.mjs   # Studio 테스트
node tools/build.mjs _mock && node tools/smoke.mjs _mock     # UI만 시험(목업 어댑터)
```

smoke 테스트가 하는 일:
- CDN 주소를 `node_modules`의 파일로 대신 내준다(CORS 헤더 포함 — three.js ES 모듈에 필요). 그 밖의 외부 요청(Google Fonts 제외)은 실패로 처리한다.
- `prefers-reduced-motion`으로 실행해 시점 전환을 즉시 적용한다.
- 데스크톱(라이트/다크)과 모바일에서 다음을 검사한다:
  - 콘솔 오류, 가로 넘침
  - 면적 산정, 시점(조감·보행자·평면·북측)
  - 평면도 색 표본(사양 색과 비교)
  - 레이어 끄기, 실제 클릭으로 층 선택, 모바일 하단 시트
- 스크린샷은 `.shots/<page>-*.png`(Studio는 `.shots/studio-*.png`)에 저장된다.

이 환경의 Chromium 경로는 `/opt/pw-browsers/chromium`이다(`tools/smoke.mjs`, `tools/smoke-studio.mjs`). 다른 환경에서는 그 경로만 바꾸면 된다.
SwiftShader의 시간·fps 값은 실제 GPU 성능이 아니다.

## 데이터 재생성

```sh
node tools/gen-scene-data.mjs   # shared/scene-data.js 다시 생성 (시드 고정 → 같은 결과)
node tools/build.mjs            # dist 갱신
```

계획 건물 형태(저층부·고층부·옥탑 평면), 매스 기본값·범위, 대지 위치(서울 37.5665N 126.978E)는 `shared/scene-core.js`에 있다.

## 좌표 규칙

- 데이터(월드): `e` = 동, `n` = 북, `y` = 위 (m). 원점 = 계획 대지 중심.
- 엔진 좌표(SITE_CORE가 돌려주는 버퍼): 오른손 Y-up, `x = e`, `y = y`, `z = −n`(북쪽 = −Z). 삼각형은 CCW가 앞면.
- Babylon은 `useRightHandedSystem = true`에 재질마다 CCW 앞면을 지정한다. PlayCanvas와 three.js는 기본 좌표계 그대로 쓴다.
- 평면(top) 시점은 북쪽이 화면 위, 동쪽이 오른쪽이다. 동지 12:30 그림자는 북쪽(화면 위)으로 떨어진다.
- 방위각은 북 = 0°, 시계방향. `sunVector()`는 지면에서 태양을 향하는 벡터이므로, 광선 방향은 그 반대다.

## 게시

`dist/*.html`은 `<!doctype>/<html>/<body>` 없이 내용만 담은 claude.ai Artifact용 조각이다(호스트가 감싼다).
엔진·지도 라이브러리는 jsDelivr CDN에서 받는다(three.js는 `three.module.js` + `three.core.js` 두 모듈, import map 없음). 폰트는 Google Fonts에서 받는다.

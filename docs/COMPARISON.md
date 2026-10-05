# Babylon.js vs PlayCanvas vs three.js — 매스 스터디 비교

같은 장면(계획 건물 매스 + 주변 건물 + 주변 대지)과 같은 UI·데이터·계산(`shared/*`)을 두고,
엔진별 코드는 렌더러 어댑터(`src/adapters/*-adapter.js`)만 다르게 만들어 비교했다.
버전: Babylon.js 9.29.0, PlayCanvas 2.23.0, three.js r186(npm `three@0.186.1`).
페이지: `src/babylon.html`, `src/playcanvas.html`, `src/three.html` → `dist/*.html`. 계약·색·조명 기준은 [SPEC.md](SPEC.md).

> 측정 환경: 헤드리스 Chromium + SwiftShader(소프트웨어 WebGL2), 1440×900 / 400×860, DPR 1.
> 측정 대상은 커밋 `b8f03e0`의 세 페이지(매스 스터디 계약만 구현한 어댑터)다. 이후 Studio용으로 어댑터에 더한 선택 기능은 줄 수에 들어 있지 않다.
> `node tools/build.mjs babylon playcanvas three && node tools/smoke.mjs babylon playcanvas three`를 2회 실행한 값이다.
> **시간·fps 값은 실제 GPU 성능을 대표하지 않는다**(SwiftShader에서는 한 프레임이 수백 ms). 크기·드로우콜·삼각형 수는 환경과 무관하다.

## 1. 측정 결과

| 항목 | Babylon.js | PlayCanvas | three.js | 비고 |
|---|---|---|---|---|
| 엔진 로드 방식 | `<script>` 1개 (UMD) | `<script>` 1개 (UMD) | 동적 `import()`, 요청 2개 (ESM) | three: `three.module.js`가 `three.core.js`를 import |
| 엔진 파일 | `babylon.js` | `playcanvas.min.js` | `three.module.js` + `three.core.js` | three npm 패키지에는 minified ESM이 없다 |
| 엔진 raw | 8,618,830 B (8.2 MiB) | 2,553,755 B (2.4 MiB) | 2,120,885 B (2.0 MiB) | three = 662,772 + 1,458,113 |
| 엔진 gzip(-9) | 1,853,541 B (1.8 MiB) | 655,522 B (640 KiB) | 417,103 B (407 KiB) | three = 130,745 + 286,358. Babylon의 약 1/4.4, PlayCanvas의 약 1/1.6 |
| 어댑터 줄 수(전체 / 공백 제외) | 643 / 610 | 754 / 713 | 811 / 770 | |
| 그중 카메라 구간(궤도·프레이밍·입력·프리셋) | 201 | 234 | 228 | 어댑터 안 구간 표시 기준. three는 PlayCanvas 컨트롤러를 이식했다 |
| 공통 코드(세 페이지 동일) | `scene-core.js` 350줄, `ui-controller.js` 507줄 | 〃 | 〃 | |
| 빌드된 페이지(엔진 제외) raw / gzip | 164,346 B / 42,884 B | 169,138 B / 44,562 B | 174,585 B / 46,170 B | 이 중 ≈ 58 KB가 `scene-data.js` |
| 드로우콜 (aerial, 기본 레이어) | 13 | 17 | 13 | PlayCanvas = 장면 13 + 그림자 캐스터 4(매 프레임) |
| 드로우콜 (모든 레이어 끔, top) | 9 | 9 | 9 | 주변 건물·가로수·그림자·외곽 지형 끔 |
| 삼각형 (aerial, 기본) | 56,544 | 56,544 | 56,544 | 지형 15,488 · 가로수 37,056 · 주변 건물 2,140 등 |
| 로드 → `ready` (`goto`부터) | 1,075–1,328 ms | 679–1,925 ms | 427–720 ms | 2회 × 3개 컨텍스트(데스크톱 라이트·다크, 모바일) |
| 로드 → `ready` (UI 스크립트 시작부터, 데스크톱) | 448 / 633 ms | 922 / 1,500 ms | 510 / 666 ms | `__app.stats().loadMs`. three만 이 구간에 엔진 다운로드·파싱이 들어간다 |
| fps | 의미 없음 | 의미 없음 | 의미 없음 | SwiftShader 1–7 fps |

그림자맵을 다시 그리는 시점이 다르다.
- Babylon과 three는 해·매스·레이어가 바뀔 때만 다시 그린다(Babylon `REFRESHRATE_RENDER_ONCE`, three `shadowMap.autoUpdate = false` + `needsUpdate`). 그래서 보통 프레임은 장면 패스만 센다.
- PlayCanvas의 방향광 그림자맵은 카메라 시야에 맞춰지므로 매 프레임 그린다.
- 세 엔진 모두 1장 4096²(폰 2048²).

### 일치도(같은 화면, 같은 입력)

| 검사 | Babylon.js | PlayCanvas | three.js | 사양 |
|---|---|---|---|---|
| 평면도·하지 12:30 대지 채움 색 | `#efe8cd` | `#efe8cd` | `#efe8cd` | `#efe6c8` |
| 〃 블록 플랫폼 | `#d9d8d4` | `#d9d8d4` | `#d9d8d4` | `#d9d6cf` |
| 〃 아스팔트 | `#5b6065` | `#5b6065` | `#5b6065` | `#5b5f63` |
| 보행자 시점 그늘진 주변 건물 벽 | `#8e8c89` | `#8e8c89` | `#8e8c89` | 흰 모형 × 0.6 |
| 동지 12:30 햇빛 받는 저층부 면 | `#c98d4b` | `#c98d4b` | `#c98d4b` | `#c98d4b` |
| 화면 중앙 클릭 → `pickFloor` | 6F | 6F | 6F | 같은 층 |
| top에서 휠 줌 끝까지 → 카메라 높이 | 68.0 m | 68.1 m | 68.0 m | 옥상(64.05 m) + 4 m |
| aerial에서 휠 줌 끝까지 → 카메라 위치 | (6.4, 25.9, 11.0) | (6.4, 25.9, 11.0) | (6.4, 25.9, 11.0) | 매스 박스 밖 |
| aerial에서 900 m까지 줌아웃 후 가장 낮게 궤도 → 카메라 높이 | 49.4 m | 33.7 m | 33.7 m | 지형 메시(이 위치 격자 최고점 32.0 m) 위 |
| `setMass` 200회 후 지오메트리·메시 수 | 변화 없음 | 변화 없음 | 변화 없음 | 누수 없음 |

- 색 표본 위 3줄은 `tools/smoke.mjs`가 매번 검사한다(채널 차 ≤ 24). 벽·저층부 색은 smoke 스크린샷의 같은 픽셀((620, 300–520), (880, 505))에서 읽었다.
- 카메라 3줄은 같은 절차(휠 40회, 같은 방향 드래그 반복)를 세 페이지에 똑같이 적용해 읽었다.
- 마지막 줄만 다르다. Babylon은 극각 88° 제한에서 멈춘다(target 18 m + 900 m × sin 2° = 49.4 m).
  PlayCanvas와 three는 멀리 있을 때 극각 2° 아래로도 내려가고, 지형 격자 최고점 + 1.7 m(33.7 m)에서 멈춘다. 셋 다 지형 위다.
- 그림자 방향: 동지 09:30 / 12:30 / 15:00 평면도의 그림자를 CPU 광선 추적 결과와 비교한 IoU는 0.983 / 0.928 / 0.968이다. 세 엔진의 값 차이는 0.002 이내다.

화면 전체 차이(평균 절대 픽셀 차, 채널값 0–255):

| 화면 | three ↔ Babylon | three ↔ PlayCanvas | Babylon ↔ PlayCanvas |
|---|---|---|---|
| 조감(aerial), 동지 12:30 | 0.91 | 0.72 | 1.23 |
| 보행자 | 0.76 | 0.75 | 1.13 |
| 평면도 | ≤ 0.07 | ≤ 0.07 | ≤ 0.07 |

three는 두 엔진 각각과의 차이가 두 엔진끼리의 차이보다 작다.
남은 차이:
- PlayCanvas는 아주 먼 블록(카메라에서 약 400 m 이상)의 그림자가 흐려지고, 그림자 가장자리가 Babylon보다 약간 부드럽다.
- 수관 아랫면은 Babylon이 조금 더 어둡다(반구광의 지면색).
- three는 Babylon처럼 도시 전체를 덮는 고정 그림자 범위를 쓴다(범위는 어댑터가 직접 계산).

## 2. 실무 노트

### 공통
- **좌표·면 방향**: 공통 버퍼는 오른손 Y-up, 북 = −Z, CCW 앞면. PlayCanvas와 three는 그대로 맞는다. Babylon은 설정이 더 필요하다(아래).
- **카메라 제한**(세 엔진 같은 규칙): 보행자 시점만 극각 대신 눈높이 제한, 외곽 지형 메시 위 1.7 m, 계획 건물 박스(+4 m) 밖.
  다만 멀리서 낮게 궤도할 때 PlayCanvas·three는 극각 88°보다 더 내려간다(1절 일치도 표 마지막 카메라 줄).
- **렌즈 시프트(패널 옆 프레이밍)**: UI가 `setViewInset({left, bottom})`으로 패널이 덮는 영역을 알려 준다. 엔진별 방법은 아래.
- **피킹**: 엔진 레이캐스트 대신 코어의 `pickFloor`를 쓴다. 그래서 세 엔진이 같은 층을 고른다.
- **z-fighting**: 오버레이 층 간격이 1–3 cm라 세 엔진 모두 polygon offset이 필요하다.
  Babylon·three는 상수 항만 쓴다(기울기 항은 비스듬한 시점에서 커져 아스팔트가 플랫폼을 덮는다). PlayCanvas는 두 항을 같이 쓴다.
- **누수**: `setMass` 200회 후 세 엔진 모두 버퍼·메시 수 변화 없음.

### Babylon.js 9.29.0
- **좌표**: `scene.useRightHandedSystem = true`로도 부족하다. RH 모드에서 새 메시의 기본 `sideOrientation`이 ClockWise라서 CCW 면이 컬링된다.
  모든 재질에 `CounterClockWiseSideOrientation`을 줘야 한다(glTF 로더가 하는 방식).
- **카메라**: `ArcRotateCamera`가 궤도·팬·줌·핀치·관성을 다 준다.
  - 9.x는 입력이 `camera.movement.input`(InputMapper)으로 바뀌었다. Shift+왼쪽 / 가운데 버튼 팬은 `addEntry` 한 줄씩.
  - 팬 속도는 거리에 비례하지 않으므로 매 프레임 `movement.panSpeed`를 다시 계산한다.
  - 지면 팬은 `mapPanning` + `panningAxis (1, 1, −1)`(RH 뷰 공간에서 +Z가 뒤).
- **렌즈 시프트**: 내장 기능이 없다. `onProjectionMatrixChangedObservable`에서 투영행렬 m[8], m[9]를 직접 더한다.
  `targetScreenOffset`은 눈 위치가 움직이므로 쓰지 않았다.
- **그림자**: `ShadowGenerator`(PCF, 4096²)를 도시 전체에 맞추고 변경 시에만 렌더한다 → 매 프레임 비용 없음, 먼 곳까지 같은 해상도.
  여드름(acne) 대책은 `normalBias` 0.32(월드 단위) + `bias` 0.0004. 0.12 m 슬래브 돌출이 근접 보행자 시점에서 점선처럼 보일 수 있다.
- **색**: `StandardMaterial`은 감마 공간 조명이다. 사양 sRGB 색을 그대로 쓴다.
  - 정점색 메시는 조명 합을 1로 자른 뒤 곱하고, 재질색 메시는 곱한 뒤에 자른다.
  - 그래서 매스(정점색)는 사양색을 넘지 않지만, 흰 주변 건물(재질색)은 하늘+태양 > 1이면 하얗게 날아간다. 태양 기여를 0.32/sin(고도)로 제한해 해결했다.
  - 반구광은 `HemisphericLight` 하나로 된다.
- **z-fighting**: `zOffset`(기울기 항)은 쓰지 않고 상수 항 `zOffsetUnits`만 쓴다.
- **동적 메시**: 층 강조는 정점색 버퍼만 `updateVerticesData`로 바꾼다.
- **통계**: `SceneInstrumentation.drawCallsCounter`. 메시를 만들거나 지운 직후에는 active mesh 목록이 비므로 렌더 후에 센다.
- **API 감각**: "다 들어 있는" 엔진이라 기능을 찾는 데 시간을 쓴다. 9.x 변경(InputMapper, panSpeed)이 문서·예제보다 앞서 있다.

### PlayCanvas 2.23.0
- **카메라**: 엔진 코어에 궤도 카메라가 없다. 포인터 이벤트로 궤도/팬/줌/핀치, 스무딩, 프리셋 트윈을 직접 작성했다.
  대신 제한(극각, 지형, 매스 박스)을 한곳에서 처리하기 쉽다.
- **렌즈 시프트**: `CameraComponent.projectionOffset`이 있다. 컬링·그림자 맞춤도 이것을 반영한다.
- **그림자**: 방향광 그림자는 카메라 프러스텀 조각의 외접구에 맞춰지고, 고정 월드 영역 옵션이 없어 매 프레임 렌더한다.
  - `shadowDistance`를 시점에 따라 계산(거리 × (1 + 0.8 cos 앙각) + 60 m)해 대상 주변 선명도를 Babylon에 맞췄다. 그 대가로 먼 블록은 그림자가 흐려진다.
  - 캐스케이드 2–3개는 아틀라스를 나눠 쓰므로 대상 주변이 오히려 흐려졌다.
  - `shadowBias`는 polygon offset(×−1000)이 되고, `normalOffsetBias`는 월드 m.
- **색**: 선형 조명 + `TONEMAP_LINEAR` + `GAMMA_SRGB`. 같은 그림을 얻으려면 Babylon 기준 조명값 L을 L^2.2로 바꿔 넣어야 한다.
  - 수직 벽(환경광) = 0.60^2.2, 윗면 보충광 = 0.70^2.2 − 0.60^2.2.
  - 태양은 수평면 결과가 같도록 채널별로 계산한다.
  - 매스 재질만 `combinePS` 청크를 바꿔 조명 합을 1로 자른다(Babylon과 동일).
  - 반구광이 없어 환경광 + 아래로 비추는 그림자 없는 방향광으로 근사했다(아랫면은 약간 밝다).
- **함정**:
  - 광원 세기 < 1은 `(색 × I)^2.2`, ≥ 1은 `색^2.2 × I`로 처리된다.
  - 정점색은 `vertexColorGamma = true`가 있어야 sRGB로 읽는다.
  - `clearColor`는 변환 없이 그대로 출력된다.
  - `device.maxPixelRatio` 기본값이 1이라 레티나에서도 1×로 그린다.
- **z-fighting**: `depthBias`/`slopeDepthBias`. 선(LINES)에는 적용되지 않는다.
- **동적 메시**: `Mesh.update()`는 업로드 후 CPU 데이터를 지우므로 강조 때 작은 매스 메시를 다시 만든다(`entity.destroy()`로 GPU 버퍼 해제).
- **통계**: `app.stats.drawCalls.total`. release 빌드에는 `primitiveCount`가 없어 메시 인스턴스로 삼각형을 직접 센다.
- **API 감각**: 코어가 얇고 명시적이다(AppBase + 컴포넌트 3개). 에디터 없이 쓰면 카메라·반구광 같은 기본기를 직접 만들어야 한다.

### three.js r186
- **로드(ESM 전용)**: 클래식 `<script>`로 넣을 빌드가 없다. 어댑터가 `import('https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js')`를 부른다.
  - `three.module.js`는 `./three.core.js`를 상대 경로로 import한다 → 요청 2개, import map 필요 없음.
  - addon(`OrbitControls`, `GLTFLoader` 등)은 맨 이름 `'three'`를 import하므로 import map이 있어야 한다. 그래서 궤도 카메라는 PlayCanvas 페이지의 것을 이식했다.
  - 모듈 promise를 `window`에 보관해 어댑터를 다시 만들어도 같은 three 인스턴스를 쓴다.
  - 시험에서 CDN을 로컬 파일로 대신 낼 때 CORS 헤더가 있어야 모듈이 로드된다(`tools/smoke.mjs`가 붙인다).
- **좌표**: 공통 버퍼가 three의 기본 좌표계와 같아 그대로 넣는다.
- **렌즈 시프트**: `PerspectiveCamera.setViewOffset`(off-axis 투영). `projectionMatrixInverse`에 반영되므로 `unproject`로 만든 피킹 광선도 화면과 맞는다.
- **그림자**:
  - r186에는 `PCFSoftShadowMap`이 없다(지정하면 경고 후 `PCFShadowMap`으로 바뀐다). `PCFShadowMap` + `shadow.radius` 1.5로 가장자리를 부드럽게 했다.
  - 방향광 그림자 카메라를 자동으로 맞춰 주지 않는다. 도시 블록 바닥·주변 건물 지붕·매스를 광원 공간으로 옮겨 정사영 박스를 직접 맞춘다.
  - `shadowMap.autoUpdate = false` + 변경 시 `needsUpdate = true` → Babylon처럼 바뀔 때만 다시 그린다.
  - `normalBias` = 텍셀 1.2개(월드 m), `bias` = 깊이 4 cm.
- **색 관리(가장 손이 많이 간 부분)**:
  - 작업 공간이 선형이다. `setHex`·`'#rrggbb'`는 sRGB로 보고 선형으로 바꾸지만, `setRGB(r, g, b)`는 기본이 선형이다(세 번째 인자로 색 공간 지정).
  - 정점색 속성은 변환 없이 항상 선형으로 읽는다. sRGB 정점색은 직접 선형화해 넣는다.
  - 광원이 물리 단위다. `MeshLambertMaterial`의 BRDF가 albedo/π라서 모든 광원 세기를 π로 둔다. 조명값은 PlayCanvas처럼 L^2.2로 넣는다.
  - 감마 공간 엔진(Babylon)과 픽셀까지 맞추려면 표준 sRGB 곡선이 아니라 순수 2.2 거듭제곱이 필요하다. `colorspace_fragment` 청크를 `pow(1/2.2)`로 바꾸는 셰이더 패치를 넣었다.
    표준 곡선에서는 어두운 곱(그늘진 아스팔트, 황혼)이 최대 6/255 어두웠다.
  - 배경·안개 색은 three가 직접 sRGB로 바꾸므로 hex 값 그대로 나온다.
  - 매스는 조명 합 ≤ 1 클램프를 `outgoingLight` 식 패치로 넣었다(Babylon·PlayCanvas와 동일).
  - `NoToneMapping`, `outputColorSpace = SRGBColorSpace`.
- **안개**: three의 `Fog`는 깊이 기준 smoothstep이다. Babylon의 반경 거리 선형 안개로 바꾸는 패치를 넣었다.
  거리를 정점에서 계산하면 수백 m짜리 아스팔트·플랫폼 삼각형 가운데가 잘못 흐려지므로 프래그먼트에서 계산한다.
- **업그레이드 위험**: 위 셰이더 패치(문자열 치환 6곳: 출력 감마 1, 안개 4, 매스 클램프 1)는 r186 청크 문자열에 의존한다.
  문자열이 바뀌면 치환이 오류 없이 빠지고 색·안개만 조용히 달라진다. three 버전을 올릴 때 색 표본과 화면 차이를 다시 재야 한다.
- **z-fighting**: `polygonOffsetFactor = 0`, `polygonOffsetUnits`만 쓴다(Babylon과 같은 선택).
- **동적 메시**: 매스는 메시 1개. 층 강조는 color 속성만 바꾸고 `needsUpdate`, `setMass`는 지오메트리만 바꾼다(이전 것 `dispose()`).
- **통계**: `renderer.info.render.calls` / `.triangles`. 그림자맵을 다시 그린 프레임은 캐스터 드로우도 함께 센다.
- **API 감각**: 렌더러·장면·재질이 명시적이고 셰이더 청크를 바꾸기 쉽다. 대신 카메라 조작, 그림자 범위, 다른 엔진과의 색 일치는 직접 만들어야 한다.

## 3. BIM 뷰어 관점

- **모델 투입**: 세 엔진 모두 IFC를 직접 읽지 못한다. web-ifc 같은 파서로 메시·속성으로 바꾼 뒤 넣는 구조가 된다.
  이번처럼 "공통 코어가 지오메트리·면적·피킹을 계산하고 엔진은 그리기만" 하는 분리가 엔진 교체·비교에 유리했다.
  three.js는 공통 코드(`shared/*`)를 그대로 두고 어댑터와 페이지 조립 파일만 더해 붙였다(시험 도구는 모듈용 CORS 헤더 한 줄 추가).
- **기본 제공 vs 직접 작성**(이번 어댑터 기준):

| 기능 | Babylon.js | PlayCanvas | three.js |
|---|---|---|---|
| 엔진 로드 | `<script>` 1개 | `<script>` 1개 | ESM `import()`, 요청 2개 |
| 궤도 카메라 | 내장 `ArcRotateCamera` | 직접 작성 | 코어에 없음. addon은 import map 필요 → 직접(이식) |
| 반구광 | `HemisphericLight` | 근사(환경광 + 방향광) | `HemisphereLight` |
| 바뀔 때만 그리는 그림자 | 내장, 범위 자동 | 없음(시야 맞춤, 매 프레임) | `autoUpdate = false`, 범위는 직접 계산 |
| 렌즈 시프트 | 투영행렬 직접 수정 | `projectionOffset` | `setViewOffset` |
| Babylon 기준 색 맞추기 | 그대로(감마 공간) | 조명값 L^2.2 + 청크 1개 | 조명값 L^2.2 + 세기 π + 셰이더 치환 6곳 |
| glTF extras | 별도 로더 스크립트(`babylonjs-loaders`)의 `ExtrasAsMetadata` → `metadata` | 이번에 확인 안 함 | addon `GLTFLoader` → `userData` (import map 필요) |

- 어느 엔진이든 실제 GPU(특히 모바일)에서 fps·메모리(예: Babylon 그림자맵 4096² 32F ≈ 64 MB)를 다시 측정해야 한다. 이 문서의 시간 값은 SwiftShader 기준이다.

## 4. OHSOLV Studio 관점 (DS-W02 결정 참고)

> **검토 자료다. 결정이 아니다.** 이 저장소에서 측정하거나 코드로 확인한 사실만 적었다. 엔진 선택은 DS-W02에서 따로 정한다.

| 관점 | 사실 |
|---|---|
| 웹 IFC 생태계 | web-ifc는 엔진과 무관한 WASM 파서다. 그 위의 웹 BIM 뷰어 도구 묶음 That Open Engine(구 IFC.js)은 three.js 기반이다. |
| 엔진 다운로드(gzip) | three.js 417,103 B(≈ 417 KB, 비압축 ESM 2개) < PlayCanvas 655,522 B < Babylon.js 1,853,541 B. 셋 중 three가 가장 작다. |
| Babylon.js | 기본 제공이 가장 많다: 궤도 카메라, 반구광, 한 번만 그리는 그림자(범위 자동), glTF extras → `metadata`(로더 확장). 엔진이 가장 크다. |
| PlayCanvas | 두 클래식(UMD) 빌드 중 작은 쪽이다. 궤도 카메라는 직접 작성했다. 그림자는 시야에 맞춰 매 프레임 그리며, 카메라에서 약 400 m 이상 떨어진 블록은 그림자가 흐려진다. |
| three.js | 코어만 쓰면 import map 없이 동작한다. addon(OrbitControls, GLTFLoader)은 import map이 필요해 이번엔 카메라를 직접(이식) 만들었다. 그림자 범위는 직접 계산, Babylon과의 색 일치는 셰이더 패치로 맞췄고 이 패치는 버전에 묶인다. |
| 화면 일치 | 세 엔진의 평면도 색 표본이 같고, 그림자 IoU 차이 ≤ 0.002, 피킹 결과가 같다. three는 다른 두 엔진 각각과의 차이(조감 0.91 / 0.72)가 두 엔진끼리의 차이(1.23)보다 작다. |
| Studio에서 직접 비교 | Studio 3D 탭에서 같은 채택 대지(`STUDIO_CORE.makeEngineCore`)를 세 엔진으로 바꿔 볼 수 있다. 명세는 [STUDIO-SPEC.md](STUDIO-SPEC.md). |
| 아직 재지 않은 것 | 실제 GPU·모바일의 fps·메모리, 실제 IFC 모델 로드. |

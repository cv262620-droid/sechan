# Babylon.js vs PlayCanvas — 매스 스터디 비교

같은 장면(계획 건물 매스 + 주변 건물 + 주변 대지)과 같은 UI·데이터·계산(`shared/*`)을 두고,
엔진별 코드는 렌더러 어댑터(`src/adapters/*-adapter.js`)만 다르게 만들어 비교했다.
버전: Babylon.js 9.29.0, PlayCanvas 2.23.0. 계약·색·조명 기준은 [SPEC.md](SPEC.md).

> 측정 환경: 헤드리스 Chromium + SwiftShader(소프트웨어 WebGL2), 1440×900 / 400×860, DPR 1.
> **시간·fps 값은 실제 GPU 성능을 대표하지 않는다**(SwiftShader에서는 한 프레임이 수백 ms). 크기·드로우콜·삼각형 수는 환경과 무관.

## 1. 측정 결과

| 항목 | Babylon.js | PlayCanvas | 비고 |
|---|---|---|---|
| 엔진 번들 raw | 8,618,830 B (8.2 MiB) `babylon.js` | 2,553,755 B (2.4 MiB) `playcanvas.min.js` | CDN 로드 |
| 엔진 번들 gzip(-9) | 1,853,541 B (1.8 MiB) | 655,522 B (640 KiB) | PlayCanvas가 약 1/2.8 |
| 어댑터 줄 수(전체 / 공백 제외) | 643 / 610 | 754 / 713 | 차이의 대부분은 PlayCanvas의 자체 궤도 카메라 |
| 공통 코드(두 페이지 동일) | `scene-core.js` 350줄, `ui-controller.js` 507줄 | 〃 | |
| 빌드된 페이지(엔진 제외) raw / gzip | 164,346 B / 42,884 B | 169,138 B / 44,562 B | 이 중 ≈ 58 KB가 `scene-data.js` |
| 드로우콜 (aerial, 기본 레이어) | 13 | 17 | PlayCanvas = 장면 13 + 그림자 캐스터 4(매 프레임) |
| 드로우콜 (모든 레이어 끔, top) | 9 | 9 | 주변 건물·가로수·그림자·외곽 지형 끔 |
| 삼각형 (aerial, 기본) | 56,544 | 56,544 | 지형 15,488 · 가로수 37,056 · 주변 건물 2,140 등 |
| 로드 → `ready` (smoke, `goto`부터) | 1,056–1,338 ms | 686–2,892 ms | 2회 × 3개 컨텍스트, SwiftShader |
| 로드 → `ready` (UI 스크립트 시작부터, 데스크톱) | 432–483 ms | 920–1,653 ms | `__app.stats().loadMs`, SwiftShader |
| fps | 의미 없음 | 의미 없음 | SwiftShader 1–16 fps |

Babylon은 그림자맵을 해·매스·레이어가 바뀔 때만 다시 그린다(`REFRESHRATE_RENDER_ONCE`). 그래서 보통 프레임은 장면 패스만 센다.
PlayCanvas의 방향광 그림자맵은 카메라 시야에 맞춰지므로 매 프레임 그린다(1장 4096², 폰 2048²).

### 일치도(같은 화면, 같은 입력)

| 검사 | Babylon.js | PlayCanvas | 사양 |
|---|---|---|---|
| 평면도·하지 12:30 대지 채움 색 | `#efe8cd` | `#efe8cd` | `#efe6c8` |
| 〃 블록 플랫폼 | `#d9d8d4` | `#d9d8d4` | `#d9d6cf` |
| 〃 아스팔트 | `#5b6065` | `#5b6065` | `#5b5f63` |
| 보행자 시점 그늘진 주변 건물 벽 | `#8e8c89` | `#8e8c89` | 흰 모형 × 0.6 |
| 동지 정오 햇빛 받는 저층부 면 | `#c98d4b` | `#c98d4b` | `#c98d4b` |
| 화면 중앙 클릭 → `pickFloor` | 6F | 6F | 같은 층 |
| top에서 휠 줌 끝까지 → 카메라 높이 | 68.0 m | 68.1 m | 옥상(64.05 m) + 4 m |
| aerial에서 휠 줌 끝까지 → 카메라 위치 | (6.4, 25.9, 11.0) | (6.4, 25.9, 11.0) | 매스 박스 밖 |
| 900 m 밖 낮게 궤도 → 카메라 높이 / 지면 | 64.9 / 42.7 m | 64.9 / 42.7 m | 지형 메시 위 |

색은 `tools/smoke.mjs`가 매번 검사한다(채널 차 ≤ 24). 남은 차이: PlayCanvas는 아주 먼 블록(카메라에서 약 400 m 이상)의 그림자가 흐려지고,
그림자 가장자리가 Babylon보다 약간 부드럽다. 수관 아랫면은 Babylon이 조금 더 어둡다(반구광의 지면색).

## 2. 실무 노트

### 좌표·면 방향
- 공통 버퍼는 오른손 Y-up, 북 = −Z, CCW 앞면. PlayCanvas는 그대로 맞는다.
- Babylon은 `scene.useRightHandedSystem = true`로도 부족하다. RH 모드에서 새 메시의 기본 `sideOrientation`이 ClockWise라서 CCW 면이 컬링된다.
  모든 재질에 `CounterClockWiseSideOrientation`을 줘야 한다(glTF 로더가 하는 방식).

### 카메라 — 직접 만든 것
- **Babylon**: `ArcRotateCamera`가 궤도·팬·줌·핀치·관성을 다 준다. 9.x는 입력이 `camera.movement.input`(InputMapper)으로 바뀌었다.
  Shift+왼쪽 / 가운데 버튼 팬은 `addEntry` 한 줄씩. 팬 속도는 거리에 비례하지 않으므로 매 프레임 `movement.panSpeed`를 다시 계산한다.
  지면 팬은 `mapPanning` + `panningAxis (1, 1, −1)`(RH 뷰 공간에서 +Z가 뒤).
- **PlayCanvas**: 엔진 코어에 궤도 카메라가 없다. 포인터 이벤트로 궤도/팬/줌/핀치, 스무딩, 프리셋 트윈을 직접 작성했다(약 120줄).
  대신 제한(극각, 지형, 매스 박스)을 한곳에서 처리하기 쉽다.
- **렌즈 시프트(패널 옆 프레이밍)**: PlayCanvas 2.23은 `CameraComponent.projectionOffset`이 있다. 컬링·그림자 맞춤도 이것을 반영한다.
  Babylon은 내장 기능이 없어 `onProjectionMatrixChangedObservable`에서 투영행렬 m[8], m[9]를 직접 더한다.
  `targetScreenOffset`은 눈 위치가 움직이므로 쓰지 않았다. 지금은 UI가 `setViewInset({left, bottom})`으로 알려 준다.
- 두 엔진 모두 같은 규칙을 넣었다: 보행자 시점만 극각 대신 눈높이 제한, 외곽 지형 메시 위 1.7 m, 계획 건물 박스(+4 m) 밖.

### 그림자
- **Babylon**: `ShadowGenerator`(PCF, 4096²)를 도시 전체에 맞추고 변경 시에만 렌더 → 매 프레임 비용 없음, 먼 곳까지 같은 해상도.
  여드름(acne) 대책은 `normalBias` 0.32(월드 단위) + `bias` 0.0004. 0.12 m 슬래브 돌출이 근접 보행자 시점에서 점선처럼 보일 수 있다.
- **PlayCanvas**: 방향광 그림자는 카메라 프러스텀 조각의 외접구에 맞춰지고 고정 월드 영역 옵션이 없어 매 프레임 렌더한다.
  `shadowDistance`를 시점에 따라 계산(거리 × (1 + 0.8 cos 앙각) + 60 m)해 대상 주변 선명도를 Babylon에 맞췄다. 그 대가로 먼 블록은 그림자가 흐려진다.
  캐스케이드 2–3개는 아틀라스를 나눠 쓰므로 대상 주변이 오히려 흐려졌다. `shadowBias`는 polygon offset(×−1000)이 되고, `normalOffsetBias`는 월드 m.

### 색 관리 (가장 큰 함정)
- **Babylon `StandardMaterial`**: 감마 공간 조명이다. 사양 sRGB 색을 그대로 쓴다.
  다만 정점색 메시는 조명 합을 1로 자른 뒤 곱하고, 재질색 메시는 곱한 뒤에 자른다.
  그래서 매스(정점색)는 사양색을 넘지 않지만 흰 주변 건물(재질색)은 하늘+태양 > 1이면 하얗게 날아간다. 태양 기여를 0.32/sin(고도)로 제한해 해결했다.
- **PlayCanvas**: 선형 조명 + `TONEMAP_LINEAR` + `GAMMA_SRGB`. 같은 그림을 얻으려면 Babylon 기준 조명값 L을 L^2.2로 바꿔 넣어야 한다.
  - 수직 벽(환경광) = 0.60^2.2, 윗면 보충광 = 0.70^2.2 − 0.60^2.2.
  - 태양은 수평면 결과가 같도록 채널별로 계산한다.
  - 매스 재질만 `combinePS` 청크를 바꿔 조명 합을 1로 자른다(Babylon과 동일).
- PlayCanvas 함정 몇 가지:
  - 광원 세기 < 1은 `(색 × I)^2.2`, ≥ 1은 `색^2.2 × I`로 처리된다.
  - 정점색은 `vertexColorGamma = true`가 있어야 sRGB로 읽는다.
  - `clearColor`는 변환 없이 그대로 출력된다.
  - `device.maxPixelRatio` 기본값이 1이라 레티나에서도 1×로 그린다.
- 반구광: Babylon은 `HemisphericLight` 하나. PlayCanvas는 환경광 + 아래로 비추는 그림자 없는 방향광으로 근사했다(아랫면은 약간 밝다).

### 기타
- **z-fighting**:
  - 오버레이 층 간격이 1–3 cm라 두 엔진 모두 polygon offset이 필요하다.
  - Babylon `zOffset`(기울기 항)은 비스듬한 시점에서 커져 아스팔트가 플랫폼을 덮는다. 상수 항 `zOffsetUnits`만 써야 한다.
  - PlayCanvas는 `depthBias`/`slopeDepthBias`를 쓴다. 선(LINES)에는 적용되지 않는다.
- **동적 메시**:
  - Babylon은 정점색 버퍼만 `updateVerticesData`로 바꿔 층 강조를 한다.
  - PlayCanvas `Mesh.update()`는 업로드 후 CPU 데이터를 지우므로 강조 때 작은 매스 메시를 다시 만든다(`entity.destroy()`로 GPU 버퍼 해제).
  - 200회 `setMass` 후 두 엔진 모두 버퍼·메시 수 변화 없음(이전 단계 QA).
- **통계**:
  - Babylon은 `SceneInstrumentation.drawCallsCounter`를 쓴다. 메시를 만들거나 지운 직후에는 active mesh 목록이 비므로 렌더 후에 센다.
  - PlayCanvas는 `app.stats.drawCalls.total`을 쓴다. release 빌드에는 `primitiveCount`가 없어 메시 인스턴스로 삼각형을 직접 센다.
- **API 감각**:
  - Babylon은 "다 들어 있는" 엔진이라 기능을 찾는 데 시간을 쓴다. 9.x 변경(InputMapper, panSpeed)이 문서·예제보다 앞서 있다.
  - PlayCanvas는 코어가 얇고 명시적이다(AppBase + 컴포넌트 3개). 에디터 없이 쓰면 카메라·반구광 같은 기본기를 직접 만들어야 한다.

## 3. BIM 뷰어 관점

- **모델 투입**: IFC는 두 엔진 모두 기본 지원이 없다. web-ifc 등으로 메시·속성으로 바꾼 뒤 넣는 구조가 된다.
  이번처럼 "공통 코어가 지오메트리·면적·피킹을 계산하고 엔진은 그리기만" 하는 분리가 엔진 교체·비교에 유리했다.
  `pickFloor`를 엔진 레이캐스트 대신 코어에서 해서 두 엔진이 같은 층을 고른다.
- **Babylon이 유리한 점**:
  - 궤도 카메라, 반구광, 한 번만 그리는 그림자맵이 기본 제공이라 정적인 건축 모델(일영 검토)에 바로 맞는다.
  - 감마 공간 StandardMaterial은 사양 색 그대로 "모형" 느낌을 내기 쉽다.
  - 대신 엔진이 무겁다(gzip 1.8 MiB).
- **PlayCanvas가 유리한 점**:
  - 번들이 작다(gzip 640 KiB). 선형 색 관리가 물리적으로 일관되다.
  - 렌즈 시프트 등 카메라 투영 기능이 깔끔하다.
  - 대신 뷰어 기본기(궤도 카메라)를 직접 만들어야 한다. 그림자가 시야 의존이라 넓은 일영 범위를 한 장에 선명하게 보기 어렵다.
- **실무 권장**:
  - 일영·매스 검토처럼 정적 장면을 넓게 보는 뷰어는 Babylon이 손이 덜 간다.
  - 가벼운 웹 임베드·모바일 우선이면 PlayCanvas가 낫다. 이 경우 카메라·그림자 범위를 직접 설계할 각오가 필요하다.
  - 어느 쪽이든 실제 GPU(특히 모바일)에서 fps·메모리(그림자맵 4096² 32F ≈ 64 MB)를 다시 측정해야 한다. 이 문서의 시간 값은 SwiftShader 기준이다.

# Active Ragdoll — 기술 명세 (v0.0 → v1.0 전체 로드맵)

Euphoria(NaturalMotion)처럼 **물리 상황에 반응해 스스로 버티고, 비틀거리고, 붙잡고, 넘어지고, 다시 일어나는** 캐릭터를 웹에서 만든다.
미리 만든 애니메이션을 재생하는 것이 아니다. 관절 근육 제어, 균형 판단, 행동 선택으로 동작을 매 프레임 생성한다. 애니메이션은 "근육이 따라가려는 목표"로만 쓴다.

이 문서는 LLM 코딩 에이전트가 처음(v0.0)부터 최종(v1.0)까지 단계적으로 구현하기 위한 명세다.

- **한 번에 한 마일스톤씩** 구현한다. 완료 기준을 전부 통과한 뒤에 다음으로 넘어간다.
- 마일스톤 순서: `0.0 → 0.1 → 0.2 → 0.3 → 0.4 → 0.5a → 0.5b → 0.5c → 0.6 → 0.7 → 0.8a → 0.8b → 0.8c → 0.9 → 1.0`. 이 순서를 `config/milestones.json`에 두고, 마일스톤 비교는 모두 이 목록의 위치로 한다 (문자열·숫자 비교 금지).
- 이전 마일스톤의 시나리오가 깨지면 새 작업보다 먼저 고친다.
- 문서에 없는 결정은 README의 "결정 기록"에 남긴다.

---

## 목차

1. 최종 목표 (v1.0 완성의 정의)
2. 기술 스택
3. 핵심 설계 원칙
4. 좌표계와 단위
5. 디렉터리 구조
6. 랙돌 정의
7. 시뮬레이션 아키텍처와 API
8. 관측: 로그, 지표, 필름스트립, 보고서
9. 시나리오 시스템
10. 품질 지표 (자연스러움 측정)
11. 애니메이션 자산 파이프라인 (Mixamo, Kimodo)
12. 마일스톤 v0.0 ~ v1.0
13. 명령어
14. 앱 (브라우저 UI)
15. 성능 예산
16. 참고 문헌
17. 미정 사항

---

## 1. 최종 목표 (v1.0 완성의 정의)

v1.0은 아래 항목을 **모두** 만족할 때 완성이다.

### 반응
- 서 있는 캐릭터를 어느 방향에서 밀어도 충격 크기에 따라 다르게 반응한다. 작으면 상체로 버티고, 중간이면 1~3 스텝으로 버티고, 크면 비틀거리다 넘어진다. 단계 사이의 전환은 연속적이다.
- 넘어질 때 손을 짚고, 뒤로 넘어지면 머리를 보호하고, 높은 곳에서 떨어지면 공중에서 허우적대다 착지하거나 구른다.
- 총탄, 근접 타격, 폭발에 각각 다르게 반응한다. 맞은 부위의 힘이 빠지고, 맞은 곳을 손으로 움켜쥔다.
- 다리를 다치면 절뚝이고, 사망 처리되면 힘이 빠진다.
- 근처에 잡을 수 있는 난간이나 모서리가 있으면 붙잡는다. 벽에 밀리면 벽에 기댄다.
- 쓰러진 뒤에는 현재 자세에 맞는 동작으로 일어나서 Idle로 돌아온다.

### 애니메이션과의 공존
- 걷기·Idle 같은 클립을 재생하는 도중에 맞아도 동작이 끊기지 않고 물리 반응이 섞인다.
- 애니메이션 재생(키네마틱), 액티브(근육+균형), 완전 랙돌, 일어서기 사이를 튐 없이 전환한다.
- X Bot의 비율을 바꾼 체형(키·팔다리 길이·질량 변형)에서도 설정 자동 생성 후 동작한다. (캐릭터는 X Bot 하나로 간다 — 2026-10-26 사람 결정)

### 품질
- 전체 시나리오 스위트(약 80개)를 통과한다.
- 무작위 퍼징 10,000회에서 시뮬레이션 폭발 0회.
- 자연스러움 지표(10장)가 v1.0 기준값을 만족한다.
- 같은 입력에서 같은 결과가 나온다 (같은 플랫폼 기준).

### 도구
- 브라우저 앱에서 클릭으로 충격을 주고, 파라미터를 튜닝하고, 결과를 애니메이션 파일로 구울 수 있다.
- 파라미터 자동 튜닝(CMA-ES)으로 초기값을 찾을 수 있다.
- Kimodo로 필요한 목표 동작과 레퍼런스 동작을 생성할 수 있다.
- 게임 코드가 쓸 수 있는 공개 API와 문서가 있다.
- 엔진 독립 알고리즘 문서(`docs/ALGORITHMS.md`)가 있다. 외부 엔진 이식(PORTING, 테스트 벡터)은 현재 범위 밖이다 — 최종 쓰임새는 웹 데모·시연과 연구·프로토타입이다 (2026-10-26 사람 결정).

---

## 2. 기술 스택

| 용도 | 선택 |
|---|---|
| 언어 | TypeScript (strict) |
| 물리 | `@dimforge/rapier3d-compat` |
| 렌더링 | three.js (+ FBXLoader, GLTFExporter) |
| 개발 서버 | Vite |
| Node 실행 | `tsx` |
| 브라우저 자동화·캡처 | Playwright (Chromium) |
| 단위 테스트 | Vitest |
| 병렬 실행 (자동 튜닝, 퍼징) | Node `worker_threads` |
| 동작 생성 | 로컬 kimodo-server (11.3절) |

라이브러리 API는 추측하지 않는다. 설치된 패키지의 타입 정의(`node_modules/.../*.d.ts`)나 공식 문서를 확인한다.

---

## 3. 핵심 설계 원칙

1. **sim과 render 분리.** `src/sim/`은 three.js, DOM, window를 import하지 않고 Node에서 단독으로 실행된다. 수학 연산은 자체 `math.ts`(vec3, quat, mat3)로 처리한다.
2. **데이터 주도.** 바디, 관절, 근육, 균형, 행동, 캐릭터별 파라미터는 모두 `config/*.json`에 둔다. 코드에 숫자를 하드코딩하지 않는다.
3. **결정론.** 고정 타임스텝, 고정 시드, 고정된 업데이트 순서를 지킨다. 무작위성은 시드가 있는 PRNG 하나에서만 얻는다. `Math.random` 사용은 금지한다.
4. **관측 가능성.** 새 제어 로직을 넣을 때는 로그 필드와 디버그 시각화를 함께 넣는다. 보이지 않는 로직은 만들지 않는다.
5. **시나리오로 판정.** "잘 되는 것 같다"는 판정이 아니다. 시나리오 통과와 지표 수치로 판단한다.
6. **가짜 힘 금지.** 허공에서 몸통을 잡아 주는 외력으로 균형을 속이지 않는다. 예외는 설정으로 켜고 끄는 명시적 보조(루트 보조, 겟업 보조, 핀 보조)뿐이고, 사용량을 로그에 남긴다. 각 보조의 허용 범위는 해당 마일스톤에 정한다(루트 v0.2, 핀 v0.6, 겟업 v0.7). 허용 범위 밖에서 쓰면 시나리오 실패로 판정한다.
7. **사람다움이 목표다** (2026-10-26 사람 결정). 퀄리티는 "넘어지지 않음"이 아니라 "사람처럼 보임"으로 판정한다. 로봇처럼 너무 효율적·정확하거나 뻣뻣한 동작은 시나리오를 통과해도 실패로 본다. 판정은 필름스트립을 직접 보는 시각 검토(8.5 체크리스트, 특히 6번)와 자연스러움 지표(10장)로 한다.
   - Kimodo는 로코모션·동작 클립(Idle, 걷기, 전환, 겟업 등)을 만드는 도구다. 반응 판정의 정답지가 아니다.
   - Kimodo 반응 레퍼런스는 **가볍게** 쓴다: 이미 만든 밀림 조사(`assets/kimodo/push_study/`)를 `film --compare` 겹쳐 보기와 기대값 근거(걸음 수·회복 시간의 대략적 범위)로 참고한다. `refSimilarity`는 보조 지표이고 판정 관문으로 강제하지 않는다. 새 반응 레퍼런스는 기본적으로 소량만 만들되, 퀄리티를 올리는 데 확실히 도움이 되는 상황(예: 특정 반응이 계속 어색한데 원인을 모를 때)에는 아끼지 말고 충분히 생성해 쓴다. 쓴 이유를 결정 기록에 남긴다.
8. **계층 구조.** 위 계층은 아래 계층의 출력을 바꿀 수 있지만, 아래 계층은 위 계층을 모른다.

```
[게임/앱]  hit(), trigger(), playClip()
    ↓
[행동 계층]  행동 선택·블렌드 → 관절별 목표 포즈 + 강도 배율 + 균형 모드
    ↓
[균형·스텝 계층]  COM 피드백, 스텝 계획, 가상 힘 → 하체 목표 수정 + 보상 토크
    ↓
[근육 계층]  PD / 모터 → 관절 토크
    ↓
[물리]  Rapier
```

---

## 4. 좌표계와 단위

- 오른손 좌표계, **Y 위**, 캐릭터 정면 **+Z**, 캐릭터 왼쪽 **+X**. Mixamo와 Kimodo도 같은 규약이다.
- 단위는 미터, 킬로그램, 초, 라디안이다. JSON 설정의 각도만 도 단위로 쓰고 로드할 때 변환한다.
- Mixamo FBX는 센티미터이므로 로드할 때 ×0.01 한다. Kimodo JSON은 미터, Kimodo BVH는 센티미터다.
- 물리 타임스텝은 **1/120초 고정**이다. 렌더 프레임과 무관하게 누적 시간 방식으로 스텝을 돈다. v0.0 스파이크에서 실험한 뒤 1/240로 바꿀 수 있고(v0.2에서 재확인), 바꾸면 결정 기록에 남긴다.
- 중력은 (0, -9.81, 0)이다.
- 애니메이션 자산은 30fps로 통일한다.

---

## 5. 디렉터리 구조

```
advanced-ragdoll/
  SPEC.md                    이 문서
  CLAUDE.md                  작업 규칙
  README.md                  실행 방법, 진행 상황, 결정 기록
  docs/
    SPIKE.md                 v0.0 기술 스파이크 결과
    ALGORITHMS.md            엔진 독립 알고리즘 설명 (마일스톤마다 갱신)
    API.md                   공개 API (v0.9~)
    PORTING.md               언리얼 이식 가이드 (v1.0)
  config/
    milestones.json          마일스톤 순서 목록
    hitScale.json            충격 크기 이름 → Δv (7.2)
    hitModel.json            피격 종류별 수치, 사망 임계값 (v0.5)
    animDriver.json          클립 추종, 핀 보조 (v0.6)
    characters/xbot.json     캐릭터별 바디·관절 정의 (자동 생성)
    characters/xbot.overrides.json  수동 보정 (병합)
    muscles.json
    balance.json
    stepping.json
    behaviors.json
    poses/                   정적 목표 포즈 (stand 등)
  assets/
    fbx/                     Mixamo 원본 (X Bot, 애니)
    kimodo/                  Kimodo 생성 원본 (요청 JSON + 응답 JSON + BVH)
    poses/                   변환된 포즈 클립 JSON (sim이 읽는 유일한 애니 형식)
    library/                 겟업·리액션 라이브러리 인덱스
  src/
    sim/                     물리 코어 (three.js 금지)
      math/                  vec, quat, mat, ik, geometry(볼록 껍질 등)
      prng.ts
      world.ts               Rapier 월드, 지형, 스텝
      character/
        ragdoll.ts           설정 → 바디·관절
        muscles.ts           근육 계층
        balance.ts           균형 계층
        stepping.ts          스텝 계획·스윙
        perception.ts        레이캐스트, 잡을 곳 탐지, 지면 정보
        behaviors/           행동별 파일 + 블렌더
        states.ts            파워드 랙돌 상태 머신
        animDriver.ts        클립 재생 → 목표 포즈
        hitModel.ts          피격 종류 → 충격·행동
      metrics/               품질 지표 계산
      logger.ts
      runner.ts              시나리오 실행
      api.ts                 공개 API
    render/                  three.js (sim 상태를 읽어서 그리기만 한다)
      scene.ts
      debugDraw.ts
      skin.ts                FBX 캐릭터에 물리 결과 적용
    app/                     브라우저 앱, 튜닝 UI
  scenarios/                 시나리오 JSON (마일스톤별 하위 폴더)
  tools/
    sim.ts                   Node 시나리오 실행기
    film.ts                  필름스트립 생성기
    fuzz.ts                  퍼징
    tune.ts                  CMA-ES 자동 튜닝
    genRagdoll.ts            스켈레톤 → 캐릭터 설정 자동 생성
    extractFbxPoses.ts       FBX → 포즈 클립
    kimodo/
      client.ts              kimodo-server 호출
      toPoseClip.ts          Kimodo 응답 → 포즈 클립
      fromPose.ts            우리 포즈 → Kimodo 키프레임
      buildGetupLibrary.ts
    bake.ts                  시뮬 결과 → glTF/BVH/포즈 클립
  spike/                     v0.0 실험 코드 (제품 코드 아님)
  out/                       실행 결과 (git 제외)
  tests/
```

---

## 6. 랙돌 정의

### 6.1 바디 목록

바디 이름은 **Mixamo 본 이름**을 쓴다 (`mixamorig:` 접두어는 뺀다).

| 바디 | 대응 Mixamo 본 | 부모 | 관절 형태 | 질량 비율 | 75kg 기준 |
|---|---|---|---|---|---|
| Hips | Hips | 없음 (루트) | — | 11.2% | 8.4 kg |
| Spine | Spine (+Spine1) | Hips | 구형 | 16.3% | 12.2 kg |
| Spine2 | Spine2 (+Shoulder) | Spine | 구형 | 16.0% | 12.0 kg |
| Head | Head (+Neck) | Spine2 | 구형 | 6.9% | 5.2 kg |
| LeftArm / RightArm | LeftArm | Spine2 | 구형 | 2.7% | 2.0 kg |
| LeftForeArm / RightForeArm | LeftForeArm | 상완 | 경첩 | 1.6% | 1.2 kg |
| LeftHand / RightHand | LeftHand | 전완 | 구형 | 0.6% | 0.5 kg |
| LeftUpLeg / RightUpLeg | LeftUpLeg | Hips | 구형 | 14.2% | 10.6 kg |
| LeftLeg / RightLeg | LeftLeg | 허벅지 | 경첩 | 4.3% | 3.2 kg |
| LeftFoot / RightFoot | LeftFoot | 정강이 | 구형 | 1.4% | 1.0 kg |

질량 비율은 de Leva(1996) 인체 분절 데이터의 근사치이고 합계는 100%다. 관성 텐서는 형상에서 자동 계산하되, 바디별 관성 배율을 설정으로 조절할 수 있게 한다. 관성이 너무 작으면 진동이 생기기 때문이다.

v0.8a에서 발가락(ToeBase) 바디 추가를 검토한다. 넣으면 걷기와 스텝이 더 자연스럽지만 바디 수가 늘어난다.

쇄골(LeftShoulder/RightShoulder) 바디 추가 여부는 v0.0 스파이크에서 정한다. 판단 기준은 X Bot 치수로 계산한 팔 도달 범위다: 반대쪽 가슴·배 움켜쥐기(HoldWound), 허리 높이 난간 잡기(Grab). 추가하면 바디는 18개가 되고, 질량은 Spine2에서 나눠 준다.

### 6.2 형상

- 몸통과 팔다리는 캡슐, 머리는 구, 발은 박스(앞뒤 약 0.25m)다. 지지 영역을 안정적으로 잡으려면 발바닥이 평평해야 한다.
- v0.1부터 X Bot 스켈레톤에서 자동 생성한다(`tools/genRagdoll.ts`, 12장 v0.1). 손으로 정한 값은 `xbot.overrides.json`에만 두고 생성 결과에 병합한다. 체형별 튜닝 손실을 막으려고 처음부터 실제 캐릭터 비율을 쓴다.
- 인접 바디끼리는 충돌을 끈다. 나머지 자기 충돌(팔과 몸통, 다리끼리)은 켠다.
- 마찰은 발 1.0, 손 0.9, 나머지 0.6이다. 반발계수는 0이다.

### 6.3 관절 제한 (시작값, 도)

| 관절 | 굽힘(앞+/뒤-) | 옆 굽힘 | 비틀기 |
|---|---|---|---|
| Spine, Spine2 | -20 ~ 35 | ±25 | ±25 |
| Head (목) | -40 ~ 50 | ±35 | ±60 |
| 어깨 (Arm) | 스윙 콘 100 (축 = T-포즈 상완 방향 ±X, 축별 제한의 상자 근사) | — | ±70 |
| 팔꿈치 (ForeArm) | 0 ~ 145 (한 방향) | — | — (회내·회외는 손목이 담당, 아래 참고) |
| 손목 (Hand) | ±60 | ±30 | ±90 (회내·회외 포함, 2026-10-27) |
| 고관절 (UpLeg) | -20 ~ 110 | ±40 | ±35 |
| 무릎 (Leg) | 0 ~ 140 (뒤로만) | — | — |
| 발목 (Foot) | -40 ~ 25 | ±20 | ±15 (2026-10-26 ±5에서 완화) |

> 2026-10-26 결정: Kimodo 걷기 클립을 리타깃하자 팔꿈치가 경첩이라 전완 비틀림이 손목으로 몰리고(걷기 평균 14°), 뒤로 걷기에서 발목 비틀림이 최대 11.5°로 ±5° 제한을 넘었다. 사람 전완은 회내·회외로 약 ±80° 돌고, 발은 발목·거골하 관절을 합쳐 안팎으로 15° 안팎 돈다. 사람다운 로코모션을 위해 발목 비틀기를 ±15°로 넓히고, 전완 회내·회외 ±80°를 추가한다.
> 2026-10-27 구현 결정: 회내·회외를 팔꿈치 2자유도 관절이 아니라 **손목 비틀기(±10° → ±90°)**로 넣었다. Rapier는 쿼터니언 성분으로 제한·고정하므로, 굽힘+비틀기 팔꿈치는 굽힘과 비틀기가 함께 클 때 옆으로 밀리는 오류(90° 굽힘 + 30° 비틀기에서 약 20°)가 생긴다. 해부학적으로도 회내는 전완 먼 쪽이 도는 것이라 손목 쪽에 두는 것이 맞고, 전완 캡슐은 대칭이라 물리 결과는 같다. 스킨은 손의 비틀림 60%를 전완에 나눠 줘 전완을 따라 비틀려 보이게 한다. 자유도 수(43)는 그대로다.

**v0.0 결론 (docs/SPIKE.md)**: (a) generic 관절의 축별 제한을 raw API로 설정하고 솔버 반복을 8로 둔다. 제한은 쿼터니언 성분 기준이라 스윙 콘은 상자로 근사된다. 손·발에는 각감쇠와 관성 배율을 설정으로 둔다(충격 후 고속 회전 방지).

조사했던 후보는 세 가지다.

- (a) 범용(generic) 관절의 축별 제한
- (b) 멀티바디 관절
- (c) 제한 근처에서 되미는 토크를 직접 걸기

방식을 고른 이유를 `docs/SPIKE.md`와 결정 기록에 남긴다.

### 6.4 캐릭터 설정 스키마 `config/characters/<id>.json`

```json
{
  "id": "xbot",
  "totalMass": 75,
  "height": 1.8,
  "skeleton": "mixamo",
  "bodies": [
    {
      "name": "LeftForeArm",
      "parent": "LeftArm",
      "sourceBones": ["LeftForeArm"],
      "shape": { "type": "capsule", "radius": 0.045, "halfHeight": 0.11 },
      "massRatio": 0.0162,
      "inertiaScale": 1.0,
      "restPosition": [0, 0, 0],
      "restRotation": [0, 0, 0, 1],
      "joint": {
        "type": "hinge",
        "anchorInParent": [0, 0, 0],
        "anchorInChild": [0, 0, 0],
        "axis": [1, 0, 0],
        "limitsDeg": { "flex": [0, 145] }
      },
      "friction": 0.6
    }
  ]
}
```

- `restPosition`과 `restRotation`은 월드 기준 기본 자세(팔을 내린 A포즈) 값이다.
- `sourceBones`는 이 바디가 흡수하는 원본 본 목록이다. FBX와 Kimodo 매핑에 쓴다.

---

## 7. 시뮬레이션 아키텍처와 API

### 7.1 한 스텝의 순서 (고정)

```
1. 입력 이벤트 처리 (충격, 트리거, 클립 변경)
2. 인지 갱신: 접촉, 지면, 잡을 곳 (perception)
3. 상태 머신 갱신: Animated / Active / Ragdoll / GettingUp (states)
4. 행동 갱신 → 관절별 목표 포즈, 강도 배율, 균형 모드 (behaviors)
5. 애니 목표와 행동 목표 합성 (animDriver + 블렌더)
6. 균형·스텝 계층이 하체 목표 수정, 보상 토크 계산 (balance, stepping)
7. 근육 토크 또는 모터 목표 적용 (muscles)
8. Rapier 스텝
9. 안전 검사: 폭발이나 NaN이 나면 그 캐릭터를 Ragdoll 상태로 리셋하고 이벤트를 남긴다
10. 로그 기록
```

### 7.2 공개 API (v0.9 확정 — 사용법은 [docs/API.md](docs/API.md), 바뀐 점은 README 결정 9a-1)

```ts
class World {
  static async create(opts: { seed: number; dt?: number; terrain?: TerrainName; gravity?: Vec3 }): Promise<World>;  // 지형은 config/sim.json의 이름
  addCharacter(def: CharacterDef, cfg: RagdollConfig, spawn: SpawnOpts, opts?: CharacterOpts): Character;          // spawn: position, yaw, state?, pose?, bodies?
  addProp(def: PropDef): Prop;                 // 상자·공·캡슐 물체. grabbable 태그 가능 (난간·계단·벽은 지형)
  step(): void;
  advance(realDt: number): number;             // 실시간 누적 → 고정 스텝
  readonly time: number;
  readonly characters: Character[]; readonly props: Prop[]; readonly events: SimEvent[];
  save(): WorldSnapshot;                       // 직렬화 (v0.9)
  static load(s: WorldSnapshot): Promise<World>;
  free(): void;
}

class Character {
  // 외부 자극
  hit(h: HitInfo): void;                       // 피격 (12장 v0.5 hitModel)
  applyImpulse(body: BodyName, impulse: Vec3, worldPoint?: Vec3): void;
  // 제어
  setState(s: "Animated" | "Active" | "Ragdoll"): void;
  playClip(clip: string, opts?: { blendIn?: number; startTime?: number }): void;   // 루프 여부는 클립 파일
  trigger(behavior: BehaviorName, params?: object): void;   // 예: trigger("Limp")
  setMuscleScale(region: RegionName | JointName, scale: number, recoverTime?: number): void;
  lookAt(target: Vec3 | null): void;
  setAssist(a: { root?: boolean }): void; getAssist(): { root: boolean };
  setBalance(on: boolean): void; setStepping(on: boolean): void; setGetup(on: boolean): void;
  setMuscleConfig(cfg: MuscleConfig): void; muscleGains(): MuscleGain[];
  // 조회
  getState(): CharacterState;
  reference(): ReferenceFrame | null;          // 레퍼런스 ↔ 추종기 경계 (src/sim/tracker.ts)
  on(ev: CharacterEvent, cb: (e: SimEvent) => void): void;  // fell, gotUp, step, grabbed, released, exploded + 7.2 밖 이벤트
  off(ev: CharacterEvent, cb: (e: SimEvent) => void): void;
}

interface HitInfo {
  type: "bullet" | "melee" | "explosion" | "push";
  body?: BodyName; point?: Vec3; direction: Vec3;
  magnitude: number | "small" | "medium" | "large";   // 전신 COM 속도 변화 Δv (m/s)
  duration?: number;                                   // push: 이 시간(초)에 나눠 가함
}
```

**충격 크기 단위**: `magnitude`는 이 충격이 전신 COM에 주는 속도 변화 Δv(m/s)다. 실제 충격량은 `J = totalMass × magnitude × direction`이고, 이것을 지정 바디·지점에 가한다(melee는 인접 바디에 나눠 가한다). 체형과 무관하게 같은 의미를 갖도록 질량으로 정규화한 것이다. explosion의 magnitude는 폭발 중심에서 1m 거리의 Δv이고, 거리에 반비례해 줄어든다. 이름은 `config/hitScale.json`의 값으로 바꾼다.

```json
{ "small": 0.3, "medium": 0.8, "large": 1.5 }
```

이 경계값은 고정이다. 바꾸려면 이유와 함께 사람의 승인을 받는다 (시나리오 `expect` 완화와 같은 급).

### 7.3 상태 스냅샷

```ts
interface CharacterState {
  time: number;
  state: StateName;
  bodies: Record<BodyName, { pos: Vec3; rot: Quat; linVel: Vec3; angVel: Vec3 }>;
  com: Vec3; comVel: Vec3;
  contacts: { body: BodyName; point: Vec3; normal: Vec3; impulse: number }[];
  supportPolygon: Vec2[];
  capturePoint: Vec2;
  stance: "double" | "left" | "right" | "none";
  behaviors: { name: string; weight: number }[];
  joints: Record<JointName, { errorDeg: number; torque: number; saturated: boolean; strength: number }>;
  posture: "standing" | "kneeling" | "down" | "airborne";  // 8.2 판정 정의
  assist: { root: number; getup: number; pin: number };    // 보조 힘 사용량 (허용 범위 밖에서는 0)
  debug: Record<string, number | string>;
}
```

`render`, `logger`, `metrics`는 `getState()`만 쓴다. Rapier 객체는 sim 밖으로 노출하지 않는다.

---

## 8. 관측: 로그, 지표, 필름스트립, 보고서

LLM은 동작을 직접 볼 수 없다. 이 장은 LLM의 눈 역할을 한다.

### 8.1 프레임 로그 `out/<scenario>/log.jsonl`
- 한 줄에 한 프레임씩 `CharacterState`를 기록한다. 기본 간격은 1/30초이고 설정할 수 있다.
- 숫자는 소수점 4자리로 반올림한다. 그래야 재실행 결과를 바이트 단위로 비교할 수 있다.

### 8.2 요약 `out/<scenario>/summary.json`

```json
{
  "scenario": "push_front_medium",
  "duration": 5.0,
  "exploded": false,
  "fell": false, "fallTime": null,
  "kneeled": false, "kneelTime": null,
  "stepsTaken": 2, "recoveredTime": 1.9,
  "firstGroundContact": null,
  "metrics": { "energy": 0.41, "comJerk": 12.3, "footSlide": 0.012, "limitHits": 0, "selfPenetration": 0.0, "assistUsage": 0 },
  "expectations": { "passed": true, "failures": [] }
}
```

판정 정의:
- `exploded`: 선속도 > 20 m/s, 각속도 > 50 rad/s, NaN 중 하나라도 발생
- `kneeling` 자세: 지면에 닿은 바디가 발·손·정강이(LeftLeg/RightLeg)뿐이고, 정강이가 하나 이상 닿아 있고, Spine2 기울기(월드 Y축 기준)가 45° 미만이고, Hips 높이가 0.35m 초과. `kneeled`는 이 자세가 0.3초 이상 유지된 적이 있는지, `kneelTime`은 그 시작 시점
- `fell`: 발·손·정강이를 제외한 바디가 지면에 닿거나, `kneeling`이 아닌데 COM 높이가 0.5m 미만. 무릎 꿇기는 넘어짐이 아니다
- `posture` 판정 순서: ① 지면 접촉이 없으면 `airborne` ② `kneeling` 조건을 평가해 맞으면 `kneeling` ③ 아니면 `fell` 조건(위 정의)이 맞으면 `down` ④ 나머지는 `standing`
- `recoveredTime`: 충격 이후 COM 속도가 0.05 m/s 미만이고 COM 투영점이 지지 다각형 안에 0.5초 이상 머문 최초 시점
- `firstGroundContact`: 넘어질 때 지면에 처음 닿은 바디 이름

### 8.3 필름스트립 `out/<scenario>/film.png`
- 0.1초 간격 프레임을 한 줄 10칸 격자로 이어 붙인다. 칸 크기는 256×256이고, 각 칸 왼쪽 위에 시간을 표시한다.
- 카메라는 `side`(기본), `front`, `top`, `follow` 중에서 고른다. 시나리오마다 여러 개를 지정할 수 있다.
- 디버그 표시:

| 항목 | 표시 |
|---|---|
| COM | 빨간 점 |
| COM 바닥 투영 | 빨간 십자 |
| 지지 다각형 | 초록 선 |
| 캡처 포인트 | 파란 점 |
| 스텝 목표 | 하늘색 발자국 |
| 충격 | 노란 화살표 |
| 활성 행동 | 텍스트 |
| 근육 강도 | 바디 색상 (강하면 진하게, 약하면 연하게) |
| 잡기 대상 | 보라 점 |

- `--compare` 옵션을 주면 레퍼런스 동작(Kimodo 등)을 반투명 회색으로 겹쳐 그린다.
- `--fbx` 옵션을 주면 캡슐 대신 FBX 캐릭터로 그린다. `--both`는 둘을 나란히 그린다.

### 8.4 보고서 `out/report.md`
- `sim:all`을 실행하면 시나리오별 통과·실패, 핵심 수치, 이전 실행 대비 변화(↑↓)를 표로 만든다.
- 직전 보고서는 `out/report.prev.md`로 보관해서 회귀를 비교한다.

### 8.5 LLM 시각 검토 체크리스트
필름스트립을 열어 본 뒤 아래 항목에 예/아니오로 답하고, 그 답을 보고에 포함한다.
1. 관절이 반대로 꺾이거나 제한을 넘은 곳이 있는가
2. 몸이 떨리거나 진동하는가
3. 발이 지면에서 미끄러지거나 지면을 뚫는가
4. 몸의 부위가 서로 관통하는가
5. 반응 방향이 충격 방향과 맞는가
6. 사람이 했다면 이렇게 움직였겠는가 (이유 한 줄)
7. 레퍼런스와 겹쳐 그렸다면 가장 크게 다른 점은 무엇인가

---

## 9. 시나리오 시스템

### 9.1 형식 `scenarios/<milestone>/<name>.json`

```json
{
  "name": "push_front_medium",
  "milestone": "0.4",
  "duration": 5.0,
  "seed": 1,
  "terrain": "flat",
  "character": "xbot",
  "spawn": { "position": [0, 0, 0], "yaw": 0, "state": "Active" },
  "clip": "stand",
  "events": [
    { "t": 0.5, "type": "hit", "hit": { "type": "push", "body": "Spine2", "direction": [0, 0, 1], "magnitude": "medium" } }
  ],
  "cameras": ["side"],
  "reference": null,
  "expect": {
    "exploded": false, "fell": false,
    "steps": [1, 3], "recoveredWithin": 3.0,
    "metrics": { "footSlide": { "max": 0.03 }, "assistUsage": { "max": 0 } }
  }
}
```

- `milestone`은 문자열이고 `config/milestones.json` 목록의 값 중 하나다 (`"0.5a"` 등).
- 현재 마일스톤보다 뒤에 있는 `milestone`의 시나리오는 `sim:all`에서 건너뛴다. 순서는 `config/milestones.json`을 따른다.
- 충격 크기는 Δv(m/s) 숫자 또는 `config/hitScale.json`의 이름(`"small"`, `"medium"`, `"large"`)으로 쓴다 (7.2).
- 이벤트 종류: `hit`, `trigger`(행동 트리거, 셋업용 포함), `setState`, `playClip`, `setMuscleScale`, `lookAt`.
- 지형 종류는 `flat`, `slope10`, `slope20`, `stairs`, `ledge`(1.5m 단차), `rail`(허리 높이 난간), `wall`, `box_obstacle`이다.

### 9.2 시나리오 목록 (마일스톤별)

**v0.1 랙돌**
| 이름 | 내용 | 기대 |
|---|---|---|
| stand_drop | 힘 없이 서 있는 자세에서 시작 | 쓰러짐, 폭발 없음 |
| push_front / push_side | 큰 충격 | 그 방향으로 쓰러짐 |
| drop_from_height | 2m 높이에서 낙하 | 폭발 없음, 관절 제한 준수 |

**v0.2 근육**
| 이름 | 내용 | 기대 |
|---|---|---|
| hold_pose_pinned | Hips 고정, 근육만으로 유지 | 10초간 관절 오차 < 5° |
| hold_pose_assist | 루트 보조를 켜고 서기 | 10초간 서 있음 |
| track_wave_pinned | Hips 고정, 팔 흔드는 목표 추종 | 평균 오차 < 8°, 지연 < 0.1초 |
| strength_drop | 서 있다가 전신 강도를 0으로 | 폭발 없음, `firstGroundContact` ≠ Head, 무릎 굽힘 30° 도달이 Hips 0.3m 하강보다 먼저 ※ |

**v0.3 균형**
| 이름 | 내용 | 기대 |
|---|---|---|
| stand_still | 보조 없이 서기 | 20초간 서 있음, 보조 사용량 0 |
| push_{front,back,left,right}_small | 작은 충격 4방향 | 스텝 없이 버팀, 2초 안에 회복 |
| lean_target | 상체를 20° 숙이는 목표 | 넘어지지 않음, Spine2 기울기 ≥ 15°인 동안 Hips가 시작 위치보다 뒤로 ≥ 0.03m ※ |
| slope10_stand | 10° 경사에서 서기 | 서 있음 |

**v0.4 스텝**
| 이름 | 내용 | 기대 |
|---|---|---|
| push_{front,back,left,right}_medium | 중간 충격 4방향 | 1~3 스텝 후 버팀 |
| push_diag_medium | 대각선 | 1~3 스텝 후 버팀 |
| push_twice | 0.6초 간격으로 두 번 | 버팀 |
| push_while_stepping | 스텝 도중 추가 충격 | 스텝 계획을 다시 세우고 버팀 |
| push_left_crossstep | 셋업 이벤트 `trigger("LiftFoot", { foot: "RightFoot" })`로 왼발 단독 지지를 만든 뒤, 오른발이 떠 있는 동안 왼쪽으로 밀림 | 교차 스텝 또는 2단 스텝 |

**v0.5a 행동 프레임워크·피격**
| 이름 | 내용 | 기대 |
|---|---|---|
| hit_bullet_{chest,shoulder,thigh,head} | 총탄 | 부위별 약화, 움켜쥐기, 다리면 절뚝임 |
| hit_melee_{side,back} | 근접 타격 | 비틀거림 후 회복 또는 넘어짐 |
| injured_leg_push | 다친 다리 상태에서 밀림 | 성한 다리로 스텝 |
| look_at_threat | 위협 지점 지정 | 머리가 그 방향을 봄 (오차 < 15°) |
| shot_chest_stagger_clutch | 가슴 총탄 (대표 장면) | 12장 v0.5a 대표 장면 완료 기준 |
| shot_shoulder_spin | 어깨 총탄 | 몸통 yaw가 맞은 쪽으로 ≥ 15° 돌아감, 움켜쥐기 |

**v0.5b 넘어짐**
| 이름 | 내용 | 기대 |
|---|---|---|
| push_{front,back,side}_large | 큰 충격 | 비틀거림 → 넘어짐. 앞: 손이 먼저 닿음 / 뒤: 머리가 먼저 닿지 않음 |
| death_limp | 사망 트리거 | 폭발 없음, 무릎 굽힘 45° 도달이 Spine2 0.3m 하강보다 먼저 ※ |
| shot_belly_clutch_kneel | 배에 총탄 3발 연속 | 움켜쥐기 유지, `kneeled` true 또는 넘어짐 |
| kneel_trigger | `trigger("Kneel")` | 1초 안에 `kneeled` true, 3초 이상 유지, 폭발 없음 |

**v0.5c 공중·바닥**
| 이름 | 내용 | 기대 |
|---|---|---|
| explosion_near | 근처 폭발 | 공중에 떴다 착지하거나 구름 |
| ground_writhe | 쓰러진 뒤 5초 | 폭발 없음, COM 속도 최대 < 0.3 m/s, 관절 평균 각속도가 `behaviors.json` Writhe 범위 안 ※ |

**v0.6 애니메이션 통합**
| 이름 | 내용 | 기대 |
|---|---|---|
| idle_follow | Kimodo Idle 클립 추종 | 20초간 서 있음, FBX 렌더 정상, 루프 이음매에서 튐 없음 |
| walk_forward_track | Kimodo 앞으로 걷기 클립 추종 | 10초 걷기, 넘어지지 않음, 핀 보조 사용량 기준 이하 |
| walk_back_track | Kimodo 뒤로 걷기 클립 추종 | 10초 걷기, 핀 보조 사용량 기준 이하 |
| walk_push_side | 걷는 중 옆에서 중간 충격 | 비틀거렸다가 걷기로 복귀 |
| animated_to_active | 키네마틱 재생 중 피격 | 전환 시 튐 없음 (속도 불연속 < 기준) |
| upper_body_hit_while_walking | 걷는 중 상체 총탄 | 하체는 걷기 유지, 상체만 반응 |
| shot_while_walking_clutch | 걷는 중 가슴 총탄 | 움켜쥐기, 비틀거린 뒤 걷기 복귀 또는 정지 |

**v0.7 일어서기**
| 이름 | 내용 | 기대 |
|---|---|---|
| getup_prone / getup_supine / getup_side | 엎드림·누움·옆 | 겟업 후 Idle 복귀 |
| getup_random_x20 | 무작위 쓰러짐 20개 시드 | 20개 중 19개 이상 성공 |
| getup_interrupted | 일어서는 중 피격 | 다시 반응한 뒤 재시도 |

**v0.8a 지형**
| 이름 | 내용 | 기대 |
|---|---|---|
| stairs_push_down | 계단 위에서 앞으로 밀림 | 아래 계단으로 스텝 또는 구름 |
| stairs_tumble | 계단 위에서 큰 충격 | 굴러 내려감, 머리 보호 |
| fall_from_ledge_3m | 3m 낙하 | 공중 허우적 → 착지(무릎 굽힘) 또는 구름 |
| trip_obstacle | 걷다가 상자에 걸림 | 비틀거림, 넘어지면 손 짚기 |
| slope20_push | 20° 경사에서 밀림 | 폭발 없음, 경사에 맞춰 발 디딤 |

**v0.8b 잡기·벽**
| 이름 | 내용 | 기대 |
|---|---|---|
| rail_grab | 난간 옆에서 밀림 | 난간을 잡고 버팀 |
| ledge_grab | 모서리에서 밀려 떨어짐 | 모서리를 잡고 매달림 |
| wall_lean | 벽 쪽으로 밀림 | 손이나 어깨로 벽을 짚음 |

**v0.8c 캐릭터·물체**
| 이름 | 내용 | 기대 |
|---|---|---|
| two_characters_collide | 두 캐릭터 충돌 | 서로 밀리고 각자 반응 |
| prop_hit | 위에서 떨어진 상자에 맞음 | 접촉 충격량으로 hit 이벤트 발생, 반응 |

※ 표시 기대값은 원래 서술형이던 것을 수치로 바꾼 초기 제안값이다. 첫 구현 때 필름스트립과 함께 사람이 확인하고, 바꾸면 결정 기록에 남긴다.

**v0.9~v1.0** 전 시나리오를 다른 체형 캐릭터 2종으로 다시 실행하고, 퍼징과 성능 시나리오를 추가한다(12장).

---

## 10. 품질 지표 (자연스러움 측정)

"자연스러움"을 수치로 근사하는 지표다. v0.3부터 계산하고, v0.9 자동 튜닝의 목적 함수로 쓴다.

| 지표 | 정의 | 방향 |
|---|---|---|
| energy | ∫ Σ_joint |τ|² dt / (총질량 × 시간) | 낮을수록 좋음 (과한 근력 사용) |
| comJerk | COM 가속도 미분의 RMS | 낮을수록 좋음 (덜컹거림) |
| angJerk | 몸통 각가속도 미분의 RMS | 낮을수록 좋음 |
| footSlide | 지지발 접촉 중 수평 이동 거리 합 | 낮을수록 좋음 |
| limitHits | 관절 제한에 닿은 프레임 수 | 낮을수록 좋음 |
| saturation | 토크 포화 프레임 비율 | 낮을수록 좋음 |
| selfPenetration | 바디 간 관통 깊이 최대값 | 0 |
| assistUsage | 보조 힘 적분. 전체 합계이고, 보조별로 `assistUsage.root`, `assistUsage.pin`, `assistUsage.getup`을 따로 기록하며 expect에서 각각 상한을 걸 수 있다 | 0 (허용 범위 제외) |
| jitter | 관절 각속도 부호가 빠르게 바뀌는 횟수 | 낮을수록 좋음 |
| reactionLatency | 충격부터 행동 반응 시작까지 시간 | 0.08~0.2초 (사람 반응 속도) |
| symmetry | 좌우 대칭 시나리오 결과의 차이 | 낮을수록 좋음 |
| refSimilarity | 레퍼런스 동작과의 거리 (COM 궤적과 바디 방향을 DTW로 비교) | 낮을수록 좋음 |

v1.0 기준값은 v0.9 자동 튜닝을 마친 뒤 그 결과에 여유를 더해 확정하고 `config/qualityTargets.json`에 둔다.

---

## 11. 애니메이션 자산 파이프라인

sim이 읽는 애니메이션 형식은 **포즈 클립 JSON** 하나뿐이다. FBX와 Kimodo 출력은 모두 이 형식으로 변환한다.

### 11.1 포즈 클립 형식 `assets/poses/<clip>.json`

```json
{
  "name": "warrior_idle",
  "source": "kimodo:idle_relaxed/rp12_s7",
  "fps": 30,
  "loop": true,
  "rootMotion": "removed",
  "frames": [
    {
      "root": { "pos": [0, 0.98, 0], "rot": [0, 0, 0, 1] },
      "joints": { "Spine": [x, y, z, w], "...": [] },
      "contacts": { "LeftFoot": true, "RightFoot": true }
    }
  ]
}
```

- `joints`는 부모 바디 기준 자식 바디의 상대 회전이고, 우리 랙돌의 rest 자세 기준이다.
- `contacts`는 발 접촉 정보다. Kimodo는 `foot_contacts`를 그대로 쓰고, Mixamo는 발 높이와 속도로 추정한다.
- `rootMotion`은 `removed`(제자리) 또는 `kept`다. 걷기 추종(v0.6)에는 `kept`가 필요하다.

> **애니메이션 출처 규칙 (2026-10-26 사람 결정)**: 동작 클립은 **Kimodo 생성 애니메이션만** 쓴다. 사람이 준 Mixamo 애니(Warrior Idle, Unarmed Walk Forward/Back)는 쓰지 않는다. X Bot FBX는 캐릭터(스켈레톤·메시)로만 쓴다. 아래 11.2는 스켈레톤·rest 추출과, 나중에 다른 Mixamo 캐릭터를 쓸 때의 참고로 남긴다.

### 11.2 Mixamo FBX → 포즈 클립 (`tools/extractFbxPoses.ts`) — 동작 클립에는 쓰지 않음

- three.js FBXLoader로 읽는다. Playwright 브라우저 또는 Node 환경에서 실행한다.
- 프레임마다 각 바디의 대표 본 **월드 회전**을 구한 뒤 바디 간 상대 회전으로 바꾼다. 중간 본은 계산 과정에서 자동으로 합쳐진다.
- 대표 본 매핑:

| 바디 | Mixamo 대표 본 | 흡수되는 본 |
|---|---|---|
| Hips | Hips | |
| Spine | Spine1 | Spine |
| Spine2 | Spine2 | LeftShoulder, RightShoulder |
| Head | Head | Neck |
| LeftArm | LeftArm | |
| LeftForeArm | LeftForeArm | |
| LeftHand | LeftHand | 손가락 전부 |
| LeftUpLeg | LeftUpLeg | |
| LeftLeg | LeftLeg | |
| LeftFoot | LeftFoot | LeftToeBase |

- 바인드 포즈 차이는 rest 보정으로 처리한다: `Q_body = Q_bone_world · inv(Rest_bone_world) · Rest_body_world`
- 입력 자산은 X Bot(메시 포함)이다. Mixamo 스켈레톤(`mixamorig:` 본 65개, v0.0 확인). `assets/fbx/`의 애니 FBX 3개는 보관만 하고 쓰지 않는다.

### 11.3 Kimodo (로컬 동작 생성 서버)

**필요한 경우 `C:\Users\junjun612\Documents\kimodo-server\`를 활용해서 애니메이션을 생성할 수 있다.**

NVIDIA Kimodo(kinematic motion diffusion) 모델을 로컬 GPU에서 돌리는 HTTP 서버다. 텍스트 프롬프트와 운동학 제약(전신 키프레임, 손발 위치, 루트 경로)을 받아 30fps 모션을 만든다.

#### 언제 쓰는가
| 용도 | 마일스톤 | 설명 |
|---|---|---|
| 목표 포즈 소스 | v0.5~ | 손 짚기 직전 자세, 머리 보호 자세, 움켜쥐기 자세처럼 행동이 따라갈 포즈 |
| 레퍼런스 동작 | v0.4~ | "밀려서 두세 걸음 비틀거리다 버티는 사람" 같은 운동학적 정답. `refSimilarity` 지표와 필름스트립 겹쳐 그리기에 쓴다 |
| 겟업 라이브러리 | v0.7 | 실제로 쓰러진 자세를 첫 프레임으로 고정하고 일어나는 동작을 생성 (12장 v0.7) |
| 걷기·이동 클립 보강 | v0.6~ | 옆걸음, 절뚝이며 걷기, 다친 채 걷기 등 Mixamo에 없는 클립 |
| 자동 튜닝 목표 | v0.9 | 레퍼런스 세트와의 유사도를 목적 함수에 포함 |

Kimodo는 **오프라인 도구**다. 생성에 수 초가 걸리므로 sim 런타임에서는 호출하지 않는다. 생성한 결과를 포즈 클립으로 변환해 `assets/`에 저장해 두고 그것을 쓴다.

#### 서버
- 시작: `C:\Users\junjun612\Documents\kimodo-server\start-server.ps1` (포그라운드 실행)
- 주소: `http://127.0.0.1:5310`. 콘솔에 `Uvicorn running on`이 출력되면 준비가 끝난 것이다.
- 확인: `GET /health`로 모델, 텍스트 인코더 상태, VRAM을 본다.
- 텍스트 인코더(Llama-3-8B)는 CPU에서 돌고, 서버를 켠 뒤 첫 텍스트 요청 때 로드된다. 그래서 첫 요청은 수 분 걸릴 수 있고, 이후 요청은 수 초면 끝난다. 텍스트 없이 제약만 주는 생성은 항상 빠르다(90프레임에 약 4초).
- 생성 요청은 서버에서 한 번에 하나씩 처리된다. 병렬로 보내지 않는다.
- 상세 문서는 `kimodo-server\README.md`에 있다. 제약 `raw` 형식은 `kimodo-src\docs\source\user_guide\constraints.md`에 있다.

#### `POST /generate` 요약
```jsonc
{
  "text": "a person is pushed from behind, stumbles forward two steps and regains balance",
  "duration_s": 3.0,            // 또는 num_frames (최대 300 = 10초)
  "fps": 30,                    // 30만 지원
  "seed": 42,                   // 재현을 위해 항상 지정
  "diffusion_steps": 100,       // 50이면 약 2배 빠름
  "postprocess": true,          // 발 미끄러짐과 제약 보정
  "bvh_standard_tpose": true,
  "include_frames": true,
  "constraints": {
    "root_path": [[0,0],[0,0.8]], "root_path_frames": [0, 60],
    "keyframes": [ { "frame": 0, "root_position": [x,y,z], "local_joints_rot": [[ax,ay,az], ...] } ],  // 77관절 axis-angle
    "raw": [ ]                  // left-hand / right-foot / end-effector 등 공식 형식
  }
}
```
응답에서 쓰는 필드:
- `root_positions [T][3]`: Hips 월드 위치(m)
- `local_rotations_wxyz [T][77][4]`: 표준 T-pose 기준 부모 상대 로컬 회전. **wxyz 순서**이므로 xyzw로 바꿔야 한다
- `world_joint_positions [T][77][3]`
- `foot_contacts [T][6]`
- `skeleton`: joint_names, parents, rest_offsets_m

#### Kimodo(SOMA77) → 우리 바디 매핑
| 바디 | SOMA77 대표 관절 | 흡수되는 관절 |
|---|---|---|
| Hips | Hips | |
| Spine | Spine2 | Spine1 |
| Spine2 | Chest | LeftShoulder, RightShoulder |
| Head | Head | Neck1, Neck2 (Jaw, Eye, HeadEnd 무시) |
| LeftArm | LeftArm | |
| LeftForeArm | LeftForeArm | |
| LeftHand | LeftHand | 손가락 전부 |
| LeftUpLeg | **LeftLeg** | |
| LeftLeg | **LeftShin** | |
| LeftFoot | LeftFoot | LeftToeBase |

> ⚠ SOMA의 `LeftLeg`는 **허벅지**이고 `LeftShin`이 정강이다. Mixamo의 `LeftLeg`(정강이)와 이름이 엇갈리니 주의한다.

- 변환 방법: FK로 대표 관절의 월드 회전을 구하고, rest 보정(`Q_world_target = Q_world_src · inv(Rest_world_src) · Rest_world_target`)을 한 뒤, 바디 간 상대 회전으로 바꾼다.
- `llm_anim_studio`에 같은 리타깃이 이미 구현돼 있다(`C:\Users\junjun612\Documents\llm_anim_studio\src\core\retarget-kimodo.js`). 규약과 검증 방식은 참고하되 코드는 이 프로젝트의 TypeScript로 새로 작성한다.

#### 우리 포즈 → Kimodo 키프레임 (`tools/kimodo/fromPose.ts`)
겟업 라이브러리처럼 "지금 이 자세에서 시작하는 동작"을 만들 때 쓴다.
1. 캐릭터를 원점으로 옮긴다: Hips의 XZ를 (0,0)으로, 정면 방향을 +Z로 회전한다. 이 변환을 저장해 두었다가 결과에 역으로 적용한다.
2. 바디 월드 회전 → SOMA 대표 관절 월드 회전으로 바꾼다 (rest 보정 역방향).
3. 흡수된 중간 관절에 회전을 나눠 준다. 예를 들어 Spine1과 Spine2는 Hips→Spine 상대 회전을 절반씩 slerp로 나누고, Shoulder는 Chest와 같은 월드 회전(상대 회전 0)으로 둔다. 손가락은 rest 그대로 둔다.
4. 로컬 회전 = inv(부모 월드) · 월드로 계산해 axis-angle로 변환한다. 이것을 `keyframes[].local_joints_rot`(77개)로 보낸다.
5. 검증: 보낸 키프레임과 생성 결과 0프레임의 `world_joint_positions` 오차가 2cm 이하인지 확인한다.

#### 저장 규칙
- `assets/kimodo/<name>/request.json`, `response.json`, `.bvh`를 함께 저장한다. 시드도 반드시 남긴다.
- 변환 결과는 `assets/poses/kimodo_<name>.json`이다.
- `assets/kimodo/INDEX.md`에 이름, 프롬프트, 용도, 품질 메모를 한 줄씩 기록한다.
- 서버는 LLM이 직접 켜고 끈다 (2026-10-26 사람 결정). 모델은 `Kimodo-SOMA-RP-v1.2`(포트 5310)와 `Kimodo-SOMA-SEED-v1.1`(포트 5311)을 함께 띄워 비교할 수 있다. GPU를 사람의 다른 작업(언리얼 등)과 공유하므로 요청은 한 번에 하나씩 보내고, 다 쓰면 끈다. 켜는 방법은 `docs/KIMODO.md`에 적는다.

#### 품질 확인
- 생성 결과는 반드시 필름스트립(`npm run film:clip -- <clip>`)으로 확인한다. 발 미끄러짐이나 프롬프트를 따르지 않은 결과가 나올 수 있다.
- 마음에 들지 않으면 시드를 바꿔 3~5개 생성한 뒤 고른다. 고른 이유를 INDEX.md에 남긴다.

#### 후보 선별 (모든 클립 필수)
한 클립당 후보를 여러 개(기본: 모델 2종 × 시드 6개 = 12개) 만들고, 자동 점수로 거른 뒤 필름스트립으로 최종 선택한다.
- **자동 점수** (`tools/kimodo/score.ts`): 발 미끄러짐(접촉 중 수평 이동), 지면 관통·부양, 관절 저크, 우리 랙돌 관절 제한 위반, 리타깃 오차(우리 바디로 바꾼 뒤 손·발 위치 차이), 루프 클립이면 이음매 오차(위치·속도), 첫·끝 프레임과 기준 자세(stand) 사이 거리, 물리 추종성(근육으로 추종했을 때 관절 오차와 보조 사용량 — 해당 계층이 생긴 뒤부터).
- **사람 판단에 가까운 확인**: 상위 3개를 `film:clip`으로 그려 직접 보고, 프롬프트를 따랐는지와 사람다움으로 고른다. 비교 이미지(한글 라벨)를 남긴다.
- 고른 클립, 점수표, 탈락 이유를 `assets/kimodo/INDEX.md`에 남긴다.

#### 블렌딩·전환 품질 (모든 클립 필수)
- **공통 기준 자세**: 서기·걷기 시작 클립은 0프레임을 우리 stand 자세로 키프레임 고정해서 생성한다(11.3 "우리 포즈 → Kimodo 키프레임"). 그래야 클립 사이와 물리 반응 뒤 복귀가 매끄럽다.
- **루프**: 루프 클립은 필요한 길이보다 길게 생성한 뒤 자세·속도 차이가 가장 작은 구간을 잘라 쓰고, 이음매는 짧은 크로스페이드로 정리한다. 이음매 오차를 점수에 넣는다.
- **전환**: 클립 사이 전환은 크로스페이드 대신 관성화(inertialization) 블렌딩을 기본으로 한다. 필요한 전환(예: 서기→걷기 시작, 걷기→멈춤)은 Kimodo로 전환 클립을 따로 생성한다(시작·끝 키프레임 고정).
- **위상 정렬**: 걷기 계열은 발 접촉 패턴으로 위상을 맞춘다. 루트 모션은 수평 이동과 방향을 정규화해 저장한다.
- **발 접촉 정리**: Kimodo `foot_contacts`를 쓰되 짧은 깜빡임은 제거하고, 접촉 중 발이 미끄러지지 않도록 후처리한다.
- 전환 지점에서 관절 각속도 불연속을 측정해 기준 이하인지 테스트로 확인한다.

#### 라이선스
- 모델(Kimodo-SOMA-SEED)은 NVIDIA Open Model License이고, 텍스트 인코더는 Llama 3 Community License다.
- 상용 게임에 생성 동작을 넣기 전에 라이선스 확인이 필요하다. 이 프로젝트에서는 연구·프로토타입·레퍼런스 용도로 쓴다.

---

## 12. 마일스톤

각 마일스톤은 같은 틀로 정리한다: 목표 / 만들 것 / 원리 / 설정 / 로그·시각화 / 완료 기준.
모든 마일스톤의 완료 기준에는 다음이 기본으로 포함된다.
- 이전 마일스톤의 시나리오 전부 통과
- `npm test` 통과
- `docs/ALGORITHMS.md`에 이번 마일스톤의 알고리즘 설명 추가
- README 진행 상황과 결정 기록 갱신

---

### v0.0 — 기술 스파이크

**목표**: 설계 전체가 기대는 Rapier·FBX 기능을 먼저 확인해서, 나중 마일스톤에서 설계가 흔들리지 않게 한다. 제품 코드가 아니라 실험 코드(`spike/`)이고, 결론만 다음 마일스톤에 넘긴다.

**확인할 것**
1. **Rapier 버전과 API**: `@dimforge/rapier3d-compat` 버전을 고정하고 `.d.ts`에서 확인한다 — 구형 관절의 축별 제한, generic 관절, 멀티바디 관절, 구형 관절 모터(축별 위치 목표·stiffness·damping), 바디별 토크 적용, 충돌 그룹, 접촉 이벤트, 레이캐스트.
2. **관절 제한 방식** (6.3의 a/b/c): 16바디 체인에서 각각 구현 가능 여부와 제한 위반량.
3. **근육 구현 후보 비교**: (A) 명시적 토크 PD, (B) 관절 모터, (C) Stable PD(Tan 2011, 다음 스텝 속도를 예측한 PD). 바디 16개(손 0.5kg 대 Hips 8.4kg 질량비)를 Hips 고정으로 매달아 두고 1/120초에서 kp를 올려 가며 진동이 시작되는 지점, 자세 오차, 스텝당 시간을 잰다. 1/240초도 같은 측정을 한다.
4. **결정론**: 같은 시드로 Node에서 두 번 돌려 상태를 바이트 비교. Node와 브라우저(Playwright) 결과 비교.
5. **성능**: 16바디 캐릭터 1명의 스텝당 Rapier 시간, 8명 동시.
6. **FBX 읽기**: three.js FBXLoader로 `assets/fbx/X Bot.fbx`의 스켈레톤·스킨 가중치·애니 트랙을 Node에서 읽을 수 있는지 확인한다. 안 되면 Playwright 브라우저에서 읽어 JSON으로 덤프하는 방식을 쓴다. 애니 FBX의 Hips 이동(루트 모션 포함 여부)도 기록한다.
7. **쇄골 바디 판단** (6.1): X Bot 치수로 2관절 IK를 풀어, Spine2에 붙은 어깨로 (a) 반대쪽 가슴·배의 상처 지점 (b) 허리 높이 난간에 손이 닿는지 확인한다. 닿지 않는 경우가 많으면 18바디로 간다.

**산출물**: `docs/SPIKE.md` (항목별 결과 수치와 결론), README 결정 기록 (관절 제한 방식, 근육 기본 구현, 타임스텝, 쇄골, FBX 읽기 경로).

**완료 기준**: 위 7개 항목 모두 결론이 있고 근거 수치가 `docs/SPIKE.md`에 있다. 결론이 SPEC의 가정과 다르면(예: 구형 관절 모터 미지원) 영향을 받는 절을 적고 사람에게 알린다.

---

### v0.1 — 랙돌 기반

**목표**: 물리 몸체와 관측 도구를 갖춘다.

**만들 것**
- 프로젝트 셋업, `math/`, `prng.ts`, `config/milestones.json`, `config/hitScale.json`
- `tools/genRagdoll.ts`: X Bot 스켈레톤에서 본 길이로 캡슐 길이와 관절 위치를 계산한다 (cm → m). 메시 정점과 스킨 가중치에서 바디별 반경을 추정한다(가중치가 높은 정점들의 본 축 거리 중앙값). 질량은 6.1 비율 × `totalMass`. 결과는 `config/characters/xbot.json`이고, 수동 보정 `xbot.overrides.json`을 병합한다. FBX 읽기 경로는 v0.0 결론을 따른다.
- 바디·관절 생성(관절 제한은 v0.0 결론의 방식), 평지 지형
- 로거, 요약 판정(8.2, posture 포함), 시나리오 러너, `sim` / `film` / `sim:all` 명령
- 디버그 그리기 (COM, 충격 화살표)

**완료 기준**
- v0.1 시나리오 통과
- 같은 시나리오를 두 번 돌리면 로그가 바이트 단위로 같다 (테스트로 작성)
- 질량 합계 75 ± 0.1 kg (테스트)
- 생성된 관절 위치가 X Bot 대응 본 위치와 1cm 이내 (테스트)
- 필름스트립에서 무릎과 팔꿈치가 반대로 꺾이지 않는다 (사람 확인)

---

### v0.2 — 근육

**목표**: 관절이 목표 자세를 안정적으로 따라간다.

**원리: PD 제어**
```
q_err = q_target_rel · inverse(q_current_rel)    // 최단 경로 (w < 0이면 부호 반전)
e     = axisAngle(q_err)                          // 월드 좌표 벡터
ω_rel = ω_child − ω_parent
τ     = kp · e − kd · ω_rel
τ     = clampMagnitude(τ, maxTorque)
child += τ,  parent −= τ
```

**구현 방식은 v0.0 결론을 따른다**
- 후보는 (A) 명시적 토크(위 식을 매 스텝 토크로 적용), (B) Rapier 관절 모터(위치 목표 + stiffness + damping), (C) Stable PD다. **v0.0 결론: (B) 관절 모터 + 중력 보상 피드포워드** (A는 손목 관성 때문에 발산, C는 kp 800 한계). 모터가 실제로 낸 토크는 읽을 수 없으므로 로그의 torque·saturated는 위 PD 식으로 계산한 추정값이다.
- 어떤 방식이든 위 PD 식의 의미(목표 회전, kp, kd, maxTorque, strength 배율)를 같은 설정으로 표현해서, 상위 계층은 구현 방식을 모르게 한다.
- `hold_pose_pinned`에서 v0.0 측정을 실제 캐릭터로 다시 확인하고, 결과가 다르면 결정 기록을 갱신한다.

**중력 보상 (피드포워드)**
- 각 관절에 대해 그 관절 아래(자손) 바디들의 질량 M_sub과 무게중심 c_sub을 구한다. 그 무게를 버티는 데 필요한 토크를 더한다.
```
τ_gc(j) = (c_sub(j) − p_j) × (−M_sub(j) · g)
```
- 이것을 넣으면 kp를 낮게 유지하면서도 처지지 않는다. 낮은 kp는 부드러운 반응으로 이어진다.
- 지지 다리는 v0.3에서 가상 힘 방식으로 바꾼다.

**근육 상태 모델**
- 관절별 `strength`(0~1)는 런타임에 바뀐다. 이 값이 kp, kd, maxTorque에 곱해진다.
- 강도 변화는 바로 반영하지 않고 1차 저역 통과 필터로 부드럽게 바꾼다 (활성화 지연, 기본 30ms).
- 영역(region) 단위 제어 API를 둔다: `upperBody`, `lowerBody`, `leftArm`, `rightLeg`, `neck` 등.
- 피로(v0.5에서 사용): 토크를 오래 쓰면 strength 상한이 서서히 떨어지고, 쉬면 회복된다.

**설정** `muscles.json`: 관절별 kp, kd, maxTorque, 중력 보상 배율. kp 초기값은 전체 배율 × 상대 비율로 정한다 (다리·몸통 1.0, 목 0.4, 어깨 0.4, 팔꿈치 0.3, 손목·발목 0.2). kd는 `2·sqrt(kp·I)` 근처에서 시작한다.

**루트 보조**: Hips를 세우는 가상 토크와 높이 스프링이다. v0.2 검증용이며 v0.3부터 기본으로 꺼 둔다. 사용량은 `assist.root`로 기록한다.

**목표 포즈**: `config/poses/stand.json` (X Bot의 rest 자세에서 팔을 내린 A포즈)

**FBX 스킨 렌더** (`render/skin.ts`)
- 바디 월드 회전 → 대표 본에 적용한다. 흡수된 중간 본(Spine, Neck, Shoulder)은 양쪽 회전 사이를 보간한다.
- 캡슐 / FBX / 둘 다 표시 토글. `film --fbx`, `film --both`를 이때 붙인다. 사람이 동작을 판단하기 쉽게 하려고 일찍 넣는다.

**로그·시각화**: 관절별 오차 각도, 토크, 포화 여부, strength. 바디 색상으로 강도를 표시한다.

**튜닝 UI**: 관절별 슬라이더, 전체 배율, 루트 보조 on/off, JSON 내보내기·불러오기.

**완료 기준**: v0.2 시나리오 통과. 진동 없음(`jitter` 기준). `film --both`에서 FBX와 캡슐이 같은 방향으로 움직임 (사람 확인).

---

### v0.3 — 균형 (스텝 없이 버티기)

**목표**: 보조 힘 없이 서 있고, 작은 충격은 제자리에서 버틴다.

**계산**
- COM과 COM 속도: 질량 가중 평균
- 지지 다각형: 지면에 닿은 발 박스 바닥면 꼭짓점들의 XZ 볼록 껍질
- 안정 여유: COM 투영점에서 지지 다각형 경계까지의 부호 있는 거리
- 지면 법선과 높이: 경사면 대응을 위해 발 아래로 레이캐스트

**제어 구조** (Generalized Biped Walking Control의 방식을 따른다)
1. **몸통 자세 제어**: 몸통(Spine2) 방향을 **월드 기준**으로 PD 제어해 필요한 토크 τ_torso를 구한다.
2. **COM 가상 힘**: COM을 목표 위치로 되돌리는 가상 힘을 구한다.
   `F = kp_com · (c_target − c) − kd_com · v_com`
   이 힘을 지지 다리 관절 토크로 변환한다 (자코비안 전치): `τ_j = (c − p_j) × F` (발목 → 무릎 → 고관절)
3. **지지 고관절 토크 배분**: 몸통 토크를 지지 다리 고관절로 넘긴다. 양발 지지일 때는 각 발에 실린 하중 비율로 나눈다.
4. **중력 보상**: 지지 다리는 COM에 `−M·g`를 가상 힘으로 넣는 방식으로 처리한다.

**전략**
- 발목 전략: 안정 여유가 충분하면 발목 토크로만 되돌린다.
- 고관절 전략: 여유가 줄어들면 고관절을 굽혀 상체를 반대로 기울이고, 팔을 반대쪽으로 뻗어 각운동량을 쓴다.
- 발목 토크는 발이 뒤집히지 않도록 제한한다. 압력 중심(CoP)이 발 영역 안에 있도록 발목 최대 토크를 동적으로 계산한다.
- 전략 사이는 안정 여유에 따라 연속적으로 블렌드한다.

**반응 지연**: 균형 피드백은 감지 지연(기본 0.08초)을 거친 상태를 쓴다. 근육의 수동 반응(PD)은 즉시 일어난다.

**설정** `balance.json`: COM 게인, 몸통 게인, 전략 경계, 지연, 발목 토크 제한 여유.

**로그·시각화**: 지지 다각형, 안정 여유, 가상 힘, 현재 전략, CoP.

**완료 기준**: v0.3 시나리오 통과. `stand_still`에서 `assistUsage` 0. 품질 지표 계산 시작(10장).

---

### v0.4 — 발 내딛기

**목표**: 중간 충격에 1~3 스텝으로 버틴다.

**캡처 포인트** (선형 역진자 모델)
```
ω0 = sqrt(g / h)
cp = c_xz + v_xz / ω0
```
- 캡처 포인트가 지지 다각형 밖으로 `stepTriggerMargin` 이상 나가면 스텝을 시작한다.
- **자연스러운 스텝 경계** (2026-10-26 사람 결정): 사람은 제자리로 버틸 수 있는 충격에도 반 발 정도 움찔 내딛는 경우가 많다. `stepTriggerMargin`은 이론적 한계보다 이르게(보수적으로) 두고, 시드 노이즈로 시도마다 조금씩 달라지게 한다(`stepTriggerJitter`). 작은 충격에서 "스텝 없음"과 "반 발 움찔"이 섞여 나오는 것을 허용하되, v0.3 small 시나리오는 스텝 없이도 버틸 수 있어야 한다(균형 계층 단독 검증용으로 스텝을 끈 채 실행). 경계값은 Kimodo 레퍼런스와 비교해 정한다.

**스텝 계획**
- 스윙 다리 선택: 넘어지는 방향 쪽 다리, 하중이 덜 실린 다리, 교차가 필요한지를 비용 함수로 평가한다.
- 착지 목표: 캡처 포인트 + `stepOvershoot`. 다리 길이 한계, 다른 발과의 최소 간격, 교차 허용 범위로 제한한다.
- 착지 지점 검사: 레이캐스트로 지면 높이와 법선을 확인한다. 디딜 수 없는 곳(구멍, 장애물)이면 후보 지점을 다시 고른다.
- 스텝 시간: 0.25~0.45초. 캡처 포인트까지의 거리에 따라 정한다.
- 스윙 도중 캡처 포인트가 바뀌면 착지 목표를 매 프레임 다시 계산한다 (`push_while_stepping`).

**스윙 실행**
- 발 궤적: 시작 → 최고점(지면 위 0.05~0.1m) → 목표. 3차 베지어를 쓴다.
- 다리 2관절 IK로 고관절·무릎 목표를 구하고, 발목은 지면 법선에 맞춘다.
- SIMBICON 균형 피드백을 스윙 고관절 목표에 더한다: `θ = θ_IK + c_d·d + c_v·v` (d: 발목에서 COM까지 수평 거리, v: COM 속도)
- 착지 감지: 발 접촉 + 하중이 임계값을 넘으면 지지발을 교체한다.

**상태 머신**: `Stand → Step(L|R) → Settle → Stand`. 3스텝 뒤에도 캡처 포인트를 따라잡지 못하면 `Stagger`(v0.5a)로 넘긴다.

**팔**: 스텝 중에는 팔을 진행 방향 반대로 벌려 균형을 돕는다.

**설정** `stepping.json`

**로그·시각화**: 캡처 포인트, 스텝 목표 발자국, 실제 착지 위치, 착지 오차, 스텝 상태.

**레퍼런스**: Kimodo로 "밀려서 비틀거리다 버티는" 동작을 4방향에 대해 생성하고(11.3), `refSimilarity`를 계산하기 시작한다.

**완료 기준**: v0.4 시나리오 통과. 착지 오차 평균 < 0.05m. `footSlide` 기준 만족.

---

### v0.5 — 행동 (v0.5a / v0.5b / v0.5c)

**목표**: Euphoria다운 행동들을 갖춘다.

v0.5는 세 마일스톤으로 나눠 구현한다. 이 절의 프레임워크·행동 목록·피격 모델은 공통 명세이고, 각 행동을 어느 마일스톤에서 만드는지는 행동 목록의 "단계" 열을 따른다. 끝의 "v0.5a / b / c 완료 기준"을 각각 통과해야 다음으로 넘어간다.

| 단계 | 내용 |
|---|---|
| v0.5a 행동 프레임워크·피격 | 블렌더, hitModel(bullet·melee·push), 대표 장면(총 맞고 움켜쥐기) |
| v0.5b 넘어짐 | 넘어짐 예측과 대비, 머리 보호, 손 짚기, 사망, 무릎 꿇기 |
| v0.5c 공중·바닥 | 폭발, 공중 허우적, 착지, 구르기, 바닥 몸부림 |

**행동 프레임워크** (v0.5a)
- 행동이 출력하는 것: 관절별 (목표 회전, 가중치, 강도 배율), 균형 모드(on/off/약화), 스텝 허용 여부, 손 IK 목표, 시선 목표.
- 여러 행동이 동시에 켜질 수 있다. 관절별로 **우선순위 레이어 + 가중치 블렌드**로 합친다. 예를 들어 Balance가 하체를 맡고, HoldWound가 오른팔을 맡고, LookAt이 목을 맡는다.
- 행동 전환은 0.1~0.2초 동안 블렌드한다.
- 행동은 감지 지연(0.08~0.15초) 뒤에 반응한다. 피격 순간의 수동 반응은 근육 PD가 담당한다.
- 행동 파라미터는 `behaviors.json`에 두고, 외부에서 `trigger(name, params)`로 덮어쓸 수 있다.

**행동 목록**
| 행동 | 단계 | 시작 조건 | 하는 일 |
|---|---|---|---|
| Balance | 0.5a | 기본 | v0.3~v0.4 로직 |
| HitReaction | 0.5a | 피격 | 맞은 바디와 인접 관절 strength를 순간적으로 낮췄다가(예: 0.3배) 0.3~0.6초에 걸쳐 회복. 맞은 쪽으로 몸을 굽힘 |
| Stagger | 0.5a | 스텝으로 회복 실패 | 상체 강성을 낮추고 연속 스텝(최대 6), 스텝 간격 불규칙. 회복하면 Balance로, 실패하면 BraceForFall로 (v0.5a에서는 BraceForFall이 없으므로 Balance 유지) |
| HoldWound | 0.5a | 총탄 피격 후 | 가까운 손을 맞은 지점(바디 로컬 좌표로 고정)에 IK로 가져감. 지속 시간과 강도 설정 가능 |
| InjuredLeg | 0.5a | 다리 피격 | 그 다리의 strength 상한을 낮춤. 스텝 계획이 성한 다리를 우선 쓰고, 다친 다리는 짧게 디딤 |
| LookAt | 0.5a | 시선 대상 지정 | 목과 상체 일부를 대상 쪽으로 (가중치 낮음) |
| BraceForFall | 0.5b | 넘어짐이 확실함 (안정 여유와 COM 속도 기준) | 넘어지는 방향과 시간을 예측해 그 시점의 손 착지 지점을 계산하고 두 팔을 IK로 뻗음. 무릎을 굽혀 낙하 높이를 줄임 |
| ProtectHead | 0.5b | 뒤나 옆으로 넘어짐 | 턱을 당기고 팔로 머리를 감쌈 |
| CatchFall | 0.5b | 손이 지면에 닿음 | 팔꿈치를 굽혀 충격을 흡수하고 팔 강도를 서서히 낮춤 |
| Kneel | 0.5b | 피해 누적으로 하체 strength 상한이 임계값 아래, 또는 trigger | 무릎을 꿇고 상체를 세운 채 버팀 (`posture` = kneeling). 더 약해지면 BraceForFall/Limp로 |
| Limp | 0.5b | 사망 또는 기절 | 전 관절 strength → 0.05 근처. 무릎부터 무너지도록 하체를 먼저 약화 |
| Flail | 0.5c | 공중 상태 (접촉 없음 + 하강 속도) | 팔다리를 휘저음 (시드 노이즈 기반 목표), 균형 off |
| PrepareLanding | 0.5c | 공중에서 지면 접근 (레이캐스트로 착지까지 남은 시간 예측) | 다리를 지면 쪽으로 펴고 착지 순간 무릎 강성을 낮춰 흡수 |
| Roll | 0.5c | 착지 수평 속도가 크거나 경사에서 구를 때 | 몸을 웅크리고 머리를 보호 |
| Writhe | 0.5c | 쓰러진 상태로 일정 시간 | 약하고 느린 무작위 목표 (시드 노이즈) |
| LiftFoot | 0.4 | trigger 전용 (시나리오 셋업) | 지정한 발을 들어 단독 지지 자세를 만듦. v0.4에서는 행동 프레임워크 없이 스텝 계층의 셋업 명령으로 구현해도 됨 |

**피격 모델** (`hitModel.ts`)
| 종류 | 단계 | 충격 | 행동 |
|---|---|---|---|
| push | 0.5a | 지정 바디에 충격 (7.2 Δv 단위) | Balance가 처리 |
| bullet | 0.5a | 맞은 점에 작고 날카로운 충격량 | 부위 약화 + HitReaction + HoldWound (+ 다리면 InjuredLeg) |
| melee | 0.5a | 맞은 바디와 인접 바디에 분산된 큰 충격 | HitReaction + Balance/Stagger |
| explosion | 0.5c | 거리에 반비례하는 방사형 충격을 전 바디에 | 공중이면 Flail → PrepareLanding / Roll |
| 공통 | 0.5b | 크기가 사망 임계값(`hitModel.json`, Δv) 이상 | Limp |

피격 종류별 수치는 `config/hitModel.json`에 둔다. 충격 크기는 모두 7.2의 Δv 단위다.

**대표 목표 장면: 총에 맞고 뒤로 밀리며 상처를 움켜쥠**

이 프로젝트에서 가장 중요한 장면이다. v0.5a의 품질은 이 장면으로 판단한다. 무릎 꿇기·쓰러짐(마지막 행의 BraceForFall / Limp / Kneel)은 v0.5b에서 붙는다.

| 시간 (피격 후) | 일어나야 할 일 | 담당 |
|---|---|---|
| 0 ~ 0.08초 | 맞은 부위가 충격 방향으로 꺾임. 상체가 뒤로 젖혀짐 (수동 반응, 아직 의도 없음) | 충격 + 근육 PD |
| 0.05 ~ 0.3초 | 맞은 부위와 인접 관절 힘이 빠짐. 무릎이 살짝 꺾이며 몸이 움찔 주저앉음 ("으억") | HitReaction (strength 하락) |
| 0.1 ~ 0.8초 | 뒤로 1~3 스텝 밀려남. 스텝은 고르지 않고 휘청거림 | Balance → Stagger |
| 0.15 ~ 0.5초 | 맞은 곳에 가까운 손이 상처 지점으로 감. 다른 팔은 균형을 잡으려 벌어짐 | HoldWound + Balance 팔 |
| 0.5초 ~ | 손은 상처를 누른 채 유지되고, 상체는 상처 쪽으로 웅크림. 회복하면 천천히 서고, 피해가 크면 무릎을 꿇거나 쓰러짐 | HoldWound + (Balance 또는 BraceForFall / Limp) |

세부 규칙:
- 상처 지점은 맞은 바디의 **로컬 좌표**로 저장한다. 그래야 몸이 움직여도 손이 같은 자리를 따라간다.
- 움켜쥐는 손 선택: 상처까지 팔이 닿고 덜 바쁜 손. 같은 쪽 손이 우선이고, 반대쪽 가슴이나 배라면 반대 손도 허용한다. 맞은 팔 자체는 쥐지 못하므로 다른 손으로 쥔다.
- 손바닥이 상처 쪽을 향하게 손목 방향도 IK 목표에 넣는다. 손이 몸을 관통하지 않도록 목표를 몸 표면에서 약간 띄운다.
- 피해 누적: 여러 발을 맞으면 strength 상한이 계속 떨어지고, 일정 값 아래로 내려가면 무릎을 꿇거나 쓰러진다.
- 반응 강도는 맞은 부위와 탄의 위력(`hitModel.json`)에 따라 달라진다. 어깨는 몸이 돌아가고, 배는 웅크리고, 다리는 절뚝인다.
- 사운드 연동용 이벤트를 낸다 (`hitReacted`, 부위와 강도 포함). 소리 재생 자체는 이 프로젝트 범위 밖이다.

대표 장면 시나리오: `shot_chest_stagger_clutch`, `shot_shoulder_spin`(v0.5a), `shot_belly_clutch_kneel`(3발 연속, v0.5b), `shot_while_walking_clutch`(걷기가 필요하므로 v0.6). 대표 장면 완료 기준 (`shot_chest_stagger_clutch`):
- 손이 0.5초 안에 상처 지점에서 8cm 이내로 도달하고 1초 이상 유지
- 뒤로 1~3 스텝
- 피격부터 첫 의도 반응(손 이동 시작)까지 0.1~0.2초
- 필름스트립 사람 확인: "맞고 휘청이며 상처를 움켜쥐는 것처럼 보이는가"
- Kimodo로 "a person gets shot in the chest, staggers backward and clutches the wound" 레퍼런스를 만들어 겹쳐 비교한다

**목표 포즈**: 손 짚기, 머리 보호, 움켜쥐기 자세는 Kimodo로 생성하거나(11.3) 직접 만든 정적 포즈 JSON에서 가져온다. 동적인 부분(손 위치)은 IK로 덧입힌다.

**로그·시각화**: 활성 행동과 가중치, 관절별 최종 strength, 예측된 손 착지 지점, `posture`.

**v0.5a 완료 기준**: v0.5a 시나리오 통과. 위 대표 장면 완료 기준 충족. 행동 블렌더가 관절별 레이어·가중치를 로그와 필름스트립 텍스트로 보여 준다.

**v0.5b 완료 기준**: v0.5b 시나리오 통과. 앞으로 넘어지는 경우 `firstGroundContact`가 손이고, 뒤로 넘어지는 경우 머리가 아니다. `shot_belly_clutch_kneel`에서 무릎을 꿇는 경우 `fell`이 아니라 `kneeled`로 판정된다. `trigger("Kneel")` 시나리오(`kneel_trigger`)에서 1초 안에 `kneeled`가 true이고 3초 이상 유지된다.

**v0.5c 완료 기준**: v0.5c 시나리오 통과. `explosion_near`에서 공중 구간 동안 Flail이, 착지 0.3초 전부터 PrepareLanding이 활성이다.

---

### v0.6 — 애니메이션 통합

**목표**: 애니메이션을 재생하면서 물리 반응을 섞는다. (캐릭터 설정 자동 생성은 v0.1, FBX 스킨 렌더는 v0.2에서 이미 갖춘다.)

**포즈 클립**: Idle, 앞으로 걷기, 뒤로 걷기와 그 사이 전환 클립을 Kimodo로 생성한다(11.3 후보 선별·블렌딩 규칙). Mixamo 애니는 쓰지 않는다.

**파워드 랙돌 상태 머신** (`states.ts`)
| 상태 | 물리 바디 | 근육 | 균형 |
|---|---|---|---|
| Animated | 키네마틱 (애니메이션이 직접 위치 지정) | — | — |
| Active | 동적 | 애니 추종 + 행동 | on |
| Ragdoll | 동적 | 거의 0 | off |
| GettingUp | 동적 | 겟업 클립 추종, 높은 강성 | 겟업 보조 |

- Animated → Active: 애니메이션의 이전·현재 프레임 차분으로 각 바디의 선속도와 각속도를 구해 넘긴다. 속도가 이어져야 튐이 없다.
- 부분 물리: 본별 블렌드 가중치를 둔다. 예를 들어 걷는 중 상체만 맞으면 하체는 Animated에 가깝게, 상체는 Active로 처리한다. 다만 물리 바디는 하나로 이어져 있으므로, 하체는 높은 강성으로 애니를 추종하는 방식으로 구현한다.
- 렌더 블렌드: 최종 표시 포즈 = slerp(애니 포즈, 물리 포즈, w_bone). 상태 전환 순간의 시각적 튐을 숨긴다.

**애니메이션 추종 걷기**
- 클립의 발 접촉 정보로 지지·스윙 단계를 판단한다.
- 하체는 클립 목표 + 균형 피드백(SIMBICON 방식)으로 추종하고, 루트는 물리가 움직인다.
- 외란을 받으면 균형 계층과 스텝 계층이 클립 목표를 수정한다. 많이 벗어나면 Balance/Stagger로 전환한 뒤, 회복되면 가장 가까운 클립 위상으로 돌아간다 (발 접촉 패턴으로 위상 매칭).
- 옆걸음, 다친 걸음 등 추가 클립이 필요하면 Kimodo로 생성한다.

**핀 보조** (원칙 6의 명시적 보조, PuppetMaster의 pin weight와 같은 개념)
- 각 바디를 애니메이션 목표 위치·회전 쪽으로 끄는 외력과 토크다: `F = kp_pin·(x_anim − x) − kd_pin·(v − v_anim)`, 회전도 같은 형태. 바디별 핀 가중치 × 전체 핀 강도로 크기를 정한다.
- 허용 범위: (1) Animated ↔ Active 전환 블렌드 구간, (2) 애니메이션 추종 걷기·Idle 중. 이 밖에서는 0이어야 한다.
- 피격·외란이 오면 핀 강도를 감쇠 시간(설정) 안에 0으로 내리고, Balance·Stagger·행동 반응 중에는 0을 유지한다. 반응이 끝나고 클립 위상으로 돌아가면 다시 올린다.
- 사용량은 `assist.pin`(힘 크기의 시간 적분)으로 기록하고, 필름스트립에 핀 강도를 바디 테두리 색으로 표시한다.
- 설정 `animDriver.json`: 핀 on/off, 바디별 가중치, kp_pin, kd_pin, 감쇠 시간.
- 핀은 걷기를 가능하게 하는 발판이다. 튜닝은 핀 사용량을 줄이는 방향으로 하고, 시나리오의 `assistUsage.pin` 상한을 마일스톤마다 낮춘다.

**완료 기준**: v0.6 시나리오 통과. 상태 전환 시 바디 속도 불연속이 기준 이하. 피격 반응 구간에서 `assist.pin`이 0. 걷기 시나리오의 핀 사용량이 상한 이하(상한값은 첫 구현 결과를 보고 사람이 정한다).

---

### v0.7 — 일어서기

**목표**: 어떤 자세로 쓰러져도 맞는 방법으로 일어난다.

**쓰러짐 판정**: Ragdoll 또는 Writhe 상태에서 속도가 안정되고 일정 시간이 지나면 일어서기를 시작한다 (설정 가능, 게임이 막을 수 있음).

**자세 분류와 포즈 매칭**
- 특징 벡터: Hips 위쪽 축의 방향(엎드림/누움/옆), Hips 기준 각 바디의 상대 방향, 팔다리가 몸 아래에 깔렸는지 여부
- 라이브러리의 각 겟업 클립 첫 프레임과 비교해 비용이 가장 낮은 클립을 고른다. 클립은 수평 회전(yaw)과 위치를 현재 캐릭터에 맞춰 정렬한다.

**겟업 라이브러리 생성** (`tools/kimodo/buildGetupLibrary.ts`)
1. 넘어짐 시나리오들을 다양한 시드·방향·충격으로 수백 번 실행하고, 최종 쓰러진 자세를 모은다.
2. 특징 벡터로 클러스터링해 대표 자세 20~40개를 고른다.
3. 각 대표 자세를 Kimodo 키프레임(0프레임)으로 넣고 텍스트 "a person gets up from the ground and stands still"로 3~4초 동작을 생성한다 (11.3 "우리 포즈 → Kimodo 키프레임"). 마지막 프레임을 Idle 자세로 고정하는 키프레임도 함께 넣을 수 있다.
4. 시드를 바꿔 2~3개씩 생성하고, 시뮬레이션에서 실제로 성공하는 것만 남긴다.
5. `assets/library/getup.json`에 인덱스(첫 프레임 특징 벡터, 클립 경로, 성공률)를 저장한다.
- 기본 보험으로 엎드림·누움 대표 자세 각 1개에 대해 Kimodo 겟업 클립을 따로 넉넉히 생성해 둔다 (Mixamo 애니는 쓰지 않는다).

**겟업 실행**
- 현재 물리 자세와 클립 첫 프레임 사이를 0.3초 블렌드한다.
- 근육 강성을 높이고 겟업 보조(Hips 높이·자세 보조)를 클립 진행도에 맞춰 켰다가 끝에서 끈다. 사용량은 `assist.getup`에 기록한다.
- 균형 계층은 발이 둘 다 지면에 닿은 뒤부터 다시 켠다.
- 중간에 피격되면 겟업을 취소하고 행동 계층으로 넘긴다.
- 실패(일정 시간 안에 서지 못함)하면 Ragdoll로 돌아가 다른 클립으로 재시도한다 (최대 3회).

**완료 기준**: v0.7 시나리오 통과. `getup_random_x20` 성공률 95% 이상. 겟업 보조 사용량이 기준 이하.

---

### v0.8 — 환경 상호작용 (v0.8a / v0.8b / v0.8c)

**목표**: 계단, 경사, 벽, 난간, 모서리, 장애물, 다른 캐릭터에 반응한다.

세 마일스톤으로 나눠 구현한다.

| 단계 | 내용 |
|---|---|
| v0.8a 지형 | 지면 인지, 경사·계단 대응, StairStep, Tumble, Trip, 발가락 바디 검토 |
| v0.8b 잡기·벽 | 잡을 곳·벽 탐지, Grab, HangOnLedge, BraceAgainstWall |
| v0.8c 캐릭터·물체 | 캐릭터 간 충돌, 떨어지는 프롭 |

**인지** (`perception.ts`)
- (0.8a) 발 아래와 진행 방향의 지면 레이캐스트: 높이, 법선, 디딜 수 있는지
- (0.8b) 잡을 곳 탐지: `grabbable` 태그가 붙은 콜라이더 중 손이 닿는 범위(어깨에서 팔 길이) 안의 가장 가까운 점과 모서리
- (0.8b) 벽 탐지: 넘어지는 방향으로 짧은 레이캐스트
- 인지 결과는 감지 지연을 거쳐 행동에 전달된다

**새 행동**
| 행동 | 단계 | 하는 일 |
|---|---|---|
| StairStep | 0.8a | 계단에서 스텝 목표를 계단 면에 맞춰 조정 (높이 차이를 IK에 반영) |
| Tumble | 0.8a | 계단이나 경사에서 구를 때 웅크리고 머리 보호, 팔로 속도를 줄이려 함 |
| Trip | 0.8a | 스윙 발이 장애물에 걸림 → 상체가 앞으로 쏠림 → Stagger나 BraceForFall로 |
| Grab | 0.8b | 잡을 곳으로 손을 IK로 뻗고, 손이 충분히 가까워지고 상대 속도가 작으면 손과 대상 사이에 관절(구형)을 만든다. 당기는 힘이 임계값을 넘거나 팔 강도가 약해지면 놓는다. 잡은 상태에서 몸을 끌어당기는 힘은 팔 근육으로만 낸다 |
| HangOnLedge | 0.8b | 모서리를 잡고 매달린 상태. 다리는 벽을 짚거나 늘어뜨림 |
| BraceAgainstWall | 0.8b | 벽 쪽으로 넘어질 때 손이나 어깨로 벽을 짚고 버팀 |

**지면 대응** (0.8a): 스텝 계획과 균형 계층이 지면 법선과 높이를 사용한다. 경사면에서는 지지 다각형을 경사면 위에서 계산한다. 발가락(ToeBase) 바디 추가 여부를 이때 실험으로 정한다.

**캐릭터 간 상호작용** (0.8c): 두 캐릭터의 바디는 서로 충돌한다. 다른 캐릭터와 부딪히면 push 피격으로 처리하고, 그 캐릭터를 잡을 곳으로 쓸지 여부는 설정으로 정한다.

**떨어지는 물체** (0.8c): 프롭이 캐릭터를 치면 접촉 충격량을 Δv(7.2)로 환산해 hit 이벤트를 만든다.

**v0.8a 완료 기준**: v0.8a 시나리오 통과. 경사·계단에서 착지 오차 평균 < 0.05m.

**v0.8b 완료 기준**: v0.8b 시나리오 통과. 잡기 성공 시 손과 대상의 상대 미끄러짐이 기준 이하.

**v0.8c 완료 기준**: v0.8c 시나리오 통과. 두 캐릭터 시나리오에서 서로의 관통 깊이 최대값이 기준 이하.

---

### v0.9 — 자동 튜닝, 체형 다양화, API 확정

**목표**: 파라미터를 체계적으로 최적화하고, 다른 체형에서도 동작하게 하고, 공개 API를 확정한다.

**자동 튜닝** (`tools/tune.ts`)
- 알고리즘: CMA-ES (외부 의존 없이 직접 구현하거나 검증된 경량 구현 사용)
- 탐색 대상: muscles, balance, stepping, behaviors 설정의 수치 중 지정한 부분집합. 범위는 `config/tuneSpace.json`에 둔다.
- 목적 함수: 시나리오 실패 페널티(큰 값) + 품질 지표 가중합 + `refSimilarity`(Kimodo/레퍼런스 세트)
- 과적합 방지: 학습용 시나리오와 검증용 시나리오(다른 시드, 다른 충격 크기)를 나눈다. 검증 성능으로 최종값을 고른다.
- `worker_threads`로 병렬 실행한다. 진행 상황과 최고 기록을 `out/tune/<run>/`에 남긴다.
- 결과는 바로 덮어쓰지 않고 `config/tuned/<run>.json`으로 저장한다. 사람이 필름스트립을 확인한 뒤 반영한다.

**체형 다양화** — *보류 (2026-10-27 사람 결정: 기본 체형 X Bot만 간다. DEVLOG 결정 body-1, 작업 중이던 코드는 브랜치 worktree-agent-ab42ded6700bc2fb2에 보존)*
- X Bot 비율 변형 2종 이상(예: 키 1.6m 마른 체형, 키 1.9m 무거운 체형 — 본 길이·반경·질량 스케일)으로 `genRagdoll` → 전체 시나리오를 실행한다.
- 게인은 질량과 키에 따라 자동으로 스케일한다 (kp ∝ 질량 × 길이², 시간 상수는 √(길이/g)에 비례하도록).
- 캐릭터 설정에 `strengthMultiplier`(힘센 캐릭터, 약한 캐릭터)를 둔다.

**공개 API 확정**: 7.2절 API를 확정하고 `docs/API.md`를 작성한다. 이벤트 콜백, 직렬화(상태 저장·복원)도 포함한다.

**퍼징** (`tools/fuzz.ts`)
- 무작위 피격(종류, 부위, 방향, 크기), 무작위 지형, 무작위 상태에서 시작하는 실행을 대량으로 돌린다.
- 폭발, NaN, 관통, 일정 시간 이상 같은 상태에 갇힘(예: 계속 겟업 실패)을 감지해 재현 시드와 함께 보고한다.

**완료 기준**
- 튜닝된 파라미터로 모든 시나리오 통과, 품질 지표 기준 설정 (`qualityTargets.json`)
- ~~체형 3종(X Bot + 변형 2종) 모두 v0.1~v0.8c 시나리오의 95% 이상 통과~~ (보류, 결정 body-1)
- 퍼징 10,000회에서 폭발 0회
- `docs/API.md` 완성

---

### v1.0 — 완성

**목표**: 성능, 도구, 문서, 이식성을 마무리한다.

**성능** (15장) — *축소 (2026-10-27 사람 결정, DEVLOG scope-1): 웹 데모에서 2~4명이 실시간으로 도는 것만 확인한다. LOD와 8·16명 예산은 보류*
- 프로파일링하고 병목을 제거한다: 할당 줄이기, 레이캐스트 횟수 줄이기, 행동 갱신 주기 분리(일부는 30Hz).
- LOD: 멀리 있거나 화면 밖에 있는 캐릭터는 단순 모드(균형만, 행동 최소)나 Animated 상태로 둔다. 정지한 Ragdoll은 Rapier 슬립을 쓴다.
- 여러 캐릭터 시나리오(8명, 16명)에서 성능 예산을 확인한다.

**굽기와 내보내기** (`tools/bake.ts`) — *보류 (2026-10-27 사람 결정, DEVLOG scope-1)*
- 시뮬레이션 결과를 본 애니메이션으로 기록한다.
- 출력 형식: glTF(GLTFExporter), BVH, 포즈 클립 JSON.
- 키 감소 옵션: 오차 허용치 이내에서 키프레임을 줄인다.
- `llm_anim_studio`에서 불러올 수 있는 형식으로도 내보낼 수 있게 한다. 형식은 그 프로젝트 문서를 확인해서 맞춘다.

**앱 완성** (14장)

**이식 준비** (현재 범위 밖, 후순위 — ALGORITHMS.md 정리만 필수)
- `docs/ALGORITHMS.md`를 엔진 독립 의사코드로 정리한다.
- `docs/PORTING.md`에 언리얼(Chaos) 대응표를 정리한다: 관절, 모터, 레이캐스트, 질량, 좌표계 변환(Y-up → Z-up, 미터 → 센티미터).
- 검증용 테스트 벡터를 만든다: 주요 함수(캡처 포인트, 스텝 목표, IK, PD 토크, 포즈 매칭)의 입력과 기대 출력 JSON. 다른 엔진 구현이 같은 결과를 내는지 확인하는 용도다.
- 설정 JSON은 엔진과 무관하게 재사용할 수 있게 유지한다.

**최종 검토**
- 1장 "최종 목표"의 모든 항목을 체크리스트로 검증하고 결과를 `docs/RELEASE_CHECK.md`에 남긴다.
- 별도의 검토 에이전트(이 작업을 하지 않은 세션)가 필름스트립 전체를 8.5 체크리스트로 독립 검토한다.

**완료 기준**: 1장 전 항목 충족. 단 보류한 항목(체형 다양화 body-1, LOD·다인원 예산·굽기/내보내기 scope-1)은 제외한다.

---

## 13. 명령어

| 명령 | 동작 | 도입 |
|---|---|---|
| `npm run dev` | 브라우저 앱 | v0.1 |
| `npm run sim -- <name>` | Node 시나리오 실행 → log, summary | v0.1 |
| `npm run film -- <name> [--compare] [--fbx\|--both]` | 필름스트립 (`--fbx`, `--both`는 v0.2, `--compare`는 v0.4) | v0.1 |
| `npm run sim:all [-- --milestone 0.5a]` | 시나리오 전체 → report.md | v0.1 |
| `npm run ragdoll:gen -- <fbx>` | 캐릭터 설정 자동 생성 | v0.1 |
| `npm test` | 단위 테스트 | v0.1 |
| `npm run film:clip -- <clip>` | 포즈 클립 자체를 키네마틱으로 재생해 필름스트립 | v0.4 |
| `npm run kimodo -- <request.json> --name <name>` | Kimodo 생성 → 저장 → 포즈 클립 변환 | v0.4 |
| `npm run kimodo:candidates -- <spec.json>` | 후보 여러 개 생성 → 점수 → 비교 이미지 | v0.3 |
| `npm run getup:build` | 겟업 라이브러리 생성 | v0.7 |
| `npm run fuzz -- --runs 10000` | 퍼징 | v0.9 |
| `npm run tune -- <tuneSpace> --gens 100` | 자동 튜닝 | v0.9 |
| `npm run bake -- <scenario> --format gltf\|bvh\|clip` | 굽기 | v1.0 |
| `npm run bench` | 성능 측정 | v0.4 |

---

## 14. 앱 (브라우저 UI)

마일스톤마다 필요한 기능을 붙여 나가고, v1.0에서 아래 전체를 갖춘다.

- **뷰**: 3D 뷰, 지형 선택, 카메라(궤도/추적/고정), 디버그 표시 항목별 on/off, 캡슐·FBX 토글
- **재생**: 재생/일시정지/한 스텝/되감기(스냅샷 링버퍼), 속도 0.1x~1x
- **입력**: 바디 클릭+드래그로 밀기, 피격 종류 선택(총탄/근접/폭발), 세기 슬라이더(Δv m/s, small/medium/large 프리셋), 바닥 클릭으로 폭발, 시선 대상 지정
- **캐릭터 제어**: 상태 전환, 클립 재생, 행동 트리거, 근육 영역 강도
- **튜닝**: 모든 설정 파일을 패널로 편집해 즉시 반영, JSON 내보내기·불러오기, 변경 전후 비교 실행
- **시나리오**: 시나리오 불러와 실행, 결과 요약, 레퍼런스 겹쳐 보기
- **그래프**: COM 높이, 안정 여유, 관절 토크, 행동 가중치 실시간 그래프
- **굽기**: 현재 재생 구간을 glTF/BVH로 내보내기

---

## 15. 성능 예산 (v1.0 목표, 데스크톱 기준)

> 퀄리티가 우선이다 (2026-10-26 사람 결정). 전신 QP 등으로 아래 값을 넘으면 동시 인원 축소·LOD로 해결하고 실측값을 기록한다. 예산 때문에 품질을 낮추지 않는다.

**강화학습 옵션**: 해석적 제어(전신 QP) + 레퍼런스 추종으로도 로봇 같은 느낌이 남으면, 모캡 모방 강화학습(DeepMimic/AMP/PHC 계열, Kimodo 클립을 모방 대상으로)을 도입할 수 있다 (사람 승인됨). 도입하면 학습 환경·정책 실행 방식·결정론 영향을 결정 기록에 남긴다.

| 항목 | 목표 |
|---|---|
| 캐릭터 1명, 전 계층 활성, 물리 스텝당 | ≤ 0.5 ms (Node) |
| 브라우저 60fps 실시간, Active 캐릭터 동시 | ≥ 8명 |
| Ragdoll 또는 슬립 캐릭터 동시 | ≥ 32명 |
| 시나리오 1개 (5초) Node 실행 | ≤ 2초 |
| `sim:all` 전체 | ≤ 3분 |

v0.4부터 `npm run bench`로 추적하고, 이전보다 20% 이상 느려지면 보고한다.

---

## 16. 참고 문헌

- de Leva, P. (1996). Adjustments to Zatsiorsky-Seluyanov's segment inertia parameters. 인체 분절 질량
- Pratt, J. et al. (2006). Capture Point: A Step toward Humanoid Push Recovery. 스텝 위치
- Yin, K., Loken, K., van de Panne, M. (2007). SIMBICON: Simple Biped Locomotion Control. 균형 피드백
- Coros, S., Beaudoin, P., van de Panne, M. (2010). Generalized Biped Walking Control. 가상 힘, 몸통 제어, 중력 보상
- Tan, J., Liu, K., Turk, G. (2011). Stable Proportional-Derivative Controllers. 높은 강성에서도 안정적인 PD
- Zordan, V. et al. (2005). Dynamic Response for Motion Capture Animation. 피격 반응과 모캡 블렌드
- Hansen, N. (2016). The CMA Evolution Strategy: A Tutorial. 자동 튜닝
- NVIDIA Kimodo 기술 보고서: https://research.nvidia.com/labs/sil/projects/kimodo/
- 구현 참고: RootMotion PuppetMaster (Unity), Unreal Physics Control 플러그인

---

## 17. 미정 사항 (구현 중 결정하고 결정 기록에 남긴다)

**나중에 따로 연구할 것** (2026-10-26 사람 결정 — 마일스톤 범위 밖, 지금 구현하지 않음)
- 레퍼런스 모션 매칭: Kimodo 레퍼런스 데이터베이스에서 현재 상태(COM 속도, 몸통 기울기, 지지발, 캡처 포인트)와 가장 비슷하게 시작하는 반응 구간을 골라 근육 목표로 쓰는 방식. 커버리지 부족 상황은 `fromPose`로 보충 생성. 미끄러짐 해결책이 아니라 목표 선택 도구다. v0.6 위상 복귀·v0.7 겟업 선택의 단순 매칭은 원래 명세대로 진행한다.
  - **2026-10-27 사람 결정으로 일부를 범위로 당김** (강화학습 전에 "애니메이션을 더 넣어 자연스럽게"): 서서 몸통을 밀리거나 맞으면 Kimodo 반응 클립 라이브러리(`assets/poses/reaction/`, 방향 8 × 세기 3)에서 밀린 방향·세기로 클립을 고르고, 다리·COM은 v0.4 균형·스텝 계층이 정하는 채 클립의 척추·머리·팔 목표를 우리 걸음에 맞춰 시간을 늘이고 줄여 쓴다(상체 스타일). 클립 전체(걸음 포함)를 애니 추종 QP로 따르는 방식은 실험 옵션(`reaction.mode = "track"`)으로 남겼다. 정의 docs/ALGORITHMS.md '반응 클립', 결정 README 159~139.
  - **경계 원칙 (2026-10-27)**: "레퍼런스 생성"(반응 클립 선택·시간 늘이기 + 행동 계층 편집 → 관절 목표 흐름과 관절별 추종 세기)과 "추종기"(전신 QP + 근육)를 분리한다. 나중에 추종기를 학습 정책(DReCon·SuperTrack류)으로 바꿀 수 있게, 행동 논리는 가능하면 QP 목적 항이 아니라 레퍼런스(목표 포즈·추종 세기)로 낸다.


- 구형 관절의 축별 제한 구현 방식 (v0.0)
- 근육 구현 A(명시적 토크) / B(관절 모터) / C(Stable PD) (v0.0, v0.2에서 재확인)
- 물리 타임스텝 1/120 유지 또는 1/240 (v0.0, v0.2에서 재확인)
- 쇄골 바디 추가 여부 (v0.0)
- FBX를 Node에서 직접 읽을지, 브라우저에서 덤프할지 (v0.0)
- 브라우저와 Node의 Rapier 결과가 완전히 같은지. 다르면 판정은 Node 결과를 기준으로 한다 (v0.0)
- ※ 표시 시나리오 기대값과 v0.6 핀 사용량 상한 (첫 구현 때 사람 확인)
- 사망 임계값 Δv (`hitModel.json`)와 Kneel 진입 strength 임계값 (`behaviors.json`) (v0.5b)
- v0.7 겟업 보조 사용량 상한 (`assistUsage.getup`) (v0.7)
- 발가락 바디 추가 여부 (v0.8a)
- 품질 지표 최종 기준값 (v0.9)

결정된 사항 (2026-10-26 면담): 충격 크기 단위와 경계값(7.2), 핀 보조 허용(v0.6), genRagdoll·FBX 렌더 앞당김(v0.1·v0.2), v0.0 스파이크 추가, v0.5·v0.8 분할, kneeling 자세와 `fell` 정의(8.2). 자세한 내용은 README 결정 기록에 있다.

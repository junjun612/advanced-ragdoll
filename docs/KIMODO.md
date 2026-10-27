# Kimodo 서버와 애니메이션 파이프라인

동작 클립은 Kimodo로 생성한 것만 쓴다(CLAUDE.md, SPEC 11.1). 이 문서는 서버를 켜고 끄는 법, 후보를 만들어 고르는 법, 변환 규약을 정리한다. 서버 API 자체는 `C:\Users\junjun612\Documents\kimodo-server\README.md`에 있다.

## 1. 서버

| 모델 | 포트 | 태그 (`config/kimodo.json`) | 표시 이름 |
|---|---|---|---|
| Kimodo-SOMA-RP-v1.2 | 5310 | `rp12` | RP-v1.2 |
| Kimodo-SOMA-SEED-v1.1 | 5311 | `seed11` | SEED-v1.1 |

### 켜기 (PowerShell, 숨김 창)
서버마다 한 번씩 실행한다. 모델 로딩은 약 2초 걸린다.
```powershell
$S = "C:\Users\junjun612\Documents\kimodo-server"
foreach ($m in @(@{model="Kimodo-SOMA-RP-v1.2"; port=5310}, @{model="Kimodo-SOMA-SEED-v1.1"; port=5311})) {
  $env:HF_HOME = "$S\hf_cache"; $env:LOCAL_CACHE = "true"; $env:TEXT_ENCODER_DEVICE = "cpu"; $env:PYTHONNOUSERSITE = "1"
  $env:KIMODO_MODEL = $m.model; $env:KIMODO_PORT = "$($m.port)"
  Start-Process -FilePath "$S\.venv\Scripts\python.exe" -ArgumentList "server.py" -WorkingDirectory $S -WindowStyle Hidden
}
```
- 확인: `curl.exe -s http://127.0.0.1:5310/health`, `...:5311/health`. `model`이 위 표와 같으면 준비된 것이다.
- 텍스트 인코더(Llama-3-8B, CPU, RAM 약 16GB)는 서버마다 첫 텍스트 요청 때 로드된다. 2026-10-26 실측은 30초 안팎이었고, 디스크 캐시가 식어 있으면 수 분 걸릴 수 있다. 클라이언트 타임아웃은 900초다.
- 포그라운드로 하나만 띄울 때는 `kimodo-server\start-server.ps1` (기본 SEED, 5310)을 쓴다. 위 환경변수로 모델과 포트를 바꾼다.

### 끄기
```powershell
Get-NetTCPConnection -LocalPort 5310,5311 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }
```
GPU를 사람의 다른 작업(언리얼 등)과 같이 쓰므로 **다 쓰면 끈다**. 서버 하나는 VRAM 약 1.1GB(생성 중 1.3GB)를 잡는다.

### 규칙
- 요청은 두 서버를 통틀어 **한 번에 하나**. `tools/kimodo/client.ts`가 한 프로세스 안에서 직렬화한다. `kimodo:candidates`를 두 개 동시에 돌리지 않는다.
- 요청에는 항상 `seed`를 넣는다 (클라이언트가 없으면 거부).
- 생성 시간: 3~8초 길이 100 steps에서 약 4초 (2026-10-26, RTX 5080).

## 2. 후보 만들기와 고르기 (SPEC 11.3 "후보 선별")

```bash
npm run kimodo:candidates -- walk_forward            # tools/kimodo/specs/walk_forward.json
npm run kimodo:candidates -- <spec.json> --no-render # 점수만
npm run kimodo:candidates -- walk_forward --only rp12:3,seed11:5
npm run kimodo:candidates -- walk_forward --select rp12:1 --reason "..."   # → assets/poses/kimodo_walk_forward.json
npm run film:clip -- walk_forward --cycles 2 --fbx    # 포즈 클립 필름스트립 (assets/poses/kimodo_<clip>.json 또는 경로)
```

흐름: 모델 × 시드마다 생성 → 포즈 클립 변환 → (루프) 구간 찾기·크로스페이드 → 자동 점수 → `ranking.md/json` → 상위 3개와 모델별 1위를 `film:clip`으로 렌더 → 비교 이미지 `compare_top.png`, `compare_models.png` (한글 라벨, 칸 10개를 고르게 뽑음). 최종 선택은 비교 이미지와 필름스트립을 직접 보고 하고, 이유를 `assets/kimodo/INDEX.md`에 적는다.

같은 요청(모델·시드·프롬프트·키프레임이 모두 같음)이 이미 저장돼 있으면 서버를 부르지 않고 저장본을 쓴다. 변환·점수 코드를 고친 뒤 다시 돌리면 GPU 없이 재처리된다. `config/poses/stand.json`이 바뀌면 시작 키프레임이 바뀌므로 새로 생성된다.

### 스펙 파일 `tools/kimodo/specs/<clip>.json`
| 필드 | 뜻 |
|---|---|
| `text`, `duration_s`, `models`, `seeds` | 생성 요청 |
| `startPose` | 0프레임을 이 포즈(config/poses)로 키프레임 고정 (공통 기준 자세) |
| `loop` | `minLenS`~`maxLenS` 길이로 `fromS` 이후에서 루프 구간 탐색, `phaseAlign`이면 그 발 뒤꿈치 착지를 0프레임으로 |
| `rootMotion` | `kept` / `removed` |
| `expect` | 프롬프트 기대 동작(이동 방향·거리·속도·걸음 수·골반 흔들림·끝에서 멈춤). 어기면 벌점 |
| `weights` | 점수 항목 가중치 덮어쓰기 (예: 걷기는 시작·끝-서기 거리 0) |
| `filmCamera`, `filmCycles` | 필름 카메라, 루프 반복 횟수 |

### 저장 위치
- `assets/kimodo/<clip>/<model>_s<seed>/`: `request.json`(모델 이름 포함), `response.json`, `motion.bvh`, 변환 결과 `clip.json`, 점수 `scores.json`
- `assets/kimodo/<clip>/`: `spec.json`, `ranking.md`, `ranking.json`, `compare_top.png`, `compare_models.png`
- 고른 클립: `assets/poses/kimodo_<clip>.json`. 목록과 선택 이유: `assets/kimodo/INDEX.md`
- 필름 로그·이미지: `out/kimodo_<clip>_<model>_s<seed>/`

## 3. 변환 규약 (`tools/kimodo/`)

| 파일 | 역할 |
|---|---|
| `soma.ts` | SOMA77 응답 타입, FK, wxyz ↔ xyzw |
| `rig.ts` | SOMA77 ↔ 16바디 매핑, rest 보정, 루트 매핑, 관절 상대 회전, 관절 제한 |
| `toPoseClip.ts` | 응답 → 포즈 클립 (발 접촉 정리, 발 고정 IK) |
| `fromPose.ts` | 우리 포즈 → Kimodo 키프레임, 0프레임 검증 |
| `loop.ts` | 루프 구간, 이음매 크로스페이드, 루트 드리프트 제거, 위상 정렬 |
| `score.ts` | 자동 점수 |
| `clipToLog.ts` | 포즈 클립 → `out/<name>/log.jsonl` 등 → `npm run film` (`film:clip`) |
| `candidates.ts`, `compose.ts`, `client.ts` | 후보 실행, 비교 이미지, 서버 클라이언트 |

### 매핑과 rest 보정
- SPEC 11.3 표대로다. **SOMA `LeftLeg` = 허벅지 → 우리 `LeftUpLeg`, SOMA `LeftShin` = 정강이 → 우리 `LeftLeg`.**
- Kimodo 로컬 회전은 T-pose 기준이고 T-pose에서 모든 관절 월드 회전이 항등이다. 바디 월드 회전 `W_b = G_s · C_b · B_b`.
  - `B_b` = 우리 바인드(T-pose) 월드 회전 = A포즈 팔 내림(`restPose.armDownDeg` 60°)을 되돌린 restRotation. xbot은 모두 항등이다.
  - `C_b` = 팔·다리(`config/kimodo.json retarget.dirBodies`)는 우리 바인드 분절 방향 → SOMA rest 분절 방향 최소 회전(허벅지 1.5°, 정강이 0.8°, 팔 0°). 나머지는 항등이라 평평한 Kimodo 발은 평평한 우리 발이 된다.
  - 그래서 Kimodo가 T-pose를 내면 우리 어깨 관절 값은 rest(A포즈)에서 60° 올라간 값이 된다 (테스트로 확인).
- 흡수 관절: Spine1·Neck1·Neck2·Shoulder·손가락·발끝은 FK 월드 회전에 자연히 합쳐진다 (대표 관절의 월드 회전만 쓴다).
- 경첩(무릎·팔꿈치)은 flex 축 성분만 남긴다(`hingeProject`). 손목은 제한 안으로 자른다(`clampJoints`): Kimodo의 전완 회내·회외가 우리 팔꿈치 경첩에 없어 손목 twist(±10°)로 몰리기 때문이다. 자른 양은 점수 `handClampDegMean`.
- 루트: 다리 길이(고관절→무릎→발목) 비율 `s = 1.039`로 수평 이동을 스케일하고, 높이는 "서 있는 고관절 높이"끼리 맞춘다: `y_ours = 0.975 + s·(y_src − 0.925)`. 0.925 = SOMA 고관절→발목 0.854 + 평평한 발의 발목 높이 0.0706(`sourceAnkleHeight`, 실측).
- 발 접촉: Kimodo `foot_contacts` 6채널 = [왼 뒤꿈치, 왼 발가락, 왼 발끝(복사), 오 뒤꿈치, 오 발가락, 오 발끝]. 3프레임 미만 깜빡임을 메운다. 클립의 `contacts.LeftFoot` = 뒤꿈치 또는 발가락.
- 발 고정: 뒤꿈치 접촉 구간마다 발목을 구간 평균 위치(발바닥 4cm 안이면 y=0에 붙임)에 무릎 각 이분법 + 허벅지 최소 회전으로 고정하고 앞뒤 4프레임을 섞는다.

### 포즈 클립 형식 (SPEC 11.1 보충)
- `joints[J]` = 관절 좌표계 기준 상대 회전 `r` (xyzw), 우리 rest(A포즈) = 항등. `W_child = W_parent · frameInParent · r · frameInChild⁻¹`. `src/sim/character/pose.ts`의 `forwardKinematics` targets와 같아서 그대로 넣을 수 있다 (`jointConvention: "jointFrameRelRest"`).
- `root` = Hips 바디 원점의 월드 위치·회전. 0프레임 고관절 중점이 원점, 정면 +Z.
- 루프 + `rootMotion: "kept"`이면 `loopRootDelta {pos, yaw}`: 한 바퀴 뒤 0프레임 = 0프레임을 yaw만큼 Y축 회전 후 pos만큼 이동. 재생할 때 바퀴마다 누적한다.
- `rootMotion: "removed"` 루프는 한 바퀴 이동·회전을 선형으로 빼서 제자리로 만든다.
- `info`: 모델, 시드, 프롬프트, 루프 구간, 점수, 선택 이유.

### 우리 포즈 → Kimodo 키프레임 (`fromPose.ts`)
SPEC 11.3 절차 그대로다. Spine1·Spine2와 Neck1·Neck2는 상대 회전을 절반씩 slerp로 나누고, Shoulder는 Chest와 같은 월드 회전, 손가락은 rest. 검증은 생성 0프레임 `world_joint_positions`와 보낸 키프레임 FK의 차이로 하고 기준은 2cm다. 손가락 끝(ThumbEnd, MiddleEnd)은 뺀다: 우리는 rest 손가락을 보내지만 Kimodo가 자기 손가락 자세를 채워 3~6cm 다르다. 나머지 28관절은 RP·SEED 모두 0.0cm였다 (`assets/kimodo/roundtrip_stand`, 테스트).

## 4. 자동 점수 (`score.ts`, 낮을수록 좋음)
| 항목 | 뜻 |
|---|---|
| `footSlideRawCmPerS` | 발 고정 전 뒤꿈치 접촉 중 발목 수평 이동 (cm/초) |
| `footLockCorrectionCm` | 발 고정 IK가 발목을 옮긴 평균 거리 |
| `penetrationCm`, `floatCm` | 발바닥 최저점의 지면 관통(최대), 접촉 중 부양(평균) |
| `jerkP95` | 관절 위치 저크 (m/s³, 관절 평균의 95백분위) |
| `limitViolationDegMean` | 우리 관절 제한 초과(프레임별 최대의 평균, 도). sim과 같은 2·asin 좌표, 어깨 콘 |
| `retargetErrCm` | 손목·발목 위치와 스케일한 소스 위치 차이 |
| `seamPosCm`, `seamVelCmS` | 루프 구간 양 끝 자세·속도 차이 (크로스페이드 전) |
| `startPoseDeg`, `endPoseDeg` | 첫·끝 프레임과 stand 포즈의 평균 관절 각 차이 |
| `expectPenalty` | 스펙 `expect` 위반 |
| `trackability` | 물리 추종성. 근육 애니 추종이 생기면 채운다 (지금 null) |

가중치와 기준값은 `config/kimodo.json score.terms`.

## 5. 밀림 반응 레퍼런스 (SPEC 원칙 8 "사람 레퍼런스를 따른다")

> **레퍼런스는 "전략" 기준이다.** 걸음 수, 걸음 타이밍, 팔 사용, 몸통 기울기, 넘어질 때 손을 먼저 짚는지 같은 *반응의 모양*을 맞추는 데 쓴다. Kimodo는 키네마틱 생성 모델이라 Δv·COM 이동·회복 시간 같은 *정확한 수치*는 물리적으로 보장되지 않는다(캡처 포인트 검사로 걸러도 마찬가지). 수치 기대값의 근거로 쓸 때는 분포(중앙값·범위)만 쓰고, 단일 클립 값을 기준으로 삼지 않는다.

### 밀림을 주는 방법: 루트 경로 제약 (기본)
- 0프레임 = 우리 stand 키프레임, Hips 경로 = 1.0초(30프레임)까지 제자리, 1.4초(42프레임)에 밀린 방향으로 세기만큼 (Kimodo `root_path` + `root_path_frames`). 프롬프트는 세기와 무관하게 `a person standing still is suddenly pushed <방향 문구>, and recovers their balance`.
- 세기 = 0.4초 동안 Hips 이동: 가볍게 툭 6cm, 살짝 세게 15cm, 세게 30cm, 아주 세게 50cm, 매우 강하게 80cm. 넘어짐 레퍼런스는 50cm + `..., loses their balance and falls to the ground`.
- 텍스트만으로 세기를 준 방식(`lightly tapped / pushed firmly / shoved hard`, 2026-10-26 첫 실험, `assets/kimodo/push_study/summary_text_strength.md`)은 탈락: RP는 세 단계 모두 Δv 중앙값 0.04~0.09 m/s로 거의 같고 대부분 제자리였다(세기가 반응을 못 바꿈). 밀린 방향과 반대로 움직인 후보도 RP 14~16/24만 맞았다. 경로 제약은 "언제·얼마나" 밀렸는지를 고정해 sim 충격(Δv)과 맞춰 비교할 수 있다.
- 방향 문구는 힘의 방향을 직접 쓴다(`on the chest from the front, pushing them backward`). "pushed from behind"만 쓰면 뒤로 물러나는 후보가 많았다(첫 프롬프트, `_push_recover_*_prompt_v1`).
- 탈락 조건: 밀린 방향으로 움직이지 않음, 밀림 전(0.3~1.0초) COM이 3cm 넘게 움직임(예측 반응).
- 물리 타당성: 걸음마다 착지 발과 직전 캡처 포인트 거리(CP-착지), 제자리 버팀에서 캡처 포인트가 발 영역 밖으로 나간 거리(CP 이탈)를 함께 낸다.

### 명령
```bash
npm run kimodo:pushStudy                       # 방향 4 × 세기 6 × 모델 2 × 시드 6, 표 assets/kimodo/push_study/summary.md, 대표 이미지 push_<dir>.png
npx tsx tools/kimodo/pushSelect.ts             # 같은 세기(15cm)에서 제자리 vs 한두 걸음 후보 비교 이미지 select_<dir>.png
npx tsx tools/kimodo/pushSelect.ts --pick front hold rp12:5 --reason "..."   # → assets/poses/kimodo_push_hold_front.json (step → kimodo_push_recover_front.json)
npm run ref:compare -- <scenario> <clip>       # sim 로그 ↔ 레퍼런스 (refSimilarity)
```

### refSimilarity (`tools/kimodo/refSimilarity.ts`, SPEC 10)
- 30fps로 맞추고, sim은 `meta.events`의 첫 `hit` 시각, 레퍼런스는 클립 `info.pushFrame`(경로 제약으로 밀린 프레임, 없으면 수평 COM 가속도 피크)으로 정렬한다.
- 충격 시점의 COM 수평 위치를 원점, Hips 정면을 +Z로 정규화한 뒤 충격 0.3초 전부터 DTW(띠 0.5초). 프레임 거리 = COM 거리(m) + 0.3 × 바디 방향 평균 각(rad). 낮을수록 닮았다.
- 항목별: COM 궤적(DTW cm, 최대 이동), 바디 방향(DTW °), 몸통 기울기 프로파일(DTW °, 최대), 팔 사용량(Spine2 기준 팔 각속도 °/s, 비율), 걸음 수, 회복 시간(COM 수평 속도 < 0.1 m/s가 0.3초 이어짐), Δv. 결과는 `out/<scenario>/refSimilarity_<clip>.json`.

## 6. 계속 재생되는 클립 (idle·walk)
루프 클립은 발 미끄러짐과 이음매를 더 엄격하게 본다: 스펙 `weights`로 `footSlideRawCmPerS` 2, `footLockCorrectionCm` 1, `seamPosCm` 2, `seamVelCmS` 1, `seamAccelCm` 1 (기본의 2배 안팎).

## 7. 겟업 라이브러리 (v0.7, `npm run getup:build`)
```bash
npm run getup:build                                   # sample → cluster → generate → test → write (서버 RP-v1.2 필요, 캐시 있으면 GPU 없이)
npm run getup:build -- generate --seeds 1,2,3,4,5,6 --bothModes   # 대표마다 두 끝 방향 × 시드 6
npm run getup:build -- test --jobs 28 --force-test    # 물리 시험 병렬 (같은 결과)
npm run getup:build -- write --perRep 2 --insPerRep 4 # assets/poses/getup/*.json, assets/library/getup.json, src/sim/character/getupClips.generated.ts
npx tsx tools/getupTry.ts <out 이름> --clip <클립> --pose <out/시나리오 | 자세 json> --film   # 클립 하나 시험
```
- 요청: 시작 키프레임(0) = 실제 쓰러진 물리 자세(`fromPose`, 0프레임 검증 ≤ 2cm), 끝 키프레임(119) = 서기 포즈(feet/head 방향), 120프레임. **시작 키프레임만 주면 RP는 일어서지 않는다**(12/12).
- 후처리(`tools/kimodo/getupLib.ts`): 관절 튐 제거(35°/프레임), 몸통 지면 맞춤, feetTau·balanceTau.
- 저장: `assets/kimodo/getup_<대표>_<방향>/rp12_s<시드>/`, 후보 클립 `assets/library/candidates/`(추적 안 함), 표·선택 `assets/kimodo/INDEX.md` 겟업 절.

## 8. 반응 클립 라이브러리 (2026-10-27, README 결정 159~161)
```bash
npx tsx tools/kimodo/reactLib.ts gen [--dirs back,left] [--str s08] [--seeds 1-6]   # 지수 감속 루트 경로 밀림 클립 (서버 RP-v1.2, 캐시 있으면 GPU 없이)
npx tsx tools/kimodo/reactSelect.ts rank                                             # 칸별 순위·탈락 → out/react_lib/ranking.md (assets/kimodo/react_lib_ranking.md에 복사)
npx tsx tools/kimodo/reactSelect.ts write --per 2                                    # assets/poses/reaction/ + src/sim/character/reactionClips.generated.ts
npx tsx tools/kimodo/clipProfile.ts <clip.json>...                                   # COM 수평 속도·발 접촉 프로파일
npx tsx tools/armEval.ts --human react_back_s08,push_back_hard                       # 사람 클립 팔·몸통 지표 분포
```
밀림 조사(5장)의 '0.4초 동안 Hips 끌기'는 클립 COM이 밀리는 동안 가속해 물리 추종용으로 맞지 않는다. 반응 클립은 밀림 프레임에서 바로 Δv로 출발해 x(t) = D(1 − e^{−t/τ})로 감속하는 경로를 준다.

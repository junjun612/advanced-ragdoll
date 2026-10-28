# Kimodo 생성 목록

모든 요청에는 seed가 들어 있다. 클립마다 `<clip>/<model>_s<seed>/`에 `request.json`(모델 이름 포함), `response.json`, `motion.bvh`, 변환 결과 `clip.json`, 점수 `scores.json`이 있다. 순위표는 `<clip>/ranking.md`, 비교 이미지는 `<clip>/compare_top.png`와 `compare_models.png`다. 만들고 고르는 방법은 `docs/KIMODO.md`, 모델 비교는 `docs/KIMODO_COMPARE.md`에 있다.
모델: RP = Kimodo-SOMA-RP-v1.2 (5310), SEED = Kimodo-SOMA-SEED-v1.1 (5311). diffusion_steps 100, postprocess on. 날짜는 모두 2026-10-26.

## 고른 클립 (→ `assets/poses/`)

| 클립 | 결과 파일 | 프롬프트 | 생성 조건 | 고른 후보 | 점수 | 고른 이유 | 나머지를 떨어뜨린 이유 |
|---|---|---|---|---|---|---|---|
| idle_relaxed | `kimodo_idle_relaxed.json` (루프 3.5초, 105프레임, 제자리) | `a person stands idle in a relaxed way, slowly shifting their weight from the left leg to the right leg and back, breathing calmly` | 8초 생성, 0프레임 = stand 키프레임. 루프 구간 3~6초를 찾고, 이음매 크로스페이드 8프레임, 드리프트 제거 | RP 시드 2 | 2.48 (1위) | 정면 필름에서 좌우 체중 이동(골반 2.3cm)과 호흡이 자연스럽고 "전사" 자세가 아니다. 손목·목 꼬임이 없다. 최종 발 미끄러짐 0, 관통 0, 이음매 위치 1.1cm, 이음매 가속도 0.03이 안쪽 p95 0.06보다 작다 | RP 시드 4(2.84)는 거의 같지만 이음매 속도 차이가 더 크다. RP 시드 1·3·6은 루프 구간의 체중 이동이 1.5cm 미만이다(시드 1은 전체 클립에서는 8cm 움직이지만 루프 구간은 조용하다). SEED 6개는 모두 체중 이동 0.3~0.7cm로 거의 정지해 있다 |
| walk_forward | `kimodo_walk_forward.json` (루프 2.17초 = 2걸음 주기, 루트 모션 kept, 한 바퀴 +Z 3.04m, 1.40m/s) | `a person walks forward at a normal relaxed pace` | 8초 생성, 0프레임 = stand. 1.5초 뒤에서 루프 0.9~2.6초를 찾고, 왼발 뒤꿈치 착지를 0프레임으로 맞춤. 한 바퀴 yaw 변화(−1.6°)를 빼고 이동 방향을 +Z로 정규화 | RP 시드 1 | 6.35 (1위) | 측면·정면 모두 팔 흔들기, 양발 지지 구간, 발뒤꿈치→발끝 구르기가 자연스럽다. 이음매 가속도 0.72가 안쪽 p95 0.96보다 작다. 최종 미끄러짐 0, 관통 0 | RP 시드 6(6.89)은 이음매 속도 차이(10.1cm/s)가 더 크고 1.6m/s로 조금 빠르다. SEED 시드 2(7.22)는 발목 제한 초과가 6.0°로 크다(발끝이 바깥으로 돈다) |
| walk_backward | `kimodo_walk_backward.json` (루프 1.43초, 루트 모션 kept, 한 바퀴 −Z 1.41m, 0.98m/s) | `a person walks backwards at a steady pace` | walk_forward와 같음 (루프 1.0~3.0초) | RP 시드 3 | 5.69 (1위) | 속도가 "steady pace"에 맞고 저크가 낮다(136). 정면에서 발 궤적이 곧다. 미끄러짐 0, 관통 0 | RP 시드 2(7.07)는 루프 2.9초로 길고 손목 자름이 35°다. RP 시드 4는 속도 1.73m/s로 너무 빠르다(기대 위반). SEED는 발목 제한 초과가 평균 6.4°다. ※ 고른 클립도 발목 twist가 최대 11.5° 남는다 (±5° 제한) |
| walk_start | `kimodo_walk_start.json` (4초, 루프 아님, 루트 모션 kept, 0.9초쯤 왼발 첫 떼기, 4초에 +Z 3.4m) | `a person standing still starts walking forward at a normal relaxed pace` | 4초 생성, 0~6프레임 stand 고정 (`tools/kimodo/specs/walk_start.json`, 2026-10-27) | RP 시드 1 | 3.71 (1위, 시드 5와 동점) | 0.9초에 자연스러운 첫 걸음, 무게 옮기기 뒤 떼기, 미끄러짐 2.3cm/s·제한 위반 0. v0.6 걷기 복귀(멈춘 몸 → 다시 걷기, `config/animDriver.json resume.startClips`)에 쓴다 | 시드 5는 점수 같지만 첫 걸음 전 몸통 흔들림이 크다. 나머지는 저크·발고정 보정이 크다 |
| walk_backward_slow | `kimodo_walk_backward_slow.json` (루프, 작은 보폭) | `a person walks backwards slowly and carefully, taking small steps` | 8초 생성, 루프 1~3초 (2026-10-27) | RP 시드 6 | 3.59 (1위) | 뒤로 걷기 추종이 핀 없이 버티는지 보려고 만들었다 | ※ 지금 쓰지 않음(시나리오 없음, `animClips.ts` 미등록) — 뒤로 걷기는 walk_backward + 추종 핀 0.1로 정함 (README 결정 109·118) |
| push_hold_front | `kimodo_push_hold_front.json` | 아래 "밀림 조사" 프롬프트 (앞에서) | 밀림 6cm/0.4초 (가볍게) | RP 시드 4 | 4.91 | 가볍게 밀린 유효 후보 중 자동 점수 1위. 0걸음, Δv 0.06m/s, 몸통 10°, 회복 0.1초 | 같은 세기의 다른 RP 후보도 모두 제자리다. 점수만 낮다 |
| push_hold_back | `kimodo_push_hold_back.json` | 〃 (뒤에서) | 6cm | RP 시드 3 | 1.85 | 0걸음, Δv 0.04m/s, 몸통 3° | 〃 |
| push_hold_left | `kimodo_push_hold_left.json` | 〃 (왼쪽에서) | 6cm | RP 시드 3 | 1.82 | 0걸음, Δv 0.05m/s | 〃 |
| push_hold_right | `kimodo_push_hold_right.json` | 〃 (오른쪽에서) | 6cm | RP 시드 3 | 1.82 | 0걸음, Δv 0.05m/s | 〃 |
| push_recover_front | `kimodo_push_recover_front.json` | 〃 (앞에서) | 밀림 15cm/0.4초 (살짝 세게) | RP 시드 4 | — | 15cm 밀림에서 1~2걸음 후보 중 1위. 2걸음, Δv 0.47m/s, 몸통 17°, 팔 74°/s, 회복 1.8초 | 3걸음 후보는 "한두 걸음"이 아니라서 뺐다 |
| push_recover_back | `kimodo_push_recover_back.json` | 〃 (뒤에서) | 15cm | RP 시드 2 | — | 1걸음, Δv 0.34m/s, 몸통 21°, 회복 0.33초 | 〃 |
| push_recover_left | `kimodo_push_recover_left.json` | 〃 (왼쪽에서) | 15cm | RP 시드 5 | — | 2걸음, Δv 0.32m/s, 회복 0.8초 | 〃 |
| push_recover_right | `kimodo_push_recover_right.json` | 〃 (오른쪽에서) | 15cm | RP 시드 3 | — | 1걸음, Δv 0.29m/s, 회복 1.0초 | 〃 |
| push_diag_medium | `kimodo_push_diag_medium.json` | 아래 "밀림 추가 4종" | 앞-왼쪽 45°에서 15cm/0.4초 (오른쪽 뒤로) | RP 시드 2 | 2.89 (4위/6) | 밀린 직후(+0.77초) 오른발을 오른쪽 뒤로 32cm, +1.2초 왼발 26cm — 2걸음, 팔을 벌려 버티고 1.9초에 회복. 반응 지연이 가장 짧고 측면·정면 모두 자연스럽다. Δv 0.53m/s, 몸통 32° | 시드 3(1위)·4는 첫 걸음이 0.7~1.2초 늦다. 5는 3초 뒤 걸어가 버린다. 1은 몸통이 비틀린다. 6은 70° 숙이며 3걸음 휘청인다 |
| push_twice | `kimodo_push_twice.json` | 〃 | 앞에서 두 번: 1.0→1.4초 12cm, 1.6→2.0초 12cm (1.4~1.6초 2cm) | RP 시드 2 | 2.91 (3위/6) | 밀림마다 한 걸음: +0.8초 오른발 38cm 뒤로, +1.27초 왼발 36cm 뒤로. 1차에 몸통이 접히고 팔을 벌린다. 2걸음, 회복 1.5초 | 시드 1·4(1·2위)는 2차 밀림이 끝난 뒤에야 한 번에 크게 물러나 두 번 밀린 구분이 없다. 대안은 시드 3(3걸음, 작은 첫 걸음 → 두 번 물러남). 6은 75° 숙임, 5는 반응이 약하다 |
| push_side_during_step | `kimodo_push_side_during_step.json` | 〃 (프롬프트 변형 `_stop`) | 서기 → 첫 걸음. 루트 경로 0.4초까지 제자리, 0.8초 +13cm 전진(스윙 중간), 0.8→1.2초 오른쪽 15cm·전진 45cm | RP 시드 4 (`push_side_during_step_stop`) | 7.44 (1위/6) | 0.8초에 오른발 스윙 중 밀림 → 오른발을 오른쪽 앞에 넓게 딛고(+0.47초) 왼발·오른발(54cm)·왼발(13cm) 4걸음 만에 팔을 벌린 채 멈춘다 | 원래 프롬프트(`push_side_during_step`, 12시드)는 모두 밀린 뒤 오른쪽으로 돌아 계속 걸어가 버렸다(옆 3~5m). 그중 시드 4만 4걸음 뒤 멈췄지만 팔 반응이 1초 늦다. 변형 시드 3도 멈추지만 발이 엇갈린다 |
| push_side_single_support | `kimodo_push_side_single_support.json` | 〃 (프롬프트 변형 `_step`) | 왼발 외발 서기 키프레임(아래)을 0·0.8·1.0초에 고정, 1.0→1.4초 왼쪽(디딤발 쪽) 15cm | RP 시드 4 (`push_side_single_support_step`) | 7.11 (3위/6) | 외발로 버티다 +1.1초 든 오른발을 왼발 바로 뒤(28cm 뒤)에 내리고, +2.5초 왼발을 왼쪽으로 17cm 옮기는 2단계 걸음. 몸이 약 55° 돈다. ※ 반응 지연 약 1초는 사람보다 길다. 교차 걸음은 한 후보도 없었다 | 원래 프롬프트(`push_side_single_support`, 12시드)는 모두 외발로 버티며 든 다리를 옆으로 뻗어 균형을 잡았다(시드 3이 가장 뚜렷, 걸음 0). 변형 시드 1·2·6은 발을 2.3초 넘어서야 내리고, 3은 원래처럼 다리를 뻗고, 5는 한 발만 다시 옮긴다 |

- 밀림 레퍼런스는 사람 결정에 따라 가볍게만 쓴다(SPEC 원칙 7). 전략(걸음 수·타이밍·팔·몸통)을 참고하는 데 쓰고, 정확한 수치 기준으로 쓰지 않는다. 클립 `info.pushFrame` = 30(1.0초)이 밀린 시점이고, `npm run ref:compare`가 이 값으로 시점을 맞춘다.
- Δv는 밀린 뒤 1초 안의 COM 수평 속도 최대값에서 밀리기 직전 속도를 뺀 값이다(우리 바디로 FK한 질량 가중 COM).

## 밀림 조사 (`push_study/`, `push_<dir>_<strength>/`)

- 프롬프트: `a person standing still is suddenly pushed <on the chest from the front, pushing them backward | in the back from behind, pushing them forward | on their left shoulder from the left side, pushing them to their right | on their right shoulder from the right side, pushing them to their left>, and recovers their balance`. 넘어짐 행만 `… is suddenly shoved hard …, loses their balance and falls to the ground`를 쓴다.
- 생성 조건: 4초(넘어짐은 5초). stand 키프레임을 0·24·30프레임에 둔다. root_path는 0·30프레임에 제자리, 42프레임에 밀린 방향으로 6/10/15/30/50/80cm(넘어짐은 50cm)다. RP·SEED 각각 시드 1~6.
- 결과 표: `push_study/summary.md`. 대표 이미지: `push_study/push_{front,back,left,right}.png`. 같은 세기에서 제자리와 걸음 후보를 나란히 보려면 `npx tsx tools/kimodo/pushSelect.ts`를 쓴다.
- 버린 실험:
  - `_textstrength_push_*` (`summary_text_strength.md`): 텍스트로만 세기를 줬다. 세기가 반응을 바꾸지 못했다(RP Δv 0.04~0.09 m/s).
  - `summary_path_only.md`: 경로만 주고 밀림 직전 자세를 고정하지 않았다. 밀리기 0.3초 전부터 2~10cm 먼저 움직이는 예측 반응이 나왔다.
  - `_push_recover_*_prompt_v1`: "pushed from behind"처럼 방향만 쓴 첫 프롬프트다. 뒤에서 밀었는데 뒤로 물러나는 후보가 많았다.

## 밀림 추가 4종 (`tools/kimodo/pushExtra.ts`, 2026-10-26, RP-v1.2만)

- 방법은 밀림 조사와 같다: 중립 프롬프트 + 루트 경로로 밀림 + 밀림 직전 0.8·1.0초 전신 키프레임(걷기 클립은 0프레임 stand만). 스펙 `tools/kimodo/specs/push_extra/<clip>.json`, 후보별 반응 지표·착지 목록 `<clip>/reaction.json`, 후보 전부 비교 `<clip>/compare_all_{front,side}.png`.
- 프롬프트: diag `… pushed on the chest from the front-left, pushing them diagonally backward and to their right, and recovers their balance` / twice `… pushed twice in quick succession on the chest from the front, pushing them backward, …` / step `a person starts walking forward from standing, and during their first step is suddenly pushed on their left shoulder from the left side, pushing them to their right, and recovers their balance` (변형 `_stop`: `…, takes a quick step to the side to catch their balance, then stops and stands still`) / single `a person standing on their left leg with their right foot raised is suddenly pushed on their right shoulder from the right side, pushing them to their left, and recovers their balance` (변형 `_step`: `a person balancing on their left leg … quickly puts their right foot down across to catch themselves, and recovers their balance standing on both feet`).
- 외발 서기 키프레임 `stand_single_left`: stand에서 오른 고관절 flex 40°·무릎 70°(발목 16cm 들림), 왼 고관절 side −6°·발목 side +6°(왼발이 골반 중점 아래, 발바닥 수평), Spine side −3°(디딤발 쪽으로). src 포즈 라이브러리에 없어서 `pushExtra.ts`가 POSES에 넣고 `fromPose.ts`로 보낸다.
- 시드: diag·twice 1~6, step·single 원래 프롬프트 1~12, 변형 1~6. 예측 반응(밀림 전 0.3초 2cm 초과)은 정지 클립 모두 0.3cm 미만이다. 걷기 클립은 걷는 중이라 이 검사가 맞지 않는다.
- 실패 기록: 외발 클립의 기대(교차 걸음)는 18후보 중 하나도 나오지 않았다. RP는 외발 밀림에서 다리 뻗기 균형이나 늦은 발 내리기를 고른다.

## 그 밖의 생성

| 이름 | 용도 | 메모 |
|---|---|---|
| roundtrip_stand | 우리 포즈 → 키프레임 검증 (테스트 픽스처) | 프롬프트 `a person stands still`, 1초, 시드 0, RP·SEED. 0프레임 오차는 손가락 끝을 뺀 28관절에서 0.0cm다(기준 2cm) |
| _idle_prompt_v1 | idle 첫 프롬프트 (탈락) | `a person stands in a relaxed natural pose, breathing calmly and occasionally shifting weight …`. 12개 모두 골반 흔들림이 1.5cm 미만으로 체중 이동이 거의 없었다 |

## 가슴 총격 반응 조사 (`shot_study`, 2026-10-27, RP-v1.2만, v0.5a 대표 장면 레퍼런스)

- 방법은 밀림 조사와 같다: stand 키프레임 0·24·30프레임, root_path 0·30프레임 제자리 → 42프레임 뒤로 28cm. 클립 `info.pushFrame` = 30(맞은 시점, candidates.ts가 rootPath에서 자동으로 넣음). 스펙 `tools/kimodo/specs/shot_study/*.json`, 고른 후보 비교 이미지 `assets/kimodo/shot_study_chosen.png`(정면·옆).
- 결과: RP는 "shot"·"clutches the wound"를 거의 모른다. 같은 시드는 프롬프트가 달라도 거의 같은 동작(경로 제약이 지배). 손바닥(Hand 바디)이 Spine2 앞 가슴 영역에 1초 넘게 머문 후보는 94개 중 4개뿐이었다(right s4·s7, press s4, painB s2).

| 이름 | 프롬프트 | 시드 | 결과 / 선택 |
|---|---|---|---|
| shot_chest_clutch | `a person standing still gets shot in the chest, staggers backward and clutches the wound` (SPEC 지정) | 1~18 | 움켜쥠 0/18 (s12만 끝 0.37초 왼손, 그것도 3.3m 뒤로 걸어감). 탈락 — 손이 몸 옆에 그대로 |
| shot_chest_clutch_free | 위와 같고 root_path 없음 | 1~12 | 12개 모두 그냥 서 있음(이동 3cm 미만). 탈락 |
| shot_chest_clutch_cfg5 | SPEC 프롬프트 + cfg separated [5,2] (스크래치 스크립트, candidates.ts 미지원) | 1~12 | 움켜쥠 0/12. 탈락 |
| shot_chest_clutch_hand | `…, staggers backward a couple of steps and clutches the wound on their chest with one hand` | 1~12 | s12 왼손 0.93초(2.8m 뒤로 걸어감)만. 탈락 |
| shot_chest_clutch_painA / painB | `a person stumbles backward and clutches their chest with their right hand in pain` / `a person is hit in the chest, stumbles backward, then holds their right hand on their chest` | 1~8 | A 0/8, B s2 왼손 2.3초지만 2.8m 뒤로 계속 걸음. 탈락 |
| **shot_chest_clutch_press** `rp12_s4/clip.json` | `a person standing still is suddenly hit hard in the chest, stumbles backward two steps and presses their right hand against their chest in pain` | 1~12 | **1안 선택.** 오른손이 맞은 뒤 0.63초에 가슴(Spine2 기준 x+0.15 y−0.14 z+0.14m)에 닿아 끝까지 2.4초 유지, 왼팔은 옆으로 벌려 균형. 뒤로 4번 착지(COM 1.2m)·몸통은 뒤로 젖히지 않고 최대 36° 앞으로 웅크림. 12개 중 유일하게 1초 넘게 가슴을 누름 |
| **shot_chest_clutch_right** `rp12_s4/clip.json` | `a person standing still is suddenly shot in the right side of the chest, staggers backward two steps and clutches the wound with the right hand` | 1~12 | **2안 선택.** 1안과 같은 시드라 동작이 거의 같다(경로 지배). 오른손 0.83초 도달·2.0초 유지 후 마지막 0.4초는 배 쪽으로 내려감, 3걸음(1.1m). s7(오른손 1.2초, 아래 갈비 옆, 2걸음)은 손 위치가 낮아 제외 |
- ※ 두 안 모두 뒤로 1.1~1.2m 물러나 "1~3걸음 비틀"보다 크고, 맞는 순간 몸통이 뒤로 젖혀지지 않는다(앞으로 웅크림만). 맞은 직후 0.3초 반응(뒤 젖힘·팔 튐)은 레퍼런스로 못 얻었으니 손 움켜쥠 타이밍·자세 수치만 참고한다.

## 넘어짐 레퍼런스 (`fall_study`, 2026-10-27, RP-v1.2만, v0.5b film --compare)

- 방법: 밀림 조사와 같다(stand 키프레임 0·24·30프레임, 앞·뒤는 root_path 0·30프레임 제자리 → 42프레임 0.5m). 스펙 `tools/kimodo/specs/fall_study/*.json`, 후보 비교 `assets/kimodo/<clip>/compare_top.png`. 시드 1~8.

| 이름 | 프롬프트 | 결과 / 선택 |
|---|---|---|
| **fall_forward_hands** `rp12_s6/clip.json` | `a person standing still is pushed hard from behind, stumbles forward, loses their balance and falls forward to the ground, catching themselves with their hands` | 8개 모두 넘어짐. 대부분 한두 걸음 → 무릎을 먼저 대고 → 손으로 짚어 엎드림(s1·s5). **s6 선택**: 한쪽 무릎을 꿇으며 두 팔을 앞으로 뻗어 엎드림(손 뻗는 모양이 우리 대비와 가장 비슷). push_front_large `reference` |
| **fall_backward_protect** `rp12_s3/clip.json` | `a person standing still is pushed hard on the chest, stumbles backward, loses their balance and falls backward to the ground, tucking their chin and protecting their head with their arms` | 8개 중 넘어진 것은 s3 하나(나머지는 6~9m 뒤로 계속 걸음). s3는 팔을 벌린 채 뒤로 눕고 머리 감싸기는 없음 — RP는 머리 보호를 모른다. push_back_large `reference` |
| **collapse_to_knees** `rp12_s1/clip.json` | `a person standing still suddenly weakens and collapses down onto both knees, then stays kneeling upright` | 8개 모두 무릎을 꿇음. **s1 선택**: 뒤꿈치를 들며 무릎이 앞으로 내려가 0.6초에 꿇고, 허벅지를 세운 채 고개를 숙임(s5도 비슷). kneel_trigger `reference` |

## 공중·바닥 레퍼런스 (`air_study`, 2026-10-27, RP-v1.2만, v0.5c)

- 방법: 폭발은 fall_study와 같다(stand 키프레임 0·24·30프레임, root_path 0·30프레임 제자리 → 50프레임 뒤로 2.0m, 4초). 바닥 몸부림은 시작 키프레임·root_path 없이 6초. 스펙 `tools/kimodo/specs/air_study/*.json`, 후보 비교 `assets/kimodo/<clip>/compare_top.png`. 시드 1~8.
- 수치: `npx tsx tools/kimodo/airStats.ts thrown <clip.json>` / `writhe <clip.json>... [--last 3]`.

| 이름 | 프롬프트 | 결과 / 선택 |
|---|---|---|
| explosion_thrown_roll (탈락) | `a person standing still is thrown backward through the air by an explosion in front of them, lands on the ground and rolls backward` | 8개 모두 넘어지지 않고 뒤로 9~14m 달려감(4초 끝 Hips 0.95m 이상). 쓸 것 없음 |
| **explosion_thrown_roll_v2** `rp12_s8/clip.json` | `a person standing still is blown off their feet by a huge explosion in front of them, flies backward through the air, crashes flat on their back on the ground and tumbles over backward, then lies on the ground` | 바닥까지 간 것 4개(s1·s2·s6·s8), 나머지는 뒤로 계속 달림. **s8 선택**: 뒤로 크게 두세 걸음 뛰며 팔을 앞·옆으로 들고(비행 중 상완-몸통 아래축 평균 왼 67°·오 76°, 최대 152°, 서기 16°) → 2.0초 엉덩이로 주저앉고 → 2.4~2.9초 어깨 너머로 뒤구르기(2.63초 골반 뒤집힘) → 3초부터 등을 대고 누움. s6은 등으로 떨어지기만 하고 구르지 않음. 진짜 체공은 없다(Hips 최고 = 서기 높이 1.03m) — RP는 "날아감"을 뒷걸음 도약으로 낸다 |
| lie_writhe_pain | `a person lies on their back on the ground in pain, writhing slowly, knees drawn up, holding their stomach` | 8개 모두 누움(s2·s6은 0프레임부터 누움, 나머지는 0.5~1.4초에 쪼그려 앉았다 누움). 누운 뒤는 거의 정지: 끝 3초 관절 평균 각속도 중앙값 3.3°/s(3.0~8.3), Hips 수평 최대 0.05m/s. 무릎은 굽힘 95~106°(s4만 53°) |
| **lie_writhe_pain_v2** `rp12_s8/clip.json` | `a person lying on their back on the ground rolls from side to side in pain, clutching their stomach with both hands, knees pulled up toward the chest, writhing and squirming` | 8개 모두 누움, 움직임이 v1보다 큼(끝 3초 중앙값 8.0°/s, 3.7~21.7). **s8 선택**: 0.8초 쪼그려 앉음 → 1.0~1.3초 옆으로 쓰러져 등·옆구리로 누움 → 무릎을 당긴 채(엉덩 굽힘 60°, 무릎 100°) 팔·머리를 계속 조금씩 움직임. 끝 3초 관절 평균 18.8°/s(팔 19.6, 손 39.3, 머리 29.2, 엉덩 11.8, 무릎 8.6), Hips 수평 최대 0.14m/s. s7(21.7°/s)은 웅크려 공처럼 말려 반듯이 눕지 않아 뺐다. 반듯이 등 대고 좌우로 뒹구는 몸부림은 RP가 거의 안 낸다 |
<!-- getup-library -->
## 겟업 라이브러리 (v0.7, `npm run getup:build`)

- 프롬프트 `a person gets up from the ground and stands still`, RP-v1.2, 4초. 0프레임 = 실제로 쓰러진 물리 자세(키프레임, 오차 ≤ 2cm), 끝 프레임 = 서기 자세(feet: 발 쪽을 보고 엉덩이~발 중간, head: 머리 쪽을 보고 엉덩이 자리; 대표마다 두 방향 × 시드 1~6, 보험도 같음). 끝 키프레임 없이 시작 키프레임만 주면 RP는 12/12 누운 채 끝났다.
- 표본 251개(무작위 쓰러짐 260회 중 판정된 것) → 대표 30개 + 보험 2개. 생성 384개, 물리 시험 통과(대표 자세 성공 + 성공률 ≥ 50%) 중 대표마다 성공률·보조 사용량 순 상위 2개(보험 4개) = 68개.

| 대표 | 자세 | 구성원 | 후보 (성공률 · 남김) |
|---|---|---|---|
| c01 | 누움 | 26 | feet s1 100%, feet s2 75%, feet s3 75%, feet s4 100% ✓, feet s5 100% ✓, feet s6 0%, head s1 0%, head s2 0%, head s3 0%, head s4 0%, head s5 0%, head s6 100% |
| c02 | 엎드림 | 4 | head s1 100%, head s2 100%, head s3 100%, head s4 100% ✓, head s5 25%, head s6 75%, feet s1 75%, feet s2 0%, feet s3 0%, feet s4 25%, feet s5 100% ✓, feet s6 75% |
| c03 | 옆 | 2 | feet s1 50%, feet s2 100%, feet s3 100%, feet s4 100% ✓, feet s5 100% ✓, feet s6 100%, head s1 50%, head s2 100%, head s3 100%, head s4 50%, head s5 100%, head s6 0% |
| c04 | 옆 | 4 | feet s1 100%, feet s2 25%, feet s3 100%, feet s4 100% ✓, feet s5 50%, feet s6 100% ✓, head s1 75%, head s2 25%, head s3 0%, head s4 50%, head s5 0%, head s6 0% |
| c05 | 누움 | 18 | feet s1 100% ✓, feet s2 100%, feet s3 75%, feet s4 100%, feet s5 100% ✓, feet s6 50%, head s1 75%, head s2 0%, head s3 100%, head s4 100%, head s5 50%, head s6 25% |
| c06 | 엎드림 | 6 | head s1 100%, head s2 100%, head s3 75%, head s4 100%, head s5 0%, head s6 75%, feet s1 0%, feet s2 100% ✓, feet s3 100% ✓, feet s4 100%, feet s5 75%, feet s6 75% |
| c07 | 엎드림 | 9 | head s1 100%, head s2 75%, head s3 25%, head s4 0%, head s5 100% ✓, head s6 0%, feet s1 0%, feet s2 0%, feet s3 0%, feet s4 100% ✓, feet s5 75%, feet s6 0% |
| c08 | 누움 | 6 | feet s1 75%, feet s2 25%, feet s3 50%, feet s4 100% ✓, feet s5 75%, feet s6 100% ✓, head s1 100%, head s2 0%, head s3 100%, head s4 0%, head s5 100%, head s6 100% |
| c09 | 엎드림 | 3 | head s1 67%, head s2 100% ✓, head s3 100%, head s4 33%, head s5 0%, head s6 100% ✓, feet s1 0%, feet s2 0%, feet s3 33%, feet s4 0%, feet s5 0%, feet s6 0% |
| c10 | 누움 | 50 | feet s1 100% ✓, feet s2 100%, feet s3 75%, feet s4 100%, feet s5 100% ✓, feet s6 100%, head s1 0%, head s2 25%, head s3 100%, head s4 75%, head s5 100%, head s6 25% |
| c11 | 옆 | 5 | feet s1 50%, feet s2 0%, feet s3 0%, feet s4 100% ✓, feet s5 100% ✓, feet s6 50%, head s1 100%, head s2 75%, head s3 100%, head s4 50%, head s5 100%, head s6 75% |
| c12 | 누움 | 18 | feet s1 100%, feet s2 50%, feet s3 100%, feet s4 100%, feet s5 100% ✓, feet s6 50%, head s1 100% ✓, head s2 75%, head s3 100%, head s4 0%, head s5 0%, head s6 0% |
| c13 | 엎드림 | 5 | head s1 75%, head s2 75%, head s3 100% ✓, head s4 0%, head s5 0%, head s6 100% ✓, feet s1 0%, feet s2 0%, feet s3 0%, feet s4 0%, feet s5 50%, feet s6 0% |
| c14 | 옆 | 3 | feet s1 33%, feet s2 100%, feet s3 100% ✓, feet s4 100%, feet s5 100% ✓, feet s6 67%, head s1 100%, head s2 100%, head s3 33%, head s4 67%, head s5 100%, head s6 0% |
| c15 | 옆 | 9 | feet s1 100%, feet s2 75%, feet s3 100%, feet s4 100% ✓, feet s5 100% ✓, feet s6 75%, head s1 100%, head s2 0%, head s3 75%, head s4 100%, head s5 25%, head s6 75% |
| c16 | 엎드림 | 17 | head s1 100%, head s2 100% ✓, head s3 0%, head s4 100% ✓, head s5 0%, head s6 0%, feet s1 25%, feet s2 25%, feet s3 75%, feet s4 75%, feet s5 0%, feet s6 50% |
| c17 | 엎드림 | 3 | head s1 67%, head s2 100%, head s3 33%, head s4 0%, head s5 0%, head s6 67%, feet s1 67%, feet s2 100% ✓, feet s3 100% ✓, feet s4 100%, feet s5 67%, feet s6 67% |
| c18 | 엎드림 | 8 | head s1 100%, head s2 100% ✓, head s3 100%, head s4 0%, head s5 100% ✓, head s6 50%, feet s1 0%, feet s2 0%, feet s3 0%, feet s4 75%, feet s5 75%, feet s6 0% |
| c19 | 옆 | 10 | feet s1 100%, feet s2 75%, feet s3 75%, feet s4 100% ✓, feet s5 100% ✓, feet s6 100%, head s1 100%, head s2 25%, head s3 75%, head s4 50%, head s5 100%, head s6 75% |
| c20 | 누움 | 4 | feet s1 100% ✓, feet s2 75%, feet s3 75%, feet s4 100% ✓, feet s5 100%, feet s6 100%, head s1 75%, head s2 100%, head s3 25%, head s4 50%, head s5 100%, head s6 100% |
| c21 | 옆 | 3 | feet s1 0%, feet s2 100% ✓, feet s3 100% ✓, feet s4 100%, feet s5 100%, feet s6 100%, head s1 67%, head s2 100%, head s3 100%, head s4 33%, head s5 67%, head s6 0% |
| c22 | 엎드림 | 1 | head s1 0%, head s2 0%, head s3 100% ✓, head s4 100%, head s5 0%, head s6 100%, feet s1 100%, feet s2 100% ✓, feet s3 100%, feet s4 100%, feet s5 0%, feet s6 0% |
| c23 | 엎드림 | 3 | head s1 100% ✓, head s2 0%, head s3 100%, head s4 100%, head s5 100%, head s6 100%, feet s1 0%, feet s2 67%, feet s3 67%, feet s4 100% ✓, feet s5 100%, feet s6 100% |
| c24 | 옆 | 10 | feet s1 100%, feet s2 100% ✓, feet s3 100%, feet s4 75%, feet s5 100% ✓, feet s6 100%, head s1 100%, head s2 25%, head s3 75%, head s4 100%, head s5 100%, head s6 50% |
| c25 | 엎드림 | 5 | head s1 100%, head s2 100%, head s3 50%, head s4 0%, head s5 25%, head s6 25%, feet s1 0%, feet s2 50%, feet s3 50%, feet s4 0%, feet s5 100% ✓, feet s6 100% ✓ |
| c26 | 옆 | 2 | feet s1 0%, feet s2 0%, feet s3 0%, feet s4 100% ✓, feet s5 100% ✓, feet s6 100%, head s1 100%, head s2 0%, head s3 50%, head s4 0%, head s5 50%, head s6 50% |
| c27 | 엎드림 | 3 | head s1 100% ✓, head s2 33%, head s3 67%, head s4 67% ✓, head s5 0%, head s6 67%, feet s1 0%, feet s2 33%, feet s3 0%, feet s4 33%, feet s5 33%, feet s6 33% |
| c28 | 옆 | 3 | feet s1 33%, feet s2 0%, feet s3 67%, feet s4 33%, feet s5 67%, feet s6 100% ✓, head s1 100%, head s2 100%, head s3 67%, head s4 100% ✓, head s5 33%, head s6 33% |
| c29 | 누움 | 4 | feet s1 100%, feet s2 75%, feet s3 100%, feet s4 100% ✓, feet s5 25%, feet s6 100% ✓, head s1 100%, head s2 25%, head s3 100%, head s4 100%, head s5 100%, head s6 75% |
| c30 | 누움 | 7 | feet s1 50%, feet s2 100%, feet s3 100% ✓, feet s4 100% ✓, feet s5 100%, feet s6 100%, head s1 100%, head s2 0%, head s3 50%, head s4 100%, head s5 75%, head s6 25% |
| ins_prone | 엎드림 | 67 | feet s1 0%, feet s2 25%, feet s3 0%, feet s4 100% ✓, feet s5 100% ✓, feet s6 25%, head s1 100% ✓, head s2 100% ✓, head s3 75%, head s4 50%, head s5 0%, head s6 75% |
| ins_supine | 누움 | 131 | feet s1 100% ✓, feet s2 100% ✓, feet s3 75%, feet s4 100%, feet s5 100% ✓, feet s6 100% ✓, head s1 0%, head s2 25%, head s3 100%, head s4 75%, head s5 100%, head s6 25% |

## 반응 클립 라이브러리 (`react_lib`, 2026-10-27, RP-v1.2만, README 결정 159~161)

- 목적: 서서 몸통을 밀린 사람의 상체(척추·머리·팔) 반응 레퍼런스 — 런타임 반응 클립(`assets/poses/reaction/*.json`, `src/sim/character/reactionClips.generated.ts`).
- 프롬프트: `a person standing still is suddenly pushed <방향 문구>, and recovers their balance` (밀림 조사 문구 + 대각 4개). stand 키프레임 0·24·30프레임.
- 루트 경로: 30프레임(밀림)부터 x(t) = D(1 − e^{−t/τ}), D = Δv·τ — 밀림 직후 Hips가 바로 Δv로 출발해 감속(순간 충격과 같은 꼴). 밀림 조사(0.4초 동안 끌기)는 클립 COM이 밀리는 동안 가속하고 급정거·달리기가 섞여 물리 추종이 안 됐다(README 결정 160).
- 생성: `npx tsx tools/kimodo/reactLib.ts gen` — 방향 8(back·front·left·right·backleft·backright·frontleft·frontright = 밀려 가는 쪽) × 세기 3(s05 Δv 0.5 τ 0.55, s08 0.8 τ 0.6, s11 1.1 τ 0.65) × 시드 1~6 = 144개 (`tools/kimodo/specs/react_lib/`).
- 고르기: `npx tsx tools/kimodo/reactSelect.ts rank|write --per 2` — 탈락(몸통 최대 > 35°, 팔 들림 p90 > 55°, 끝 COM 속도 > 0.15 m/s), 순위 = 칸 중앙값(팔 들림·팔꿈치·팔 사용·몸통)에서의 거리 + 0.1 × 자동 점수 + (팔 들림 p90 − 25°)/10. 칸마다 2개 = 48개. 전체 표 `assets/kimodo/react_lib_ranking.md`.
- 관찰: 시드 6은 거의 모든 칸에서 60~70° 숙이며 비틀거림(탈락). COM 최대 속도는 Hips 경로 Δv의 60~85%(Kimodo가 몸통을 늦게 따라옴). 사람 첫 걸음은 밀림 0.3~0.4초 뒤.

## 반응 클립 프롬프트 변형 (`react_upright_*`, `react_shove_*`, 2026-10-28, RP-v1.2만, 결정 clip-1~5)

- 목적: 가슴·어깨를 손으로 민 외란에 맞는 반응(몸통이 크게 꺾이지 않음)이 문구로 나오는지, 반응 클립을 바꾸면 sim의 몸통 휨이 줄어드는지 확인.
- 루트 경로·키프레임·시드는 원래 라이브러리와 같다(`reactLib.ts gen --set <묶음>`, `REACT_SETS`). 문구:
  - `upright`: `a person standing still is suddenly shoved <방향 문구>; they keep their torso upright and take one or two quick steps <밀린 쪽> to catch their balance, then stand still with arms relaxed` — 8방향 × 3세기 × 시드 1~6 = 144개
  - `shove`: `a person standing still is suddenly shoved <방향 문구>, staggers <밀린 쪽> with one or two quick steps, and then stands still` — back·left × s08 × 시드 1~6 = 12개(예비)
- 원래 문구 144개도 같은 시드로 다시 만들었다(관절 값이 정적 라이브러리와 비트 단위로 같음 — 재현 확인).
- 측정(`tools/kimodo/clipTone.ts`, toneDiag와 같은 정의): 문구를 바꿔도 몸통 휨 분포는 거의 같다 — back·left s08 몸통 최대 원래 7~23°(라이브러리 2개) / upright 4~28°(시드 6만 57°) / shove 6~34°(시드 6 71°). 엄격 선별(몸통 ≤ 25°·목 ≤ 45°·팔 p90 ≤ 50°)에서 탈락은 원래 49/144, upright 45/144(몸통 42 → 30, 목 4 → 11).
- 고른 것: 없음(정적 라이브러리 그대로). 원래 + upright 288개에서 엄격 선별 48개(`reactSelect.ts write --sets ,upright --maxTrunk 25 --maxNeck 45 --maxElevP90 50 --out out/clipsel/strict`, 원래 25 · upright 23)는 sim 216짝에서 넘어짐 22 → 17(p = 0.27)·걸음 −0.13 ± 0.08·몸통 −0.9 ± 0.3°로 잡음 수준이고 필름에서 차이가 안 보여 채택하지 않았다(결정 clip-4).
- 사람 첫 걸음 시각(`tools/onsetEval.ts human`): 라이브러리 48개 이륙 0.23초(p25~p75 0.13~0.33)·착지 0.43초(0.30~0.57), 밀림 조사 medium 0.27·0.40초, hard 0.20·0.40초. 착지까지 몸통 2~7°, 2.5초 최대 13~16°.

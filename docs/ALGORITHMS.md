# 알고리즘 정의 (SPEC 보조 문서)

SPEC.md는 고치지 않는다. SPEC에 없는 세부 정의는 여기에 둔다.

## limitHits (제한 닿은 프레임)

로그 프레임(30Hz) 중 아래 둘 중 하나를 만족하는 관절이 하나라도 있는 프레임의 수. 판정은 매 스텝의 `JointState`로 하고, 로그 프레임에서만 센다. 잠긴 축(경첩의 비틀기·옆굽힘)은 제외한다.

1. **초과**: `limitMarginDeg > limitHitTolDeg` (기본 1°). 가장 가까운 제한을 1° 넘게 넘었다.
2. **밀착 + 진행**: `limitMarginDeg > -limitPressMarginDeg` (기본 0.5°)이고 `limitApproachDegS > limitPressVelDegS` (기본 5°/s). 제한 0.5° 안쪽까지 붙어 있고 상대 각속도가 제한 쪽을 향한다.

이전 정의(제한 1° 안쪽에 있기만 하면 셈)는 rest 자세의 팔꿈치·무릎(0° 제한 경계)이 매 프레임 걸려 의미가 없었다. 가만히 제한에 붙어 있는 것은 이제 세지 않는다.

- `limitApproachDegS`: 상대 각속도(자식 − 부모, 부모 쪽 관절 좌표계로 표현)에서 가장 가까운 제한 축의 성분. 작은 각에서 관절 좌표의 변화율과 같다. 양수 = 제한 쪽.
- 기준값은 `config/sim.json` `judge`의 `limitHitTolDeg`, `limitPressMarginDeg`, `limitPressVelDegS`.

## t=0 프레임의 접촉

`World.addCharacter` 직후 `PhysicsWorld.refreshContacts()`가 한 스텝을 돌려 접촉을 채우고, 모든 바디를 스폰 위치로 되돌리며 속도를 0으로 둔다(시간·스텝 수 불변). 그래서 첫 로그 프레임의 `contacts`·`posture`·`stance`가 지면 접촉을 반영한다. 공중에서 시작하는 시나리오는 그대로 `airborne`다.

## 복합 형상 (목 캡슐)

바디는 `extraShapes`로 콜라이더를 더 가질 수 있다. 질량은 바디 `massRatio`를 콜라이더 부피(겹침 무시) 비례로 나눈다. 그래서 Head 바디의 질량 중심은 구 중심에서 목 쪽으로 약간 내려간다. 인접 바디 충돌 끄기는 바디 단위라 목 캡슐에도 그대로 적용된다(Head↔Spine2 충돌 없음).

---

# v0.2 근육

코드: `src/sim/character/muscles.ts`, `assist.ts`, `pose.ts`, `src/sim/metrics/muscleMetrics.ts`. 설정: `config/muscles.json`, `config/assist.json`, `config/poses/`, `config/sim.json` `muscleJudge`.

## 근육 (관절 모터 + 중력 보상)

매 스텝(7.1의 7단계) 관절마다:
1. **strength**: 명령 c = 영역 배율(회복 램프 포함) × 피로 상한(v0.2는 1). 상태가 Ragdoll이면 c = 0. `s += (c − s)·(1 − e^(−dt/τ))`, τ = `activationTime`(30 ms). 차이 1e-6 미만이면 c로 맞춤.
2. **목표**: 클립이 준 관절 좌표계 상대 회전 r_def(없으면 rest = 항등) → Rapier 관절 좌표계 r = conj(frameP_rapier)·frameInParent·r_def (어깨는 콘 축으로 돌린 frameP) → 축별 목표 2·asin(r 성분), w ≥ 0.
3. **모터** (raw `jointConfigureMotor`, ForceBased, 축별): stiffness s·kp, damping s·kd + 수동 마찰(`ragdoll.json` jointDamping), maxForce s·maxTorque + 수동 마찰 × `passiveVelCap`. 경첩은 AngX 하나.
4. **중력 보상**: 서브트리 질량 M과 질량 중심 c(바디 역순 누적), 관절점 p = 자식 위치 + q_child·anchorInChild. τ_gc = s·gc·(c − p) × (−M·g), |τ_gc| ≤ s·maxTorque. 자식에 +τ, 부모에 −τ (`addTorque`, 매 스텝 `resetTorques`/`resetForces` 먼저).
5. **로그(추정값)**: errorDeg = 목표·현재 상대 회전 사이 각. torque = |frame·clamp_축(s·kp·(목표좌표 − 현재좌표) − s·kd·ω_rel) + τ_gc|. saturated = 축별 클램프 또는 τ_gc 클램프가 걸림(s > 0일 때만). 모터가 실제로 낸 토크는 읽을 수 없다.

- kp_j = kpScale × kpRatio_j. kd_j = 2·ζ·sqrt(kp_j·I_j), I_j = rest 자세에서 관절점 기준 서브트리 관성 trace/3 (= Σ(trace I_body + 2m|r|²)/3, 회전 불변).
- 영역: `muscles.json` `regions`(all, upperBody, lowerBody, torso, neck, leftArm, rightArm, leftLeg, rightLeg) 또는 관절 이름. `setMuscleScale(region, scale, recoverTime?)`: 배율을 scale로, recoverTime이 있으면 그 시간 동안 1까지 선형 회복.
- 피로(v0.5): `fatigue.enabled`면 상한 cap += (recover·(1−u) − drain·u)·dt, u = torque/maxTorque, [minCap, 1]. v0.2는 꺼짐.

## 루트 보조

보이지 않는 고정 앵커 바디(스폰 때 Hips 위치·회전, 충돌체 없음)와 Hips를 축 잠금 없는 generic 관절로 잇고 모터를 건다: AngX/Y/Z 목표 0(stiffness `uprightKp`, damping `uprightKd`, 축별 maxForce `maxTorque`), LinY 목표 0(`heightKp`, `heightKd`, maxForce `maxForceBodyWeight`×체중). LinX·LinZ는 자유. 끄면 모든 이득과 maxForce를 0으로. 앵커는 처음 켤 때 만든다.
사용량 assist.root(N) = |F| + |τ|/`usageLeverArm`, F·τ는 같은 PD 식(클램프 포함) 추정. `assistUsage.root` = ∫ assist.root dt (N·s), `assistRootPeak` = 최대.
명시적 addTorque/addForce PD로 처음 구현했더니 Hips 하나에 거는 감쇠(kd·dt/I_Hips ≫ 2)가 매 스텝 부호를 바꿔 전신이 떨렸다(결정 28).

## 목표 포즈

`config/poses/<name>.json`: `joints: { Joint: { flex, twist, side } }` — 관절 좌표계(docs/RAGDOLL_CONFIG.md 3장) 회전 벡터(도), rest = 0. 클립은 `fps`, `loop`, `frames[].joints`, 키프레임 사이 slerp, 루프면 마지막→첫 프레임도 보간. `base`의 값으로 빈 관절을 채운다.
순기구학: q_child = q_parent·frameInParent·r·frameInChild⁻¹, p_child = p_parent + q_parent·anchorInParent − q_child·anchorInChild. `spawn.pose`는 Hips를 rest 위치에 두고 FK한 뒤 발 박스 최저 꼭짓점을 spawn.position.y로 옮긴다.

## v0.2 지표

| 지표 | 정의 |
|---|---|
| jointErrorMaxDeg / MeanDeg | strength ≥ 0.5인 관절의 errorDeg 최대·평균 (매 스텝) |
| jitter | 관절별로 축 3개의 "빠른 반전" 수 합 / 시간, 관절 최대. 반전 = 상대 각속도(부모 관절 좌표계) 축 성분 부호가 바뀌고 앞뒤 스텝 모두 \|ω\| > 0.1 rad/s. 빠른 = 같은 축 직전 반전 뒤 0.1초 안(5 Hz 이상 왕복). `jitterAll`은 간격 조건 없이 센 값(스파이크 정의, 진동 판정 ≥ 5/s) |
| saturation | saturated 관절이 하나라도 있는 스텝 비율 |
| energy | ∫ Σ_j torque_j² dt / (총질량 × 시간), torque는 추정값 |
| trackErrorMeanDeg | 1초(`trackWarmup`) 이후, 목표가 움직이는 관절(축 목표 표준편차 > 2°)의 errorDeg 평균 |
| trackLag | 같은 채널(관절×축, 목표·현재 Rapier 좌표)들로 lag ∈ [0, 0.5초]마다 ρ = Σcov(tgt(t), act(t+lag)) / sqrt(Σvar·Σvar)(겹치는 구간 평균 제거)를 구해 최대인 lag |
| collapseKneeFlexTime / HipsDropTime / KneeLeadTime | 첫 setMuscleScale 이벤트 뒤 첫 스텝을 기준: max(무릎 flex) ≥ 30°가 된 시각, Hips 높이가 기준 − 0.3m 이하가 된 시각(기준 대비). Lead = 하강 시각(없으면 끝) − 무릎 시각. strength_drop은 Lead ≥ 0 |

## kp 스윕 (실제 캐릭터, `npm run sweep:kp`)

hold_pose_pinned(10초), kpScale 5…51200(×2). 진동 = jitterAll ≥ 5/s 또는 폭발. 오차는 마지막 1초 평균(전 관절).

| 조건 | 진동 kp | 오차 @400 | @800 | @1600 | @51200 |
|---|---|---|---|---|---|
| 1/120, Hips 고정, 목표 포즈로 시작, 중력 보상 | 없음 | 0.078° | 0.062° | 0.049° | 0.013° |
| 1/120, Hips 고정, rest에서 시작(과도 응답), 중력 보상 | 없음 | 0.078° | 0.062° | 0.049° | 0.015° |
| 1/120, Hips 고정, 중력 보상 끔 | 5 (LeftHand) | 0.68° | 0.36° | 0.20° | 0.02° |
| 1/240, Hips 고정, rest 시작, 중력 보상 | 없음 | 0.027° | 0.022° | 0.019° | 0.006° |
| 1/120, 지면에 서기(hold_pose_assist), 중력 보상 | 5~100(다리가 못 버텨 넘어짐), **12800 이상**(RightFoot, 포화 0.68~0.90) | 4.7° | 1.6° | 0.8° | 0.29° |

스파이크 결론(모터 + 중력 보상은 전 kp 구간 무진동)은 Hips 고정에서 그대로 재현된다. 서 있는 전신에서는 kp ≥ 12800에서 발목이 축별 maxTorque에 걸려 뱅뱅 진동하므로(6400에서 2.8/s로 시작) 상한이 있다. 1/240은 오차를 1/3로 줄이지만 1/120 오차가 이미 0.1° 미만이라 타임스텝은 1/120 유지(결정 13 유지).

---

# v0.3 균형 (전신 운동량 제어, README 결정 49~53)

코드: `src/sim/character/perception.ts`, `balance.ts`, `contactQP.ts`(피라미드), `src/sim/dynamics/wholeBody.ts`(강체 동역학), `src/sim/dynamics/wbqp.ts`(전신 QP), `src/sim/math/nnls.ts`, `dense.ts`, `muscles.ts`(명령 반영), `src/sim/metrics/quality.ts`. 설정: `config/balance.json`, `config/sim.json`(`solverIterations` 20, `currentMilestone`, `qualityJudge`, `terrain.slopeDeg`), `config/ragdoll.json`(전완 감쇠), `config/poses/stand.json`·`lean.json`.

## 인지 (7.1의 2단계)
스텝마다 한 번(`Character.perception()`, 캐시). 지면 접촉점(거리 ≤ `judge.groundContactDist`), 발 하중 N = Σ 법선 충격량/dt, 발 아래 레이캐스트(점·법선), 지지 다각형 = 접촉 발의 박스 바닥 꼭짓점 중 지면 평면 `soleContactDist` 안 + 접촉점의 XZ 볼록 껍질, CoP = 접촉점 법선력 가중 평균.

## 강체 동역학 모델 (`wholeBody.ts`)
부유 기저 Hips(6) + 구형 11×3 + 경첩 4×1 = **43 자유도**. 월드 원점 기준 공간 벡터(운동 (ω, v_O), 힘 (n_O, f)). 관절 속도는 준속도: 구형 = 상대 각속도(월드) 3, S = [e_k; p×e_k], Ṡq̇ = [0; ṗ×ω_rel]; 경첩 = 부모에 고정된 축 a 둘레 각속도, S = [a; p×a], Ṡq̇ = v_p ×ₘ Sq̇. 질량·관성은 Rapier 바디 값(질량 중심, 주관성 × 주축 프레임) 그대로. M = Σ_b J_bᵀ I_b J_b, A_O = Σ_b I_b J_b(= M의 기저 6행), 운동량 바이어스 Σ(I a0 + v ×* I v), 역동역학(RNEA, 원점 공간 벡터) → 관절점 둘레 월드 토크.
검증(`tests/wholeBody.test.ts`): M 대칭·정부호, 무중력 랙돌에 관절 토크를 걸었을 때 예측 q̈와 Rapier 다음 스텝 차분이 1% 안, 순·역동역학 왕복 일치.

## 전신 운동량 QP (`wbqp.ts`)
변수 q̈(43) + 접촉 피라미드 계수 ρ ≥ 0(지지발 바닥 꼭짓점 × 4면, μ 0.8, 꼭짓점마다 최소 법선력 `minNormal`).
- 목적: Σ 과제 w‖T q̈ − r‖² + λ‖q̈‖² + wLin‖Σf − F_des‖² + wAng‖Σ(p−c)×f − k̇_des‖² + λ_ρ‖ρ‖² + λ_d‖ρ − ρ_prev‖²
- 등식: A_O q̈ = W_c(ρ) + W_g − bias (부유 기저 = 운동량), 지지발 공간 가속도 = −footKv·v_foot
- 풀이: 등식이 ρ에 선형 → KKT 행렬 [[H, Eᵀ],[E, 0]]을 한 번 LU 분해해 q̈(ρ) = x0 + Xρ를 구하고(X = Z·W_O, Z = 운동량 우변 단위 6개의 해 — v0.4 결정 65), 과제 값 함수를 ρ의 2차식으로 바꿔 ρ만 비음수 최소제곱(Lawson–Hanson)으로 푼다. 등식·부등식을 정확히 만족하는 결합 QP의 해이고 결정론적이다(외부 의존 없음). 로그 `qpResidual` = 등식 최대 잔차, `wbBaseResidual` = 역동역학 기저 잔차(둘 다 ~1e-9).
- 과제: 몸통(Spine2) 월드 방향 PD 가속도(yaw 제외, kp 30, kd 11 — 감지 지연 0.08초에서 진동하지 않는 이득; kp 100은 1 Hz 몸통 흔들림), 골반 방향(목표 포즈가 고관절을 더 굽히면 그만큼 기운 골반), 관절 자세 PD 가속도(관절별 가중치, 팔은 낮게), 팔 반사(아래).
- 원하는 렌치: F_des = DCM 피드백(아래) + 중력, k̇_des = −angularDamping·k_G (낮은 가중치 → 발 안에서 못 만드는 만큼은 몸통·팔 각운동량으로).
- 토크: τ = RNEA(q̈, 중력 + 접촉력)를 모든 관절에 토크 쌍으로, 서브트리 중력 보상 끔. 근육 모터는 kp·kd × `motorScale`(0.3)로 느슨하게 두고 그 PD 추정분을 균형 토크에서 뺀다(`subtractMotor`) → 모터 + 추가 토크 = 역동역학 토크가 되어 모델과 실제가 맞는다(빼지 않으면 실제 COM 감속이 명령의 절반). 모터의 암시적 감쇠는 남는다.

## 감지·목표
1. **감지 지연** 0.08초 + **예측 보상**: 지연된 COM·속도에 지연 구간 동안 내 접촉 합력(efference copy)/M + g를 적분, 몸통 회전은 감지 각속도 × delay로 앞당김(스미스 예측기). 예측 오차 ≤ 8 mm. 관절 상태(자세 과제)는 즉시.
2. **DCM 피드백**: ω = √(g/h), ξ = c + v/ω, CMP p = ξ + (kDcm/ω)(ξ − c_t), F_h = Mω²(c − p) + kiH∫(c_t − c), |F_h| ≤ maxHorizontalForce. 수직 = Mg + kpV Δh − kdV v_y.
3. **COM 목표** = 지지 다각형 중심(켤 때 현재 COM에서 시작, delay 뒤 중심으로). stand 포즈는 다리 4° 앞기울기로 근육 포즈의 COM이 처음부터 중심 위(결정 45).
4. **팔 반사**(결정 52): 감지 COM 수평 속도 v에 대해 팔 자세 목표를 ŷ×v̂ 축으로 min(maxDeg, degPerMs·|v|) 돌림(넘어지려는 회전과 같은 방향 → 각운동량을 받는다, 옆이면 반대쪽 팔만), 시정수 0.12초. 사람 레퍼런스 팔 사용량에 맞춤.
5. **개인차 훅**: `wb.variation.amount` > 0이면 시드 PRNG로 팔 반사·DCM 이득을 조금씩 다르게(기본 0).
6. **지지발 발목 목표** = 발바닥이 지면 법선에 평평(현재 정강이 기준).
7. 라벨: QP 모멘트 오차 / hipMomentRef의 smoothstep → "고관절 전략"(≥ 0.5) / "발목 전략".

## 사람 레퍼런스 비교 (SPEC 원칙 8)
`npm run film -- <시나리오> --compare <레퍼런스 clip.json>`: 레퍼런스(Kimodo 클립을 우리 랙돌로 FK)를 반투명 회색으로 겹쳐 그린다. 밀림 시작(수평 COM 가속도 피크)을 sim 첫 충격 시각에, 그 순간 COM 수평 위치를 맞춘다(`src/render/ghost.ts`, `tools/film.ts`). 레퍼런스 폴더 이름은 "어느 쪽에서 밀렸나"라서 방향이 반대다: 우리 push_front(+Z로 밀림) ↔ `push_back_*`(뒤에서 밀림), push_left(+X) ↔ `push_right_*`.

## 품질 지표 (SPEC 10, `quality.ts`)

| 지표 | 정의 |
|---|---|
| comJerk / angJerk | COM 속도·Spine2 각속도를 `jerkDt`(1/30초) 간격 표본 → 두 번 차분 → RMS |
| footSlide | (v0.4, 결정 58) 연속 두 스텝 모두 지면에 닿은 발의 접촉 중심점 수평 속도 × dt 합(두 발, m). 예전 정의(바디 원점 이동)는 footSlideBody |
| footDisplacementMax | 발의 시작 위치에서 수평 거리 최대 (m). push_*_small "스텝 없음" ※ ≤ 0.05 |
| reactionLatency | 충격 시각 → 원하는 COM 힘(피드백)이 충격 직전 값에서 `reactionForce`(30 N) 넘게 바뀐 첫 시각 (충격별 평균) |
| assistUsage.pin / .getup | 보조별 적분 (v0.3에는 0). 루트는 v0.2 정의 |
| limitHits, saturation, selfPenetration, jitter, energy | v0.1~v0.2 정의 그대로 |
| balanceMarginMin, hipWeightMax, hipStrategyTime, momentErrorMax, forceErrorMax | 균형이 켜진 스텝의 COM 여유 최소, w_hip 최대, 고관절 전략 시간, QP 렌치 추적 오차 최대 |
| leanTiltMaxDeg, leanHipsBackMin | 로그 프레임 Spine2 기울기 최대; 기울기 ≥ `leanTiltDeg`(15°)인 로그 프레임에서 Hips가 t=0 위치보다 뒤(t=0 Hips heading 기준)로 간 거리의 최소. lean_target ※ ≥ 0.03 |

`recoveredAfterHit` = recoveredTime − 마지막 충격 시각. `expect.recoveredWithin`은 충격이 있으면 이 값으로 판정(결정 37).
로그 `balance`: strategy, hipWeight, margin, cpMargin, comTarget, comSensed, virtualForce, torsoTorque, achievedForce/Moment, forceError, momentError, qpResidual, contactForces[{p, f}], flywheel, hipAxis, loadLeft, cop, groundHeight/Normal. 필름스트립: CoP(주황), 가상 힘(자홍 화살표), 접촉력(청록 막대), 칸 아래 "발목 전략/고관절 전략 · 여유" 라벨.

## 지형 slope10 / slope20
평지와 같은 판을 X축으로 −각 돌려 윗면이 원점을 지나고 +Z 쪽으로 올라가게 한다(y = tan(각)·z). 렌더는 `config/sim.json` 같은 각으로 지면 묶음을 돌린다. slope10_stand는 발목 flex +10°인 `stand_slope10` 포즈로 스폰.

## 뒤꿈치 CoP 진단 (사람 지시 2차, `diag` 계측: 왼발, Δv 뒤로)

| 항목 | 계측 | 결론 |
|---|---|---|
| QP 요구 vs 실제 CoP, 뒤 0.2 m/s | QP −0.060, 실제 −0.045 ~ −0.065 m (발목 −0.023) | 따라감. 이전 보고의 "−0.03에 머묾"은 결정 43의 고관절 내부 토크(초과 모멘트를 몸통에)가 다리를 거쳐 지면으로 전달된 탓 — 구조를 바꾼 뒤 사라짐 |
| 같은 조건 뒤 0.3 m/s | QP −0.060, 실제 −0.040 (t > 1.3 s) | 발 정적 평형: CoP_z = 발목_z − (h·G_z + τ_x)/N. 발목 τ_x는 QP대로(6~8 N·m), 차이는 실제 앞쪽 지면 마찰력 G_z ≈ 0 (QP는 약 75 N 요구). 수평 지면력은 몸 전체 가속도로 정해지며, COM이 이미 뒤꿈치 너머라 QP의 정적(무질량 다리) 가정이 깨짐 |
| 발목 토크 포화·strength | strength 1.00, saturated false, 추정 \|τ\| ≤ 28 N·m (상한 150) | 원인 아님 |
| 발목 모터 "발바닥 평평" 목표 오차 | 0.05 ~ 0.45° (모터 토크 ≤ 1.3 N·m) | 원인 아님 |
| 발 박스 높이 | 발목이 발바닥 위 0.086 m, 발목이 뒤꿈치에서 0.036 m | 뒤꿈치 CoP에 필요한 발목 토크가 작아(≈ 12 N·m) 수평력 75 N(→ 6.5 N·m)에 민감 — 진단상 민감도 원인이지만 형상은 SPEC 6.2·X Bot 그대로 둠 |
| 솔버 반복 / 접촉 소프트니스 | 반복 8·12·20·24·32, contact_natural_frequency 15~120 Hz | 발 미끄러짐에만 영향, CoP 추종과 무관 |
| 포착 한계 (근본) | 지연 0·발목만: 앞·뒤 0.25 통과, 0.3 실패. 0.3 m/s 밀기 직후 COM 속도 0.35~0.36 → DCM 이동 0.115 m > 발끝·뒤꿈치까지 0.10~0.105 m | 발 안의 CoP만으로는 0.3 m/s를 못 세움 → 각운동량(고관절·팔)이 필수 |
| 플라이휠 효과 | 서 있는 상태에서 200 N·m를 계속 걸어도 COM 속도 변화 < 0.05 m/s, CoP가 출렁임 | 고관절 내부 토크의 다리 반작용이 발목·지면으로 흡수되어 CMP가 발 밖으로 나가지 않음 → 현재 구조의 고관절 전략은 포착 한계를 늘리지 못함 |

## v0.4 스텝 (`stepping.ts`, 값 `config/stepping.json`, 결정 54~66)
스텝 계층은 균형 계층(전신 QP) 안에서 돈다. 매 스텝 `Stepping.update`가 감지 상태(지연 + 예측)를 보고 `StepCommand`를 내면 균형 계층이 그것을 QP 과제·제약으로 바꾼다. 스윙발은 접촉(지지 다각형·QP 접촉점)에서 빠지고, 지지발은 접촉 제약 그대로다.

상태 기계: **Stand → Step(L|R) → Settle → Stand**, 셋업용 **Lift**(trigger LiftFoot). maxSteps(3) 뒤에도 스텝이 필요하면 `stagger` 이벤트(v0.5a Stagger 훅)를 남기고 hardMaxSteps(12)까지 같은 방식으로 내딛는다.

1. **트리거**: ξ = c + v/ω. ξ가 지지 다각형 밖으로 `stepTriggerMargin` + 지터(흔들림 구간마다 시드 PRNG, ±`stepTriggerJitter`) 넘게 나가면, 또는 가장자리 `nearEdge` 안에 `nearEdgeTime` 머물면(COM이 움직일 때) 스텝. 정착 중에는 `retriggerMargin`(느릴 때 `slowRetrigger`), 두 발이 닿을 때까지 대기(0.15초 넘으면 그냥).
2. **다리 선택**: 두 발 각각 `plan`(교차/비교차) 후 비용 = load·하중 비율 + dir·(1 − 넘어지는 방향 쪽 다리 정도) + cross·교차 + reach·보폭/maxStepLength + clamp·잘린 거리 + 시드 다리 선호, 이동 < minUsefulMove면 +10. 정착 중엔 방금 디딘 발의 하중을 1로 본다.
3. **착지 목표**: p̄ = 지지발 중심 → ξ 쪽 가장자리로 cmpUse만큼, ξ_td = p̄ + (ξ − p̄)e^{ωT}, 목표 = ξ_td + stepOvershoot·넘어지는 방향 + 옆 간격(넘어지는 방향에 수직인 성분만, landingWidthSteps 중 착지 뒤 다각형 안 DCM 여유 ≥ landingMargin인 가장 넓은 것). 제한: 지지발 기준 타원(앞 maxStep.fwd, 뒤 maxStep.back, 옆 maxStepLength), 스윙 고관절에서 수평 maxReach, 옆 간격 ≥ minFootSpacing(교차면 crossMax까지, 앞 crossFwd 이상). 지면 레이캐스트(경사·높이 차 넘으면 지지발 쪽으로 0.8배씩). 스윙 70%까지 매 프레임 다시 계획하고, 목표가 멀어지면 스텝 시간도 다시 정한다.
4. **스텝 시간** T = min(max, min + max(0, 거리 − refDist)/swingSpeed). 반응 스텝은 unloadTime 동안 스윙발 접촉력 벌점(하중 빼기) 뒤 든다.
5. **스윙 = QP 과제**: 수평은 3차 베지어 ease(시작 → 목표, 진행 [hStart, 1 − hEnd])를 PD + 피드포워드 가속도로, 수직은 apex·16s²(1 − s)²(apex 0.05~0.1, 거리 비례), s ≥ 1이면 landDescentSpeed로 내림. 교차 스텝은 앞으로 crossBulge만큼 돌아간다. 방향은 발바닥 기울기만 지면 법선에(발목 제한 안으로 자름). 스윙 다리 관절 목표 = 2관절 IK(`legIK`) — 자세 과제(legPostureWeight)와 모터 계획. SIMBICON: 스윙 고관절 기준 목표를 넘어지는 방향으로 cd·d + cv·v(≤ maxDeg) 더 돌림.
6. **원하는 CMP(스윙 중)**: 착지 때 ξ가 목표 ξ_g(= 목표 − overshoot)에 오도록 p = (ξ_g − ξE)/(1 − E), E = e^{ωT_rem}. 지지 다각형 밖 cmpOutside까지로 자른다(그 이상은 몸통을 접어야 해 사람답지 않음 → 발로 해결).
7. **착지 감지**: 진행 ≥ touchdownMinS(또는 목표 touchdownNear 안) + 스윙발 접촉 + 하중 ≥ touchdownLoad N(또는 접촉 touchdownHold초). 착지 오차 = |발 중심 − 목표|. 걸음 수는 발이 countMinMove 넘게 옮겨진 것만(`step` 이벤트), 아니면 `footReplace`.
8. **정착**: 양발 QP(몸통·팔 이득은 스텝 값, 다리 자세 = 지금 자세로 고정, 팔 자세 가중치 armPostureWeight). 한 발이 떠 있으면 내려놓기(place), 멈추면 서기와 먼 배치를 모으기(closing: 체중 shiftFraction 이동 → 들기, 못 옮기면 포기), 막바지 COM 목표 = 다각형 중심(recenter), COM이 중심 2cm 안·0.04 m/s 아래로 standTime 조용하면 Stand.
9. **트렁크·팔**: 스텝 중 몸통(Spine2, 지연 없는 값)·골반 방향 이득·가중치는 `trunk`(서기 이득은 몸통이 50° 넘게 접힘), 몸통 yaw는 골반 기준 행. 팔은 v0.3 팔 반사(stepGain배), 팔 가속 정규화 armAccelReg. 스텝이 끝난 뒤 arms.returnTime초 동안 팔 반사에 arms.reflexDeadband 데드밴드.
10. **모터**: 스텝 중 motorPlanJoints(다리) 모터 목표 = QP 계획의 이 스텝 끝 자세·속도(결정 55). 관절 제한 회피 행·뒤꿈치 들기는 결정 56.

로그 `stepping`: state, swingFoot, phase(unload/swing), kind(reactive/closing/lift), stepCount, target, xiGoal, cp, cpOutside, threshold, s, duration, crossing, simbiconDeg, legCost[L, R], landings[{foot, t, p, target, error, kind}], lastLandingError, staggerHandoff. `stepTargets`(필름: 하늘색 발자국), 실제 착지(남색) + 오차 선, 한글 라벨("왼발 스텝 N", "모으기", "정착 (N걸음)", "하중 빼기", "들기", "비틀거림 넘김").
요약 지표: stepsTaken, landingErrorMean/Max, firstLandingAfterHit, footSlide(접촉점 미끄러짐, 결정 58).
도구: `tools/stepTrace.ts <시나리오>`(스텝 이벤트·0.05초 타임라인), `tools/stepEval.ts [--seeds] [시나리오|push:<방향>:<Δv>]`(통과·회복·걸음·착지 오차·미끄럼 표, 값 덮어쓰기 SET="s.a.b=1"), `npm run bench`.

### v0.4 보강 (결정 67~71)
- 지지발 기준 좌표(옆 간격·교차·겹침)는 지지발 yaw 기준. 교차 스텝은 `crossSteps`일 때만 후보(기본 끔).
- 한 발 지지(LiftFoot)에서 지지발 쪽으로 밀리면 2단 스텝: 든 발을 지지발 뒤 `liftFoot.downBack`에 내리고(목표 고정) 다음 스텝에서 지지발을 옮긴다.
- 정착 중 떠 있는 발: 몸이 `settle.placeMaxSpeed`보다 빠르면 반응 스텝(교차 없음), 아니면 서기 자리에 내려놓기.
- 스윙 경로가 지지발 반대편으로 지나가면 지지발 앞(목표가 뒤면 뒤)으로 돌아간다(crossBulge).
- 정착 중 닿은 발: 발목 자세 목표 = 발바닥 평평, 발끝 지지는 스텝 모드에서만.
- 견고성 평가: `tools/stepEval.ts --sweep 8 --jitter --v04 [--ref]` (시드 2~8 = 밀기 세기 ±5%·방향 ±5°, `--ref`는 시드 1 팔 사용량/사람).
- 관절 변경(결정 72): 손목 twist ±90(전완 회내·회외 포함), 발목 twist ±15. 스텝 중 손 가속 정규화 `trunk.handAccelReg`.
- 스윙 후반 재계획 `lateReplan`(결정 73): 목표 고정(`replanUntil`) 뒤라도 스윙 `until` 전에 새 목표가 `jump` m 넘게 바뀌면 다시 계획하고 시간을 늘린다.
- 정착 막바지 COM 되돌리기 중 다리 자세 고정(`settle.recenterFreeze`).
- 혼돈 진단: `tools/stepDiverge.ts [--eps 0.002] <시나리오...>` — 밀기 세기만 ±eps 다른 두 실행의 스텝 이벤트가 처음 갈라지는 곳.

### v0.4 결과 (관절 변경 뒤; sim:all 시드 1 + 근처 입력 8개 통과 수)
| 시나리오 | 시드 1 | 근처 8개 통과 | 걸음 (사람) | 회복 s | 착지 오차 m | 팔/사람 |
|---|---|---|---|---|---|---|
| push_front_medium | 통과 | 7/8 | 2 (2) | 1.74 | 0.036 | 1.2 |
| push_back_medium | 통과 | 2/8 | 4 (3) | 2.18 | 0.037 | 4.4 |
| push_left_medium | 통과 | 4/8 | 3 (3) | 2.08 | 0.027 | 2.3 |
| push_right_medium | 실패(착지 오차) | 4/8 | 4 (7) | 1.97 | 0.074 | 1.9 |
| push_diag_medium | 통과 | 5/8 | 3 (2) | 2.28 | 0.032 | 2.8 |
| push_front_small | 통과 | 8/8 | 1 (4) | 1.31 | 0.007 | 1.3 |
| push_back_small | 통과 | 8/8 | 1 (2) | 1.08 | 0.032 | 1.0 |
| push_twice | 통과 | 6/8 | 3 (2) | 1.51 | 0.040 | 1.7 |
| push_while_stepping | 실패(회복 못 함) | 0/8 | 7 (4) | — | 0.056 | 2.3 |
| push_left_crossstep | 실패(착지 오차) | 2/8 | 3 (1) | 1.45 | 0.060 | 2.8 |

근처 입력 80개: 넘어짐 1, 회복 71, 통과 46, 착지 오차 평균 0.054 m. 실패는 대부분 시나리오별 착지 오차 평균 0.05~0.10(스윙 중 다시 계획한 걸음이 짧게 떨어짐)과 넓은 발로 끝나 회복 판정이 늦는 경우.

---

# v0.5a 행동 프레임워크·피격 (README 결정 75~85)

코드: `src/sim/character/hitModel.ts`, `behaviors/`(blender, hitReaction, holdWound, simple(InjuredLeg·Stagger·LookAt), kinematics(팔 IK·시선)), `metrics/behaviorMetrics.ts`, 연결은 `api.ts`·`balance.ts`(손 과제 등)·`stepping.ts`(mods)·`muscles.ts`(강도·힘 상한). 설정: `config/behaviors.json`, `config/hitModel.json`, `config/sim.json behaviorJudge`. 도구: `tools/behaviorEval.ts`(근처 입력 스윕, `SET="h.…;m.…;s.…;b.…"`, `--why`).

## 한 스텝 (7.1의 1·4·5단계)
1. **피격** `resolveHit`: push = v0.4 그대로. bullet = 입사점(point를 지나 direction으로 오는 직선과 맞은 바디 주 형상의 첫 교점; 캡슐·구·상자 해석식, 빗나가면 가장 가까운 표면 점)에 min(pointShare·J, m_body·maxPointDv), 나머지는 carryBodies(전신) 질량 중심에 질량 비례. 상처 = 입사점·표면 법선(바디 로컬). melee = selfShare를 맞은 바디(점)에, 나머지를 인접 바디(부모·자식)에 질량 비례. 합은 항상 J = M·Δv·dir. 켤 행동: bullet → HitReaction·HoldWound (+ 다리면 InjuredLeg, Δv ≥ staggerMinDv면 Stagger), melee → HitReaction·Stagger.
2. **블렌더**: 클립 목표 위에 레이어 순(같은 레이어는 이름·생성 순)으로 관절마다 target은 slerp(현재, 목표, w·w_j), add는 slerp(I, Δ, w·w_j)·현재. 강도 배율 ∏(1 + w(s − 1)), 힘 상한 배율 ∏(1 + w(c − 1)). 행동 가중치 w = smoothstep((t − startT)/T) × 끄기 램프, startT = 피격 + reactionDelay(의도), 수동 반응을 가진 행동(HitReaction·InjuredLeg)은 즉시 1. 시선은 그 행동의 레이어에서 목·척추 목표로 풀어 넣는다. 손 목표·COM 낮추기·COM 이동·기울기 여유·몸통 강성·균형 모드·스텝 수정도 같은 가중치로 합친다. 행동이 하나도 없으면 v0.4 경로 그대로.
3. **균형(전신 QP)**: 손 과제(손바닥 점 가속도 kp(p_ref − p) + kd(v_ref − v), 방향 PD, 기준 각속도 = 맞은 바디), COM 높이 − comDrop, 서기 COM 목표 + comShift(정착 되돌리기에도), 균형 끄는 기울기 + tiltAllow, 몸통 과제 kp × trunkGainScale(kd × √), 스텝 중 몸통 yaw 목표 = 골반 yaw + 척추 비틀기 목표 합, 손 과제 팔은 팔 정규화·팔 반사·벌림에서 제외(손목은 handReg), 쥐지 않는 팔은 반사 × reflexScale + 옆 벌림(손 뻗은 뒤 hold초, release초에 내림).
4. **스텝 계층 mods**: 다친 발 스윙 비용 +penalty, 다친 발 보폭 타원 × stepScale, 불규칙(스텝마다 'stagger' PRNG로 시간 ×(1±d), 넘침·옆 ±), 최대 걸음 min(hardMax, maxSteps), 서기 스텝 문턱 + triggerRelax.
5. **근육**: 목표 strength = 영역 배율 × 피로 상한 × 행동 강도 배율. 최대 토크·모터 최대 힘 × 힘 상한 배율(명령 토크는 상한까지 그대로). 로그 strength = s × 상한.

## 행동
- **HitReaction**: 맞은 바디의 관절(weakScale 0.3)과 인접 관절(부모 쪽·자식; 몸통이 맞으면 몸통·목만, neighborScale 0.75)을 weakOnset 뒤 weakHold 유지, recoverTime[0]~[1](강도 k 보간)에 선형 회복. 다리 strength 잠깐 × legScale. 의도(startT 뒤): 맞은 점이 오목해지게(−dir 쪽) 척추 굽힘·옆 flinchDeg·k(Spine 0.4 / Spine2 0.6), 충격의 수직축 토크 방향 비틀기 twistDeg·k·min(1, 옆 지렛대/0.15), 머리 숙임, COM 낮춤 comDrop·k, 움찔 동안 몸통 강성 × trunkBrace. `hitReacted` 이벤트(바디, 강도 k).
- **HoldWound**: 손 고르기 — 맞은 팔의 손 제외, 다리 상처는 같은 쪽만, 어깨→목표 > maxReach·팔 길이면 제외(허벅지는 숙인 뒤라 거리 검사 안 함), 비용 = 같은 쪽 0 / 가운데 0.05 / 반대쪽(몸통·팔) 0.6 / 바쁜 손 +2 / 오른손 −0.01 / + 0.1·거리. 목표 = 상처 + 법선·palmClear(손바닥 점 = 손 로컬 (0, −0.028, 0), 손바닥 표면). 팔다리 상처는 감싸 쥐기: 법선이 '몸 앞 + 쥐는 어깨 쪽 0.3' 방향에서 maxWrapDeg보다 멀면 축 둘레로 그만큼 돌린 같은 높이 표면 점. 궤적: 기준 바디(팔 상처는 Spine2, 나머지는 맞은 바디) 로컬 최소 저크, 시간 = clamp(거리/reachSpeed, reachTime, maxReachTime), 가운데 볼록 = 법선·bulge + 앞·crossBulge·|옆 이동|. 손 방향: 손바닥(−Y) → −법선, 손가락 = 팔꿈치→목표를 법선에 수직으로 투영, 시작 방향에서 slerp, 손목 제한 안으로 자름. 팔 IK: 어깨점 = Spine2 + 앵커, 손목 = 손바닥 − R(palm − wrist), 2관절 해(팔꿈치 힌트 Spine2 로컬 (0.7·side, −1, −0.4)), 상완·전완 회전 = (뼈 방향, 경첩 축) → (u, cross(u, s)) 프레임 대응, 관절 목표 = conj(q_parent·F_P)·q_child·F_C. 웅크림(부위표 regions × 강도 × 진행): 척추 굽힘·상처 쪽 옆 굽힘·쥐는 손 쪽 어깨가 앞으로 오게 비틀기·머리 숙임, (배·허벅지) 고관절·무릎, 숙이는 만큼 스텝 문턱 늦춤. 시선 = 상처. duration 뒤 놓음.
- **InjuredLeg**: 그 다리 고관절·무릎·발목 힘 상한 strengthCap, 무릎 +kneeFlexDeg, COM 이동 = 골반 옆축 성분 × loadShift, 스텝 mods(성한 발 우선, 다친 발 짧게).
- **Stagger**: 피격 뒤 window 안 반응 스텝 시작(또는 stagger 이벤트) 때 켜짐(대기 중에도 불규칙 mods), 켜진 동안 균형 weak·몸통 이득 × trunkGainScale, 스텝 계층이 서기로 돌아오면 꺼짐. BraceForFall(v0.5b) 전까지 실패해도 Balance 유지.
- **LookAt**: yaw는 골반 기준, pitch는 Spine2 기준 대상 각을 시정수 tau로 따라가 목(headShare, ±55°, 넘치면 척추)·척추(spineShare, ±40°, Spine 0.4/Spine2 0.6)로 나눈다.

## 지표 (`behaviorMetrics.ts`, 정의값 `sim.json behaviorJudge`)
clutchReachTime, clutchHoldTime, clutchIntentOnset, clutchMoveOnset, clutchDistMean, trunkYawTowardHitDeg/MaxAbsDeg, comAlongHit, gazeErrorDeg, hitJointStrengthMin, stepsInjuredFoot/HealthyFoot, firstStepHealthy, injuredLegStrengthMax(켜진 뒤 0.2초부터), loadHealthyMean(마지막 1.5초), hitReactedEvents. 정의는 파일 머리 주석과 README 결정 83.

## 로그·시각화
로그 `behavior`: active(이름·한글·가중치·레이어·단계·정보), layers(관절별 "HoldWound 1.00 > HitReaction 0.62", 위 레이어가 앞), strengthMul, wounds(월드 점·법선), hands(목표·궤적 기준·손바닥·거리·상처 거리), gaze(대상·오차), comDrop·tiltAllowDeg·trunkGainScale·balanceMode. `behaviors`(SPEC 7.3)는 이름·가중치. 필름스트립: 왼쪽 아래 "행동: 상처 움켜쥐기 1.0 · 피격 반응 0.6 · 비틀거림 1.0", 오른쪽 "오른손-상처 2.1cm", 상처(진한 빨강 점), 손 목표(자홍 점 + 손바닥 선), 시선(하늘색 선). 바디 색 = 최종 strength.

## 결과 (시드 1 / 근처 입력 6개)
| 시나리오 | 시드 1 | 근처 6 | 핵심 |
|---|---|---|---|
| shot_chest_stagger_clutch | 통과 | 6/6 | 손 도달 0.42초, 유지 3.6초, 손 이동 시작 0.15초(의도 0.10), 뒤로 1걸음(COM 23cm) |
| shot_shoulder_spin | 통과 | 5/6 | 몸통 yaw 24.7°, 오른손 → 왼 어깨 0.39초 |
| hit_bullet_chest / shoulder / thigh / head | 통과 | 6 / 5 / 6 / 6 | 도달 0.42 / 0.37 / 0.31 / 0.56초 |
| hit_melee_side / back | 통과 | 6 / 4 | 2걸음, 회복 1.1 / 1.4초 |
| injured_leg_push | 통과 | 4 | 첫 걸음 성한 발, 성한 발 하중 0.69 |
| look_at_threat | 통과 | 6 | 시선 오차 8.4° |

## 알려진 문제 (v0.5a)
- 위팔(RightArm) 상처를 반대 손으로 쥐지 못한다: 맞은 팔이 뒤로 젖혀지고 건너오는 팔이 가슴에 막힌다. 맞은 팔 감싸기(guardArm)는 두 팔이 엉켜 꺼 둠 → 어깨 총탄 시나리오는 Spine2 어깨 끝.
- 사람 레퍼런스보다 덜 걷는다(레퍼런스 4걸음·1.2m, 우리 1걸음·0.25m). SPEC 1~3걸음을 따랐다.
- ~~쥐지 않는 팔이 비틀거리는 동안 옆으로 뻣뻣하게 벌어진다~~ → v0.5b 결정 86(전완·손을 QP에서 빼 늘어뜨림, 벌림 14°·0.35초). 비틀거리는 1초 동안 15~20° 벌어지는 것은 남는다(팔 반사).
- 넓은 발 정착 뒤 몸통이 0.35초 주기로 흔들리는 v0.4 문제(결정 74 ③)가 뒤 타격 근처 입력에서 보인다.

# v0.5b 넘어짐 (README 결정 86~97)

코드: `src/sim/character/behaviors/fall.ts`(FallMonitor, BraceForFall, ProtectHead, CatchFall), `collapse.ts`(Kneel, Limp), 연결은 `blender.ts`(자동 시작·피해 누적), `hitModel.ts`(사망 임계값), `api.ts`(push duration), `perception.ts`(무릎 접촉), `balance.ts`·`muscles.ts`(느슨한 팔). 설정: `config/behaviors.json` fall·BraceForFall·ProtectHead·CatchFall·Kneel·Limp·damage, `hitModel.json deathDv`, `sim.json judge.kneeContactDist`·`behaviorJudge.limp*`. 시나리오 `scenarios/0.5b/`. 테스트 `tests/fall.test.ts`.

## 넘어짐 확실도 (FallMonitor, 매 스텝, 행동이 없어도 로그)
- 두 발 기준 바닥 = 두 발 박스 바닥 꼭짓점 볼록 껍질(접촉과 무관), ξ = c + v/ω(ω = √(g/h)), dcmOut = ξ의 바닥 밖 부호 거리.
- 항목: dcm = smoothstep((dcmOut − 0.4)/0.25), tilt = smoothstep((Spine2 기울기 − 행동 tiltAllow − 40)/20) × smoothstep((dcmOut + 0.02)/0.1), drop = (하강 속도 ≥ 0.5 m/s일 때) smoothstep((처음 높이 − h − 0.2)/0.15). raw = max(세 항목), Kneel 중에는 tilt만. 확실도 = raw의 저역 통과(오를 때 0.03초, 내릴 때 0.3초).
- 방향 = 바닥 중심 → ξ(가까우면 COM 수평 속도). 종류: 골반 앞과 50° 안이면 앞, 130° 밖이면 뒤, 나머지는 왼쪽/오른쪽.
- 시간·손 착지: 축 점 = 바닥 꼭짓점 중 넘어지는 방향 끝(COM의 옆 위치). 역진자 θ(축 점 → COM 선과 수직 사이), θ̇ = (v_h·d·h − v_y·d_c)/L², θ̈ = (g/L)sinθ를 1/120초로 적분, 어깨(두 어깨 중점) 높이 = Ls·cos(θ + φ)가 0.6m 이하가 되는 시각(최대 1.5초). 손 착지점 = 축 점 + 넘어지는 방향 × (Ls·sin(θ+φ) + 0.08) + 각 어깨의 옆 위치.
- 로그 `behavior.fall`: certainty, raw, terms, dcmOut, tiltDeg, comHeight, dir, kind, timeToImpact, pivot, hands. 필름: 주황 점 = 예측 손 착지점(확실도 ≥ 0.3, 착지 전), 오른쪽 위 "넘어짐 확실도 0.9 · 앞 · 0.35초".

## 자동 시작 (블렌더, 상태 Active일 때)
1. Limp가 있으면 아무것도 안 함. 피해 하체 상한 < 0.2 → Limp(cause damage).
2. 상한 < 0.55 → Kneel (스텝 계층이 쉬고 COM 수평 속도 < 0.25 m/s일 때, 아니면 1초 뒤).
3. 확실도 ≥ 0.6이고 BraceForFall이 없으면 BraceForFall(감지 지연 0.08초 뒤), 종류가 뒤면 ProtectHead(두 손), 옆이면 ProtectHead(넘어지는 반대 손).
4. BraceForFall 중(누움 전) 손이 지면에 닿으면 CatchFall. 누움 단계가 되면 ProtectHead·CatchFall을 끈다.
- 피격: Δv ≥ deathDv(2.5) → 행동은 Limp만(다른 행동 모두 끔). 총탄마다 하체 상한 −= Δv × damage.lowerPerDv[부위]. 상한은 다리 관절 힘 상한(capacity)으로, Kneel 가중치만큼 0.85까지만 깎는다. 두 손이 다 상처를 쥐고 있으면 새 HoldWound를 만들지 않고, 둘째부터는 웅크림 없이 손만. 상한 < 0.55면 HoldWound는 duration이 지나도 놓지 않는다.

## 행동 (레이어: HoldWound 5 < Kneel 5.5 < BraceForFall 6 < ProtectHead 7 < CatchFall 8 < Limp 9)
- **BraceForFall**: 균형·스텝 끔. 방향별 poses(무릎·고관절·척추·머리·발목 add, 다리 강도)와 trunkStrength. 팔(앞 = 두 손, 옆 = 넘어지는 쪽, 뒤 = 없음; 상처를 쥔 손 제외): 착지점(저역 통과 0.08초) 쪽 방향을 각속도 ≤ 6 rad/s로 따라가고 손목 = 어깨 + 방향 × (상완+전완) × 0.92, 손 회전 = 손바닥 아래·손가락 넘어지는 방향, 팔꿈치 힌트 Spine2 로컬 (0.6·side, −0.5, −0.8), 관절 목표는 제한 안으로 자르고 변화 ≤ 12 rad/s. 착지(발 아닌 바디 접촉) 뒤 팔 목표 고정, 다리 대비는 0.25초에 풀고 힘 0.2, 0.5초 뒤(또는 COM 속도 < 0.25가 0.3초) '누움' = 모든 관절 기본 자세 목표·0.8초에 힘 0.2.
- **ProtectHead**: 목 굽힘 38°(턱 당기기), 옆이면 머리를 위로 18°, 척추 16°, 손바닥을 Head 로컬 (±0.1, 0.02, 0.09)(머리 옆·앞)로 IK, 팔꿈치 앞.
- **CatchFall**: 손별로 닿은 순간부터 팔꿈치 +55°(0.25초), 0.15초 뒤 0.6초에 그 팔 강도 0.3.
- **Kneel**: 단계(아래). 무릎이 닿은 뒤 균형 계층이 꺼진 단계에서 COM을 무릎 → 발끝 35% 지점에 두도록 무릎 +δ·고관절 −δ(δ = 100·e + 20·v °, ≤ 20°). 다리·몸통 목표를 덮어쓰고(HoldWound 위), 팔은 그대로.

| 단계 | 시간 | 무릎·고관절·발목·척추 (°) | 다리 강도 | 균형 |
|---|---|---|---|---|
| 몸 숙임 | 0.4초 또는 무릎이 닿을 때 | 40 · 30 · 25 · 12, COM 목표 발끝 쪽 25%, COM 높이 −0.4m(균형 끄는 높이 0.3m) | 1.0 | 켬 |
| 무릎 내림 | 0.2 | 120 · 30 · 0 · 15 | 무릎 0.15·발목 0.1 | 끔 |
| 무릎 닿음 | 0.25 | 120 · 10 · −10 · 8 | 0.8 | 끔 |
| 몸 세움 | 0.35 | 120 · 10 · −10 · 0 | 1.0 | 끔 |

- **Limp**: 균형·스텝 끔, 다리 strength → 0.05(0.15초), 몸통·팔·목 0.12초 뒤 0.4초에 0.05, 무릎 +40°, 고개 30°·척추 25°·고관절 35° 처짐.
- **push duration** (API): push만 충격을 round(duration/dt) 스텝에 나눠(작용점은 바디 로컬로 따라감) 가한다. 합 J = M·Δv.
- **판정**: 허벅지 캡슐 접촉점이 무릎 관절점(정강이 관절 앵커) 0.1m 안이면 그 접촉을 무릎(LeftLeg/RightLeg)으로 기록(`perception.ts`) — 꿇은 자세(8.2)가 가능해진다.
- **쥐지 않는 팔** (결정 86): HoldWound freeArm.parts(ForeArm·Hand)·loose 0.7 → 그 관절 QP 토크 × 0.3, 중력 보상 × 0.7, 모터 kp × (0.3 + 0.2·0.7), 모터 목표 속도 × 0.3, 모터 추정분 빼기 × 0.3, QP 가속도 정규화 + 30·0.7.

## 지표 (`behaviorMetrics.ts`, `summary.ts`)
braceStart(대비 가중치 > 0.01), braceLeadTime(→ 발 아닌 첫 접촉), fallPredictError(대비 시작 때 예측 착지점 ↔ 첫 손 접촉점, 수평 m), fallCertaintyMax, limpKneeLeadTime(Limp 뒤 Spine2 0.3m 하강 − 무릎 45°), kneelTime·kneelHeldMax(가장 긴 연속 kneeling), headImpactSpeed(머리가 처음 닿을 때 속도, 안 닿으면 0). 기대값 키: firstGroundContactIn, kneeledOrFell.

## 결과 (시드 1 / 근처 입력 6개)
| 시나리오 | 시드 1 | 근처 6 | 핵심 |
|---|---|---|---|
| push_front_large | 통과 | 6/6 | 첫 접촉 LeftHand, 대비 1.30초(밀기 +0.3) → 착지 0.64초 뒤, 예측 착지점 오차 0.68m |
| push_back_large | 통과 | 6/6 | 두 걸음 비틀 → 주저앉으며 머리 감싸기, 첫 접촉 Hips, 머리 닿는 속도 0.87 m/s |
| push_side_large | 통과 | 6/6 | 넘어지는 쪽 손으로 짚음(LeftHand), 다른 손은 머리 |
| death_limp | 통과 | 6/6 | 무릎 45°가 Spine2 0.3m 하강보다 0.2초 먼저, 첫 접촉 손 |
| kneel_trigger | 통과 | 6/6 | 0.98초에 꿇음, 4.0초 유지, Spine2 기울기 약 14° |
| shot_belly_clutch_kneel | 통과 | 6/6 | 두 손으로 배를 쥔 채 웅크림 → 3.9초 꿇음(0.4초 뒤 옆으로 쓰러짐), 시드 4·6은 끝까지 꿇음 유지 |

## 알려진 문제 (v0.5b)
- 꿇은 자세는 근육 PD 자세 유지 + 앞뒤 되먹임뿐이라 한쪽 무릎만 닿으면 옆으로 천천히 쓰러진다(배 3발 시드 1: 0.4초 꿇었다가 쓰러짐). 정강이 지지 QP·옆 되먹임은 효과가 없었다(결정 94). 다음: 무릎 접촉을 전신 QP 접촉으로 넣은 '꿇은 균형'을 두 무릎이 닿은 뒤에만.
- `trigger("Kneel")`의 무릎 내림 단계에서 발이 0.15초 들린다(무릎이 빨리 접혀 정강이가 발을 들어 올림, 'airborne' 5프레임). 1초 안 기준 때문에 더 천천히 내리지 못했다. Kimodo 레퍼런스는 뒤꿈치를 들며 0.6초에 부드럽게 내려간다.
- 큰 옆 밀기에서 대비가 시작되기 전 0.15~0.2초 동안 균형이 꺼진 채(몸통 기울기 > 50°) 서기 자세를 근육 PD로 붙들어 몸이 판자처럼 기운다. 감지 지연(0.08초)·전환(0.15초) 안에서는 줄일 수 없었다.
- 뒤로 넘어지며 엉덩이로 앉은 뒤 뒤로 구르는 운동량으로 다리가 0.3초쯤 위로 솟았다 내려온다.
- 앞으로 넘어질 때 무릎을 25°만 굽힌다(SPEC '손이 먼저'). Kimodo 레퍼런스는 무릎을 먼저 대고 손을 짚는 경우가 많다.

# v0.5c 공중·바닥 (README 결정 98~106)

코드: `src/sim/character/hitModel.ts`(폭발), `behaviors/air.ts`(AirMonitor, BlastStun, Flail, PrepareLanding, Roll, 누운 자세 lieJoints), `behaviors/writhe.ts`(Writhe), `behaviors/noise.ts`(시드 부드러운 노이즈), 연결은 `blender.ts`(자동 시작), `fall.ts`(서 있던 높이). 설정: `config/hitModel.json explosion`, `config/behaviors.json` air·BlastStun·Flail·PrepareLanding·Roll·lie·writheStart·Writhe, `sim.json behaviorJudge.flailGrace·writheWindow`. 시나리오 `scenarios/0.5c/`. 테스트 `tests/air.test.ts`. 도구 `tools/airTrace.ts <시나리오> [간격] [시작] [끝]`(자세·COM·공중 신호·접촉·행동 타임라인), `tools/kimodo/airStats.ts`(레퍼런스 수치).

## 폭발 (hitModel, SPEC 7.2)
- `hit({ type: 'explosion', point: 중심, magnitude })`. 바디 i: Δv_i = (Δv(d_COM))^(1−f) · (Δv(d_i))^f, Δv(d) = magnitude · refDist / max(minDist, d), f = perBodyFalloff(0.3).
- 방향: 공중 폭발은 중심 → 바디(3D 방사). 지면 폭발(중심이 지면에서 0.5m 안)은 지면을 따라 수평 방사 + 위 성분 groundLift · Δv_i · max(0, 1 − h_i/liftFadeHeight).
- 수평 성분 × max(0.2, 1 + heightGain · (h_i − h_COM)): 상체가 폭풍을 더 받고 발은 지면에 붙잡혀 상체가 뒤로 젖혀지며 발이 들린다.
- 마지막에 한 배율로 맞춰 |Σ J_i| / M = Δv(d_COM) (7.2 정의 그대로). 한 스텝에 가한다. 이벤트 `hit`(detail explosion, point = 중심, direction = 실제 COM Δv 방향, dv = COM Δv).
- 행동: BlastStun(즉시, 전 관절 강도 0.3 → 0.12초 유지 → 0.4초에 회복, 위 레이어 강도에 곱해짐). 사망 임계값은 폭발 전용 `explosion.deathDv` 8 m/s.

## 공중 신호 (AirMonitor, 매 스텝, 행동이 없어도 로그 `behavior.air`)
- 접촉 = 지면에 닿은 바디가 하나라도 있음. 공중 = 접촉 없음 ≥ minAirTime(0.04초) + COM 수직 가속도(0.02초 저역 통과) < −6 m/s²(자유 낙하). 고정 장치에 매달린 몸은 가속도 0이라 공중이 아니다.
- 착지 예측(접촉 없을 때): 자세 고정 강체 = COM 탄도 + 고정 자세 각속도 ω = I⁻¹L(바디 질량 중심 점질량 근사). 형상 끝점(캡슐 양 끝 + 반지름, 구, 상자 꼭짓점)을 ω·s만큼 돌려 최저점을 구하고, 그 xz 아래 지면을 레이캐스트. 1/30초 표본으로 2초까지, 처음 닿는 시각을 선형 보간. 결과: timeToGround, lowestBody, touchdown(점), touchdownVel, touchdownSpeedH, upright(골반 위가 월드 위와 50° 안).
- 착지 기록 landing = {t, speedH, vy, body, flight, slopeDeg}: 0.15초 이상 공중이었다가 닿은 순간.

## 자동 시작 (블렌더, 상태 Active)
1. 공중이고 공중 시간 + 착지 예측 ≥ minFlightTotal(0.4초)일 때만(넘어지며 발이 잠깐 뜨는 것은 v0.5b 대비가 맡는다):
   - 착지 예측 ≥ flailMinTime(0.45초)이면 Flail(감지 지연 0.08 뒤, 비행마다 한 번). BraceForFall·ProtectHead·CatchFall·Stagger는 끈다.
   - 착지 예측 ≤ prepareLead(0.5초)면 PrepareLanding(감지 지연 뒤 → 착지 약 0.4초 전에 활성).
   - 서 있지 않은 자세(몸으로 떨어짐)이고 착지 예측 ≤ rollLead(0.25초)이며 예측 착지 수평 속도 ≥ 2 m/s면 Roll(미리 웅크림).
2. 착지 순간(비행 ≥ 0.4초): 수평 속도 ≥ 2 m/s 또는 경사 15° 이상에서 1 m/s 이상이면 Roll. 서 있던 높이(FallMonitor)를 다시 잰다.
3. 누운 채(발·손·정강이가 아닌 바디가 닿고 COM < 0.5m) 1초 + COM 속도 < 0.3 m/s → Writhe(사망 Limp 제외). 이때 BraceForFall·PrepareLanding·Roll·CatchFall·ProtectHead·Stagger는 끈다.
4. Flail, Writhe, (공중·몸 착지·누움 단계의) PrepareLanding, (끝나기 전) Roll이 있으면 BraceForFall을 새로 켜지 않는다.

## 행동 (레이어: BlastStun 5.2 < BraceForFall 6 < Flail 6.2 < PrepareLanding 6.6 < ProtectHead 7 < Roll 7.5 < CatchFall 8 < Writhe 8.5 < Limp 9)
- **Flail**: 처음 0.25초 놀람 반사(어깨 벌림 75°·앞 15°, 팔꿈치 55°), 0.3초에 걸쳐 노이즈를 키움. 채널(관절·축·좌우)마다 0.6~1.3 Hz 사인 두 개(시드, `Flail@피격시각` 하위 스트림) — 좌우 박자가 달라 춤처럼 보이지 않는다. 팔 ±50°(앞)·±30°(벌림)·±25°(비틀기)·팔꿈치 ±35°, 다리 고관절 25 ± 30°·무릎 40 ± 30°, 척추·머리 작게. 강도 팔 0.7·다리 0.5·몸통 0.6. 균형·스텝 끔. 지면에 닿으면 끝.
- **PrepareLanding**: 서 있는 자세면 다리를 편다(고관절 15°·무릎 20°·발목 5° = 발바닥 평평, 나는 방향으로 고관절 8°/(m/s) ≤ 20°, 강도 1), 몸이 기울었으면 턱 30°·척추 20°·고관절 50°·무릎 70°. 팔 벌림 55°·앞 30°(가중치 0.75 — Flail이 조금 비침). 발(정강이)만 닿으면 흡수: 무릎 강도 0.35 → 0.35초에 1, 0.15초에 무릎 65°·고관절 50°·발목 25°·척추 12°로 굽힘, 0.35초 뒤 0.3초에 풀며 끝(흡수 중 균형·스텝 켬). 몸이 먼저 닿으면 0.25초 버틴 뒤 0.8초에 누운 자세(lie).
- **Roll**: 웅크림(척추 50°·턱 45°·고관절 100°·무릎 120°, 강도 0.8) + 두 손으로 머리 감싸기(ProtectHead IK, 팔 0.9). 닿은 뒤 0.4초 이상 지나고 COM 수평 속도 < 0.6 m/s이며 골반 수평 각속도 < 1.5 rad/s면(최대 2.5초) 1초에 풀기: 강도는 앞 1/3에 누운 자세 강도로, 목표는 천천히 누운 자세로. rollDeg = 골반 수평 각속도 적분.
- **누운 자세 lie**: 고관절 20°·무릎 30°·척추 5°·머리 5°·어깨 앞 10°·몸에 붙임 15°·팔꿈치 25°, 강도 몸 0.15·팔 0.06.
- **Writhe**: 시작할 때의 실제 관절 자세(relJoint)에서 2.5초에 몸부림 자세로. 다리 고관절 55 ± 15°·무릎 95 ± 15°·벌림 8 ± 6°(무릎을 끌어올림), 척추 15 ± 8°·옆 ±6°·비틀기 ±6°, 머리 10 ± 10°·비틀기 ±20°·옆 ±8°, 노이즈 0.1~0.3 Hz. 손: 몸통 상처가 있으면 가까운 손 = 상처, 다른 손 = 상처 옆 7cm; 없으면 두 손이 배(Spine 앞 표면, ±7cm); 엎드려 있으면(가슴이 아래) 두 손으로 머리 옆. 손바닥 IK(목표 변화 ≤ 3 rad/s) + 노이즈 ±2cm. 강도 다리·몸통 0.3, 팔 0.4. 균형·스텝 끔.

## 지표 (`behaviorMetrics.ts`, ※)
airTimeMax·touchdownT·touchdownSpeedH(가장 긴 비행), flailAirCoverage(그 비행 시작 + 0.25초부터 착지까지 Flail 가중치 > 0.01 비율), prepLandingLead(착지 − 그 비행 중 PrepareLanding 가중치 > 0.01 첫 시각), rolled·rollDegMax, writheStart·writheWindowS·writheComSpeedMax·writheJointSpeedMean(관절 상대 각속도 크기 평균, 몸부림 시작부터 5초)·writheSpeedInRange(Writhe.jointSpeedRange [4, 25] °/s 안이면 1).

## 로그·시각화
로그 `behavior.air`(contact, airborne, airTime, freeFall, accY, timeToGround, lowestBody, touchdown, touchdownVel, touchdownSpeedH, upright, landing). 필름스트립: 하늘색 글자 "공중 0.42초 · 착지까지 0.31초", 착지 뒤 0.4초 "착지 3.6m/s · Hips", 하늘색 점 = 예측 착지점, 충격 라벨 "폭발 Δv 4.55m/s", 행동 이름 "폭풍 충격·공중 허우적·착지 준비·구르기·몸부림"과 단계(놀람/허우적, 착지 준비 (발)/(몸), 착지 흡수, 웅크림/구르기/풀기/누움, 몸부림 시작/몸부림). 카메라 높이는 COM이 높이 뜨면 따라 올라간다(서 있을 때는 그대로).

## 결과 (시드 1 / 근처 입력 6개, `tools/behaviorEval.ts --sweep 6`)
| 시나리오 | 시드 1 | 근처 6 | 공중 s | Flail 비율 | 착지 준비 선행 s | 착지 수평 m/s | 구름(°) | 몸부림 COM 최대 m/s | 몸부림 관절 °/s |
|---|---|---|---|---|---|---|---|---|---|
| explosion_near | 통과 | 6/6 | 0.75 | 1.00 | 0.40 | 2.9 | 185 | 0.27 | 19.7 |
| ground_writhe | 통과 | 6/6 | — | — | — | — | — | 0.21 | 16.0 |
| ground_writhe_wounded (추가) | 통과 | 6/6 | — | — | — | — | — | 0.17 | 16.1 |
| explosion_behind (추가) | 통과 | 6/6 | 0.71 | 1.00 | 0.36 | 3.6 | 132 | 0.22 | 16.6 |
| explosion_side (추가) | 통과 | 6/6 | 0.56 | 1.00 | 0.39 | 2.9 | 50 | 0.21 | 14.2 |
| explosion_far (추가) | 통과 | 6/6 | 0.28(안 뜸) | — | — | — | — | 0.13 | 19.0 |
| drop_1m_feet (추가) | 통과 | 6/6 | 0.45 | 허우적 없음 | 0.31 | 0.2 | — | — | — |

sim:all 46/49, 회귀 0(알려진 문제 3, v0.4 결정 74). 이전 시나리오는 넘어져 누운 뒤(몸부림) 지표만 바뀌었다(push_*_large·shot_belly_clutch_kneel 등, 기대값 판정 그대로). 결정론: 같은 시나리오 두 번 실행 로그 바이트 동일.

## 알려진 문제 (v0.5c)
- Kimodo 레퍼런스(explosion_thrown_roll_v2 s8)는 실제로 뜨지 않고 뒤로 뛰다 주저앉아 뒤로 구른다(RP는 '폭발로 날아감'을 모른다). 비행 자세 비교에는 못 쓰고 착지 뒤 '주저앉음 → 뒤구르기 → 누움' 순서만 참고했다.
- 뒤구르기가 어깨 너머가 아니라 목·머리 위로 넘어간다(0.3초쯤 머리만 닿음). 웅크림 중 고개를 옆으로 돌리는 것은 아직 없다.
- 옆 폭발은 옆으로 날아가 측면 카메라로는 잘 안 보인다(정면 카메라로 확인).
- 몸부림은 누운 자세 그대로 구르지 않는다(Kimodo도 골반 회전 9°/s로 거의 안 구름). 엎드린 채 머리를 감싸 쥐는 경우 몸통 노이즈가 바닥에 막혀 거의 안 보인다.
- 근육 강도가 0인 상태(strength_drop)에서도 누우면 Writhe가 켜진다(힘이 없어 움직이지는 않는다).

## 알려진 문제 (v0.4까지)
- 성능: 스텝당 0.57~0.85 ms(v0.4, 캐릭터 1명 전 계층, 예산 0.5 ms; `npm run bench`) — 퀄리티 우선으로 넘김(사람 지시). 접촉 열마다 풀던 KKT를 6개 단위 우변으로 줄임(결정 65). 남은 큰 몫: Rapier, KKT LU, 과제 2차형 조립.
- v0.4 남은 문제 (마일스톤 닫음, 결정 74):
  1. 팔 과사용: 뒤 밀림 4.4배·대각 2.8배(사람 대비). 원인 = 몸통이 사람보다 크게 젖혀짐(뒤 44° vs 18°)과 느슨한 팔이 끌려 흔들림. 팔 QP를 잠가도 남는다 → 다음: 뒤 밀림 몸통 자세 제어(스텝 중 몸통 목표·각운동량 분배) 재설계.
  2. 착지 오차 평균 0.054 m(목표 < 0.05): 스윙 중 재계획 걸음(옆 7~14cm)과 2단 스텝의 '지지발 뒤에 내리기'(왼발 뒤꿈치에 막혀 7~10cm 더 뒤). 다음: 스윙 궤적을 현재 발 상태에서 다시 만드는 재생성, 내리기 목표에 발 충돌 반영.
  3. push_while_stepping: 넘어짐은 드물지만 4~7걸음·넓은 발에서 흔들림이 남아 3초 안에 회복 못 함(근처 8개 중 0 통과).
  4. 결과가 입력에 혼돈적으로 민감(결정 67, 73): 접촉 깜빡임이 착지·다음 스텝 시각을 1~6프레임 바꾸고, 그 뒤 궤적이 갈라진다(`tools/stepDiverge.ts`). 근처 입력 80개 중 통과 46.
  5. 시나리오 기대값 중 착지 오차(시나리오별 평균 ≤ 0.05)가 가장 자주 걸린다(push_right_medium·push_left_crossstep 시드 1). 약한 곳: push_while_stepping(스윙 중 재밀림 뒤 다리가 엉키거나 막 디딘 지지발이 튀어 떠 넘어짐), push_diag_medium(넓게 벌린 발로 끝나 몸통이 천천히 흔들려 회복 판정이 늦음), 팔 사용량이 뒤·대각에서 사람의 3.5~4.3배(팔을 각운동량 자원으로 쓴다).
- Δv 0.3 m/s 앞뒤 제자리 버팀은 하지 않는다(결정 51): 레퍼런스상 사람은 내딛는다 → v0.4.
- 하중 뺀 발 끌림·발 미끄러짐: 20초 서기 2.4cm, 밀기 4초 0.5cm.

# v0.6 애니 통합 (README 결정 107~118, 값은 `config/animDriver.json`)

## 클립 재생 (`animDriver.ts`)
- 클립 = Kimodo 생성 포즈 클립(`assets/poses/kimodo_*.json`, `animClips.ts`). 루프 클립은 한 바퀴마다 루트 이동·yaw를 누적(루트 모션 kept). 클립 공간 → 월드 = 앵커(yaw + 위치).
- 기준값 `ref(t)`: 관절 목표, 바디 FK, 바디 선·각속도(FK 중앙 차분 × 재생 속도), COM·속도·가속도, 각운동량, 발별 FootRef(지지 여부 = Kimodo 접촉 플래그, 뒤꿈치·발끝 높이, 떼기·착지 시각, 디딤 자세), 디딤 순서.
- 관성화: 전환 순간 이전 출력 − 새 클립의 관절 회전·각속도(루트는 위치·회전)를 오프셋으로 두고 임계 감쇠 스프링 x(t) = (x₀ + (v₀ + λx₀)t)e^{−λt}, λ = 6.6/blendTime로 줄여 새 클립에 더한다.
- 위상 맞추기 `matchPhase`: 클립 모든 프레임에서 비용 = w_c·(접촉 불일치 수) + w_f·|두 발 상대 위치 차|² + w_j·Σ(다리 관절 각 차)² + w_v·(앞 속도 차)² 최소.

## 상태 (`states.ts`, `api.ts setState`)
- Animated: 모든 바디 키네마틱(다음 스텝 클립 FK로 setNextKinematic*). Active: 동적 + 근육·균형. Ragdoll: 폭발 판정 뒤. GettingUp: 자리만(v0.7).
- Animated → Active: 바디 속도 = 클립 FK 중앙 차분(질량 중심 오프셋 ω × r 포함). 핀 강도 1 → 0을 toActive.pinTime에, 렌더 블렌드 w(애니→물리)를 renderTime에. 피격으로 바뀌면 핀 없이 렌더 hitRenderTime.
- 렌더 블렌드: 바디 위치 lerp, 회전 slerp(anim, physics, w) (`src/render/blend.ts`).

## 핀 보조 (`pin.ts`, 명시적 보조 `assist.pin`)
- F_b = s·w_b·m_b·(kp·e_x + kd·e_v), τ_b = s·w_b·I_b·(kpRot·log(q_ref q⁻¹) + kdRot·e_ω), |F| ≤ m·maxAccel, |τ| ≤ I·maxAngAccel. 'shape'는 e_x, e_v를 COM 기준 상대값으로(Σm·e = 0 → 전신 COM 알짜 힘 0).
- 강도 s: 전환 블렌드 + 클립별 추종 강도(trackingByClip), 반응 중(피격 뒤 reactHold, 행동 실행, 걷기 넘김) 목표 0(decayTime에 감소), 돌아오면 returnTime에 증가. 사용량 = Σ|F| + Σ|τ|/usageLeverArm (N).

## 걷기 추종 (`walk.ts`, 균형 계층 안에서 v0.3 QP 대신)
1. 발 모드: 클립 지지 + 접촉 → stance, 클립 지지인데 안 닿음 → landing(스윙하던 발) / liftoff, 클립 스윙 → swing. 이른 착지는 스윙 s ≥ 0.75이고 목표 6cm 안일 때만.
2. 앵커: 스윙하던 발이 평평하게 디디면 앵커 xz = 실제 − 클립 디딤 − pathKeep·Δ (위치 오차를 걸음마다 흡수).
3. DCM: ξ = x + v/ω. 옆은 클립 디딤 순서의 DCM 역방향 계획, 앞뒤는 클립 COM. 원하는 CMP = ξ_ref 쪽 피드백(kXi), 지지 다각형 + cmpOutside로 자름.
4. 디딤 수정(스윙발): e(착지) = e·exp(ω·min(T, expCapT)), Δ_앞 = gain·e_앞(−maxBack~maxFwd), Δ_옆 = gainLat·e_옆(±maxLat). 지지발보다 안쪽이면 minWidth까지, 앞뒤로 crossFwd 넘게 떨어졌으면 crossMax까지 건너 딛기 허용. freezeS 뒤 고정(lateUntil 전 lateJump 넘는 변화만 다시).
5. QP: 수평 운동량(가중 wLin, DCM 오차 e0~e1에서 wLinHScale), 각운동량 감쇠, 골반·몸통·자세 PD, 스윙발 궤적(클립 + Δ, 착지 하강 속도 제한), 지지발 방향, 관절 한계 회피, 팔 가속 정칙화, 핀 렌치는 외부 렌치. 지지발 접촉 = 평평(면)/발끝·뒤꿈치(선).
6. 재생 속도: 착지 시각 차를 corrTime에 갚음 → 기다림(waitRate) → 착지점 멀면 늦춤(reachRate) → 옆·앞 오차 > boostE0이고 스윙 앞쪽이면 서두름(루프 클립) → 진행 방향 뒤처짐 > lagE0이면 늦춤.
7. 넘김: 결정 114. 넘기면 스텝 계층에 지지발을 알리고(`stepping.handover`), 클립 목표를 실제 관절에서 관성화.
8. 복귀: 결정 115 (`api.ts tryResume`, `chainResume`).

## 지표 (`animMetrics.ts`)
pinUsageTracking/Blend(N·s), pinPeak(N), pinDuringReaction(0이어야), walkEngagedFrac, walkHandovers/Resumes, walkDistance/Speed, clipComErrCm·clipPoseErrDeg·clipShapeErrCm(추종 중 클립 대비), walkSteps, walkLandingErrorMean(목표 = 클립 디딤 + Δ), walkFootSlidePerStep(지지발 접촉점, 걸음당 m), walkScuffTime(스윙발이 바닥에 닿은 시간), switchVelJumpLin/Ang·switchPopAccel(전환), animTargetSpeedMax/P99·animSeamSpeedRatio(루프 이음매).

## 결과 (시드 1, sim:all 53/57, 회귀 0)
| 시나리오 | 결과 | 핵심 |
|---|---|---|
| idle_follow (20초) | 통과 | 이음매 속도비 1.53, COM 오차 0.05cm, 핀 0 |
| walk_forward_track (10초) | 통과 (위상 4/4) | 13.3m·1.37 m/s, 추종 핀 0, COM 2.3cm, 자세 13.0°, 미끄러짐 3.3cm/걸음, 착지 1.6cm |
| walk_back_track (10초) | 통과 (4/4) | 8.4m, 추종 핀 624 N·s(0.1 full), COM 4.0cm, 미끄러짐 4.9cm/걸음, 착지 7.2cm |
| animated_to_active | 통과 | 속도 차 0.31 m/s·1.76 rad/s, 반응 중 핀 0 |
| walk_push_side (Δv 0.25) | 통과 (4/4) | 교차 디딤 + 2~3걸음 비틀거림 뒤 계속 걷기, 넘김 0 |
| walk_push_side_medium (Δv 0.5) | 알려진 문제 | 넘김 → 스텝 계층이 걷는 몸을 못 받아 넘어짐 |
| upper_body_hit_while_walking | 통과 (4/4) | 몸통 11°, 다리는 계속 걷기(넘김 0) |
| shot_while_walking_clutch | 통과 (위상 2/4 안 넘어짐) | 손 도달 0.52초·유지 3.7초, 비틀거리며 계속 걷기 |

## 알려진 문제 (v0.6)
- 걷는 중 옆 밀림은 Δv 0.25까지(결정 116). 넘김 뒤의 v0.4 스텝 계층은 서 있는 몸용이라 걷는 속도의 몸을 받지 못한다 — 걷는 몸용 스텝(여러 걸음 교차·옆걸음) 필요.
- 뒤로 걷기는 추종 핀 0.1이 필요(결정 109). 발끝 착지에서 뒤꿈치 내리기가 불안정하고 착지 오차 7cm.
- 걷기 시작 클립 복귀(결정 115)는 근처 입력에서만 확인(shot_while_walking_clutch 위상 0, 7.1초 복귀 → 계속 걷기). sim:all 시드 1 시나리오에는 넘김 → 복귀가 나오지 않는다.
- 결과가 위상(시작 시각 0.13초 단위)에 민감: 총탄 걷기 2/4, 옆 밀림 Δv 0.3은 1~2/4.
- 스윙발 바닥 스침(walkScuffTime 앞으로 걷기 0.3초/10초), 밀린 뒤 팔이 옆으로 크게 벌어진다(균형 팔).
- 성능: 걷는 중 스텝당 약 0.85 ms(예산 0.5 ms 초과, 퀄리티 우선).

# v0.7 일어서기 (README 결정 119~132, 값은 `config/getup.json`)

코드: `src/sim/character/getup.ts`(GetupController·GetupAssist·GetupLibrary·RootBlend), `getupFeatures.ts`(특징·매칭), `getupQP.ts`(막바지 전신 QP), 연결은 `api.ts getupStep`. 라이브러리 `tools/kimodo/buildGetupLibrary.ts`(`npm run getup:build`), `tools/kimodo/getupLib.ts`(생성·지면 맞춤·균형 복귀 시각), 시험 `tools/getupTry.ts`. 무작위 쓰러짐 `src/sim/getupScenarios.ts`. 지표 `src/sim/metrics/getupMetrics.ts`. 테스트 `tests/getup.test.ts`.

## 쓰러짐 판정 (monitor)
- 누움 = 발·손·정강이가 아닌 바디가 지면에 닿음 + COM 높이 < lyingComHeight(0.5m). COM 속도 < settleSpeed(0.3)가 이어진 시간이 delay(1.6초; 피해 누적이 있으면 woundedDelay 2.6초)를 넘으면 시작. 실패 뒤 retryDelay(0.8초).
- 막음: 게임(`setGetup(false)`, 시나리오 이벤트 `setGetup`), 사망(Limp), 폭발 판정 뒤, Animated, 피격 반응 중(reactHold). 한 쓰러짐에 최대 3번.
- 이전 마일스톤 시나리오는 일어서기를 끈다(`scenario.getup` 없으면 v0.7부터 켬, README 결정 120) → v0.1~v0.6 로그 바이트 동일.

## 자세 분류와 포즈 매칭 (`getupFeatures.ts`)
- 특징 = Hips 위쪽 축(로컬 +Y)·앞쪽 축(로컬 +Z, 배)의 월드 방향, 바디 원점 − Hips 원점(월드 축 16개), 깔린 팔다리(전완·정강이가 Hips→Spine2 몸통 선분 아래 수평 14cm 안, 3cm 이상 낮음).
- 비용 = min_ψ Σ‖R_y(ψ)a_b − c_b‖² + 0.5(‖Rψ·up − up_c‖² + ‖Rψ·fwd − fwd_c‖²) + 0.15·Σ|깔림 차| + 0.5·(1 − 성공률). ψ는 닫힌 식(Y축 Procrustes: ψ = atan2(Σ(a_z c_x − a_x c_z), Σ(a_x c_x + a_z c_z))).
- 분류(로그·필름): 앞쪽 축 y > 0.5 누움, < −0.5 엎드림, 그 밖 옆, 위쪽 축 y > 0.6 앉음.
- 정렬: 클립 공간 → 월드 yaw = −ψ, 클립 0프레임 Hips xz = 지금 Hips xz, 높이 = 지면.

## 실행 (rising, 상태 GettingUp)
1. 시작: 누움 행동(몸부림·대비·상처 쥐기…)을 바로 뺀다. 클립 재생 + 관절 목표를 지금 자세에서 0.3초 관성화(AnimDriver.blendFromActual), Hips 목표도 RootBlend(위치·회전 오프셋 임계 감쇠 스프링 0.3초).
2. 근육: 모터 kp·kd × motorScale(2, 팔 armMotorScale 2), 목표 = 클립 관절(관성화). 균형 계층은 꺼져 있다(Active가 아님).
3. 겟업 보조(GetupAssist, assist.getup): 보이지 않는 키네마틱 앵커 2개 + generic 관절 모터. 자세 앵커 = 목표 Hips 회전(AngXYZ 목표 0, uprightKp 800·Kd 80, 상한 250 N·m), 높이 앵커 = 목표 Hips 높이·항등 회전(LinY 목표 0, Kp 3000·Kd 300, 상한 0.5 × 체중). 수평은 끌지 않는다. 세기 = 처음 0.3초 0→1 → 균형 복귀 뒤 tailTime(2초)에 0. 사용량 = |F| + |τ|/1m (루트 보조와 같은 PD 추정).
4. 막바지 전신 QP(`getupQP.ts`, qp.feetPhaseOnly): 두 발로만 딛고(클립도 두 발 지지) 있는 동안 v0.3 전신 운동량 QP와 같은 풀이로 COM(클립 COM을 실제 디딘 바디 기준으로 옮긴 목표, 수평 kp 16·kd 8, 수직 kp 40·kd 12, wLin 0.1) + 골반·몸통 방향 + 관절 자세 + 관절 제한 피하기, 디딘 발 고정 등식, 겟업 보조 렌치는 외부 렌치. 모터 × 1, 모터 추정분 빼기. 누운·짚는 단계 전체에 QP를 쓰면 접촉이 깜빡이며 팔다리를 휘둘러 성공률이 2~9%로 떨어졌다(README 결정 127).
5. 균형 복귀(handover): (클립 시각 ≥ feetTau − 0.6초) + 두 발 닿음 + 발이 아닌 바디 안 닿음 + Spine2 기울기 < 45° + Hips ≥ 0.55 × 기준 + COM ≥ 0.62m → Active, 균형·스텝 계층(v0.4, 서 있는 몸)이 남은 클립 관절 목표를 따르고, 균형을 끄는 COM 높이를 0.6으로 낮춤(서면 원래대로), 넘어짐 확실도 지움 + 1초간 대비 문턱 0.95(braceGuard), 서기 COM 높이를 클립 끝에서 정함. 클립 끝 0.3초 전 Idle 클립(관성화 0.5초)으로 — Idle은 애니 추종 QP에 다시 붙이지 않고 서 있는 균형 계층이 따른다(결정 129).
6. 완료(getupDone): Idle 클립에서 스텝 계층이 쉬고 COM 수평 < 0.1 m/s가 0.5초(또는 4초), 또는 피해 누적 Kneel이 켜짐(상처가 깊어 일어선 뒤 무릎 꿇음).
7. 실패: 클립 balanceTau + 1.2초가 지나도 못 넘김, 또는 Hips가 기준보다 0.3m 넘게 낮은 채 0.6초 → Ragdoll(힘 0)로 떨어져 retryDelay 뒤 다른 클립으로(시도한 클립 제외). 3번째 실패면 Active로 누운 채(몸부림). 균형 복귀 뒤 다시 누우면 '다시 넘어짐'(시도 수는 그대로).
8. 피격(rising 중): 겟업 취소(시도로 세지 않음) → Active, 서기 포즈 목표를 지금 자세에서 0.3초 관성화(한 스텝에 바꾸면 손이 53 rad/s로 돌았다) → 행동 계층이 반응 → 다시 누워 안정되면 재시도.

## 라이브러리 (`buildGetupLibrary.ts`)
1. sample: 무작위 쓰러짐 260개(밀기 40%·골반 밀기 10%(Δv 1.3~2.2)·폭발 15%·배 총탄 3발 10%·걷다가 밀림 17%·사망 8%) → 판정이 시작을 정하는 순간의 자세(probe, 사망도 자세만) 251개.
2. cluster: 매칭 비용 행렬로 k-medoids(PAM BUILD 초기화) K = 30 + 보험(엎드림·누움 분류 중심 자세) 2.
3. generate: Kimodo RP-v1.2, 4초(120프레임), 시작 키프레임 = 대표 자세(`fromPose`, 0프레임 오차 0.00cm — 2cm 넘으면 버림), 끝 키프레임(119) = 서기 포즈(feet: 발 쪽을 보고 엉덩이~발 중간 / head: 머리 쪽을 보고 엉덩이 자리), 프롬프트 `a person gets up from the ground and stands still`, 대표마다 두 방향 × 시드 1~6 = 384개.
   - 후처리: 한 프레임 35° 넘게 튀는 관절 목표는 앞 프레임 유지(손목 비틀기 ±90° 자르기가 −90↔+90으로 뒤집힘), 지면 맞춤(몸통 4바디가 바닥을 뚫으면 그만큼 올리고 몸 전체가 뜨면 내림, 팔다리만 뚫는 것은 그대로 — 물리에서 그 팔다리가 바닥을 민다), feetTau(두 발 + 무릎·손·몸 8cm(무릎 20cm) 위) / balanceTau(+ Spine2 < 35°).
4. test: 클립마다 대표 + 가까운 구성원 자세 최대 4개에서 그 클립만으로 10초(병렬 `--jobs`). 성공 = 완료 + 끝에 서 있음 + 폭발 없음 + 실패 0.
5. write: 대표 자세에서 성공 + 성공률 ≥ 50%인 것 중 대표마다 성공률·보조 사용량 순 2개(보험 4개) → 68개(누움 20·엎드림 28·옆 20), 모두 4/4.

## 지표 (`getupMetrics.ts`)
getupStarts/Done/Fails/Cancels/GiveUp, getupSuccess(Idle 복귀까지 + 끝에 누워 있지 않음), getupFirstStart, getupPostureSupine/Prone/Side(첫 시도 분류), getupStandTime(시작 → 균형 복귀), getupDoneTime(첫 시도 → 완료), getupAssistPeakBW·TorquePeak, getupHandContact·KneeContact(일어서는 중 손·무릎 짚음), getupBodySpeedMax, getupAirborneMax(몸 전체가 뜬 최장 시간), getupPostSteps. 묶음(getup_random_x20): getupRuns·SuccessCount·SuccessRate·평균들, 실행별 `out/getup_random_x20/runs.json`·`runs/<시드>/`.

## 로그·시각화
로그 `getup`(phase, enabled, settled, attempt, posture, clip, cost, tau, progress, balanceTau, assist{s, force, torque}, last, qp{comTarget, comErr, supportShift, nPoints, forceError, contactForces}). 필름스트립 보라 글자 "일어서기 1/3 · 엎드림 · 진행 45% · 보조 0.62 (210N)" / "일어섬 · 균형 복귀" / "누워 쉼 1.2초 · 누움", `film --compare anim`이 겟업 클립(관성화·정렬 포함)을 회색 고스트로.

## 결과 (시드 1)
| 시나리오 | 결과 | 핵심 |
|---|---|---|
| getup_supine | 통과 | 누움 → 1.6초 쉬고 4.34초 시작, 앉아 올라와 손 짚고 웅크려 섬, 균형 복귀 2.69초, 완료 6.23초, 보조 596 N·s(최대 0.37 체중) |
| getup_prone | 통과 | 엎드림 → 손으로 밀고 무릎을 당겨 꿇은 뒤 섬, 균형 복귀 2.41초, 완료 4.17초, 손·무릎 짚음, 보조 600 N·s |
| getup_side | 통과 | 폭발로 옆으로 누움 → 균형 복귀, 완료 5.39초, 보조 514 N·s |
| getup_interrupted | 통과 | 시작 1.26초 뒤 밀림 → 취소·반응 → 다시 누워 재시도 성공(완료 8.2초), 보조 757 N·s |
| getup_blocked (추가) | 통과 | 막힌 동안 누워 몸부림, 8초에 허용 → 일어섬 |
| getup_random_x20 | 통과 20/20 | 모두 첫 시도, 균형 복귀 중앙값 2.67초(2.11~3.39), 완료 평균 5.40초, 보조 평균 701 N·s(506~1103), 손 짚음 100%·무릎 50% |
| (확인) 시드 2001~ 40개 | 37/40 | 실패: 걷다 밀린 넘어짐의 손 폭발 판정(v0.6 경로, 겟업 전) 1, 배 총탄 3발(피해 누적)로 무릎 꿇은 자세가 무너진 2 |

sim:all 59/63, 회귀 0(알려진 문제 4, v0.4 3 + walk_push_side_medium), 이전 로그 바이트 동일, 결정론(같은 시나리오 두 번 로그 동일).

## 알려진 문제 (v0.7)
- 겟업 보조가 크다: 평균 약 700 N·s(일어서는 2.5초 + 꼬리 2초, 순간 최대 0.5 × 체중·250 N·m). 자세 토크 상한을 150으로 낮추면 시험 성공 32%로 떨어진다 — 근육 PD가 클립을 따라가는 동안 몸통 기울기를 지키는 것을 보조가 많이 한다. 짚는 단계의 접촉 일반 QP가 다음 과제.
- 일어선 순간 수평 운동량이 남아 1~2걸음 내딛는다(평균 1.9). 넓거나 앞뒤로 엇갈린 발로 서면 v0.4 스텝 계층의 '발 모으기'가 흔들린다.
- 피해 누적으로 무릎 꿇을 만큼 다친 몸은 일어선 뒤 다시 꿇고, 꿇은 자세가 무너지면 다시 일어서기를 되풀이한다(v0.5b Kneel 유지 한계).
- 클립 하나의 시험 성공률(전체 후보 1368회 중 64%)은 높지 않다. 대표마다 잘 되는 클립만 남겨(68개 모두 4/4) 실제 쓰러짐에서 첫 시도 성공률이 높다.
- 성능: 막바지 QP 동안 스텝당 약 0.8 ms.

# v0.8a 지형 (README 결정 133~147, 값은 `config/sim.json terrain`·`config/stepping.json terrain`·`config/behaviors.json` StairStep·Tumble·Trip·Misstep)

코드: `src/sim/terrain.ts`(지형 정의·해석식 지면 높이), `world.ts`(상자 콜라이더), `perception.ts`(발판 검사 `probeFoothold`, 허공 꼭짓점 `soleSupported`), `stepping.ts`(지형 디딤 `terrainTarget`·`pathProfile`·스윙 높이), `balance.ts`(높이 기준 지면 속도 제한), `walk.ts`(헛디딤·걸림 넘김), `behaviors/terrain.ts`(StairStep·Tumble·Trip·Misstep), `render/scene.ts`(지형 그리기). 도구 `tools/swingTrace.ts`(스윙 기준·발·접촉, `--watch 바디`), `tools/toeExperiment.ts`(발가락 바디 실험).

## 지형
- 평지·경사 판(v0.3) 위에 축 정렬 상자. 계단: 받침(z ≤ 0, 윗면 10 × 0.17 = 1.7m) + 정면(+Z)으로 내려가는 단 9개(디딤 너비 0.30m, 단 높이 0.17m), 단 상자는 뒤쪽(더 높은 단 밑)으로 이어 붙여 디딤면에 이음매가 없다. 모서리(ledge): 높이 3m 받침(z ≤ 0). 상자 장애물: z 2.9~3.1m, 높이 0.14m, 폭 1.2m. 상자 모서리 반지름 1.5cm(`edgeRadius`, Rapier roundCuboid — 바깥 크기 그대로).
- `terrainHeightAt(x, z)` = 판 높이와 그 점을 덮는 상자 윗면의 최대(평지는 정확히 0). 렌더(필름·앱)도 같은 정의로 상자를 그린다.
- **높이 판정은 그 아래 지면 기준**: 자세(fell·kneel의 COM·Hips 높이), 캡처 포인트, 누움(몸부림·일어서기) — 평지는 지면 0이라 이전과 같은 값.
- **일어서기는 평지에서만**: COM 둘레 0.8m 십자 5점 지면 높이 차 ≤ 3cm이고 경사 지형이 아닐 때(겟업 라이브러리가 평지 클립).

## 지면 인지 (발판 검사, `probeFoothold`)
발 원점을 (xz, yaw)에 놓을 때: 가운데 레이 → 지면 높이·법선. 발바닥 격자 3(옆) × 5(앞뒤, 앞뒤로 margin 1.5cm 늘림) 레이를 가운데 지면 평면(법선 기준, 경사면은 평면을 따라 높이가 바뀜)과 비교 — levelTol 2cm 안이면 받침. 디딜 수 있음 = 경사 ≤ 30° + 평면보다 높은 표본 없음 + 받침 비율 ≥ minSupported(1.0). 발 접촉 꼭짓점도 꼭짓점 아래 짧은 레이로 지면이 있는지 본다(`soleSupported`) — 계단 코 밖 허공의 꼭짓점은 지지 다각형·QP 접촉점에서 뺀다.
인지는 정적인 지형을 레이로 읽는다. 감지 지연(0.08초)은 반응(행동 시작: Tumble·Trip은 reactionDelay 뒤, 균형·스텝은 지연 + 예측 COM)에 그대로 걸린다.

## 지형 디딤 (스텝 계층, StairStep 행동이 켤 때만 — `mods.terrainStep`)
1. **착지 자리**: 평지 계획(DCM 착지점·옆 간격·보폭 타원)으로 얻은 원하는 자리에서 넘어지는 방향을 따라 ±0.3m를 2cm 간격으로, 가까운 것부터(뒤로 줄이는 쪽은 backCost 2배 멀게) 발판 검사. 디딜 수 있고 지지발 지면 대비 높이 차가 +0.22 / −0.22m(한 단) 안이고 보폭 타원·고관절 도달·옆 간격(minFootSpacing) 안인 첫 자리를 찾으면 같은 디딤면 구간의 가운데로 옮긴다(양쪽 4칸까지). 다시 계획할 때는 이전 디딤면 높이에서 0.12m 안을 먼저(두 단 사이에서 목표가 뒤집히지 않게). 없으면 지지발 옆 서기 자리 → 원하는 자리 선을 따라 먼 곳부터 같은 검사. 원하는 자리가 낭떠러지(지지발보다 0.6m 넘게 낮음)이고 닿는 가장 먼 디딤면도 5cm 넘게 모자라면 허공으로 내딛는다(헛디딤, `voidStep` 이벤트 → Misstep).
2. **스윙 높이**: 경로 아래 지면 표본(수평 진행 21점, 경로 방향 발 길이 창의 최대). 시작·목표 지면을 잇는 직선보다 튀어나온 곳(계단 코·장애물, 튀어나온 높이 4cm에서 다)에만 clearance 9cm. 요구 높이 = 표본마다 (지면 + clearance − 1.5 × 경로 길이 × |u − u_i|)의 최대(연속, 기울기 ≤ 1.5), 기준 진행과 **실제 발 진행** 둘 다로 계산해 큰 쪽(뒤처진 발이 먼저 내려가 계단 코에 걸리지 않게). 지금 발바닥 꼭짓점(실제 방향)이 그 아래 지면보다 3cm 위(스윙 진행 0.1~0.8). 스윙 높이 ≥ 7cm. 수직 기준은 이것들과 v0.4 혹의 최대, 속도·가속도는 수치 미분(가속도 ±60 m/s²로 자름).
3. **내려 딛기**: 스윙 시간 + 0.6 × |높이 차|, 스윙 끝 뒤 내림 속도 0.8 m/s, 스윙발 발끝을 min(20°, 120°/m × 높이 차) 내림(수평 진행 0.55~0.8에서 들어가 착지 뒤 풀림 — 발끝으로 먼저 닿기), COM 높이 목표를 0.6 × 높이 차(≤ 0.15m) 낮춤. 지형에서는 SIMBICON 목표 돌리기를 하지 않는다.
4. **착지 판정**: 목표 디딤면 높이 ± 5cm인 접촉점이 있어야 착지(지나가는 계단 코에 스친 것은 아님).
5. **균형**: COM 높이 기준 지면(닿은 발 평균)은 0.4 m/s 이하로만 따라간다(`balance.json com.groundRate`). 지지 다각형은 디딘 발 꼭짓점의 수평 투영(경사면 위 접촉 꼭짓점을 경사면 기준으로 고른 것).
6. **넘어짐 확실도**: 스텝 계층이 내딛는 중이고 속도 방향 0.5m 앞 지면이 발 지면보다 0.1m 넘게 낮으면 DCM 항 문턱을 0.35m 늦춘다(계단을 뛰어 내려가는 비틀거림).

## 행동 (레이어: StairStep 1.5 < Trip 4.5 < Misstep 6.1 < Tumble 7.6)
- **StairStep**(계단 디딤): 평지가 아닌 지형이면 바로 켜짐(지형은 늘 보인다). 지형 디딤을 켜고, 내딛는 동안 착지 자리를 가중치 0.35로 내려다본다.
- **Tumble**(굴러 내려감): 내리막(속도 방향 0.6m 앞 지면이 0.12m 넘게 낮음)에서 발 아닌 바디가 닿은 채 COM 속도 ≥ 1 m/s, COM이 지면에서 0.8m 안 → 감지 지연 뒤. 넘어짐 대비·머리 보호·손 짚기·구르기·착지 준비·허우적·비틀거림을 끄고(켜져 있는 동안 막음) 웅크림(척추 30°·턱 35°·고관절 60°·무릎 80°, 강도 0.7). 골반 각속도 < 3 rad/s(미끄러짐)면 어깨가 지면에 가까운 손을 내려가는 쪽 지면으로 뻗어 짚고(목표는 지면 위 3cm, 닿으면 강도 0.25) 다른 손은 머리를 감싼다, 빨리 구르는 동안은 두 손 모두 머리. 손목 강도 ≤ 0.12, 닿은 손의 목표 출발점 = 지금 자세. COM 속도 < 0.35 m/s가 0.4초 → 1초에 누운 자세.
- **Trip**(걸림): 걷기 추종 중 스윙발 접촉 법선의 세로 성분 < 0.5(장애물 옆면) → 걷기 넘김('trip') + Trip + 비틀거림. 감지 지연 뒤 걸린 다리 고관절 45°·무릎 60° 들기(0.35초), 두 팔 앞 70°·벌림 25°, 척추 10° 젖힘, 1.2초.
- **Misstep**(헛디딤): 걷기 추종 스윙발 아래가 낭떠러지('void' 넘김) 또는 스텝 계층 헛디딤 스윙이 반을 넘음 → 즉시. 균형·스텝 끔, 내딛던 다리 고관절 30°·무릎 15°, 지지 다리 무릎 35°·강도 0.35(꺾임), 팔 놀람. 공중이 되면 끝(공중 행동이 맡음).

## 지표 (※, `behaviorMetrics.ts`)
tumbled, tumbleTime(Tumble 가중치 > 0.01이고 풀기 전), tumbleGuardFrac(그동안 손이 머리 0.2m 안이던 비율), tumbleDrop(Tumble 시작~끝 COM 높이 차), tripped, misstep. 로그 `stepping.terrain`(지지발 대비 디딤면 높이 차·받침 비율·헛디딤, 지형 디딤일 때만). 필름: "오른발 스텝 1 · 아래 디딤면 17cm" / "헛디딤(디딜 곳 없음)", 걷기 넘김 이유(헛디딤·걸림), 행동 이름(계단 디딤·굴러 내려감·걸림·헛디딤)과 단계(미끄러짐 · 왼손 짚기 / 구름 · 머리 감싸기 / 풀기 / 누움, 걸린 발 들기 / 팔 내밂).

## 발가락(ToeBase) 바디 실험 (`tools/toeExperiment.ts`, 결정 146)
발 박스(0.25m)를 뒤꿈치~볼(72%)과 볼~발끝(28%, 높이 4.4cm 상자) 두 바디로 나누고 볼에 옆 축 경첩(−60~25°, 근육 kp 0.05·최대 30 N·m), 발가락 접촉은 그 발의 지지(지지 다각형·하중·QP 접촉점)로 센다. 같은 시나리오·근처 입력 6개(밀기 세기 ±5%·방향 ±5°):

| 시나리오 | 발 박스: 통과 / 넘어짐 / 착지 오차 / 미끄럼 | 발 + 발가락 |
|---|---|---|
| push_front_medium | 5/6 · 0 · 3.5cm · 6.8cm | 1/6 · 3 · 4.0cm · 21.8cm |
| push_back_medium | 1/6 · 1 · 4.4cm · 29.4cm | 3/6 · 1 · 3.6cm · 20.8cm |
| push_left_medium | 4/6 · 0 · 3.6cm · 17.0cm | 0/6 · 5 · 6.0cm · 64.9cm |
| push_front_small | 6/6 · 0 · 0.6cm · 2.2cm | 0/6 · 0 · 4.7cm · 13.7cm |
| stairs_push_down | 6/6 · 6 · 4.3cm · 58.2cm | 6/6 · 6 · 5.2cm · 21.8cm |
| slope20_push | 3/6 · 3 · 5.8cm · 83.1cm | 4/6 · 2 · 4.9cm · 79.3cm |
| walk_forward_track | 6/6 · 0 · 착지 1.6cm · COM 2.3cm · 13.3m | 0/6 · 6 · 3.1cm · 4.6cm · 2.8m |

넣지 않는다: 평지 스텝·걷기가 크게 나빠졌고(걷기 6/6 넘어짐, 작은 밀기도 걸음이 늘고 미끄러짐 6배), 경사·뒤 밀림의 나아짐은 근처 입력 6개 안의 차이다. 발가락을 쓰려면 걷기 추종(클립 발끝 굴림을 발가락 관절로)·스텝 QP(발가락 접촉 힘을 발가락 바디에)·Kimodo 발가락 리타깃·겟업 라이브러리(바디 수)·스킨을 다시 맞춰야 한다. 실험용 훅(바디 이름, 발가락 접촉 = 그 발의 지지)은 남겨 두었다(기본 캐릭터에는 영향 없음).

## 결과 (시드 1 / 근처 입력 6개, `tools/stepEval.ts --sweep 6 --jitter`)
| 시나리오 | 시드 1 | 근처 6 | 핵심 |
|---|---|---|---|
| stairs_push_down | 통과 | 6/6 통과(모두 넘어짐) | 한 단 내려 디딤(착지 오차 3.7cm) → 앞으로 넘어져 손 짚고 굴러 내려감(굴러 내려감 1.5초, 머리 감싼 비율 0.88, 0.93m 내려감) |
| stairs_tumble | 통과 | 5/6 | 앞으로 뛰듯 넘어져 손 짚기 → 앞구르기 → 계단에 누움(굴러 내려감 1.1초, 머리 감싼 비율 0.80, 머리 닿는 속도 1.9 m/s) |
| fall_from_ledge_3m | 통과 | 5/6 | 헛디딤 → 공중 허우적 0.77초(비율 1.0) → 착지 준비 0.42초 전 → 손 먼저 → 구름 |
| trip_obstacle | 통과 | 6/6 | 상자에 발이 걸림(걷기 넘김 '걸림') → 팔 내밂·비틀거림 → 손으로 짚으며 넘어짐 |
| slope20_push | 통과 | 5/6 | 경사를 가로질러 한 걸음(착지 오차 3.5cm), 1.5초에 회복 |
| slope20_push_downhill (추가) | 통과 | 6/6 통과(모두 넘어짐) | 내리막으로 한 걸음 뒤 넘어져 굴러 내려감 |

경사·계단 착지 오차 평균(시드 1) 3.5cm, 근처 입력 4~5cm. sim:all 65/69, 회귀 0(알려진 문제 4), 이전 로그는 slope10_stand 하나만 바뀜(경사에서 StairStep이 켜지고 캡처 포인트 높이가 지면 기준이 됨, 기대값 판정 그대로) — 나머지 바이트 동일.

## 알려진 문제 (v0.8a)
- 계단 위에서 앞으로 밀리면(medium, Δv 0.8) 한 단 내려 디딘 뒤 넘어져 굴러 내려간다(근처 입력 6/6 넘어짐). Δv 0.3은 4/6 버팀, 0.4~0.5는 넘어짐. 내려 디딜 때마다 COM이 내려가며 앞으로 가속되는데(평지 LIP 계획), 단 하나씩 짧게 디디는 스텝이 따라가지 못한다. 내리막 DCM 보정(실효 CoP − a/ω²)은 나아지지 않아 뺐다.
- 계단·경사에서 넘어질 때 몸이 앞으로 뛰어오르듯 떠서(0.3~0.4초 공중) 손으로 떨어지는 경우가 있다(지지 다리가 마지막에 몸을 민다). 걸림(trip_obstacle)도 걸린 뒤 한 걸음 만에 뛰어오르며 넘어진다 — v0.6 알려진 문제(걷는 몸을 받는 스텝 계층 없음)와 같은 뿌리.
- 3m 모서리에서 밀리면 허공으로 내딛고(헛디딤) 몸이 앞으로 기울며 떨어진다 → 공중 허우적 0.77초 → 손이 먼저 닿고 구른다(발로 착지하지 못함, 머리 닿는 속도 3.1 m/s). 걷다가 모서리를 넘는 경우(걷기 추종 'void' 넘김 → Misstep)는 뒤에 남은 발이 모서리에 끌려 몸이 더 크게 돈다.
- 굴러 내려가는 동안 손이 계단 모서리·바닥에 부딪히는 순간 한 스텝 각속도가 50 rad/s를 넘는 경우가 있다(근처 입력 stairs_tumble 1/6·fall_from_ledge_3m 1/6 폭발 판정). 모서리를 둥글게(1.5cm)·손목 약하게·손 목표 이어 받기로 줄였다.
- 굴러 내려간 뒤 계단에 머리를 아래로 누우면 몸부림(무릎 당김) 자세가 다리를 위로 든 모양이 된다. 계단·경사 위에서는 일어서지 않는다.
- slope20_push(경사를 가로질러 밀림) 근처 입력 5/6, 내리막 쪽 밀림(slope20_push_downhill, 추가)은 넘어진다.

# v0.8b 잡기·벽 (README 결정 148~158, 값은 `config/sim.json terrain`(rail·wall·ledgeGrabEdge)·`config/behaviors.json` grabSense·grabStart·Grab·HangOnLedge·BraceAgainstWall)

코드: `src/sim/terrain.ts`(난간대·기둥·벽 `props`, 잡을 곳 `grabs`), `world.ts`(지형 물체 콜라이더 `propColliders`·`wallColliders`, `grabbable` 태그), `perception.ts`(지형 물체 접촉 `props`·`propTouch`·`grabTouch`, `senseGrab`·`senseWall`·`DelayLine`), `behaviors/grab.ts`(GrabJoint·Grab·HangOnLedge·BraceAgainstWall), `blender.ts`(`autoStartGrab`), `metrics/behaviorMetrics.ts`(잡기·벽 지표), 렌더 `scene.ts`(난간대·벽)·`debugDraw.ts`(잡기 점·선, 벽 탐지 점, 잡기 텍스트).

## 지형
- **난간(rail)**: 평지 + 진행 방향(Z)을 따라 놓인 둥근 난간대(축 x 0.42m, 높이 0.95m, 지름 5cm, z −3~3, 끝 기둥 2개). **벽(wall)**: 평지 + 정면 벽(벽면 z 0.85m, 높이 2.4m, 두께 0.2m). **모서리(ledge)** 받침의 앞 윗모서리는 잡을 곳.
- 난간대·기둥·벽은 **지면이 아니다**: 접촉은 `per.props`로 따로 세고(자세·넘어짐·공중·누움 판정, 지지 다각형, 지면 레이에 안 들어감), 평지 판단(`flat`)도 그대로라 난간·벽 지형은 평지 경로(일어서기 등)를 쓴다. `grabbable` 태그: 난간대, 잡을 모서리가 있는 받침.

## 인지 (감지 지연 0.08초)
- **잡을 곳** `senseGrab`: 손마다 어깨에서 잡을 곳(난간대 축·받침 윗모서리 선분)의 가장 가까운 점. 거리 ≤ 팔 길이(어깨~손바닥 0.64m) × 1.0, 몸통 앞 성분(내적) ≥ −0.35이면 후보. 모서리는 어깨보다 아래면 주저앉아 뻗는 몫 0.9m를 더해 보고, 받침 안쪽을 보고 있을 때만(몸통 앞·받침 안쪽 내적 ≥ 0.3).
- **벽** `senseWall`: 넘어지는 방향(넘어짐 확실도 ≥ 0.05면 그 방향, 아니면 COM 수평 속도 ≥ 0.25 m/s의 방향)으로 Spine2에서 수평 레이 1.3m, 벽 콜라이더만.
- 두 결과는 매 스텝 `DelayLine`(0.08초)에 넣고 행동 시작 판단은 0.08초 전 결과로 한다.

## 시작 (`autoStartGrab`, 잡을 곳·벽이 있는 지형에서만 — 이전 지형은 로그 그대로)
- 흔들림 = 피격 뒤 0.08~1.5초 안에 (스텝 계층이 내딛는 중 / 넘어짐 확실도 ≥ 0.1 / COM 수평 속도 ≥ 0.3 m/s), 또는 확실도 ≥ 0.3, 공중, 헛디딤.
- 잡기: 가장 가까운 후보 손 하나. 다른 손은 어깨 거리 ≤ 팔 길이 × 0.7일 때만(몸을 가로질러 뻗지 않음), 모서리는 두 손. 놓거나 못 잡은 손은 0.3초 뒤 다시.
- 벽 짚기: 벽 레이 거리 ≤ 1.1m이고 잡기 중이 아니면. 잡기·벽 짚기 중에는 넘어짐 대비(BraceForFall·ProtectHead·CatchFall)를 켜지 않는다. 잡고 있으면 넘어짐·공중 행동(허우적·착지 준비·구르기·헛디딤)을 끄고, 모서리를 잡고 발이 떠 있으면 HangOnLedge.

## Grab (레이어 7.3)
1. **잡을 점**: 처음에 한 번 정해 월드에 고정 — 몸이 움직이는 쪽으로 0.3초 앞 어깨에 가장 가까운 잡을 곳 점. 어깨 거리가 팔 길이 × 1.1을 넘으면 다시 정함.
2. **손바닥 목표**: 난간대는 축에서 (반지름 + 4mm), 바깥 법선 n = (어깨 쪽 수직 성분 + 위 1.2) 정규화 — 위·안쪽에서 감아쥠, 손가락은 난간대 너머 바깥과 몸 앞 난간 방향 사이. 모서리는 윗면 안쪽 5cm, 손바닥 아래, 손가락 안쪽.
3. **뻗기 두 단계**: ① 잡기 전 점(목표 + n × 6cm + 몸 쪽 수평 3cm)으로 최소 저크(Spine2에 붙은 시작점, 시간 = 거리/1.6 m/s ∈ [0.22, 0.45]초), 손가락은 몸 앞쪽. ② 궤적 60% 뒤 잡기 전 점 8cm 안에 들거나 시간이 끝나면 지금 손바닥에서 목표(+ 안쪽 2cm 누름)로 0.12초 내려앉기. 팔은 2관절 IK(손목은 전완 중립에서 60° 넘게 돌리지 않음) + 전신 QP 손 과제(kp 400·kd 40·가중치 40). 모서리가 팔 길이 × 0.9보다 멀고 어깨 아래면 주저앉으며 뻗음(고관절 95°·무릎 115°·척추 35°, 균형·스텝 끔).
4. **잡음**: 손바닥이 목표 쪽(바깥 법선 쪽)에 있고 속도 < 1.8 m/s이며 잡을 곳 표면까지 < 2.5cm(손이 잡을 곳에 닿아 있으면 < 6cm) → `GrabJoint`: 잡은 순간의 손바닥 점에 고정 강체(앵커)를 두고 손과 일반 관절로 잇는다. 회전 3축 자유(구형), 직선 3축은 힘 기반 위치 모터 kp 30000 N/m·kd 600·축별 최대 900 N(손아귀 힘 — 넘으면 손이 미끄러진다). 힘은 PD 식으로 추정해 로그에 남긴다(Rapier 0.21 JS는 관절 충격량을 읽을 수 없다). 0.9초 안에 못 잡으면 포기.
5. **붙들기**: 팔 IK 목표 = 앵커 쪽 어깨-손 거리 팔 길이 × 0.8(난간)·0.97(모서리) — 팔꿈치를 굽혀 몸을 끄는 힘은 팔 근육으로만(몸은 팔 관절을 거쳐서만 끌린다). 몸이 버텨 내면(확실도 < 0.1, COM 수평 속도 < 0.2 m/s) 끌지 않고 지금 거리로 붙든다.
6. **놓기**: 추정 힘 > 1050 N이 0.12초 / 미끄러짐 > 8cm / 그 팔 강도 배율(직전 스텝 다른 행동) < 0.35 / (난간) 내딛지 않음·확실도 < 0.1·COM < 0.2 m/s·두 발 닿음이 0.6초, 잡은 지 1.2초 뒤 스스로. 끄기 요청(늘어짐·일어서기)이면 놓는다. 행동이 목록에서 빠질 때 관절·앵커를 지운다(`dispose`).

## HangOnLedge (7.1)
모서리를 잡은 손이 있고 발이 떠 있으면 켜짐. 균형·스텝 끔. 엉덩이에서 잡은 점 쪽 수평 레이 0.9m(지면 콜라이더 = 받침 옆면)가 맞으면 다리로 벽 짚기(고관절 40°·무릎 70°·발목 10°, 강도 0.55), 아니면 늘어뜨림(10°·20°·15°, 0.25), 0.25초로 바꿈. 척추 6°, 머리 −20°(잡은 손을 올려다봄).

## BraceAgainstWall (7.05)
1. 손 고르기: 벽 법선과 골반 옆 방향 |내적| ≥ 0.6(옆 벽)이면 벽 쪽 손 하나, 그 어깨가 벽에서 0.22m 안이면 **어깨로 받기**(그 팔을 가슴 앞으로 접고 몸통을 벽 쪽 10° 옆 굽힘). 아니면(앞 벽) 두 손.
2. 손바닥 목표: 어깨를 벽면에 수직으로 내린 점 − 아래 10cm + 바깥 6cm, 벽에서 4cm 앞(몸이 다가오며 닿게), 손바닥은 벽·손가락 위. 최소 저크(거리/2.0 m/s ∈ [0.16, 0.35]초).
3. 닿은 손(`per.props` 벽 접촉): 그 점을 버팀점으로 0.2초 동안 팔꿈치 40° 더 굽히며 강도 0.45(흡수) → 0.85(버팀). 손목 강도 상한 0.3(벽에 부딪힌 손이 50 rad/s 넘게 돌던 것).
4. 밀어내기: 닿은 뒤 COM 속도 < 0.25 m/s가 0.35초면 0.6초에 걸쳐 어깨-손 거리를 팔 길이 × 0.92로. 끝: 밀어낸 뒤 내딛지 않음·확실도 < 0.1이 0.5초, 또는 3.5초.

## 지표 (※, `behaviorMetrics.ts`, 잡기·벽 짚기를 시도한 시나리오에만)
grabbed, gripTime(기준 피격 → 첫 잡음), grabSlipMax(잡은 동안 손바닥 점-앵커 거리 최대 — 잡은 순간 손바닥 점 기준이라 손아귀 탄성(힘/kp)과 실제 미끄러짐을 함께 잰다), grabForceMax, grabHoldTime, hangTime(HangOnLedge 가중치 > 0.5), wallBraced, wallContactLead(피격 → 첫 벽 접촉), wallContactSpeed, wallPushOff. 로그 `behavior.grab`(인지 후보·벽 탐지·손별 단계·목표·궤적 기준점·앵커·힘·미끄러짐·손바닥), `grabTarget`.

## 알려진 문제 (v0.8b)
- **ledge_grab** (결정 157 → 재조사 173): 아래 157의 분석 중 '어깨 스윙 콘이 팔을 수평 위 40°까지만 든다'는 틀렸다(결정 171: 콘 축은 T포즈, 팔은 어느 방향으로나 간다). 진짜 원인은 등 뒤 모서리다 — 주저앉아 뒤꿈치 옆 모서리를 잡으면 COM이 손보다 위·바깥에 있어 몸이 손 둘레로 뒤로 넘어 돌고, 등을 벽에 댄 채 어깨를 130~160° 펴서 매달린다(사람 불가). 허공을 헛디뎌 벽을 보고 내려가면 잡을 때 이미 4.5 m/s. 주저앉기 관절 목표가 두 Grab에서 두 번 곱해지던 버그는 고쳤다(결정 172).
- (이전 기록, 결정 157): 받침 안쪽을 보고 뒤로 밀려 떨어지는 몸은 발뒤꿈치(모서리) 둘레로 돌아 바깥으로 빠져, 어깨가 모서리에서 팔 길이 안에 드는 것은 엉덩이가 모서리에 걸친 0.1초 남짓뿐이다. 주저앉으며 뻗기를 넣어도 그때 팔이 떨어지는 몸에 휘둘려(손 4~6 m/s) 윗면에 닿지 못한다(시도 11가지). 또 X Bot 어깨 스윙 콘 100°(A포즈 rest 기준)는 팔을 수평 위 약 40°까지만 들 수 있어 팔을 머리 위로 뻗고 매달리는 자세 자체가 관절 제한 밖이다.
- 난간 잡기는 근처 입력 7/8(나머지는 잡은 채 다리가 풀려 난간에 기대 주저앉음), 벽 짚기 7/8. 잡을 때 팔이 궤적보다 0.1~0.15m 늦다(뻗는 0.3초 동안).
- 스텝 계층의 뒤쪽 헛디딤: 낭떠러지로 내딛는 스윙 시간에 바닥까지 높이(3m × 0.6초/m)가 더해져 스윙이 끝나지 않아 헛디딤 알림이 안 온다(결정 158, 고치면 fall_from_ledge_3m 공중 시간이 바뀌어 그대로 둠).
## 어깨 가동 범위 (결정 171, `config/ragdoll.json $shoulderRom`, 기본 끔)
X Bot 어깨 = Rapier 구형 관절, T포즈 위팔 방향을 축으로 스윙 콘 100°(AngX·AngZ 각각 ±100°) + 비틀기 ±70°. 좌표가 전체 사원수의 2·asin(허수 성분)이라 비틀기와 섞여, 비틀기를 고르면 몸통 기준 모든 팔 방향에 갈 수 있다(사람보다 넓음: 폄 100° 넘는 장면 다수). `Ragdoll.applyShoulderRom`(근육 apply 맨 앞, 근육 상태와 무관): 위팔 방향 d를 Spine2 rest 기준 몸통 좌표(x 왼쪽·y 위·z 앞)로 보고, 관상면 뒤 각 β = asin(−d_z)가 팔 높이별 한계(아래 60°·수평 45°·위 10°, d_y로 선형)를, 시상면 넘어 반대쪽 각이 45°를 넘으면 넘은 각 e에 τ = min(maxTorque, k·e + c·들어가는 각속도)를 앞쪽·제 쪽으로 돌리는 축으로 위팔 +τ, Spine2 −τ. 로그 `joints.LeftArm/RightArm.rom {excessDeg, torque}`.

# v0.8c 캐릭터·물체 (README 결정 8c-1~8c-10, 값은 `config/interaction.json`)

코드: `src/sim/interaction.ts`(Prop·ContactSensor·설정), `api.ts`(World.addCharacter 충돌 비트·addProp·senseContacts·grabTargets, Character._onContacts·reactToContact·updateLookOther), `ragdoll.ts`(charBit), `runner.ts`(여러 캐릭터·spawnProp), 렌더 `src/render/others.ts`(다른 캐릭터 색 캡슐·프롭·묶음 카메라), 필름 `tools/film.ts`·릴 `tools/reel.ts --config config/reel_08c.json`, 탐색 `tools/interactTry.ts`(시나리오·설정 덮어쓰기 묶음 실행), 회귀 비교 `tools/outCompare.ts`, 테스트 `tests/interaction.test.ts`.

## 여러 캐릭터 월드
- 시나리오: 최상위 character·spawn·clip·expect = 첫 캐릭터(이름 primaryName, 기본 A). `characters[]` = 두 번째 이후(name, spawn, clip, balance·stepping·getup, expect). 이벤트 `char` = 받을 캐릭터(없으면 첫 캐릭터). `spawnProp` = 그 시각 프롭 생성.
- 순서: World.step = 캐릭터 순서대로 7.1의 1~7단계 → Rapier 한 스텝 → 캐릭터 순서대로 안전 검사 → (다른 캐릭터·프롭이 있으면) 접촉 감지. 이벤트 처리·로그도 캐릭터 순서. 결정론: 같은 시나리오 두 번 → 모든 캐릭터 로그·프롭 로그·요약 바이트 동일.
- 무작위성: 첫 캐릭터는 이전과 같은 하위 스트림, k번째(k ≥ 1)는 `prng.fork('character:<이름>')` 아래에서 갈라 쓴다.
- 충돌 그룹: 혼자인 캐릭터는 이전 그대로. 두 번째 캐릭터가 들어오면 캐릭터 k마다 비트 C_k = 1 << (15 − k)를 주고, 몸 안 충돌 제외 쌍(설정 쌍·걷기 다리 쌍)에 든 바디는 소속에 C_k를 더하고 필터에서 C_k를 뺀다. Rapier 규칙(A.소속 & B.필터 ≠ 0 그리고 B.소속 & A.필터 ≠ 0)으로 자기 몸 안의 제외 쌍은 그대로 막히고(쌍 비트가 서로 빠짐 + C_k가 서로 빠짐), 다른 캐릭터와는 C_k가 남아 늘 충돌한다(쌍 비트 번호가 두 캐릭터에서 같아도).
- 선택: 캐릭터끼리 거를 바디 쌍(`character.noCollide`)이 있으면 그 바디 콜라이더에만 Rapier 접촉 거르기 훅을 켠다(기본 비움 → 훅 없음).
- 로그: 첫 캐릭터 `log.jsonl`, 나머지 `log.<이름>.jsonl`, 프롭 `props.jsonl`(로그 프레임마다 {time, props[{id,pos,rot,linVel,angVel}]}), meta.characters·props, 이벤트에 `char`(낸 캐릭터)·`source`(접촉 상대). 요약 = 첫 캐릭터 요약 + `others[이름]`(각자 기대값; 실패 사유는 '이름: ' 붙여 합침). 혼자인 시나리오는 이 필드가 모두 없다(로그·요약·메타 바이트 동일, 247개 파일 확인).

## 접촉 감지 → hit (SPEC '다른 캐릭터와 부딪히면 push 피격', '프롭 접촉 충격량을 Δv로 환산')
1. 매 스텝 Rapier 뒤 캐릭터마다 자기 콜라이더의 접촉 쌍 중 상대가 다른 캐릭터·프롭인 것만, 상대별로 법선 충격량 J = Σ impulse_i · n_i(n = 상대 → 몸), 바디별 충격량 합, 충격량 가중 접촉점, 관통 깊이(−contactDist 최대)를 모은다. 마찰 충격량은 넣지 않는다.
2. 합 J(모든 상대)를 균형 계층 `noteExternalImpulse`에 알린다: 측정 지면력 예측(v0.4 결정 56)이 이 충격을 지면 반력으로 착각해 '밀린 것을 즉시 아는' 일을 막는다 — 스크립트 밀기와 같은 규칙.
3. 감지기(ContactSensor): 상대별로 접촉 시작부터 window(0.05초) 동안 J를 모아 창 끝에 Δv = |ΣJ| / 총질량. Δv ≥ minDv(캐릭터 0.05, 프롭 0.04)면 hit(감지 시각 = 창 끝, 촉각 감지 지연). 접촉이 이어지면 다음 창. gap(0.1초) 넘게 끊기면 끝.
4. 프롭은 '날아온 충격'만: 접촉 직전 스텝 프롭 속력 ≥ 1.5 m/s 그리고 그 속도의 접촉 법선(몸 쪽) 성분 ≥ 0.3 m/s일 때만 hit. 바닥의 상자를 차거나 상자 위에 누운 접촉은 장애물(hit 아님, 충격량 알림은 함).
5. hit 처리(다음 스텝 시작, Character): 피격 모델 `resolveHit`으로 행동·상처만 정하고 충격량은 다시 가하지 않는다. 종류 = 캐릭터 push(행동 없음 — 균형·스텝이 물리 밀림에 반응), 프롭 melee(피격 반응·비틀거림). 반응 중(reactHold) 핀 0, 일어서기 중이면 취소 — 다른 피격과 같다.

## 접촉 뒤 의도 반응 (`reactToContact`)
- 팔 힘 빼기(armYield): 맞은 바디가 위팔·전완·손이면 그 팔 근육 배율 0.3 → 0.5초에 회복(`setMuscleScale`, 이벤트). 흔들던 팔이 굳은 채 받은 충격을 몸통에 넘겨 걷기 추종이 무너졌다.
- 서 있는 클립 넘김(handover): 애니 추종 중 클립 COM 수평 속도 < 0.3 m/s(Idle)이면 Δv ≥ 0.08에서 바로 균형·스텝 계층(v0.4)에 넘김 → 서면 tryResume이 Idle로 다시 붙임. 걷는 클립은 넘기지 않음(walkDv null).
- 돌아보기: 캐릭터 접촉 Δv ≥ 0.1이면 0.15초 뒤부터 1.2초 동안 LookAt, 목표 = 매 스텝 상대 머리 위치. 로그 interaction.lookAt.
- 맞은 자리 누르기: 프롭 hit Δv ≥ 0.08이고 맞은 바디가 머리·Spine2·위팔이면 0.12초 뒤 HoldWound(맞은 바디 로컬 접촉점, 2.2초) — 상자에 맞은 머리를 문지름.

## 프롭 (`Prop`, SPEC 7.2 addProp)
상자·구·캡슐 동적 강체(CCD 켬). 질량 없으면 부피 × 400 kg/m³. 위치·회전·선속도·각속도는 정의대로(떨어뜨리기·던지기). `grabbable` 표시 → World.grabTargets()(v0.8b 훅, 다른 캐릭터 바디는 `character.grabbable`일 때만 — 기본 끔).

## 사람 짚기 (결정 174, v0.8b BraceAgainstWall 재사용)
- 인지: `senseWall`이 벽 콜라이더에 더해 다른 사람(PhysicsWorld.persons, World.addCharacter가 등록)의 `grabSense.person.bodies`(Hips·Spine·Spine2)에 넘어지는 방향 수평 레이(1.3m)를 쏜다. 레이 시작은 wallFrom(Spine2) + person.from(LeftArm·RightArm·Head). 맞으면 그 바디 로컬 점·법선(`WallSense.person`)을 남긴다. 감지 지연 0.08초, 시작 조건은 벽 짚기와 같다(흔들림 + 거리 ≤ 1.1m).
- BraceAgainstWall: 매 스텝 맞은 바디 자세로 점·법선을 다시 계산(상대가 움직임). 손 고르기는 넘어지는 방향과 골반 옆 방향 내적(사람 몸은 둥글어 법선이 비스듬함). 사람이면 `person` 값(손바닥 아래 0.1m, 표면 2cm 안쪽, 뻗기 ≤ 0.25초)으로 덮고, 손바닥 목표를 맞은 점 좌우 `personHalfWidth` 0.18m 안으로 자른다. 닿기 전까지 전신 QP 손 과제(`task`, kp 400·가중치 60). 닿음 = 손 콜라이더와 상대의 어떤 콜라이더든 Rapier 접촉 1cm 안(어깨 받기는 Spine2·위팔). 닿은 점은 상대 바디 로컬로 붙여 흡수·버팀·밀어내기 동안 따라간다.
- 밀어낸 뒤 물러나기(결정 178): 밀어내기 끝(push = 1)에 엉덩이~짚은 점 수평 거리 < personalSpace(0.6m)면 단계 want → COM 목표 이동 stepBack(0.2m, 상대 반대쪽) + StepMods.newEpisode(서 있는 동안 걸음 수 0으로) → 걸음 시작(stepping) → 착지(done)에 그침. 그동안 짚기는 끝나지 않는다. 로그 info.backPhase.
- 다른 사람 발 피하기(스텝 계층, `stepping.json otherFootClear` 0.25m): 착지 목표가 다른 사람 발 중심 그 거리 안이면 지지발 쪽으로 0.85배씩(최대 10번) 줄인다.
- 로그 `behavior.grab.wall.person`('B:Spine2'), 필름은 벽 탐지 점·손 목표 그대로.

## 지표 (`summary.ts`, 상호작용 월드에서만)
interPenetrationMax(다른 캐릭터 바디와의 관통 깊이 최대, m — 완료 기준 ≤ 0.02 ※), propPenetrationMax, contactHits·contactHitMaxDv(캐릭터 접촉 hit 수·최대 Δv), propHits·propHitMaxDv, firstContactTime, lookAtOtherTime.

## 로그·시각화
로그 `interaction`{name, contacts[{source, kind, J, penetration, point}], penetration, lastHit{t, source, body, dv, direction}, lookAt}. 필름스트립: 두 번째 캐릭터는 주황(세 번째 초록) 캡슐·FBX, 머리 위 이름표(A/B), 캐릭터별 충격·행동 줄(그 캐릭터 색), 프롭은 나무색 상자(모서리 선), 카메라는 모든 캐릭터가 들어오게 가운데·거리를 맞춤(너무 멀어지면 첫 캐릭터). 하이라이트 `npx tsx tools/reel.ts --config config/reel_08c.json --out out/reel_08c`.

## 결과 (시드 1)
| 시나리오 | 결과 | 핵심 |
|---|---|---|
| two_characters_collide | 통과 | A를 Δv 0.8로 밀어 1m 앞 B와 충돌. A 4걸음, B 5걸음으로 버티고 서로 돌아봄(1.8초), 둘 다 서 있음. 관통 최대 0.4cm |
| shoulder_bump_pass (추가) | 통과 | 엇갈려 걷다 손·팔이 상대 허벅지·팔에 걸림(Δv 약 0.2) → 팔이 밀려나고 서로 1.2초 돌아보며 계속 걷기(각 10m) |
| prop_hit | 통과 | Idle 중 3kg 상자가 머리에 떨어짐(Δv 0.18 melee) → 고개 숙임, 한 걸음 물러섬, 손으로 머리 문지름(0.94초에 닿음) |
| prop_hit_walking (추가) | 통과 | 걷는 중 상자가 머리를 스치고 어깨에 맞음 → 움찔·어깨 누르며 계속 걷기 |

근처 입력(`tools/interactTry.ts`): two_characters_collide 27개(밀기 0.7~0.9 × B 위치 ±5cm) 중 A 넘어짐 5·B 3, shoulder_bump_pass 9개(옆 간격 0.40~0.44 × 만나는 위치 ±5cm) 중 A 3·B 3, prop_hit 7개 넘어짐 0, prop_hit_walking 7개 넘어짐 0.

## 알려진 문제 (v0.8c)
- 걷기 추종(v0.6)은 다른 사람과의 손·팔·허벅지 접촉에 약하다: 같은 크기의 스크립트 밀기(몸통·허벅지 22개 위상)에는 넘어지지 않는데, 접촉으로는 스쳐 지나감 근처 입력의 1/3에서 몇 초 뒤 넘어진다(팔 힘 빼기로 11 → 8/32). 걷다 부딪혀 멈추는 경로(스텝 계층 넘김)는 걷는 속도를 못 받아 더 넘어져 쓰지 않았다.
- (해결, 결정 174·178) 서로 부딪힌 뒤 기대어 팔을 옆으로 뻗던 것 → 사람 짚기로 손을 먼저 짚고 선 뒤 밀어내고 한 걸음 물러난다. 스텝 계층은 다른 사람 발 0.25m 안에 딛지 않는다.
- 부딪힐 걸 미리 보지 못한다(인지 없음): 사람은 다가오는 사람을 보고 어깨를 돌리거나 팔을 거둔다.
- HoldWound가 끝날 때 팔이 옆으로 튀어 내려온다(prop_hit 4.0초 — 기존 상처 쥐기 풀기 동작, 반응 클립 브랜치와 겹치는 부분이라 손대지 않음).
- 가벼운 손이 두 몸 사이에 끼면 각속도 50 rad/s를 넘어 폭발 판정이 나는 경우가 있다(근처 입력 수십 개 중 몇 번, 선택한 시나리오에는 없음).
- 성능: 두 캐릭터 걷기 스텝당 약 2~9 ms(접촉 감지 + 캐릭터 둘).

# 반응 클립 (2026-10-27, SPEC 17 일부를 범위로 당김, README 결정 159~165, 값은 `config/reaction.json`)

코드: `src/sim/character/reaction.ts`(라이브러리·매칭·추종 레퍼런스), 연결 `api.ts`(scheduleReaction·startReaction·applyStyle·endReaction), 추종기 쪽 `balance.ts`(trackRef·팔 각운동량 비용), 라이브러리 `src/sim/character/reactionClips.generated.ts` ← `assets/poses/reaction/*.json`. 도구 `tools/kimodo/reactLib.ts`(생성)·`reactSelect.ts`(선별)·`clipProfile.ts`, 평가 `tools/armEval.ts`·`armMetrics.ts`·`armTrace.ts`·`armCompare.ts`·`shiftVariance.ts`. 지표 `src/sim/metrics/reactionMetrics.ts`.

## 경계: 레퍼런스 생성 ↔ 추종기 (결정 164)
- 레퍼런스 생성 = 반응 클립 고르기·시간 늘이기 + 행동 계층 편집(움켜쥐기·머리 감싸기 …) → **관절 목표 흐름**(Character의 clipTargets → blender → targets)과 **`TrackingRef`**(관절별 추종 세기 `jointWeight`, 레퍼런스 가중치 `w`, 추종기 힌트: 팔 반사·벌림·몸통 과제·팔 각운동량 비용 배율, 풀기 조건 `release`).
- 추종기 = 전신 QP + 근육(지금). `Balance.trackRef`만 읽는다: 자세 과제 가중치 = 설정값 + w·(1 − 위험도)·(jointWeight − 설정값). 위험도(감지 DCM이 지지 다각형 밖 d0 → d1 m에서 0 → 1, 오를 때 즉시·내릴 때 tau)는 추종기 쪽 판단(넘어질 듯하면 팔을 균형에 풀어 준다).
- 나중에 추종기를 학습 정책으로 바꾸면 같은 목표 흐름 + TrackingRef를 입력으로 받는다. 남은 예외: v0.5a 손 과제(HoldWound)는 아직 QP 손 과제(목적 항)다.

## 라이브러리 (결정 161)
- Kimodo RP-v1.2, 프롬프트 `a person standing still is suddenly pushed <방향 문구>, and recovers their balance`(밀림 조사와 같음), stand 키프레임 0·24·30프레임, **루트 경로 = 30프레임(밀림)부터 x(t) = D(1 − e^{−t/τ}), D = Δv·τ** (0·3·6·…·89프레임 점). 방향 8(뒤·앞·왼·오·대각 4) × 세기 3(Δv 0.5/0.8/1.1, τ 0.55/0.6/0.65) × 시드 1~6 = 144개, 4초.
- 선별(`reactSelect.ts`): 탈락 = 몸통 최대 > 35°, 팔 들림 p90 > 55°, 끝 COM 속도 > 0.15 m/s. 순위 = 칸 중앙값(팔 들림·팔꿈치·팔 사용·몸통)에서의 거리 + 0.1 × 자동 점수 + (팔 들림 p90 − 25°)/10. 칸마다 2개 → 48클립(4.8MB).
- 클립 메타: pushTau(info.pushFrame/fps), dvPeak(밀림 뒤 1초 COM 수평 속도 최대), dir(밀림 뒤 0.5초 COM 이동 방향, 클립 정면 +Z 기준).

## 시작 (style 모드, 기본)
1. 충격(종류 hitTypes, 맞은 바디 hitBodies = 몸통·머리, COM Δv minDv~maxDv)이 서 있는 Active 몸(균형·스텝 켬, 걷는 중 아님)에 오면 delay(0.08초) 뒤 고른다. 그사이 COM 수평 속도 최대 = peakSpeed. blockBehaviors(넘어짐 대비·무릎 꿇기·다친 다리 …)가 켜져 있으면 쓰지 않는다.
2. 고르기: 비용 = dir·(1 − cos(COM 속도 방향(골반 yaw 기준), 클립 dir)) + dv·(dvPeak − peakSpeed)², 최소(같으면 이름 순).
3. 클립 시각 τ = pushTau + (지금 − 충격). 반응 중 다시 맞으면 새 클립으로 바꾸되 상체 목표는 직전 출력에서 blendIn초에 이어 붙인다(rehit 'switch').

## 진행 (applyStyle, 매 스텝)
- **시간 늘이기**: 클립 착지 시각(밀림 뒤, 발이 5cm 넘게 옮겨진 디딤) k번째 T_k ↔ 우리 k번째 착지. 스텝 계층이 스윙 중이면 재생 속도 = (T_k − τ)/((1 − s)·스텝 시간), 정착 중이면 rate.settle, 그 밖 1, [min, max]로 자르고 tau초 저역 통과.
- **목표**: style.joints(척추·머리·팔)를 slerp(서기/행동 목표, 클립 목표, w). 행동 계층은 그 위에서 그대로 돈다(움켜쥐는 손 등).
- **가중치 w** = 걸음 문 × 들어가기(blendIn) × 나오기. 걸음 문(stepGate): 스텝 계층이 반응 걸음(스윙) 중이면 inStep배(down초), 걸음 사이·정착이면 1(up초) — 걸음을 내딛는 동안은 v0.4 팔 균형을 거의 그대로 두고, 버틴 뒤 팔이 사람 클립처럼 내려온다. 나오기: 스텝 계층이 서기로 돌아오고 holdAfterStand초, 또는 클립 끝 blendOut초 전.
- **TrackingRef**: 팔 관절 추종 세기(위팔 armWeight, 전완·손 foreArmWeight), 팔 반사·벌림 × reflexScale·abductScale(0: 스타일 중에는 손 규칙으로 팔을 벌리지 않음).
- **팔을 쓰는 행동과 함께 (병합, 결정 167)**: 팔 묶음 배율 armK[좌·우]는 그 팔을 행동(Grab·HangOnLedge·BraceAgainstWall·HoldWound)이 쥐었거나 근육 명령 배율이 1 아래(부딪혀 힘 뺌)이면 0, 아니면 1을 blendIn초 저역 통과로 따른다. 클립 팔 목표 가중치 = w·armK, TrackingRef.jointScale = armK(추종기는 w·(1 − 위험도)·jointScale로 팔 추종 세기를 섞는다). 로그 `reaction.style.armK`(1 아래일 때만)
- **접촉하면 놓기 (결정 168)**: 다른 캐릭터·프롭 접촉 피격(v0.8c 감지)이 오면 스타일 나오기를 시작한다(`releaseOnContact`). 클립은 빈 공간 반응이라 부딪힌 뒤는 접촉 반응과 균형·스텝 계층이 맡는다
- **행동이 몸을 맡으면 놓기 (결정 170)**: 스타일 중 blockBehaviors 행동이 켜지거나 상태가 Active가 아니면 releaseTime초에 나온다(시작 막기와 같은 목록)

## 팔 각운동량 비용 (결정 163, `balance.json wb.armMomentum`)
팔 관절 자유도 열만 모은 COM 둘레 각운동량 행 A_G,arm = (A_ang − [c]×A_lin)[:, 팔 관절] (원점 운동량 행렬의 열 j = 그 관절 아래 바디들의 운동량)로 h_arm = A_G,arm q̇. QP 과제 A_G,arm q̈ = −kd·h_arm (가중치 weight, 손 과제가 걸린 팔 제외). 로그 `balance.armMom`, `armMomShare` = |h_arm|/|k_G|.

## track 모드 (실험, 꺼 둠 — 결정 160)
상태 매칭(골반 yaw + 두 발 중점 기준 COM 위치·속도, 두 발 상대 위치, 발 접촉, 다리 관절, dvPeak)으로 클립·시각·앵커를 골라 v0.6 애니 추종 QP(walk.ts, `reaction.walk` 덮어쓰기)로 걸음까지 따른다. 크게 벗어나면 walk.ts 넘김 규칙으로 v0.4 균형·스텝 계층, 클립 끝에서 서기 균형. 착지는 step 이벤트로 센다.

## 지표·도구
- 요약(충격 시나리오만): `trunkTiltMaxAfterHit`(첫 충격 뒤 3초 Spine2 기울기 최대), `staggerSteps`(첫 충격 뒤 걸음), `armMomShareMean/Max`, `reactionClipUsed`, 레퍼런스가 있으면 `refJointRmsDeg`(DTW 경로를 따라 바디별 부모 기준 상대 회전 차이 RMS).
- `tools/armMetrics.ts`(sim 로그·Kimodo 클립 공통): 팔 들림(위팔–Spine2 아래축 각) 평균·p90, 40° 넘는 비율(전체, 충격 1초 뒤부터 lateOut), 팔꿈치, 팔 사용(°/s), 몸통 최대. `tools/armEval.ts`: 시나리오 × 근처 입력(세기 ±5%·방향 ±5°) 병렬 평가·사람 분포(`--human`). `tools/shiftVariance.ts`: 충격 시각 ±K 스텝 이동 결과 흩어짐.

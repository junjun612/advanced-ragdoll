# v0.0 기술 스파이크 — Rapier 부분 (항목 1~5)

- 날짜: 2026-10-26
- 버전: `@dimforge/rapier3d-compat` **0.21.0** (런타임 `R.version()`도 `0.21.0`), Node v24.14.1, Chromium(Playwright chrome-headless-shell 156.0.8078.4)
- 코드: `spike/rapier/` (버리는 실험 코드). 원본 결과: `spike/rapier/out/*.json`
- 실행:
  - `npx tsx spike/rapier/01-api.ts` — API 런타임 확인
  - `npx tsx spike/rapier/02-limits.ts` — 관절 제한 a/b/c
  - `npx tsx spike/rapier/03-muscles.ts` — 근육 A/B/C, kp 스윕
  - `npx tsx spike/rapier/04-determinism.ts` — Node×2, Node↔Chromium (Vite dev 서버 + Playwright)
  - `npx tsx spike/rapier/05-perf.ts` — 1명·8명 성능

## 테스트 랙돌 (스파이크 전용)

- 16바디, 키 약 1.77 m, 75.0 kg. 질량은 SPEC 6.1 비율 × 75. 몸통·팔다리는 캡슐, 머리는 구, 발은 박스(0.10×0.07×0.25 m).
- 기본 자세는 T-포즈다. 모든 바디 프레임은 기본 자세에서 월드 축과 같고, 바디 원점은 부모와 잇는 관절 위치다. 관절 프레임은 양쪽 다 항등이다. 그래서 관절 축은 X(왼쪽), Y(위), Z(앞)이다.
- 관절 제한은 SPEC 6.3 값을 축에 대응시켰다. 굽힘은 X축이다. 다만 부호가 뼈 방향에 따라 다르다. 척추·발목은 앞으로 굽힐 때 +X, 고관절 굽힘은 −X, 무릎은 +X다. 팔꿈치는 경첩축이 ±Y이고, 굽히면 음수다. 팔은 비틀기가 X축이고 스윙이 Y/Z축이다. "스윙 콘 100"은 Y/Z 각각 ±100°로 근사했다.
- 인접 바디 충돌은 `ImpulseJoint.setContactsEnabled(false)`로 껐다.

---

## 1. API 인벤토리

모든 경로는 `node_modules/@dimforge/rapier3d-compat/dist/` 기준이다. 표의 "런타임 확인"은 `01-api.ts`에서 실제로 돌려 본 결과다.

| 기능 | .d.ts 위치와 시그니처 | 런타임 확인 / 비고 |
|---|---|---|
| 관절 종류 | `dynamics/impulse_joint.d.ts:20` `enum JointType { Revolute, Fixed, Prismatic, Rope, Spring, Spherical, Generic }` | — |
| 구형 관절 | `impulse_joint.d.ts:316` `JointData.spherical(anchor1, anchor2)` | **만들어진 관절의 `type()`이 6(Generic)이다.** 그래서 래퍼는 `GenericImpulseJoint`(메서드 없음)가 되고, `SphericalImpulseJoint`(`:212`, 축별 모터 메서드 보유)는 실제로 만들어지지 않는다. `sj.configureMotorModel is not a function` 오류로 확인했다. |
| generic 관절 | `impulse_joint.d.ts:303` `JointData.generic(anchor1, anchor2, axis, axesMask)`. `axesMask`는 **잠글 축**이다. | `LinX\|LinY\|LinZ`로 잠그면 spherical과 결과가 비트 단위까지 같다(2번 표의 generic과 genericJD). |
| 경첩 | `impulse_joint.d.ts:342` `JointData.revolute(a1, a2, axis)`, `:191` `UnitImpulseJoint.setLimits(min,max)`, `:192` `configureMotorModel(model)`, `:195` `configureMotorPosition(targetPos, stiffness, damping)`, `:193` `setMotorMaxForce` | 정상. 목표 50°일 때 48.96°(ForceBased, kp 50) |
| **구형·generic 관절의 축별 제한** | TS 래퍼에는 없다. raw에만 있다: `rapier_wasm3d.d.ts:668` `RawImpulseJointSet.jointSetLimits(handle, axis: RawJointAxis, min, max)`, `:728` `enum RawJointAxis { LinX=0 … AngX=3, AngY=4, AngZ=5 }`. 접근 경로는 `world.impulseJoints.raw`다. | 정상 동작한다. 읽어 오면 같은 값이고, 회전시켜 보면 정확히 멈춘다(±30/±10/±45, −30~60 → 각각 30.0, 10.0, 60.0, −30.0). 각도 좌표는 **2·asin(q_rel.x/y/z)**(w≥0)다. 오일러각도 스윙-트위스트도 아닌 쿼터니언 벡터 성분이다. |
| **구형 관절 모터(축별 위치 목표·stiffness·damping)** | TS: `impulse_joint.d.ts:219,226,243` (`SphericalImpulseJoint`, 위 이유로 쓸 수 없음). raw: `rapier_wasm3d.d.ts:617` `jointConfigureMotorModel(handle, axis, model)`, `:618` `jointConfigureMotorPosition(handle, axis, targetPos, stiffness, damping)`, `:677` `jointSetMotorMaxForce(handle, axis, maxForce)` | raw로는 정상이다. ForceBased에서 목표 (30,0,0)→29.5°, (0,0,60)→59.6°, (30,0,45)→(28.5, −0.6, 44.8), (80,0,0)→79.3°. 목표를 2·asin 좌표로 주면 3축 조합도 맞는다. AccelerationBased도 수렴한다(stiffness·damping 단위가 1/s², 1/s). 같은 축에 제한과 모터를 함께 걸 수 있다(목표 60°, 제한 20° → 20.0°). `setMotorMaxForce`는 **축별 포화**다(maxForce 2 → 2.45 N·m 중력을 못 버티고 처짐). |
| 모터 모델 | `impulse_joint.d.ts:29` `enum MotorModel { AccelerationBased=0, ForceBased=1 }` | 기본값은 AccelerationBased다. SPEC의 kp·kd(N·m/rad) 의미를 그대로 쓰려면 ForceBased를 쓴다. |
| 멀티바디 관절 | `pipeline/world.d.ts:297` `createMultibodyJoint(params, parent1, parent2, wakeUp)`, `dynamics/multibody_joint.d.ts:38,41` `RevoluteMultibodyJoint`/`SphericalMultibodyJoint` | **제한·모터 설정 API가 없다.** `setContactsEnabled`만 있다. raw `RawMultibodyJointSet`(`rapier_wasm3d.d.ts:785~`)에도 `jointLimits*` 읽기만 있다. `JointData.limits`는 `intoRaw()`에서 prismatic일 때만 쓰인다(minified `rapier.mjs` 확인). 멀티바디 revolute에 `limits=[−0.5,0.5]`를 줘도 `jointLimitsEnabled`는 false다. |
| 바디 토크 | `dynamics/rigid_body.d.ts:548` `addTorque(torque, wakeUp)`, `:555` `applyTorqueImpulse`, `:527` `resetTorques` | **`addTorque`는 다음 스텝에도 남는다**(1스텝 ω=2.08, 2스텝 4.17). 매 스텝 `resetTorques` 후 다시 걸어야 한다. |
| 질량·관성 | `geometry/collider.d.ts:924` `ColliderDesc.setMass(mass)`, `:938`/`:344` `setMassProperties(mass, com, principalInertia, frame)`, `rigid_body.d.ts:509` `setAdditionalMassProperties`, `:472` `recomputeMassPropertiesFromColliders()`, `:360` `principalInertia()` | 바디별 질량은 정확하다(합계 75.000). 생성 후 `collider.setMassProperties`는 **다음 스텝에야 반영된다.** 바로 쓰려면 `rb.recomputeMassPropertiesFromColliders()`를 부른다. |
| 월드 관성 텐서 | `rigid_body.d.ts:383` `effectiveAngularInertia(): SdpMatrix3` | 함정이 있다. 반환 객체가 공유 scratch 버퍼를 가리킨다. 다른 getter(`worldCom()` 등)를 부르면 값이 덮어써진다. 받은 즉시 값을 복사하거나 `principalInertia`+`principalInertiaLocalFrame`으로 직접 계산해야 한다. |
| 충돌 그룹 | `geometry/interaction_groups.d.ts` (상위 16비트 멤버십, 하위 16비트 필터), `collider.d.ts:246` `setCollisionGroups`, `:256` `setSolverGroups` | 정상이다(그룹을 나눈 상자가 지면을 통과해 y=−19까지 떨어짐). |
| 인접 바디 충돌 끄기 | `impulse_joint.d.ts:161` / `multibody_joint.d.ts:20` `setContactsEnabled(false)` | 관절 기본값은 `contactsEnabled()=true`라서 직접 꺼야 한다. 쌍 단위 필터가 더 필요하면 `pipeline/physics_hooks.d.ts:25` `filterContactPair`를 쓴다. |
| 접촉 힘 이벤트 | `pipeline/event_queue.d.ts:17` `ActiveEvents.CONTACT_FORCE_EVENTS`, `:97` `drainContactForceEvents`, `:48` `totalForceMagnitude()`, `collider.d.ts:304` `setContactForceEventThreshold` | 2 kg 상자 정지 시 19.62 N(=mg)이다. 접촉점별 충격량은 `geometry/narrow_phase.d.ts:99` `contactImpulse(i)`로 읽는다. |
| 레이캐스트 | `pipeline/world.d.ts:405` `castRay(ray, maxToi, solid, filterFlags?, filterGroups?, excludeCollider?, excludeRigidBody?, predicate?)` | 정상이다. 바디 제외 옵션도 동작한다. |
| 솔버 설정 | `world.d.ts:106` `timestep`, `:141` `numSolverIterations`(기본 4), `:154` `numInternalPgsIterations`(기본 1), `rigid_body.d.ts:166` 바디별 `setAdditionalSolverIterations` | **기본 timestep이 1/60이다.** 반드시 직접 정한다. |

**결론 1**: 필요한 기능은 다 있다. 다만 구형 관절의 축별 제한과 축별 모터는 TS 래퍼로는 쓸 수 없다. `world.impulseJoints.raw.jointSetLimits / jointConfigureMotor* / jointSetMotorMaxForce`(axis 3~5)를 직접 호출해야 한다. 멀티바디 관절은 JS에서 제한과 모터를 설정할 수 없다.

---

## 2. 관절 제한 방식 (6.3의 a/b/c)

시나리오(`scenario.ts`): 1 m 높이에서 시드 기반 임의 자세·각속도로 떨어뜨린다. 이어서 1.5 s Head 60 N·s, 2.5 s LeftHand 6 N·s, 3.0 s RightFoot 10 N·s, 3.5 s Spine2 150 N·s(전신 Δv 2 m/s)로 민다. 5초 동안 근육 없이 시드 3개를 돌렸다. 위반량은 모든 관절의 모든 프레임에서 잰 "제한을 넘은 각도"이고, 좌표는 Rapier와 같은 2·asin이다.

- (a) `generic`: `JointData.spherical` + raw `jointSetLimits`. 경첩은 revolute + `setLimits`
- (a') `genericJD`: `JointData.generic(…, LinX|LinY|LinZ)` + 같은 제한
- (b) `multibody`: 멀티바디 관절. JS에서는 제한을 걸 수 없어서 제한 없이 돌렸다.
- (c) `custom`: 제한 없는 관절 + 제한 밖에서 거는 스프링·댐퍼 토크. 축별 유효 관성 기준, 감쇠는 암시적이다.
- 기준선 `nolimits`

| dt | 반복 | 방식 | 최대 위반° | p99° | p99.9° | 평균° | 5° 초과 비율 | 관절 이탈 최대 mm | 최대 각속도 rad/s | ms/스텝(측정 포함) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1/120 | 4 | nolimits | 166.7 | 147.9 | 156.7 | 39.2 | 69.7% | 22.7 | 89 | 0.156 |
| 1/120 | 4 | **(a) generic** | 81.5 (RightHand) | 16.6 | 58.2 | 0.65 | 3.6% | 22.9 | 106 | 0.082 |
| 1/120 | 4 | (a) + 관성 ×3(1.5 kg 미만) | 108.4 | 55.4 | 98.3 | 1.33 | 4.0% | 27.1 | 70 | 0.078 |
| 1/120 | 4 | (b) multibody | 155.0 | 126.1 | 144.5 | 25.8 | 59.1% | 18.3 | 91 | 0.739 |
| 1/120 | 4 | (c) custom | 102.7 | 40.6 | 72.9 | 3.97 | 22.9% | 36.4 | 108 | 0.109 |
| 1/120 | 8 | **(a) generic** | 52.1 (RightHand) | **3.6** | 20.3 | 0.15 | 0.7% | 21.2 | 103 | 0.115 |
| 1/120 | 8 | (a) + 관성 ×3 | 28.1 | 5.3 | 13.9 | 0.16 | 1.1% | 21.0 | 92 | 0.103 |
| 1/120 | 8 | (b) multibody | 171.2 | 170.6 | 170.6 | 39.8 | 56.3% | 16.9 | 75 | 1.36 |
| 1/120 | 8 | (c) custom | 134.1 | 49.2 | 91.7 | 4.89 | 25.7% | 23.2 | 108 | 0.127 |
| 1/240 | 4 | (a) generic | 40.8 | 6.0 | 30.9 | 0.24 | 1.2% | 11.7 | 152 | 0.071 |
| 1/240 | 8 | (a) generic | 23.2 | 4.0 | 12.5 | 0.11 | 0.8% | 8.4 | 141 | 0.106 |
| 1/240 | 8 | (a) + 관성 ×3 | 19.4 | 3.1 | 12.1 | 0.09 | 0.6% | 10.9 | 97 | 0.098 |
| 1/240 | 8 | (c) custom | 76.1 | 21.3 | 51.7 | 1.67 | 10.5% | 11.9 | 198 | 0.118 |

(`spike/rapier/out/02-limits.json`에 관절별 최대값이 있다. NaN과 폭발은 모든 조합에서 없었다.)

- (a)는 큰 충격이 들어간 순간에만 한계를 넘는다. 착지하거나 손·발을 직접 칠 때 그렇다. 평소 위반은 0에 가깝다(평균 0.15°). 반복을 4에서 8로 올리면 p99가 16.6°에서 3.6°로 줄고, 비용은 약 1.4배다.
- (b)는 JS에서 제한을 설정할 수 없어서 사실상 제한이 없다. 비용도 7~13배 크다. **불가**.
- (c)는 펜알티 토크라서 충돌 순간의 큰 충격량을 막지 못한다. 처음 구현에서는 폭발했다. 원인은 반작용 토크를 받는 부모 바디의 유효 관성을 과대평가한 것이다. 볼 조인트로 이어진 체인에서는 "관절에서 본 유효 관성"이 잘 정의되지 않는다. 가볍고 길쭉한 손·발은 비틀기 관성이 2.6e-4 kg·m²밖에 안 된다. 그래서 안정하게 쓸 수 있는 강성이 작고, 위반량이 (a)의 5~10배다.
- 손·발 같은 가벼운 바디는 근육이 없으면 충격 후 최대 100~150 rad/s로 돈다(제한 방식과 상관없다). 1.5 kg 미만 바디의 관성을 ×3 하면 1/120에서 최대 각속도가 106에서 70으로 줄지만, 위반량은 시드에 따라 오히려 커지기도 한다. 관성 배율은 "도움이 될 수 있는 옵션" 정도다.

**결론 2**: **(a) generic(=spherical) 관절 + raw `jointSetLimits` 축별 제한**을 쓴다. 솔버 반복은 **8**로 올린다(기본 4). 주의할 점이 둘 있다. 첫째, 제한 좌표가 2·asin(쿼터니언 성분)이라서 SPEC의 "스윙 콘 100"은 정확한 원뿔이 아니라 상자 모양이 된다. 두 축이 함께 70°이면 실제 스윙은 약 108°다. 둘째, 굽힘·옆굽힘·비틀기와 X/Y/Z의 대응과 부호가 뼈 방향마다 다르다. v0.1에서는 `setLocalFrame1/2`(raw `jointSetLocalFrame1/2`)로 관절 X축을 뼈 축에 맞추는 편이 낫다.

---

## 3. 근육 구현 비교 (Hips 고정, A포즈 유지)

설정(`03-muscles.ts`)은 다음과 같다.
- Hips는 fixed 바디이고, 나머지 15바디는 (a) 방식 제한을 건다. 지면은 없다. T-포즈에서 시작해 A포즈 목표를 4초 동안 유지한다(팔 ±45° 내림, 팔꿈치 20°, 무릎 12°, 고관절 −8°, 척추 5° 등).
- kp_j = kp 배율 × SPEC v0.2 상대 비율(다리·몸통 1.0, 목·어깨 0.4, 팔꿈치 0.3, 손목·발목 0.2). kd_j = 2·sqrt(kp_j·I_j)이고, I_j는 관절에서 본 자손 서브트리 관성이다(trace/3). 반복은 4다.
- 지터: 마지막 2초 동안 관절 상대 각속도(부모 프레임) 축별 성분의 부호가 바뀐 횟수/초. 앞뒤 샘플이 모두 |ω|>0.1 rad/s일 때만 센다. 관절 하나에 축 3개라 최대 360/s(1/120)다. 진동 판정은 최대 관절 ≥ 5/s 또는 발산(|ω|>200 또는 NaN)이다.
- 자세 오차: 마지막 1초 동안 목표와 실제 상대 회전 사이의 각도 평균. 표에는 "관절 평균 / 최대 관절"을 적었다.
- 중력 보상 τ_gc = (c_sub − p_j) × (−M_sub·g)은 `addTorque`로 자식에 +, 부모에 −로 건다. A, C, 그리고 B+gc에 넣었다.
- 방식
  - **A**: 명시적 토크 PD(SPEC v0.2 식)
  - **B**: Rapier 관절 모터. ForceBased, stiffness=kp, damping=kd. 구형 관절은 raw 축별 모터로, 목표는 2·asin(q_target) 좌표다.
  - **Bacc**: AccelerationBased, kp/I와 kd/I
  - **C**: Stable PD 근사(Tan 2011). τ = (T + dt·kd·E)⁻¹ T (kp(e − dt·ω) − kd·ω). T는 자식 바디와 부모 바디의 COM 관성을 직렬로 묶은 3×3 텐서다.
- kp 스윕: 5 … 51200 (×2 간격, A는 1600까지)

| dt | 방식 | 진동/발산 시작 kp (관절) | 안정 최대 kp | 오차 @kp400 | 오차 @kp1600 | 오차 @안정 최대 | ms/스텝(제어+스텝) |
|---|---|---|---|---|---|---|---|
| 1/120 | A (SPEC kd) | ≤5 발산 | 없음 | 발산 | 발산 | — | — |
| 1/120 | A+gc (SPEC kd) | 5 (LeftArm 지터) → 10 발산 | 없음 | 발산 | 발산 | — | — |
| 1/120 | A+gc, kd를 국소 관성으로 | 10 (LeftArm) → 100 발산 | 5 | 발산 | 발산 | 2.09/8.34° | 0.049 |
| 1/120 | B (gc 없음) | 5~50 저강성 흔들림, **100 이상 진동 없음** | 51200 | 1.35/4.51° | 0.46/1.73° | 0.09° | 0.034 |
| 1/120 | **B+gc** | **없음 (51200까지)** | 51200 | **0.42/1.45°** | 0.24/0.83° | 0.07/0.20° | 0.041 |
| 1/120 | Bacc+gc | 없음 | 51200 | 1.44/7.96° | 0.85/4.59° | 0.06/0.17° | 0.041 |
| 1/120 | C+gc | 1600 (Spine 지터) → 3200 발산 | 800 | 0.10/0.38° | 7.6/29.9°(진동) | 0.10/0.48° | 0.056 |
| 1/240 | A+gc (SPEC kd) | ≤5 발산 | 없음 | 발산 | 발산 | — | — |
| 1/240 | A+gc, 국소 kd | 50 발산 | 25 | 발산 | 발산 | 0.75/3.22° | 0.042 |
| 1/240 | B (gc 없음) | 5~50 저강성 흔들림, 100 이상 없음 | 51200 | 0.94/3.20° | 0.29/1.10° | 0.04° | 0.033 |
| 1/240 | **B+gc** | **없음** | 51200 | 0.17/0.62° | 0.10/0.37° | 0.03/0.09° | 0.041 |
| 1/240 | Bacc+gc | 없음 | 51200 | 1.45/8.35° | 0.82/4.64° | 0.02/0.06° | 0.041 |
| 1/240 | C+gc | 6400 발산 | 3200 | 0.02/0.09° | 0.01/0.06° | 0.01/0.06° | 0.055 |

ms/스텝은 1스텝(1/240은 반 스텝 분량)의 비용이다. 시뮬레이션 1초당 비용은 1/240이 2배다.

**관성 배율(1.5 kg 미만 바디 ×3) 효과**
- A+gc 국소 kd: 안정 상한이 1/120에서 5→25, 1/240에서 25→100으로 올라간다.
- A+gc SPEC kd, 1/240: 발산하던 것이 kp 10까지 안정해진다.
- C+gc 1/120, kp1600: 오차 7.6/29.9°가 3.0/8.3°로 줄지만 여전히 진동한다. 상한(800)은 그대로다.
- B: 변화 없다.
- 결론: 관성 배율은 명시적 방식의 kp 상한을 2~5배 올리지만, 명시적 방식을 쓸 만하게 만들지는 못한다.

**질량비 문제(손 0.45 kg 대 Hips 8.4 kg)에 대해**: 문제는 질량비 자체보다 **손·발의 비틀기축 관성**이다. 손 캡슐의 긴 축 관성은 2.6e-4 kg·m²로, Hips보다 약 200배 작다. 명시적 PD가 안정하려면 대략 kd·dt/I < 2이고 kp·dt²/I < 1이어야 한다. 1/120에서 손 비틀기는 kd < 0.06, kp < 3.7 N·m/rad밖에 안 된다. 그런데 kd = 2·sqrt(kp·I_서브트리)는 등방성 스칼라라서 이 축에서 금방 한계를 넘는다. 손 하나만 매단 실험에서도 kp_hand 20은 안정, 80은 발산이었다. 체인 안에서는 관절점 자체가 움직인다. 그래서 유효 관성이 "관절 기준 관성"보다 COM 관성 쪽으로 더 작아진다. 손 하나만 켰을 때 손-전완 Y축 역위상 진동이 생기는 것을 확인했다. B(Rapier 모터)는 솔버 안에서 암시적인 제약으로 풀리므로 이 문제가 없다.

**동적 확인**(전신이 움직이는 상태, 2번 시나리오에 근육을 켬, 반복 8, 시드 3개, `out/03b-dynamic.txt`)

| 방식 | dt | kp | 최대 위반° | 최대 각속도 |
|---|---|---|---|---|
| B+gc | 1/120 | 300 / 1000 / 3000 | 21.5 / 4.4 / 2.3 | 57 / 73 / 50 |
| C+gc | 1/120 | 300 / 1000 / 3000 | 35.0 / 22.9 / 12.7 | 85 / 105 / 122 |
| B+gc | 1/240 | 300 / 1000 / 3000 | 16.5 / 0.9 / 0.0 | 67 / 65 / 60 |
| C+gc | 1/240 | 300 / 1000 / 3000 | 13.1 / 4.2 / 8.7 | 107 / 105 / 221 |

**결론 3**: 근육 기본 구현은 **B: Rapier 관절 모터**(ForceBased, raw 축별 모터) **+ 중력 보상 토크(addTorque)**로 한다. 타임스텝은 **1/120을 유지**하고 솔버 반복은 8로 한다.
- B+gc는 kp 5~51200 전 구간에서 진동이 없다. kp 400에서 오차가 평균 0.42°/최대 1.45°이고, 비용이 가장 낮다.
- C는 1/120에서 kp ≤ 800까지만 안정하다. 정확도는 좋다. 토크가 명시적이라 로그로 정확히 남길 수 있다는 장점이 있어 대안으로 남긴다.
- A는 SPEC kd 식으로는 모든 kp에서 발산한다. 버린다.
- 1/240은 C의 상한을 4배 올리고 B 오차를 절반으로 줄인다. 그래도 B를 쓰면 필요 없다. 같은 1초를 시뮬레이션하는 비용은 2배다.

B로 SPEC v0.2 PD 의미를 표현하는 방법:
- kp → stiffness, kd → damping(ForceBased)
- strength → kp·kd·maxForce에 곱한 뒤 매 스텝 `jointConfigureMotorPosition`을 다시 호출
- maxTorque → 축별 `jointSetMotorMaxForce`. **벡터 크기 클램프가 아니라 축별 상자 클램프다.**
- 목표 회전 → 2·asin(q_target 성분)
- 경첩은 `RevoluteImpulseJoint`의 TS 메서드를 그대로 쓴다.

---

## 4. 결정론

`det.ts`: 2번 시나리오(시드 7, 1/120, 반복 8, 600프레임). 매 프레임 16바디 × (위치3, 회전4, 선속도3, 각속도3)를 기록한다. 비교는 (1) Float64 원시 바이트의 FNV-1a 해시, (2) 소수 4자리 문자열 해시로 프레임마다 했다. 설정은 근육 없음, B+gc(kp 300), C+gc(kp 300) 세 가지다.

| 비교 | passive | B+gc | C+gc |
|---|---|---|---|
| Node 같은 프로세스 2회 | 원시·반올림 모두 600/600 프레임 동일 | 동일 | 동일 |
| Node 별도 프로세스 2회 | 동일 (raw 865128267 / round 3515750222) | 동일 (3580047830 / 1517264424) | 동일 (2896990966 / 3373727339) |
| Node ↔ Chromium (Vite + Playwright) | **원시 바이트까지 동일**, 첫 차이 프레임 없음, 최종 상태 최대 차이 0 | 동일 | 동일 |

**결론 4**: Node 사이, 그리고 Node와 Chromium 사이 모두 비트 단위로 같다. JS 쪽 제어 코드(Math.sin/atan2/asin/sqrt를 쓰는 C 포함)도 같은 V8이라 같다.
- SPEC 17장의 "다르면 Node 기준" 규칙은 지금은 쓸 일이 없다. 그대로 둬도 된다.
- 확인하지 않은 것: Firefox/Safari(다른 JS 엔진, wasm은 같음), 바디·관절을 지우고 다시 만드는 경우(핸들 순서가 바뀜), 스냅샷 복원 후 이어 돌리기.
- 결정론은 생성 순서와 업데이트 순서가 같다는 전제 위에 있다.

---

## 5. 성능 (Node, 이 PC, 지면 위 캐릭터, 2초에 한 번 밀기, 5초 평균, 3회 중앙값)

| dt | 반복 | 근육 | 1명 Rapier ms | 1명 합계 ms | 8명 Rapier ms | 8명 합계 ms | 8명 시뮬 1초당 ms |
|---|---|---|---|---|---|---|---|
| 1/120 | 4 | passive | 0.072 | 0.073 | 0.409 | 0.409 | 49 |
| 1/120 | 4 | B+gc | 0.048 | 0.061 | 0.335 | 0.413 | 50 |
| 1/120 | 4 | C+gc | 0.042 | 0.076 | 0.306 | 0.548 | 66 |
| 1/120 | **8** | **B+gc** | **0.078** | **0.088** | **0.558** | **0.635** | **76** |
| 1/120 | 8 | C+gc | 0.064 | 0.097 | 0.479 | 0.722 | 87 |
| 1/240 | 8 | B+gc | 0.082 | 0.092 | 0.585 | 0.664 | 159 |
| 1/240 | 8 | C+gc | 0.070 | 0.104 | 0.526 | 0.793 | 190 |

(`out/05-perf.json`에 전체 조합이 있다. B는 목표가 고정이라 모터 재설정 비용이 빠져 있다. 매 스텝 재설정하면 관절 15개 × raw 호출 몇 번이 더 든다.)

**결론 5**: 추천 설정(1/120, 반복 8, B+gc)에서 1명은 0.088 ms/스텝이다. SPEC 15장 예산(1명 전 계층 ≤ 0.5 ms)의 약 18%다. 8명은 0.64 ms/스텝, 실시간 1초당 76 ms라서 60fps(2스텝/프레임 ≈ 1.3 ms/프레임)에 충분히 들어간다. 다만 브라우저 성능은 재지 않았다. 균형·스텝·인지 계층이 이 위에 더해진다.

---

## SPEC 가정과 다른 점 (사람 확인 필요)

1. **"구형 관절 모터(축별 위치 목표·stiffness·damping)"는 엔진에는 있지만 TS 래퍼로는 쓸 수 없다.** `JointData.spherical()`이 Generic 타입 관절을 만들어서 `SphericalImpulseJoint` 메서드가 붙지 않는다. raw API(`world.impulseJoints.raw.jointConfigureMotor*`, axis 3~5)로 우회하면 제대로 동작한다. 구형 관절의 축별 제한도 raw `jointSetLimits`로만 걸 수 있다.
   - 영향: 6.3(관절 제한 구현), v0.2(근육 B 구현), 2장 "API를 추측하지 않는다"(raw 계층을 감싸는 얇은 래퍼를 `src/sim/world.ts` 쪽에 두고 테스트로 고정하는 것을 권장), v1.0 `docs/PORTING.md` 대응표.
2. **멀티바디 관절은 JS에서 제한과 모터를 설정할 수 없다** → 6.3 후보 (b)는 탈락이다. 영향: 6.3.
3. **관절 제한 좌표는 쿼터니언 성분(2·asin q_i)이다.** 6.3의 "스윙 콘 100"은 축별 상자로만 근사되고, 두 축을 함께 굽히면 실제 스윙 각이 더 커진다. 영향: 6.3 표, 6.4 `limitsDeg` 의미(축 이름과 좌표 정의를 명시해야 함).
4. **근육 B(모터)를 기본으로 하면 v0.2의 "maxTorque 크기 클램프"와 "관절별 토크·포화 로그"를 그대로 할 수 없다.** 모터 출력은 축별로 포화되고, 모터가 실제로 낸 토크를 읽는 API가 없다(관절 충격량 getter가 없음). 로그에는 kp·e − kd·ω 추정 토크와 축별 포화 추정치를 남기고, 실제 토크가 아니라고 표시해야 한다. 영향: v0.2 원리·로그·시각화, 3장 원칙 4(관측 가능성). C(Stable PD 근사)를 고르면 이 문제는 없지만 1/120에서 kp ≤ 800으로 제한된다.
5. **v0.2의 "kd는 2·sqrt(kp·I) 근처"는 명시적 토크(A)에서는 kp 5에서도 발산한다.** 가벼운 손·발의 비틀기축 관성 때문이다. 모터(B)에서는 문제가 없다. 영향: v0.2(근육 설정), 6.1(관성 배율의 역할: 명시적 방식의 kp 상한을 2~5배 올리는 정도이고 결정적 해결책은 아님).
6. **타임스텝은 1/120 그대로 두지만, 솔버 반복을 기본 4에서 8로 올려야 한다**(제한 위반 p99 16.6°→3.6°). 1/240은 필요 없다. 영향: 4장(기본 timestep 1/60 함정 포함), README 결정 기록.
7. 사소한 것: 6.1 질량표의 kg 열은 반올림값이다. 비율 × 75로 계산하면 손 0.45 kg, Spine 12.225 kg이고, 표의 kg 합은 74.8이다. 비율 합은 1.000이다. 코드는 비율을 기준으로 하면 된다.

## 함정 메모 (v0.1 이후 구현 시)

- `world.timestep` 기본값은 1/60이다. 매번 직접 설정한다.
- `addTorque`는 다음 스텝에도 남는다 → 7.1의 7단계 앞에서 `resetTorques`를 부른다.
- 관절 기본값은 `contactsEnabled=true`다 → 인접 바디는 `setContactsEnabled(false)`로 끈다.
- 질량 속성 변경은 다음 스텝에 반영된다 → `recomputeMassPropertiesFromColliders()`를 부른다.
- `effectiveAngularInertia()` 같은 `SdpMatrix3` 반환값은 공유 버퍼를 가리킨다 → 받은 즉시 복사한다.
- 모터 기본 모델은 AccelerationBased다 → SPEC의 kp·kd를 쓰려면 ForceBased로 바꾼다.
- 충격 후 손·발이 100 rad/s 넘게 도는 현상은 제한 방식과 상관없이 생긴다. 근육을 켜면(B+gc, kp ≥ 1000) 50~70 rad/s로 줄어든다. 필름스트립에서 손이 팽이처럼 도는 장면이 보이면 이 원인부터 의심한다.

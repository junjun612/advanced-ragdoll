# 공개 API (v0.9 확정)

웹 액티브 랙돌 시뮬레이션(`src/sim/`)을 게임·데모·도구에서 쓰는 방법이다. 명세는 [SPEC.md](../SPEC.md) 7장, 결정은 README 결정 기록 9a-1~9a-6에 있다.

- 들어오는 곳은 `src/sim/api.ts` 하나다. 앱·도구가 쓰는 타입도 여기서 다시 내보낸다.
- `src/sim/`은 three.js·DOM·window를 모른다. Node와 브라우저에서 같은 코드가 돈다.
- 결정론: 같은 시드·같은 입력·같은 호출 순서면 로그가 바이트 단위로 같다. 무작위성은 시드 PRNG(`prng.ts`) 하나에서만 나온다.

## 1. 빠른 시작

```ts
import { World, type CharacterDef, type RagdollConfig } from './src/sim/api';
import xbot from './config/characters/xbot.json';
import ragdoll from './config/ragdoll.json';

const world = await World.create({ seed: 1 });                       // 평지, dt = 1/120 s
const ch = world.addCharacter(xbot as CharacterDef, ragdoll as RagdollConfig,
  { position: [0, 0, 0], yaw: 0, state: 'Active', pose: 'stand' });

ch.on('fell', (e) => console.log('넘어짐', e.t));
ch.on('gotUp', (e) => console.log('일어섬', e.t));

// 게임 루프: 렌더 프레임 시간을 누적해 고정 스텝을 필요한 만큼 돈다
function frame(realDt: number) {
  world.advance(realDt);                 // = 누적 시간만큼 world.step()
  const s = ch.getState();               // 렌더·지표는 getState()만 읽는다
  draw(s.bodies);
}

// 1초 뒤 가슴을 앞에서 중간 세기로 민다 (Δv 0.8 m/s, 아래 4장)
ch.hit({ type: 'push', body: 'Spine2', direction: [0, 0, -1], magnitude: 'medium' });
```

애니메이션으로 걷다가 맞기:

```ts
// 애니 클립 이름으로 스폰하면 그 클립을 키네마틱(Animated)으로 재생하며 시작한다
const ch = world.addCharacter(def, cfg, { position: [0, 0, 0], yaw: 0, state: 'Animated', pose: 'kimodo_walk_forward' });
for (let i = 0; i < 36; i++) world.step();
ch.setState('Active');                                               // 0.3초 뒤 물리로: 전신 QP가 클립을 따라 걷는다 (v0.6)
ch.hit({ type: 'bullet', body: 'Spine', point: [0.05, 1.2, 0.1], direction: [0, 0, -1], magnitude: 0.35 });
```

## 2. World

| 멤버 | 설명 |
|---|---|
| `static create(opts: { seed: number; dt?: number; terrain?: TerrainName; gravity?: Vec3 }): Promise<World>` | Rapier 초기화 + 월드. `terrain`은 `config/sim.json terrain`의 이름: `flat`(기본)·`slope10`·`slope20`·`stairs`·`ledge`·`rail`·`wall`·`box_obstacle`. `dt` 기본 1/120 s(`config/sim.json stepHz`), `gravity`는 시험용 |
| `addCharacter(def: CharacterDef, cfg: RagdollConfig, spawn: SpawnOpts, opts?: CharacterOpts): Character` | 캐릭터 추가 (최대 `config/interaction.json` collisionBits.maxCharacters). 여러 명이면 `opts.name`이 필요하다 (이벤트·로그 이름) |
| `addProp(def: PropDef): Prop` | 상자·공·캡슐 물체를 지금 시각에 만든다. `grabbable: true`면 잡을 곳 후보 |
| `step(): void` | 고정 스텝 하나 (SPEC 7.1 순서) |
| `advance(realDt: number): number` | 실시간 누적 → 필요한 만큼 `step()`. 돈 스텝 수 |
| `time`, `dt` | 시뮬레이션 시각(스텝 수 × dt, 누적 오차 없음)·스텝 길이 (s) |
| `characters`, `props`, `character(name)` | 캐릭터·프롭 목록, 이름으로 찾기 |
| `events: SimEvent[]` | 모든 캐릭터의 시뮬레이션 이벤트 기록 (`meta.json events`와 같다) |
| `save(): WorldSnapshot` | 상태 저장 (6장) |
| `static load(s: WorldSnapshot): Promise<World>` | 상태 복원 (6장) |
| `free(): void` | wasm 메모리 해제. 다 쓴 월드는 반드시 부른다 |

`SpawnOpts`: `position`, `yaw`(라디안, +Z 정면에서 Y축 둘레), `state?`(`'Animated' | 'Active' | 'Ragdoll'`, 기본 Ragdoll), `pose?`(포즈 이름 또는 애니 클립 이름으로 선 자세 스폰), `bodies?`(쓰러진 자세 스폰), `levelFeet?`, `pin?`(시험 장치).

`CharacterOpts`(모두 선택): `name`, 근육·균형·스텝·행동·피격·애니·겟업·반응 설정 덮어쓰기(`muscles`, `balanceConfig`, …, 튜닝·스윕용), 처음부터 켜고 끄기(`rootAssist`, `balance`, `stepping`, `getup`).

## 3. Character

### 외부 자극
| 메서드 | 설명 |
|---|---|
| `hit(h: HitInfo)` | 피격. 다음 스텝 시작에 피격 모델(`config/hitModel.json`)이 충격량을 나눠 가하고 상처·행동을 정한다 |
| `applyImpulse(body, impulse: Vec3, worldPoint?)` | 원시 충격량 (N·s). 행동 반응 없이 물리만 |

### 제어
| 메서드 | 설명 |
|---|---|
| `setState(s: 'Animated' \| 'Active' \| 'Ragdoll')` | 파워드 랙돌 상태. Animated ↔ Active는 속도를 넘겨 튐 없이 블렌드한다. `GettingUp`은 겟업 컨트롤러만 쓴다 |
| `playClip(clip, opts?: { blendIn?: number; startTime?: number })` | 애니 클립(Kimodo, 관성화로 이어 붙임) 또는 포즈 클립. 루프 여부는 클립 파일을 따른다 |
| `trigger(behavior, params?)` | 행동 켜기: `Kneel`, `Limp`, `Stagger`, `HoldWound`, `InjuredLeg`, `BraceForFall`, `ProtectHead`, `CatchFall`, `Writhe`, `Grab`, … (`config/behaviors.json`), 셋업용 `LiftFoot` |
| `setMuscleScale(region, scale, recoverTime?)` | 영역(`config/muscles.json regions`: `all`, `upperBody`, `leftArm`, …) 또는 관절 이름의 근육 강도 배율 0~1. `recoverTime`초에 걸쳐 1로 돌아온다 |
| `lookAt(target: Vec3 \| null)` | 시선 대상 (null = 끔) |
| `setAssist({ root? })`, `getAssist()` | 루트 보조 켜기·끄기·읽기 (5장) |
| `setBalance(on)`, `setStepping(on)`, `setGetup(on)` | 균형·스텝·일어서기 계층 켜기·끄기 (게임이 일어서기를 막을 수 있다) |
| `setMuscleScales({ 영역·관절: 배율 })` | 여러 강도를 한 번에 (튜닝 UI 슬라이더, 이벤트 하나) |
| `setMuscleConfig(cfg)`, `muscleGains()`, `muscleJoints()` | 근육 이득 런타임 교체 (튜닝 UI), 관절별 kp·kd·최대 토크, 근육 관절 이름 |
| `setAnimOverride(weight)`, `getAnimOverride()` | **애니 강제 비율(핀)** 0~1 (README 결정 app-2, 시연·실험용). PuppetMaster 핀 가중치처럼 바디를 애니 레퍼런스(클립 기준 자세, 클립이 없으면 서기 포즈를 지금 엉덩이 위치·방향에 세운 자세) 쪽으로 핀 보조 힘(`config/animDriver.json pin` 식·상한, `animOverride.mode` 기본 full)으로 끈다. 피격 반응·비틀거림·넘어짐 중에도 건다 — 기본 핀의 '피격 중 0' 규칙 밖의 명시적 보조. 기본 0이면 아무것도 하지 않는다(로그 그대로). 시나리오 이벤트로는 쓸 수 없다. 사용량 `getState().assist.animOverride` (N), 바디별 세기 `getState().animOverride` (한 번이라도 켠 캐릭터만) |

### 조회
| 멤버 | 설명 |
|---|---|
| `getState(): CharacterState` | 스텝마다 한 번 계산하는 상태 스냅샷 (SPEC 7.3): 바디 자세·속도, COM, 접촉, 지지 다각형, 캡처 포인트, 자세(`standing`/`kneeling`/`down`/`airborne`), 관절 오차·토크, 행동, 보조 사용량, 균형·스텝·애니·겟업 로그 |
| `reference(): ReferenceFrame \| null` | 이번 스텝 레퍼런스 (7장) |
| `name`, `totalMass()` | 이름(여러 명일 때), 총질량 (kg) |
| `on(ev, cb)`, `off(ev, cb)` | 이벤트 듣기·그만 듣기 (아래) |

`World.physics`, `Character.rd`·`muscles`·`balance`·… 같은 내부 필드는 `@internal`이다. 도구·시험이 읽을 수 있게 열려 있지만 바뀔 수 있고, Rapier 객체를 sim 밖에 내보내지 않는다는 원칙(SPEC 7.3) 때문에 앱은 쓰지 않는다.

## 4. 이벤트

`ch.on(이름, (e: SimEvent) => …)`. `e.t`는 시각(s), `e.detail`은 사람이 읽는 설명, 여러 명이면 `e.char`가 캐릭터 이름이다.

**SPEC 7.2 이벤트**
| 이름 | 언제 | 필드 |
|---|---|---|
| `fell` | 자세가 `down`이 됨 (8.2 넘어짐 정의: 발·정강이 밖 바디가 지면에 닿거나 COM이 낮음). 다시 `standing`이 될 때까지 한 번 | `detail` = 닿은 바디 |
| `gotUp` | 일어서기 성공 (`getupDone`과 같은 순간) | `detail` = 클립·걸린 시간 |
| `step` | 반응 스텝 착지 | `body`(발), `error`(착지 오차 m) |
| `grabbed` | 손이 잡을 곳을 잡음 (난간·모서리·grabbable 프롭) | `body`(손), `point`(잡은 점), `detail` = 종류 |
| `released` | 잡은 손을 놓음 (힘이 손아귀를 넘음·미끄러짐·버텨 냄·행동 끝) | `body`(손) |
| `exploded` | 안전 검사 실패(속도 폭주·NaN) → 그 캐릭터를 Ragdoll로 | `detail` |

`fell`·`gotUp`·`grabbed`·`released`는 알림 전용이라 `world.events`(로그)에 남지 않는다 — 이전 로그와 바이트 동일을 지키려는 것이다(결정 9a-4). 듣는 사람이 없으면 계산도 하지 않는다.

**그 밖의 이벤트** (`world.events`에도 남는다): `hit`, `hitReacted`(반응 강도 `strength` 0~1, 사운드 연동), `stepStart`, `stagger`, `footReplace`, `voidStep`, `behaviorStart`/`behaviorStop`, `trigger`, `setState`, `setMuscleScale`, `setAssist`, `setBalance`, `setGetup`, `lookAt`, `walkHandover`/`walkResume`, `reactionStart`/`reactionEnd`, `getupReady`/`getupStart`/`getupBalance`/`getupDone`/`getupFail`/`getupCancel`/`getupGiveUp`, `propSpawn`.

## 5. 좌표계·단위·hitScale·보조 힘

- 오른손 좌표계, **Y 위**, 캐릭터 정면 **+Z**, 왼쪽 **+X**. 미터·킬로그램·초·라디안 (JSON 설정의 각도만 도).
- 물리 스텝 1/120 s 고정. 렌더 프레임과 무관하게 `advance()`로 누적한다. 중력 (0, −9.81, 0).
- 사원수는 `[x, y, z, w]`. 바디 이름은 Mixamo 본 이름(`Hips`, `Spine`, `Spine2`, `Head`, `LeftArm`, `LeftForeArm`, `LeftHand`, `LeftUpLeg`, `LeftLeg`, `LeftFoot`, …).

**충격 크기 (hitScale).** `HitInfo.magnitude`는 이 충격이 **전신 COM에 주는 속도 변화 Δv (m/s)** 다. 실제 충격량은 `J = 총질량 × Δv × direction`이고 지정 바디·지점에 가한다(melee는 이웃 바디에 나눈다). 체형이 달라도 같은 이름은 같은 반응 세기다. 이름은 `config/hitScale.json`의 고정값이다.

| 이름 | Δv (m/s) | 대략 |
|---|---|---|
| `small` | 0.3 | 제자리에서 버팀 또는 한 걸음 |
| `medium` | 0.8 | 몇 걸음 밀려남 |
| `large` | 1.5 | 대개 넘어짐 |

- `type`: `push`(밀기, `duration`초에 나눠 가할 수 있다), `bullet`(관통 방향 한 점, `magnitude` 없으면 `hitModel.json` 기본값), `melee`, `explosion`(`point` = 폭발 중심 필수, magnitude = 1 m 거리의 Δv, 거리에 반비례).
- 경계값은 바꾸지 않는다(사람 승인 사항, SPEC 7.2).

**보조 힘 (명시적, SPEC 3 원칙 6).** 허공에서 몸통을 잡아 주는 힘은 쓰지 않는다. 예외는 설정으로 켜고 끄며 사용량을 `getState().assist`에 남기는 세 가지뿐이다.

| 보조 | 하는 일 | 허용 범위 | 사용량 |
|---|---|---|---|
| 루트 (`assist.root`) | Hips를 세우는 가상 토크 + 높이 스프링 (v0.2 검증용) | 기본 꺼짐. 힘 ≤ 체중의 30%, 토크 ≤ 300 N·m (`config/assist.json`) | `\|F\| + \|τ\|/1 m` (N) |
| 핀 (`assist.pin`) | 애니 자세로 바디를 당기는 PD (PuppetMaster식) | 애니 추종(Animated↔Active 전환 블렌드 포함) 중에만, **피격 반응 중 0** (`config/animDriver.json pin`) | 힘 크기 (N) |
| 겟업 (`assist.getup`) | 일어서는 동안 Hips 높이·자세 보조 | 겟업 클립 진행에 맞춰 켰다가 끝에서 끔 (`config/getup.json assist`) | 힘 + 토크 (N) |
| 애니 강제 (`assist.animOverride`) | 애니 레퍼런스로 바디를 끄는 핀 (`setAnimOverride`, 시연·실험용, 결정 app-2) | 기본 0(꺼짐). 사람이 켤 때만, 피격 중에도. 핀과 같은 바디당 상한(가속도 maxAccel·maxAngAccel × 비율). 시나리오에서 못 씀 | 힘 + 토크/1 m (N) |

시나리오 `expect`의 `assistUsage.root/pin/getup`으로 상한을 건다.

## 6. 직렬화 (상태 저장·복원)

```ts
const snap = world.save();                    // WorldSnapshot — JSON.stringify 가능 (보통 0.5 MB 안팎)
localStorage.setItem('save', JSON.stringify(snap));

const restored = await World.load(JSON.parse(localStorage.getItem('save')!));
const ch = restored.characters[0]!;
ch.on('fell', onFell);                        // 리스너는 저장되지 않는다 → 다시 등록
restored.step();                              // 원래 월드를 이어 돌린 것과 바이트 단위로 같다
```

- **무엇이 들어가나**: Rapier 물리 전체(`World.takeSnapshot()`: 강체·콜라이더·관절·접촉 캐시·섬), 모든 캐릭터·프롭의 JS 상태 — 상태 머신, 행동 목록과 진행, 상처, 균형·스텝 계획, 클립 재생(앵커·관성화), 반응 클립 추종, 겟업 시도, 근육 강도·피로, 접촉 감지 창, 시드 PRNG 상태, 이벤트 기록. 실행 중 생긴 강체(잡기 관절의 앵커)·프롭도 들어간다.
- **안 들어가는 것**: `on()` 리스너(복원 뒤 다시 등록), 캐릭터끼리 접촉 거르기 훅(복원 때 다시 만든다). 클립 라이브러리·`config/*.json` 같은 정적 데이터는 번호만 저장한다 → **같은 빌드에서만 복원**된다. 다르면 `World.load`가 지문 불일치로 거부한다. 반응 클립 라이브러리·클립 캐시 같은 파생 데이터는 만든 인자만 저장하고 복원 때 다시 계산한다(같은 계산 → 같은 비트).
- **보장**: `save()`는 읽기만 한다(저장해도 원래 실행이 바뀌지 않는다). 복원한 월드를 이어 돌리면 끊지 않고 돌린 실행과 로그·요약·메타가 바이트 단위로 같다 — `tests/snapshot.test.ts`·`snapshotScenes.test.ts`가 11개 시나리오(스텝·행동·무릎·폭발·걷기·겟업·계단·잡기·벽·프롭·두 캐릭터)의 중간 24곳에서 확인한다.
- **캐릭터 하나만** 저장하는 API는 없다. 캐릭터는 월드의 물리와 묶여 있어 월드 단위로 저장한다.
- 형식: `{ format, version, time, steps, statics, physics(base64), root, objects[] }`. 객체 표는 공유·순환 참조를 그대로 보존하고 −0·NaN·∞도 정확히 되살린다. 형식을 바꾸면 `SNAPSHOT_VERSION`을 올린다.
- 저장 비용: 저장 0.2초 안팎(처음 한 번은 정적 데이터 지문 계산 +0.4초), 복원 0.03~1.3초(반응 클립 라이브러리를 썼으면 다시 계산).
- 시나리오 러너: `runScenario(inp, { checkpointAt: [스텝…], onCheckpoint, listen })`가 실행 중 체크포인트(`RunCheckpoint` = World 스냅샷 + 로거·요약 상태)를 만들고, `resumeScenario(inp, cp)`가 거기서 이어 돈다 (퍼징·튜닝에서 한 상태를 여러 갈래로 돌릴 때).

## 7. 레퍼런스 ↔ 추종기 경계 (D안 대비)

한 스텝은 둘로 나뉜다 (README 결정 164, `src/sim/tracker.ts`).

```
레퍼런스 생성: 애니·포즈 클립 → 반응 클립 상체 스타일 → 행동 계층 편집  ──▶ ReferenceFrame
추종기:        ReferenceFrame + 몸 상태 → 균형·스텝(전신 QP) → 근육 PD  ──▶ 관절 토크
```

- `ReferenceFrame` = `{ t, joints(관절 목표), tracking(관절별 추종 세기·힌트, TrackingRef), clip(전신 추종 클립·시각), behavior(켜진 행동·강도 배율·균형 모드·손 과제) }`. `ch.reference()`로 매 스텝 읽는다 — 학습형 추종기용 (레퍼런스, 상태) 데이터를 모을 수 있다.
- `Tracker` 인터페이스 = `track(ref, state, dt) → TrackerCommand { targets, cmd }`. 지금 구현은 `wholeBodyQP` 하나(`CURRENT_TRACKER`)이고 내부에서 직접 부른다. 1.0 뒤 학습 정책(DReCon·SuperTrack류)으로 바꿀 때 이 자리를 갈아 끼운다. 레퍼런스 쪽(클립·행동)은 그대로 쓴다.
- 남은 예외: HoldWound·Grab·BraceAgainstWall의 손은 관절 목표가 아니라 QP 손 과제(`behavior.hands`)로 따른다. 학습 추종기는 손 목표를 조건으로 받거나 레퍼런스 쪽 IK로 관절 목표에 녹여야 한다.

## 8. 앱이 쓰는 것

`src/app/`은 `src/sim/api.ts`만 import한다 (타입 포함). 렌더(`src/render/`)는 `getState()` 결과 타입과 수학 타입만 읽는다.

- 시나리오 재생은 러너와 같은 공용 함수 `src/sim/scenarioPlayer.ts`(`scenarioCast`·`addCastMember`·`applyScenarioEvent`·`ScenarioPlayback`)를 쓴다 (README 결정 app-1). 묶음 시나리오는 `src/sim/getupScenarios.ts randomFallScenario`로 첫 시드를 재생한다. 그래서 앱에서 시나리오를 처음부터 재생하면 같은 프레임의 상태가 `npm run sim` 로그와 바이트 단위로 같다 (`tests/app.test.ts`, `npm run app:check`).
- 대화형 입력: `hit`(밀기·총탄·근접·폭발), `World.addProp`(던지기), `World.addCharacter`(캐릭터 추가), `playClip`(걷기 시작·정지), `lookAt`, `setState`, `setAnimOverride`.

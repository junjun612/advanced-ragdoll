// v0.9 직렬화 이어 돌리기 검사 2/2 (snapshot.test.ts와 병렬로 돈다). 덮는 기능: 일어서기(v0.7), 계단(v0.8a),
// 잡기 관절·벽 짚기(v0.8b, 실행 중 생기는 Rapier 강체·관절), 프롭·두 캐릭터(v0.8c, 접촉 거르기 훅).
import { describe } from 'vitest';
import { resumeCase } from './snapshotCases';

describe('serialization (v0.9) — scenarios 2/2', () => {
  resumeCase('getup_supine', [0.1, 0.35, 0.6]);
  resumeCase('stairs_tumble', [0.2, 0.5]);
  resumeCase('rail_grab', [0.25, 0.5]);
  resumeCase('wall_lean', [0.25, 0.5]);
  resumeCase('prop_hit', [0.3, 0.55]);
  resumeCase('two_characters_collide', [0.2, 0.4]);
});

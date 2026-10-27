// 생성 결과 + 수동 보정(overrides) 병합. 객체는 재귀 병합, 배열·원시값은 통째로 교체한다.
// overrides.bodies는 배열이 아니라 { 바디 이름: 부분 BodyDef } 객체다 (이름으로 찾아 병합).
import type { BodyDef, CharacterDef } from '../../src/sim/character/characterDef';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : structuredClone(patch)) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k.startsWith('$')) continue; // "$comment" 등 메타 필드는 무시
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out as T;
}

export interface CharacterOverrides {
  bodies?: Record<string, Partial<Record<keyof BodyDef, Json>>>;
  [k: string]: unknown;
}

export function applyOverrides(def: CharacterDef, ov: CharacterOverrides, overridesPath: string | null): CharacterDef {
  const { bodies: bodyPatch = {}, ...rest } = ov;
  const names = new Set(def.bodies.map((b) => b.name as string));
  for (const n of Object.keys(bodyPatch)) if (!names.has(n)) throw new Error(`overrides: unknown body "${n}"`);
  const merged = deepMerge(def, rest);
  merged.bodies = def.bodies.map((b) => (bodyPatch[b.name] ? deepMerge(b, bodyPatch[b.name]) : b));
  merged.generator = { ...merged.generator, overrides: overridesPath };
  return merged;
}

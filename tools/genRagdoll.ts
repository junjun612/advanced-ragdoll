// X Bot 스켈레톤 → config/characters/<id>.json (SPEC 6.4, 12장 v0.1).
// 사용법: npx tsx tools/genRagdoll.ts "assets/fbx/X Bot.fbx"
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFbxSkeleton } from './fbx/loadFbx';
import { buildCharacter, type GenConfig } from './ragdoll/build';
import { applyOverrides, type CharacterOverrides } from './ragdoll/merge';

const fbxPath = process.argv[2] ?? 'assets/fbx/X Bot.fbx';
const cfg = JSON.parse(readFileSync('config/genRagdoll.json', 'utf8')) as GenConfig;
const outPath = `config/characters/${cfg.id}.json`;
const ovPath = `config/characters/${cfg.id}.overrides.json`;

const skel = readFbxSkeleton(fbxPath, { withSkin: true });
let def = buildCharacter(skel, cfg);
if (existsSync(ovPath)) def = applyOverrides(def, JSON.parse(readFileSync(ovPath, 'utf8')) as CharacterOverrides, ovPath);
writeFileSync(outPath, JSON.stringify(def, null, 2) + '\n');

const massSum = def.bodies.reduce((s, b) => s + b.massRatio, 0) * def.totalMass;
console.log(`${outPath}: ${def.bodies.length} bodies, mass ${massSum.toFixed(3)} kg, height ${def.height} m`);
for (const b of def.bodies) {
  const s = b.shape;
  const dims = s.type === 'capsule' ? `r=${s.radius} hh=${s.halfHeight}` : s.type === 'sphere' ? `r=${s.radius}` : `he=${s.halfExtents.join(',')}`;
  console.log(`  ${b.name.padEnd(13)} ${s.type.padEnd(7)} ${dims.padEnd(22)} pos=${b.restPosition.join(',')}`);
}

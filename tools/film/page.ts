// 필름 페이지 진입점 (브라우저에서 실행). tools/film.ts가 esbuild로 묶어 Playwright Chromium에 넣는다.
import { renderFilmstrip, type FilmInput } from '../../src/render/filmstrip';
import { FbxSkin, type SkinConfig } from '../../src/render/skin';
import type { CharacterDef } from '../../src/render/stateTypes';

let skin: FbxSkin | undefined;
/** (v0.8c) 두 번째 이후 캐릭터 FBX (색만 다름) */
const extraSkins: FbxSkin[] = [];

const g = globalThis as unknown as {
  renderFilm: (input: FilmInput) => string;
  loadSkin: (fbxBase64: string, def: CharacterDef, cfg: SkinConfig, extra?: boolean) => void;
};
g.renderFilm = (input) => renderFilmstrip(input, skin, extraSkins);
g.loadSkin = (b64, def, cfg, extra) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const s = new FbxSkin(bytes.buffer, def, cfg);
  if (extra) extraSkins.push(s);
  else skin = s;
};

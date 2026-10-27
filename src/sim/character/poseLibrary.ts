// 기본 포즈 라이브러리: config/poses/*.json (sim은 파일 시스템을 쓰지 않으므로 정적 import). 포즈를 추가하면 여기에도 넣는다.
import stand from '../../../config/poses/stand.json';
import wave from '../../../config/poses/wave.json';
import lean from '../../../config/poses/lean.json';
import standSlope10 from '../../../config/poses/stand_slope10.json';
import standSlope20Down from '../../../config/poses/stand_slope20_down.json';
import type { PoseFile } from './pose';

export const POSES: Readonly<Record<string, PoseFile>> = {
  stand: stand as PoseFile,
  wave: wave as PoseFile,
  lean: lean as PoseFile,
  stand_slope10: standSlope10 as PoseFile,
  stand_slope20_down: standSlope20Down as PoseFile,
};

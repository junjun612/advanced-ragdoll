// 자동 생성 (npm run getup:build, tools/kimodo/buildGetupLibrary.ts). 고치지 말 것.
// 겟업 라이브러리: assets/library/getup.json 인덱스 + assets/poses/getup/*.json 클립 (sim은 파일 시스템을 쓰지 않으므로 정적 import).
import type { AnimClipFile } from './animDriver';
import type { GetupEntry, GetupLibraryData } from './getup';
import index from '../../../assets/library/getup.json';
import c0 from '../../../assets/poses/getup/getup_c01_feet_s5.json';
import c1 from '../../../assets/poses/getup/getup_c01_feet_s4.json';
import c2 from '../../../assets/poses/getup/getup_c02_feet_s5.json';
import c3 from '../../../assets/poses/getup/getup_c02_head_s4.json';
import c4 from '../../../assets/poses/getup/getup_c03_feet_s5.json';
import c5 from '../../../assets/poses/getup/getup_c03_feet_s4.json';
import c6 from '../../../assets/poses/getup/getup_c04_feet_s4.json';
import c7 from '../../../assets/poses/getup/getup_c04_feet_s6.json';
import c8 from '../../../assets/poses/getup/getup_c05_feet_s5.json';
import c9 from '../../../assets/poses/getup/getup_c05_feet_s1.json';
import c10 from '../../../assets/poses/getup/getup_c06_feet_s3.json';
import c11 from '../../../assets/poses/getup/getup_c06_feet_s2.json';
import c12 from '../../../assets/poses/getup/getup_c07_head_s5.json';
import c13 from '../../../assets/poses/getup/getup_c07_feet_s4.json';
import c14 from '../../../assets/poses/getup/getup_c08_feet_s6.json';
import c15 from '../../../assets/poses/getup/getup_c08_feet_s4.json';
import c16 from '../../../assets/poses/getup/getup_c09_head_s2.json';
import c17 from '../../../assets/poses/getup/getup_c09_head_s6.json';
import c18 from '../../../assets/poses/getup/getup_c10_feet_s1.json';
import c19 from '../../../assets/poses/getup/getup_c10_feet_s5.json';
import c20 from '../../../assets/poses/getup/getup_c11_feet_s5.json';
import c21 from '../../../assets/poses/getup/getup_c11_feet_s4.json';
import c22 from '../../../assets/poses/getup/getup_c12_feet_s5.json';
import c23 from '../../../assets/poses/getup/getup_c12_head_s1.json';
import c24 from '../../../assets/poses/getup/getup_c13_head_s3.json';
import c25 from '../../../assets/poses/getup/getup_c13_head_s6.json';
import c26 from '../../../assets/poses/getup/getup_c14_feet_s5.json';
import c27 from '../../../assets/poses/getup/getup_c14_feet_s3.json';
import c28 from '../../../assets/poses/getup/getup_c15_feet_s5.json';
import c29 from '../../../assets/poses/getup/getup_c15_feet_s4.json';
import c30 from '../../../assets/poses/getup/getup_c16_head_s2.json';
import c31 from '../../../assets/poses/getup/getup_c16_head_s4.json';
import c32 from '../../../assets/poses/getup/getup_c17_feet_s2.json';
import c33 from '../../../assets/poses/getup/getup_c17_feet_s3.json';
import c34 from '../../../assets/poses/getup/getup_c18_head_s5.json';
import c35 from '../../../assets/poses/getup/getup_c18_head_s2.json';
import c36 from '../../../assets/poses/getup/getup_c19_feet_s5.json';
import c37 from '../../../assets/poses/getup/getup_c19_feet_s4.json';
import c38 from '../../../assets/poses/getup/getup_c20_feet_s1.json';
import c39 from '../../../assets/poses/getup/getup_c20_feet_s4.json';
import c40 from '../../../assets/poses/getup/getup_c21_feet_s2.json';
import c41 from '../../../assets/poses/getup/getup_c21_feet_s3.json';
import c42 from '../../../assets/poses/getup/getup_c22_head_s3.json';
import c43 from '../../../assets/poses/getup/getup_c22_feet_s2.json';
import c44 from '../../../assets/poses/getup/getup_c23_feet_s4.json';
import c45 from '../../../assets/poses/getup/getup_c23_head_s1.json';
import c46 from '../../../assets/poses/getup/getup_c24_feet_s2.json';
import c47 from '../../../assets/poses/getup/getup_c24_feet_s5.json';
import c48 from '../../../assets/poses/getup/getup_c25_feet_s5.json';
import c49 from '../../../assets/poses/getup/getup_c25_feet_s6.json';
import c50 from '../../../assets/poses/getup/getup_c26_feet_s5.json';
import c51 from '../../../assets/poses/getup/getup_c26_feet_s4.json';
import c52 from '../../../assets/poses/getup/getup_c27_head_s1.json';
import c53 from '../../../assets/poses/getup/getup_c27_head_s4.json';
import c54 from '../../../assets/poses/getup/getup_c28_head_s4.json';
import c55 from '../../../assets/poses/getup/getup_c28_feet_s6.json';
import c56 from '../../../assets/poses/getup/getup_c29_feet_s6.json';
import c57 from '../../../assets/poses/getup/getup_c29_feet_s4.json';
import c58 from '../../../assets/poses/getup/getup_c30_feet_s3.json';
import c59 from '../../../assets/poses/getup/getup_c30_feet_s4.json';
import c60 from '../../../assets/poses/getup/getup_ins_prone_feet_s5.json';
import c61 from '../../../assets/poses/getup/getup_ins_prone_feet_s4.json';
import c62 from '../../../assets/poses/getup/getup_ins_prone_head_s2.json';
import c63 from '../../../assets/poses/getup/getup_ins_prone_head_s1.json';
import c64 from '../../../assets/poses/getup/getup_ins_supine_feet_s1.json';
import c65 from '../../../assets/poses/getup/getup_ins_supine_feet_s5.json';
import c66 from '../../../assets/poses/getup/getup_ins_supine_feet_s6.json';
import c67 from '../../../assets/poses/getup/getup_ins_supine_feet_s2.json';

export const GETUP_LIBRARY: GetupLibraryData = {
  entries: (index as unknown as { entries: GetupEntry[] }).entries,
  clips: {
    "getup_c01_feet_s5": c0 as unknown as AnimClipFile,
    "getup_c01_feet_s4": c1 as unknown as AnimClipFile,
    "getup_c02_feet_s5": c2 as unknown as AnimClipFile,
    "getup_c02_head_s4": c3 as unknown as AnimClipFile,
    "getup_c03_feet_s5": c4 as unknown as AnimClipFile,
    "getup_c03_feet_s4": c5 as unknown as AnimClipFile,
    "getup_c04_feet_s4": c6 as unknown as AnimClipFile,
    "getup_c04_feet_s6": c7 as unknown as AnimClipFile,
    "getup_c05_feet_s5": c8 as unknown as AnimClipFile,
    "getup_c05_feet_s1": c9 as unknown as AnimClipFile,
    "getup_c06_feet_s3": c10 as unknown as AnimClipFile,
    "getup_c06_feet_s2": c11 as unknown as AnimClipFile,
    "getup_c07_head_s5": c12 as unknown as AnimClipFile,
    "getup_c07_feet_s4": c13 as unknown as AnimClipFile,
    "getup_c08_feet_s6": c14 as unknown as AnimClipFile,
    "getup_c08_feet_s4": c15 as unknown as AnimClipFile,
    "getup_c09_head_s2": c16 as unknown as AnimClipFile,
    "getup_c09_head_s6": c17 as unknown as AnimClipFile,
    "getup_c10_feet_s1": c18 as unknown as AnimClipFile,
    "getup_c10_feet_s5": c19 as unknown as AnimClipFile,
    "getup_c11_feet_s5": c20 as unknown as AnimClipFile,
    "getup_c11_feet_s4": c21 as unknown as AnimClipFile,
    "getup_c12_feet_s5": c22 as unknown as AnimClipFile,
    "getup_c12_head_s1": c23 as unknown as AnimClipFile,
    "getup_c13_head_s3": c24 as unknown as AnimClipFile,
    "getup_c13_head_s6": c25 as unknown as AnimClipFile,
    "getup_c14_feet_s5": c26 as unknown as AnimClipFile,
    "getup_c14_feet_s3": c27 as unknown as AnimClipFile,
    "getup_c15_feet_s5": c28 as unknown as AnimClipFile,
    "getup_c15_feet_s4": c29 as unknown as AnimClipFile,
    "getup_c16_head_s2": c30 as unknown as AnimClipFile,
    "getup_c16_head_s4": c31 as unknown as AnimClipFile,
    "getup_c17_feet_s2": c32 as unknown as AnimClipFile,
    "getup_c17_feet_s3": c33 as unknown as AnimClipFile,
    "getup_c18_head_s5": c34 as unknown as AnimClipFile,
    "getup_c18_head_s2": c35 as unknown as AnimClipFile,
    "getup_c19_feet_s5": c36 as unknown as AnimClipFile,
    "getup_c19_feet_s4": c37 as unknown as AnimClipFile,
    "getup_c20_feet_s1": c38 as unknown as AnimClipFile,
    "getup_c20_feet_s4": c39 as unknown as AnimClipFile,
    "getup_c21_feet_s2": c40 as unknown as AnimClipFile,
    "getup_c21_feet_s3": c41 as unknown as AnimClipFile,
    "getup_c22_head_s3": c42 as unknown as AnimClipFile,
    "getup_c22_feet_s2": c43 as unknown as AnimClipFile,
    "getup_c23_feet_s4": c44 as unknown as AnimClipFile,
    "getup_c23_head_s1": c45 as unknown as AnimClipFile,
    "getup_c24_feet_s2": c46 as unknown as AnimClipFile,
    "getup_c24_feet_s5": c47 as unknown as AnimClipFile,
    "getup_c25_feet_s5": c48 as unknown as AnimClipFile,
    "getup_c25_feet_s6": c49 as unknown as AnimClipFile,
    "getup_c26_feet_s5": c50 as unknown as AnimClipFile,
    "getup_c26_feet_s4": c51 as unknown as AnimClipFile,
    "getup_c27_head_s1": c52 as unknown as AnimClipFile,
    "getup_c27_head_s4": c53 as unknown as AnimClipFile,
    "getup_c28_head_s4": c54 as unknown as AnimClipFile,
    "getup_c28_feet_s6": c55 as unknown as AnimClipFile,
    "getup_c29_feet_s6": c56 as unknown as AnimClipFile,
    "getup_c29_feet_s4": c57 as unknown as AnimClipFile,
    "getup_c30_feet_s3": c58 as unknown as AnimClipFile,
    "getup_c30_feet_s4": c59 as unknown as AnimClipFile,
    "getup_ins_prone_feet_s5": c60 as unknown as AnimClipFile,
    "getup_ins_prone_feet_s4": c61 as unknown as AnimClipFile,
    "getup_ins_prone_head_s2": c62 as unknown as AnimClipFile,
    "getup_ins_prone_head_s1": c63 as unknown as AnimClipFile,
    "getup_ins_supine_feet_s1": c64 as unknown as AnimClipFile,
    "getup_ins_supine_feet_s5": c65 as unknown as AnimClipFile,
    "getup_ins_supine_feet_s6": c66 as unknown as AnimClipFile,
    "getup_ins_supine_feet_s2": c67 as unknown as AnimClipFile,
  },
};

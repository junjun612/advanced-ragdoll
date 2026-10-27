import { defineConfig } from 'vite';

// GitHub Pages(https://<user>.github.io/advanced-ragdoll/)는 하위 경로라 빌드·미리보기 때 base를 맞춘다. 개발 서버는 '/'.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? (process.env.BASE_PATH ?? '/advanced-ragdoll/') : '/',
  build: { outDir: 'dist', chunkSizeWarningLimit: 20000 },
}));

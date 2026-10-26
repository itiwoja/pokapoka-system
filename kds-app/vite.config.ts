import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// 店内LANで完全オフラインに動かすため、JS/CSS を1枚の HTML に埋め込む。
// kds-bridge.js / slip-renderer.js / party-size.js は中継サーバーが配る共有ファイルなので
// 埋め込まずに通常画面の起動時に読み込む (src/main.tsx 参照)。
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    // npm run dev 時は、別ポートで起動した中継サーバー (npm start, 既定 8000) へ API と共有ファイルを流す
    proxy: {
      "/api": "http://localhost:8000",
      "/relay-server": "http://localhost:8000",
      "/slip-renderer.js": "http://localhost:8000",
      "/assets": "http://localhost:8000",
    },
  },
  // /mnt/c (WSL) では既定の forks だと worker 起動が時間切れになるため threads を使う
  test: { environment: "jsdom", pool: "threads" },
});

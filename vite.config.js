import { defineConfig } from "vite";
import { colyseus } from "colyseus/vite";

export default defineConfig(({ mode }) => ({
  // 相對路徑，讓前端可以直接放到 GitHub Pages 的子目錄
  base: "./",
  build: { outDir: "dist/client" },
  plugins: [
    // 開發時在同一個埠號啟動遊戲伺服器，改 rooms 會自動重載。
    // `--mode client` 只打包前端（部署到 GitHub Pages 用）。
    ...(mode === "client" ? [] : [colyseus({ serverEntry: "/src/server/app.config.js" })]),
  ],
}));

import { defineServer, defineRoom } from "colyseus";
import { ArenaRoom } from "./rooms/ArenaRoom.js";

// 伺服器設定。開發時由 vite.config.js 的 colyseus 外掛啟動，
// 正式環境則由 `npm run build` 產生的 dist/server/server.mjs 啟動。
export const server = defineServer({
  rooms: {
    arena: defineRoom(ArenaRoom),
  },
});

export default server;

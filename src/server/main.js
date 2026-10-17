/**
 * 正式環境的啟動檔：node src/server/main.js
 *
 * 只負責遊戲連線（配對 + WebSocket），網頁檔案由前面的 Caddy 直接提供。
 * 預設只監聽 127.0.0.1，外部連線一律經過 Caddy（HTTPS）。
 *
 * 環境變數：
 *   PORT  監聽的埠號（預設 2567）
 *   HOST  監聽的位址（預設 127.0.0.1）
 */
import { server } from "./app.config.js";

const PORT = Number(process.env.PORT) || 2567;
const HOST = process.env.HOST || "127.0.0.1";

await server.listen(PORT, HOST);
console.log(`[pixel-arena] 遊戲伺服器已啟動 ${HOST}:${PORT}`);

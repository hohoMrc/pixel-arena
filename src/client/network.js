import { ColyseusSDK } from "@colyseus/sdk";

/**
 * 遊戲伺服器位址：
 * - 預設和網頁同一個位置，包含路徑。例如網頁在 https://hoho-game.duckdns.org/arena/，
 *   就連 wss://hoho-game.duckdns.org/arena（Caddy 再轉給遊戲伺服器）
 * - 前端和後端放在不同地方時，打包前設定 VITE_SERVER_URL（例如 wss://xxx.example.com）
 */
const pageDir = new URL(".", location.href);
const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ||
  `${pageDir.protocol === "https:" ? "wss" : "ws"}://${pageDir.host}${pageDir.pathname.replace(/\/$/, "")}`;

const client = new ColyseusSDK(SERVER_URL);

/**
 * 依進場畫面的選擇加入房間：
 *   quick  自動配對（有空位的公開房間就加入，沒有就建立）
 *   create 建立私人房間
 *   join   用房號加入
 * 加入後把房號寫回網址，直接複製網址就能邀請朋友。
 * 失敗時丟出 Error，message 是可以直接顯示給玩家看的中文。
 *
 * @param {{ name: string, skin: number, mode: "quick"|"create"|"join", code?: string }} choice
 */
export async function joinArena({ name, skin, mode, code }) {
  const options = { name, skin };
  let room;
  try {
    if (mode === "join") room = await client.joinById(code, options);
    else if (mode === "create") room = await client.create("arena", { ...options, private: true });
    else room = await client.joinOrCreate("arena", options);
  } catch (err) {
    console.warn("加入房間失敗", err);
    if (mode !== "join") throw new Error("連線失敗，請稍後再試");
    // Colyseus 的錯誤訊息：找不到是 not found，滿了是 locked
    throw new Error(/locked/i.test(err?.message) ? `房間 ${code} 已滿` : `找不到房間 ${code}`);
  }

  const params = new URLSearchParams(location.search);
  params.set("room", room.roomId);
  history.replaceState(null, "", `${location.pathname}?${params}`);
  return room;
}

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
 * 網址有 ?room=xxx 就加入該房間，否則自動配對（有空房就加入，沒有就建立）。
 * 加入後把房號寫回網址，直接複製網址就能邀請朋友。
 * @param {{ name: string, skin: number }} options 進場畫面選的名稱和角色
 */
export async function joinArena(options) {
  const params = new URLSearchParams(location.search);
  const roomId = params.get("room");

  let room;
  try {
    room = roomId ? await client.joinById(roomId, options) : await client.joinOrCreate("arena", options);
  } catch (err) {
    if (!roomId) throw err;
    // 房間不存在或已滿：改成自動配對
    console.warn("無法加入指定房間，改為自動配對", err);
    room = await client.joinOrCreate("arena", options);
  }

  params.set("room", room.roomId);
  history.replaceState(null, "", `${location.pathname}?${params}`);
  return room;
}

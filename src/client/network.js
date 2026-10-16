import { ColyseusSDK } from "@colyseus/sdk";

/**
 * 遊戲伺服器位址：
 * - 開發時前後端同一個埠號，直接用目前網址
 * - 前端放 GitHub Pages、後端放別處時，打包前設定 VITE_SERVER_URL（例如 wss://xxx.fly.dev）
 */
const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ||
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

const client = new ColyseusSDK(SERVER_URL);

/**
 * 網址有 ?room=xxx 就加入該房間，否則自動配對（有空房就加入，沒有就建立）。
 * 加入後把房號寫回網址，直接複製網址就能邀請朋友。
 */
export async function joinArena() {
  const params = new URLSearchParams(location.search);
  const roomId = params.get("room");
  const options = { name: params.get("name") || undefined };

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

import * as Phaser from "phaser";
import { Predict } from "@colyseus/sdk/predict";
import { ARENA_WIDTH, ARENA_HEIGHT } from "../shared/constants.js";
import { stepEntity } from "../shared/movement.js";
import { theme } from "./theme.js";
import { joinArena } from "./network.js";
import { Controls } from "./controls.js";
import { ArenaScene } from "./scenes/ArenaScene.js";
import { escapeHtml } from "./escapeHtml.js";
import { showLobby } from "./lobby.js";
import "./style.css";

const $ = (id) => document.getElementById(id);

/**
 * 其他玩家的插值緩衝（毫秒）。要大於狀態更新偶爾的最長間隔，不然角色會停一下再跳。
 * 實測：EC2（東京）來回 40ms、更新最長間隔 38ms → 100 有餘裕。
 * 透過 Cloudflare 通道時最長間隔到 130ms 以上，要調到 150。
 */
const INTERP_DELAY_MS = 100;

// iPhone 雙指縮放、連點放大，光靠 CSS 擋不住
document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener("dblclick", (e) => e.preventDefault());
const statusEl = $("status");

async function main() {
  const controls = new Controls({ joystick: $("joystick"), knob: $("knob"), skillsEl: $("skills") });

  statusEl.textContent = "選擇角色";
  const profile = await showLobby($("lobby"));

  statusEl.textContent = "連線中…";
  const room = await joinArena(profile);
  const predict = Predict.get(room);

  // 其他玩家：畫面刻意晚 INTERP_DELAY_MS 顯示，在前後兩個伺服器快照之間插值。
  // 緩衝要大於網路偶爾的空檔，不然角色會停一下再跳。火球改用推算（ArenaScene），不在這裡插值
  predict.attachAll("players", { mode: "lerp", fields: ["x", "y"], delay: INTERP_DELAY_MS, smoothMs: 65 });

  const netInput = room.input({ mode: "reliable" });

  // 第一次收到狀態時，自己的角色才會出現
  await new Promise((resolve) => room.onStateChange.once(() => resolve()));
  const self = room.state.players.get(room.sessionId);

  // 自己的角色：先在本地預測移動（手感即時），伺服器結果回來再修正
  predict.reconciler(self, {
    input: netInput,
    // stepEntity 會讀寫的欄位都要列出來，預測才完整（面向、衝刺狀態、衝刺冷卻）
    fields: ["x", "y", "vx", "vy", "faceX", "faceY", "dashTicks", "dashCd"],
    step: (ctx, predicted, command) => stepEntity(predicted, command, ctx.dt),
  });

  setupHud(room);

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    // 畫面 = 場地 + 四周外框
    width: ARENA_WIDTH + theme.border.side * 2,
    height: ARENA_HEIGHT + theme.border.top + theme.border.bottom,
    backgroundColor: theme.backgroundColor,
    pixelArt: true,
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    // 鍵盤由 Controls 處理，Phaser 不需要搶焦點
    input: { keyboard: false },
    scene: [],
    callbacks: {
      postBoot: (game) => {
        setupMute(game);
        game.scene.add("arena", ArenaScene, true, { room, predict, netInput, controls });
      },
    },
  });

  // 開發時方便在 console 除錯：__game.scene.getScene("arena")
  if (import.meta.env.DEV) window.__game = game;
}

/**
 * 靜音按鈕，設定存在這台裝置的瀏覽器裡。
 * 不用 Phaser 的 sound.setMute：它用 setValueAtTime(…, 0) 排程，音訊已在跑時 Chrome 不一定套用。
 * 改成把狀態放在 registry，ArenaScene.playSfx 靜音時直接不播。
 */
function setupMute(game) {
  const btn = $("mute");
  const apply = (muted) => {
    game.registry.set("muted", muted);
    btn.textContent = muted ? "🔇" : "🔊";
    try { localStorage.setItem("pixel-arena:muted", muted ? "1" : "0"); } catch {}
  };
  let saved = false;
  try { saved = localStorage.getItem("pixel-arena:muted") === "1"; } catch {}
  apply(saved);
  btn.addEventListener("click", () => apply(!game.registry.get("muted")));
}

function setupHud(room) {
  statusEl.textContent = `房間 ${room.roomId}`;
  $("share").hidden = false; // 加入房間後網址才有房號，這時才能邀請

  $("share").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      $("share").textContent = "已複製！";
    } catch {
      // 非 https（例如手機連區網 IP）時剪貼簿不能用，改成顯示網址
      $("share").textContent = location.href;
    }
    setTimeout(() => ($("share").textContent = "邀請"), 2000);
  });

  // 比分不需要每幀更新
  setInterval(() => {
    const rows = [...room.state.players.entries()]
      .sort(([, a], [, b]) => b.kills - a.kills)
      .map(([id, p]) => `<span class="${id === room.sessionId ? "me" : ""}">${escapeHtml(p.name)} ${p.kills}/${p.deaths}</span>`);
    const goal = room.state.phase === "waiting" ? "練習中" : `${room.state.killsToWin} 殺獲勝`;
    $("score").innerHTML = `<span class="goal">${goal}</span>` + rows.join("");
  }, 300);

  room.onLeave(() => (statusEl.textContent = "已斷線，請重新整理"));
}

main().catch((err) => {
  console.error(err);
  statusEl.textContent = "無法連線到伺服器";
});

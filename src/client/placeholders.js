import { theme } from "./theme.js";

/**
 * 替還沒有圖片的素材產生簡單的像素 placeholder，讓遊戲在沒有美術時也能玩。
 * 只會補「沒載入成功」的 key，有圖片的會直接使用圖片。
 */
export function createMissingTextures(scene) {
  for (const [key, asset] of Object.entries(theme.assets)) {
    // 動畫圖沒有 placeholder，缺圖時就不播動畫
    if (scene.textures.exists(key) || asset.sheet) continue;

    const [w, h] = asset.size;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);

    if (key === "floor" || key.startsWith("wall") || key === "pillar") drawFloor(g, w, h, asset.color);
    else if (key.startsWith("player")) drawPlayer(g, w, h, asset.color);
    else if (key === "rubble") drawRubble(g, w, h, asset.color);
    else drawOrb(g, w, h, asset.color);

    g.generateTexture(key, w, h);
    g.destroy();
  }
}

function drawFloor(g, w, h, color) {
  g.fillStyle(color).fillRect(0, 0, w, h);
  g.fillStyle(0x000000, 0.15).fillRect(0, h - 1, w, 1).fillRect(w - 1, 0, 1, h);
}

/** 小人：頭、身體、眼睛（依圖片尺寸等比例） */
function drawPlayer(g, w, h, color) {
  const u = Math.max(1, Math.floor(w / 16)); // 一個「像素」的大小
  g.fillStyle(0x000000, 0.3).fillRect(3 * u, h - 2 * u, w - 6 * u, 2 * u);   // 影子
  g.fillStyle(color).fillRect(4 * u, h - 12 * u, w - 8 * u, 10 * u);          // 身體
  g.fillStyle(0xffe0bd).fillRect(5 * u, h - 18 * u, w - 10 * u, 6 * u);       // 頭
  g.fillStyle(0x1d1f2b).fillRect(9 * u, h - 16 * u, u, 2 * u).fillRect(11 * u, h - 16 * u, u, 2 * u); // 眼睛（朝右）
}

function drawOrb(g, w, h, color) {
  const r = Math.min(w, h) / 2;
  g.fillStyle(color).fillCircle(w - r, h / 2, r);
  g.fillStyle(0xffffff, 0.7).fillCircle(w - r - r / 3, h / 2 - r / 3, r / 3);
}

/** 碎石堆：幾塊大小不一的石頭，左上亮、右下暗 */
function drawRubble(g, w, h, color) {
  const stones = [
    [2, 6, 8, 6], [8, 3, 9, 8], [16, 5, 8, 7], [22, 8, 6, 5], [5, 10, 6, 4], [13, 10, 7, 4],
  ];
  for (const [x, y, sw, sh] of stones) {
    g.fillStyle(0x000000, 0.35).fillRect(x + 1, y + 1, sw, sh);
    g.fillStyle(color).fillRect(x, y, sw, sh);
    g.fillStyle(0xffffff, 0.25).fillRect(x, y, sw, 1);
    g.fillStyle(0x000000, 0.25).fillRect(x, y + sh - 1, sw, 1);
  }
}

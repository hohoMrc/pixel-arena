import { ARENA_WIDTH, ARENA_HEIGHT, INPUT_SCALE } from "./constants.js";

/**
 * 指定地點爆炸的落點。伺服器（實際落點）和客戶端（瞄準時的預告圈）共用，兩邊算出來才會一樣。
 *
 * aim 向量的「長度」代表丟多遠：INPUT_SCALE = 最遠（skill.range），一半 = 一半距離。
 * 落點會限制在場地內。
 *
 * @param {number} x 施放者位置
 * @param {number} y
 * @param {number} aimX -INPUT_SCALE ~ INPUT_SCALE
 * @param {number} aimY
 * @param {{ range: number }} skill
 */
export function blastTarget(x, y, aimX, aimY, skill) {
  const len = Math.hypot(aimX, aimY);
  const scale = len > INPUT_SCALE ? INPUT_SCALE / len : 1; // 斜向超過 1 時壓回來
  const tx = x + (aimX * scale / INPUT_SCALE) * skill.range;
  const ty = y + (aimY * scale / INPUT_SCALE) * skill.range;
  return {
    x: Math.max(0, Math.min(ARENA_WIDTH, tx)),
    y: Math.max(0, Math.min(ARENA_HEIGHT, ty)),
  };
}

/** 從施放者指向某個點的 aim 向量（距離超過射程就壓到射程） */
export function aimToward(x, y, targetX, targetY, skill) {
  const dx = targetX - x;
  const dy = targetY - y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return { x: 1, y: 0 }; // 不能是 (0, 0)，那代表「自動瞄準」
  const ratio = Math.min(1, dist / skill.range);
  return {
    x: Math.round((dx / dist) * ratio * INPUT_SCALE) || (dx > 0 ? 1 : -1),
    y: Math.round((dy / dist) * ratio * INPUT_SCALE),
  };
}

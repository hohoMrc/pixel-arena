import { OBSTACLES, OBSTACLE_SIZE } from "./constants.js";

/** 每個障礙物的佔地矩形（先算好，碰撞判定不用每次重算） */
export const OBSTACLE_RECTS = OBSTACLES.map(({ x, y }) => ({
  left: x - OBSTACLE_SIZE.w / 2,
  right: x + OBSTACLE_SIZE.w / 2,
  top: y - OBSTACLE_SIZE.h / 2,
  bottom: y + OBSTACLE_SIZE.h / 2,
}));

/**
 * 以下函式的 solid 參數：每根柱子還在不在（boolean 陣列，索引同 OBSTACLES）。
 * 柱子可以被打壞，打壞的不擋人也不擋技能。不傳 = 全部都在。
 */
const isSolid = (solid, i) => !solid || solid[i];

/** 以 (cx, cy) 為中心、半寬 half 的正方形撞到的障礙物（角色用），沒撞到回傳 undefined */
export function obstacleHitByBox(cx, cy, half, solid) {
  return OBSTACLE_RECTS.find((r, i) => isSolid(solid, i) &&
    cx + half > r.left && cx - half < r.right && cy + half > r.top && cy - half < r.bottom);
}

/** 圓形和矩形是否重疊 */
export function circleOverlapsRect(cx, cy, radius, r) {
  // 圓心到矩形最近點的距離
  const nx = Math.max(r.left, Math.min(cx, r.right));
  const ny = Math.max(r.top, Math.min(cy, r.bottom));
  return (cx - nx) ** 2 + (cy - ny) ** 2 <= radius * radius;
}

/** 圓形撞到的第一根柱子索引（技能用），沒撞到回傳 -1 */
export function obstacleIndexHitByCircle(cx, cy, radius, solid) {
  return OBSTACLE_RECTS.findIndex((r, i) => isSolid(solid, i) && circleOverlapsRect(cx, cy, radius, r));
}

/** 圓形是否和任何（還在的）障礙物重疊 */
export function circleHitsObstacle(cx, cy, radius, solid) {
  return obstacleIndexHitByCircle(cx, cy, radius, solid) >= 0;
}

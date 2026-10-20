import { MAPS, OBSTACLE_SIZE } from "./constants.js";

const toRect = ({ x, y }) => ({
  left: x - OBSTACLE_SIZE.w / 2,
  right: x + OBSTACLE_SIZE.w / 2,
  top: y - OBSTACLE_SIZE.h / 2,
  bottom: y + OBSTACLE_SIZE.h / 2,
});

/** 每張地圖每個障礙物的佔地矩形（先算好，碰撞判定不用每次重算） */
const MAP_RECTS = MAPS.map((m) => m.obstacles.map(toRect));

/** 某張地圖的障礙物矩形（索引同 mapObstacles） */
export const mapRects = (mapIndex) => MAP_RECTS[mapIndex] ?? MAP_RECTS[0];

/**
 * 以下函式的 solid 參數：目前「還站著」的障礙物，索引同地圖的障礙物清單，
 * 被打壞的那格是 null（不擋人也不擋技能）。不傳 = 第一張地圖全部都在。
 * 伺服器和客戶端都用 syncSolid 維護這個陣列。
 */
const standing = (solid) => solid ?? MAP_RECTS[0];

/**
 * 依地圖和每根障礙物還在不在，就地更新 solid（陣列長度跟著地圖改變）。
 * 就地修改是因為客戶端的預測移動拿的是同一個陣列。
 * @param {Array} solid
 * @param {number} mapIndex
 * @param {(i: number) => boolean} isUp 第 i 根是否還在
 */
export function syncSolid(solid, mapIndex, isUp) {
  const rects = mapRects(mapIndex);
  solid.length = rects.length;
  rects.forEach((r, i) => (solid[i] = isUp(i) ? r : null));
  return solid;
}

/** 以 (cx, cy) 為中心、半寬 half 的正方形撞到的障礙物（角色用），沒撞到回傳 undefined */
export function obstacleHitByBox(cx, cy, half, solid) {
  return standing(solid).find((r) => r &&
    cx + half > r.left && cx - half < r.right && cy + half > r.top && cy - half < r.bottom);
}

/** 圓形和矩形是否重疊 */
export function circleOverlapsRect(cx, cy, radius, r) {
  // 圓心到矩形最近點的距離
  const nx = Math.max(r.left, Math.min(cx, r.right));
  const ny = Math.max(r.top, Math.min(cy, r.bottom));
  return (cx - nx) ** 2 + (cy - ny) ** 2 <= radius * radius;
}

/** 圓形撞到的第一根障礙物索引（技能用），沒撞到回傳 -1 */
export function obstacleIndexHitByCircle(cx, cy, radius, solid) {
  return standing(solid).findIndex((r) => r && circleOverlapsRect(cx, cy, radius, r));
}

/** 圓形是否和任何（還在的）障礙物重疊 */
export function circleHitsObstacle(cx, cy, radius, solid) {
  return obstacleIndexHitByCircle(cx, cy, radius, solid) >= 0;
}

import { OBSTACLES, OBSTACLE_SIZE } from "./constants.js";

/** 每個障礙物的佔地矩形（先算好，碰撞判定不用每次重算） */
export const OBSTACLE_RECTS = OBSTACLES.map(({ x, y }) => ({
  left: x - OBSTACLE_SIZE.w / 2,
  right: x + OBSTACLE_SIZE.w / 2,
  top: y - OBSTACLE_SIZE.h / 2,
  bottom: y + OBSTACLE_SIZE.h / 2,
}));

/** 以 (cx, cy) 為中心、半寬 half 的正方形撞到的障礙物（角色用），沒撞到回傳 undefined */
export function obstacleHitByBox(cx, cy, half) {
  return OBSTACLE_RECTS.find((r) =>
    cx + half > r.left && cx - half < r.right && cy + half > r.top && cy - half < r.bottom);
}

/** 圓形是否和任何障礙物重疊（技能用） */
export function circleHitsObstacle(cx, cy, radius) {
  return OBSTACLE_RECTS.some((r) => {
    // 圓心到矩形最近點的距離
    const nx = Math.max(r.left, Math.min(cx, r.right));
    const ny = Math.max(r.top, Math.min(cy, r.bottom));
    return (cx - nx) ** 2 + (cy - ny) ** 2 <= radius * radius;
  });
}

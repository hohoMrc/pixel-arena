// 前後端共用的遊戲數值。改這裡，伺服器和客戶端會一起生效。

/** 伺服器每秒模擬幾次（每個輸入剛好推進一步） */
export const TICK_RATE = 30;

/** 場地大小（遊戲單位 = 像素；角色約 32×40，配合手機直立的上半部畫面） */
export const ARENA_WIDTH = 384;
export const ARENA_HEIGHT = 432;

/** 角色碰撞半徑 */
export const PLAYER_HALF = 9;
/** 角色移動速度（單位／秒） */
export const PLAYER_SPEED = 135;
export const PLAYER_MAX_HP = 100;
/** 死亡後幾個 tick 復活（60 = 2 秒） */
export const RESPAWN_TICKS = 60;

/**
 * 技能清單。下方操作區的技能按鈕依這個陣列自動產生。
 * 輸入裡的 skill 值 = 陣列索引 + 1（0 代表沒放技能）。
 * texture 對應 client/theme.js 的素材 key；impactScale 是命中爆炸的放大倍數（請用整數，像素才不會糊）。
 */
export const SKILLS = [
  {
    name: "火球",
    texture: "fireball",
    impactScale: 1,
    speed: 300,          // 飛行速度（單位／秒）
    radius: 5,           // 碰撞半徑
    damage: 20,
    cooldownTicks: 12,   // 冷卻（12 = 0.4 秒）
    lifetimeTicks: 36,   // 存在時間（36 = 1.2 秒）
  },
  {
    name: "爆炎",
    texture: "bigfireball",
    impactScale: 2,
    speed: 165,
    radius: 10,
    damage: 45,
    cooldownTicks: 90,   // 3 秒
    lifetimeTicks: 60,
  },
];

/** 出生點，依加入順序輪流使用 */
export const SPAWN_POINTS = [
  { x: 60, y: 60 },
  { x: ARENA_WIDTH - 60, y: ARENA_HEIGHT - 60 },
  { x: ARENA_WIDTH - 60, y: 60 },
  { x: 60, y: ARENA_HEIGHT - 60 },
];

export const MAX_PLAYERS = SPAWN_POINTS.length;

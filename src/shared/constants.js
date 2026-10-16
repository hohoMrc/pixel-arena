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

/** 一局的規則 */
export const ROUND = {
  killsToWin: 5,        // 先拿到幾殺獲勝
  minPlayers: 2,        // 幾個人以上才開始（不到就是等待／練習）
  countdownTicks: 90,   // 開局倒數（90 = 3 秒）
  endTicks: 150,        // 結算畫面停留（150 = 5 秒）
};

/**
 * 技能清單。下方操作區的技能按鈕依這個陣列自動產生。
 * 輸入裡的 skill 值 = 陣列索引 + 1（0 代表沒放技能）。
 * type："projectile"（預設，發射飛行物）或 "dash"（衝刺，在 shared/movement.js 處理）。
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
  {
    name: "衝刺",
    type: "dash",
    speed: 460,          // 衝刺速度（單位／秒），一般移動是 PLAYER_SPEED
    ticks: 6,            // 持續幾個 tick（6 = 0.2 秒，約衝 92 單位）
    cooldownTicks: 60,   // 2 秒
    invulnerable: true,  // 衝刺中不會被技能打到
  },
];

/** 衝刺在 SKILLS 裡的索引（沒有衝刺技能時是 -1） */
export const DASH_INDEX = SKILLS.findIndex((s) => s.type === "dash");

/**
 * 障礙物（石柱）。座標是「地面佔地」的中心點，w/h 是佔地大小，會擋人也會擋技能。
 * 圖片比佔地高（有立體感），畫的時候底部對齊佔地底部。
 * 調整配置時注意不要擋到出生點。
 */
export const OBSTACLE_SIZE = { w: 24, h: 18 };
export const OBSTACLES = [
  { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 },
  { x: 112, y: 140 },
  { x: ARENA_WIDTH - 112, y: 140 },
  { x: 112, y: ARENA_HEIGHT - 140 },
  { x: ARENA_WIDTH - 112, y: ARENA_HEIGHT - 140 },
];

/** 出生點，依加入順序輪流使用 */
export const SPAWN_POINTS = [
  { x: 60, y: 60 },
  { x: ARENA_WIDTH - 60, y: ARENA_HEIGHT - 60 },
  { x: ARENA_WIDTH - 60, y: 60 },
  { x: 60, y: ARENA_HEIGHT - 60 },
];

export const MAX_PLAYERS = SPAWN_POINTS.length;

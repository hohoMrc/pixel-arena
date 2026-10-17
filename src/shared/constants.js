// 前後端共用的遊戲數值。改這裡，伺服器和客戶端會一起生效。

/** 伺服器每秒模擬幾次（每個輸入剛好推進一步） */
export const TICK_RATE = 30;

/**
 * 場地大小（遊戲單位 = 像素；角色約 32×40）。
 * 比手機畫面大，鏡頭會跟著自己的角色移動（畫面大小在 client/theme.js 的 viewport）。
 */
export const ARENA_WIDTH = 576;
export const ARENA_HEIGHT = 672;

/**
 * 輸入的方向（移動、瞄準）用 -INPUT_SCALE ~ INPUT_SCALE 的整數表示，可以是任意角度。
 * 用整數是為了讓伺服器和客戶端預測拿到一模一樣的數值。
 */
export const INPUT_SCALE = 100;

/** 角色碰撞半徑 */
export const PLAYER_HALF = 9;
/** 角色移動速度（單位／秒） */
export const PLAYER_SPEED = 135;
export const PLAYER_MAX_HP = 100;
/** 死亡後幾個 tick 復活（60 = 2 秒） */
export const RESPAWN_TICKS = 60;

/** 能量：放攻擊技能要花，會自動回復（衝刺不花能量，靠冷卻限制） */
export const ENERGY = {
  max: 100,
  regenPerSec: 12,
};

/** 怒氣：打人、被打都會累積，集滿可以放大招（新的一局歸零，死掉不會清空） */
export const RAGE = {
  max: 100,
  perDamageDealt: 0.8,  // 造成 1 點傷害 +0.8
  perDamageTaken: 0.5,  // 受到 1 點傷害 +0.5
  perStructureDamage: 0.3, // 打柱子 1 點傷害 +0.3
};

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
 * type："projectile"（預設，發射飛行物）、"blast"（指定地點爆炸，見 shared/blast.js）、
 *       "meteor"（多顆指定地點爆炸，大招用）或 "dash"（衝刺，在 shared/movement.js 處理）。
 * energyCost：施放要花多少能量；ultimate: true 的技能改成要集滿怒氣，放完怒氣歸零。
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
    energyCost: 8,
    lifetimeTicks: 36,   // 存在時間（36 = 1.2 秒）
  },
  {
    name: "爆炎",
    type: "blast",       // 指定地點爆炸：丟到哪就在哪炸，地上會先出現預告圈
    texture: "bigfireball",
    impactScale: 2,
    range: 150,          // 最遠丟多遠（從角色中心算）
    radius: 30,          // 爆炸範圍半徑
    fuseTicks: 21,       // 預告多久才爆炸（21 = 0.7 秒），給對手躲的時間
    damage: 40,
    cooldownTicks: 90,   // 3 秒
    energyCost: 30,
  },
  {
    name: "衝刺",
    type: "dash",
    speed: 460,          // 衝刺速度（單位／秒），一般移動是 PLAYER_SPEED
    ticks: 6,            // 持續幾個 tick（6 = 0.2 秒，約衝 92 單位）
    cooldownTicks: 60,   // 2 秒
    invulnerable: true,  // 衝刺中不會被技能打到
  },
  {
    name: "流星雨",
    type: "meteor",      // 在落點附近依序落下好幾顆隕石，每顆都有預告圈
    ultimate: true,      // 集滿怒氣才能放
    texture: "bigfireball",
    impactScale: 2,
    range: 170,          // 中心點最遠丟多遠
    radius: 24,          // 每顆的爆炸半徑
    damage: 20,          // 每顆的傷害（站在中間不動 7 顆全中 = 140，必死）
    fuseTicks: 24,       // 第一顆的預告時間（0.8 秒）
    staggerTicks: 4,     // 之後每顆再晚多久落下
    ringRadius: 30,      // 外圈隕石離中心多遠（小於 radius + PLAYER_HALF，中心才會被每顆炸到）
    ringCount: 6,        // 外圈幾顆（中間還有 1 顆）
    cooldownTicks: 30,   // 防止連按重複施放
  },
];

/** 大招在 SKILLS 裡的索引（沒有大招時是 -1） */
export const ULTIMATE_INDEX = SKILLS.findIndex((s) => s.ultimate);

/** 衝刺在 SKILLS 裡的索引（沒有衝刺技能時是 -1） */
export const DASH_INDEX = SKILLS.findIndex((s) => s.type === "dash");

/**
 * 障礙物（石柱）。座標是「地面佔地」的中心點，w/h 是佔地大小，會擋人也會擋技能。
 * 圖片比佔地高（有立體感），畫的時候底部對齊佔地底部。
 * 配置上下左右對稱（每個人出生點附近的地形一樣），調整時注意不要擋到出生點。
 */
export const OBSTACLE_SIZE = { w: 24, h: 18 };
const CX = ARENA_WIDTH / 2;
const CY = ARENA_HEIGHT / 2;
/** 只寫左上四分之一，其他三個方向鏡射產生（落在中線上的不重複） */
const QUARTER = [
  { x: CX, y: CY },           // 正中間
  { x: CX, y: 160 },          // 上、下中間
  { x: 150, y: CY },          // 左、右中間
  { x: 190, y: 236 },         // 內圈斜角
  { x: 110, y: 170 },         // 靠近出生點的掩護
];
export const OBSTACLES = mirror(QUARTER);

function mirror(points) {
  const seen = new Set();
  const out = [];
  for (const { x, y } of points) {
    for (const p of [{ x, y }, { x: ARENA_WIDTH - x, y }, { x, y: ARENA_HEIGHT - y }, { x: ARENA_WIDTH - x, y: ARENA_HEIGHT - y }]) {
      const key = `${p.x},${p.y}`;
      if (!seen.has(key)) { seen.add(key); out.push(p); }
    }
  }
  return out;
}

/** 柱子可以被技能打壞：血量、打壞後多久長回來（新的一局全部恢復） */
export const PILLAR = {
  hp: 100,
  respawnTicks: 600, // 20 秒
};

/** 出生點，依加入順序輪流使用（對角線先，1 對 1 時離最遠） */
export const SPAWN_POINTS = [
  { x: 80, y: 80 },
  { x: ARENA_WIDTH - 80, y: ARENA_HEIGHT - 80 },
  { x: ARENA_WIDTH - 80, y: 80 },
  { x: 80, y: ARENA_HEIGHT - 80 },
];

export const MAX_PLAYERS = SPAWN_POINTS.length;

/** 可選的角色外觀數量（skin 0 ~ SKIN_COUNT-1），要和 client/theme.js 的 skins 一致 */
export const SKIN_COUNT = 4;
/** 名稱最長幾個字 */
export const NAME_MAX_LENGTH = 12;

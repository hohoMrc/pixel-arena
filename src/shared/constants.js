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
 * desc：選角畫面的技能說明（數值會自動另外列出，這裡寫玩法就好）。
 * texture 對應 client/theme.js 的素材 key；impactScale 是命中爆炸的放大倍數（請用整數，像素才不會糊）。
 */
export const SKILLS = [
  {
    name: "火球",
    desc: "直線飛出的火球。輕點自動瞄準最近的敵人，拖曳可以自己瞄準",
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
    desc: "丟到指定地點，地上先出現預告圈，短暫延遲後大範圍爆炸",
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
    desc: "往移動方向快速衝一小段，衝刺中不會被技能打中",
    type: "dash",
    speed: 460,          // 衝刺速度（單位／秒），一般移動是 PLAYER_SPEED
    ticks: 6,            // 持續幾個 tick（6 = 0.2 秒，約衝 92 單位）
    cooldownTicks: 60,   // 2 秒
    invulnerable: true,  // 衝刺中不會被技能打到
  },
  {
    name: "流星雨",
    desc: "在指定位置周圍連續落下一圈隕石，站在正中間會全部中",
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

  // ── 紅劍士 ──
  {
    name: "揮砍",
    desc: "近戰，砍前方扇形範圍內的所有敵人",
    type: "slash",       // 近戰：瞬間砍前方扇形範圍內的所有敵人
    range: 44,           // 從角色中心到刀尖的距離
    arcDeg: 120,         // 扇形角度
    damage: 26,
    cooldownTicks: 15,   // 0.5 秒
    energyCost: 7,
  },
  {
    name: "舉盾",
    desc: "舉起盾牌一段時間，擋下從正面來的所有傷害（背後擋不到）",
    type: "guard",       // 一段時間內擋下「從盾牌那一側來的」所有傷害
    durationTicks: 60,   // 2 秒
    arcDeg: 150,         // 盾牌擋得到的角度
    cooldownTicks: 105,  // 3.5 秒（從舉盾開始算）
    energyCost: 20,
  },
  {
    name: "旋風斬",
    desc: "原地轉圈連續砍周圍的敵人，轉的時候還能移動",
    type: "whirl",       // 持續轉圈，每隔一段時間砍一次周圍的人；轉的時候可以移動
    ultimate: true,
    durationTicks: 60,   // 2 秒
    hitEveryTicks: 10,   // 每 0.33 秒砍一次（共 6 次）
    radius: 40,
    damage: 14,          // 6 次全中 = 84
    cooldownTicks: 30,
  },
  {
    name: "衝刺",
    desc: "往移動方向快速衝一小段，衝刺中不會被技能打中（冷卻比較短）",
    type: "dash",        // 紅劍士的衝刺：和一般衝刺一樣，冷卻比較短（近戰要能拉近距離）
    speed: 460,
    ticks: 6,
    cooldownTicks: 36,   // 1.2 秒
    invulnerable: true,
  },

  // ── 綠巫師 ──
  {
    name: "毒液彈",      // 沒有 type = 直線飛行的子彈（和火球同一套），命中後中毒
    desc: "比火球慢的毒液，命中後中毒一段時間持續扣血",
    texture: "poisonball",
    impactScale: 1,
    speed: 230,          // 比火球慢，比較好躲
    radius: 5,
    damage: 12,
    poison: { ticks: 60, everyTicks: 15, damage: 5 }, // 中毒 2 秒，每 0.5 秒扣 5（共 20）；再中一次會重新計時，不會疊加
    cooldownTicks: 15,   // 0.5 秒
    energyCost: 8,
    lifetimeTicks: 42,   // 射程約 322
  },
  {
    name: "毒沼",
    desc: "在指定地點留下一灘毒，踩進去的敵人會變慢並持續扣血",
    type: "zone",        // 指定地點留下一灘毒，敵人踩在裡面會變慢、持續扣血
    range: 150,
    radius: 36,
    durationTicks: 90,   // 3 秒
    slowFactor: 0.5,     // 在毒沼裡移動速度剩一半
    damage: 6,
    hitEveryTicks: 15,   // 每 0.5 秒扣一次（整整 3 秒站著 = 36）
    cooldownTicks: 150,  // 5 秒
    energyCost: 30,
  },
  {
    name: "藤蔓",
    desc: "指定地點短暫預告後長出藤蔓，把範圍內的敵人定身（不能走、不能衝刺）",
    type: "root",        // 指定地點，短暫預告後把範圍內的人定身（不能走、不能衝刺，還是可以放技能）
    ultimate: true,
    range: 170,
    radius: 48,
    fuseTicks: 15,       // 預告 0.5 秒
    damage: 20,
    rootTicks: 45,       // 定身 1.5 秒
    cooldownTicks: 30,
  },

  // ── 金武僧 ──
  {
    name: "氣功波",      // 直線飛行的子彈，會穿透敵人（一排人都打得到，每人只算一次）
    desc: "會穿透敵人的氣功，排成一排的敵人都打得到",
    texture: "qiball",
    impactScale: 1,
    pierce: true,
    speed: 260,
    radius: 6,
    damage: 16,
    cooldownTicks: 18,   // 0.6 秒
    energyCost: 9,
    lifetimeTicks: 30,   // 射程約 260（中距離）
  },
  {
    name: "金鐘罩",
    desc: "罩上護盾，先扣護盾再扣血，時間到或被打破就消失",
    type: "barrier",     // 護盾：先扣護盾再扣血，時間到或被打破就消失
    amount: 40,          // 可以吸收多少傷害
    durationTicks: 90,   // 3 秒
    cooldownTicks: 180,  // 6 秒（從施放開始算，包含護盾存在的 3 秒）
    energyCost: 25,
  },
  {
    name: "獅子吼",
    desc: "以自己為中心震飛周圍的敵人，並震散附近敵人的子彈",
    type: "roar",        // 以自己為中心震開周圍的敵人，順便震散附近敵人的子彈
    ultimate: true,
    radius: 70,
    damage: 25,
    knockSpeed: 360,     // 被震飛的速度（單位／秒）
    knockTicks: 8,       // 飛多久（約 96 單位）；撞到牆或柱子會停
    cooldownTicks: 30,
  },
];

/** 指定地點的技能（拖曳時拖越遠丟越遠，落點用 shared/blast.js 算） */
export const isTargeted = (skill) => ["blast", "meteor", "zone", "root"].includes(skill?.type);

// 技能編號 = 在 SKILLS 裡的索引（火球、爆炸會記錄是哪個技能放的）
SKILLS.forEach((skill, id) => (skill.id = id));

/**
 * 每個角色的技能組，順序 = skin 編號。每組 4 格，對應按鈕位置：
 *   0 普攻（右下大顆） 1 技能（左下） 2 衝刺（右上，每個角色都要放 type: "dash" 的技能） 3 大招（左上）
 * 數字是 SKILLS 的索引。
 */
export const KITS = [
  [0, 1, 2, 3], // 藍法師：火球、爆炎、衝刺、流星雨
  [4, 5, 7, 6], // 紅劍士：揮砍、舉盾、衝刺（冷卻較短）、旋風斬
  [8, 9, 2, 10], // 綠巫師：毒液彈、毒沼、衝刺、藤蔓
  [11, 12, 2, 13], // 金武僧：氣功波、金鐘罩、衝刺、獅子吼
];
export const SLOT_COUNT = 4;
/** 衝刺固定在第 2 格（移動預測 stepEntity 靠這個判斷） */
export const DASH_SLOT = 2;
export const ULTIMATE_SLOT = 3;
/** 一般的衝刺技能（音效、無敵判定用；每個角色的衝刺都是無敵） */
export const DASH_INDEX = KITS[0][DASH_SLOT];

/**
 * 每個角色的基本數值，順序 = skin 編號。沒寫的用預設（PLAYER_MAX_HP、PLAYER_SPEED）。
 * 紅劍士是近戰坦克：血比較厚、跑比較快，才追得上邊退邊射的遠程角色。
 */
export const SKIN_STATS = [
  {},                         // 藍法師
  { maxHp: 150, speed: 150 }, // 紅劍士
  {},                         // 綠巫師
  { maxHp: 120 },             // 金武僧：中距離，比法師耐打一點
];
/** 某個角色的血量上限 */
export const maxHpOf = (skin) => SKIN_STATS[skin]?.maxHp ?? PLAYER_MAX_HP;
/** 移動用的數值：一般速度和衝刺技能（傳給 stepEntity，伺服器和客戶端預測都用同一份） */
export const moveStatsOf = (skin) => ({
  speed: SKIN_STATS[skin]?.speed ?? PLAYER_SPEED,
  dash: kitSkill(skin, DASH_SLOT),
});

/** 某個角色第 slot 格的技能（skin 超出範圍時用第一個角色的） */
export const kitSkill = (skin, slot) => SKILLS[(KITS[skin] ?? KITS[0])[slot]];
/** 某個角色的 4 個技能 */
export const kitOf = (skin) => (KITS[skin] ?? KITS[0]).map((id) => SKILLS[id]);

/**
 * 障礙物（石柱、樹、仙人掌…）。座標是「地面佔地」的中心點，w/h 是佔地大小，會擋人也會擋技能。
 * 圖片比佔地高（有立體感），畫的時候底部對齊佔地底部。
 * 配置上下左右對稱（每個人出生點附近的地形一樣），調整時注意不要擋到出生點。
 */
export const OBSTACLE_SIZE = { w: 24, h: 18 };
const CX = ARENA_WIDTH / 2;
const CY = ARENA_HEIGHT / 2;

/**
 * 地圖：每局開始時伺服器隨機選一張（state.map = 索引）。
 * quarter 只寫左上四分之一的障礙物，其他三個方向鏡射產生（落在中線上的不重複）。
 * 美術（地板、牆、障礙物的圖）在 client/theme.js 的 maps，索引要一致。
 */
export const MAPS = [
  {
    name: "地牢",
    quarter: [
      { x: CX, y: CY },           // 正中間
      { x: CX, y: 160 },          // 上、下中間
      { x: 150, y: CY },          // 左、右中間
      { x: 190, y: 236 },         // 內圈斜角
      { x: 110, y: 170 },         // 靠近出生點的掩護
    ],
  },
  {
    name: "森林",                 // 樹多、路窄，適合繞來繞去躲技能
    quarter: [
      { x: 250, y: 296 },         // 中間一圈四棵
      { x: CX, y: 190 },          // 上、下中間
      { x: 130, y: 300 },         // 左、右中間偏上（鏡射後上下各一）
      { x: 200, y: 120 },         // 上方兩側
      { x: 90, y: 220 },          // 出生點下方的掩護
      { x: 186, y: 236 },         // 內圈斜角
    ],
  },
  {
    name: "沙漠",                 // 空曠、障礙物少，遠程比較吃香
    quarter: [
      { x: CX - 24, y: CY },      // 正中間兩棵並排（像一道短牆）
      { x: CX, y: 150 },          // 上、下中間
      { x: 110, y: CY },          // 左、右中間
      { x: 180, y: 210 },         // 內圈斜角
    ],
  },
].map((m) => ({ ...m, obstacles: mirror(m.quarter) }));

/** 某張地圖的障礙物清單（索引超出範圍時用第一張） */
export const mapObstacles = (mapIndex) => (MAPS[mapIndex] ?? MAPS[0]).obstacles;

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
/** 房號幾位數字（也是 Colyseus 的 roomId，?room=房號 就能加入） */
export const ROOM_CODE_LENGTH = 4;

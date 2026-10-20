import { schema, t } from "@colyseus/schema";

/**
 * 玩家每個 tick 送出的輸入。只送「意圖」，不送位置，避免作弊。
 * 數值範圍由 ArenaRoom 的 sanitize 強制檢查。
 */
export const PlayerInput = schema({
  moveX: t.int8(), // 移動方向，每軸 -INPUT_SCALE ~ INPUT_SCALE（任意角度）
  moveY: t.int8(),
  skill: t.int8(), // 0 = 沒放技能，1..4 = 按了自己技能組（KITS）的第幾格
  aimX: t.int8(),  // 技能瞄準方向；(0, 0) = 自動瞄準最近的敵人
  aimY: t.int8(),
});

export const Player = schema({
  name: t.string(),
  skin: t.uint8(),   // 對應 theme.js 裡的角色外觀編號
  x: t.number(),
  y: t.number(),
  vx: t.number(),
  vy: t.number(),
  faceX: t.int8(),   // 面向（-INPUT_SCALE ~ INPUT_SCALE），決定衝刺方向、沒有敵人時的技能方向
  faceY: t.int8(),
  dashTicks: t.uint8(), // 衝刺剩下幾個 tick（> 0 = 衝刺中，無敵）
  dashCd: t.uint8(),    // 衝刺冷卻剩下幾個 tick
  guardTicks: t.uint8(), // 舉盾剩下幾個 tick（> 0 = 盾牌舉著）
  guardX: t.int8(),      // 盾牌朝向（-INPUT_SCALE ~ INPUT_SCALE）
  guardY: t.int8(),
  whirlTicks: t.uint8(), // 旋風斬剩下幾個 tick
  rootTicks: t.uint8(),  // 被定身剩下幾個 tick（藤蔓），stepEntity 會倒數
  poisonTicks: t.uint8(), // 中毒剩下幾個 tick（毒液彈），客戶端用來把角色染綠
  barrier: t.uint8(),      // 金鐘罩還能吸收多少傷害（0 = 沒有）
  knockTicks: t.uint8(),   // 被擊退剩下幾個 tick（獅子吼），stepEntity 會倒數
  knockX: t.int16(),       // 被擊退的速度（單位／秒）
  knockY: t.int16(),
  hp: t.uint8(),
  energy: t.uint8(), // 能量（伺服器內部用小數累積，這裡同步整數）
  rage: t.uint8(),   // 怒氣，集滿 RAGE.max 可以放大招
  alive: t.boolean(),
  kills: t.uint16(),
  deaths: t.uint16(),
});

export const Projectile = schema({
  owner: t.string(), // 施放者的 sessionId
  skill: t.uint8(),  // SKILLS 陣列索引，客戶端用來決定外觀
  x: t.number(),
  y: t.number(),
  vx: t.number(),
  vy: t.number(),
});

/** 障礙物：索引同 shared/constants.js 的 mapObstacles(state.map)，hp = 0 代表被打壞了 */
export const Pillar = schema({
  hp: t.uint8(),
});

/** 指定地點爆炸：預告中的落點，時間到就爆炸並從 map 移除 */
export const Blast = schema({
  owner: t.string(),
  skill: t.uint8(),
  x: t.number(),
  y: t.number(),
  fuse: t.uint8(),  // 預告幾個 tick 後爆炸（流星雨每顆不同），客戶端用來畫預告進度
});

/** 地上持續一段時間的區域（毒沼）。存在多久看技能的 durationTicks，時間到從 map 移除 */
export const Zone = schema({
  owner: t.string(),
  skill: t.uint8(),
  x: t.number(),
  y: t.number(),
});

export const ArenaState = schema({
  phase: t.string(),       // "waiting" | "countdown" | "playing" | "ended"
  countdown: t.uint8(),    // 倒數 / 結算剩幾秒
  winner: t.string(),      // 獲勝者的 sessionId（ended 時）
  killsToWin: t.uint8(),
  isPrivate: t.boolean(),  // 私人房間：不會被快速配對到，只能用房號加入
  map: t.uint8(),          // 這一局的地圖（shared/constants.js 的 MAPS 索引），每局開始時隨機換
  players: t.map(Player),
  projectiles: t.map(Projectile),
  blasts: t.map(Blast),
  zones: t.map(Zone),
  pillars: t.array(Pillar),
});

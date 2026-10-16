import { schema, t } from "@colyseus/schema";

/**
 * 玩家每個 tick 送出的輸入。只送「意圖」，不送位置，避免作弊。
 * 數值範圍由 ArenaRoom 的 sanitize 強制檢查。
 */
export const PlayerInput = schema({
  moveX: t.int8(),
  moveY: t.int8(),
  skill: t.int8(), // 0 = 沒放技能，1..N = 施放 SKILLS[N-1]
});

export const Player = schema({
  name: t.string(),
  skin: t.uint8(),   // 對應 theme.js 裡的角色外觀編號
  x: t.number(),
  y: t.number(),
  vx: t.number(),
  vy: t.number(),
  faceX: t.int8(),   // 面向，決定技能和衝刺方向
  faceY: t.int8(),
  dashTicks: t.uint8(), // 衝刺剩下幾個 tick（> 0 = 衝刺中，無敵）
  dashCd: t.uint8(),    // 衝刺冷卻剩下幾個 tick
  hp: t.uint8(),
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

export const ArenaState = schema({
  players: t.map(Player),
  projectiles: t.map(Projectile),
});

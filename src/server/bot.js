import { ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF, SKILLS, DASH_INDEX, INPUT_SCALE, TICK_RATE } from "../shared/constants.js";
import { circleHitsObstacle } from "../shared/obstacles.js";
import { aimToward } from "../shared/blast.js";

/**
 * 電腦對手的難度。數值越「準、快」越難，可以直接調。
 */
export const BOT_CONFIG = {
  preferredDistance: [110, 170], // 想和目標保持的距離範圍（太近就退、太遠就追）
  aimErrorDeg: 14,               // 瞄準誤差（±度）
  leadFactor: 0.8,               // 預判走位的程度（0 = 瞄現在位置，1 = 完全預判）
  fireChance: 0.12,              // 每個 tick 冷卻好了、有射線時開火的機率（模擬反應時間）
  blastErrorPx: 14,              // 爆炎落點誤差（±單位）
  blastEscapeChance: 0.6,        // 站在預告圈裡時跑出去的機率（每個預告圈只判斷一次）
  dodgeChance: 0.55,             // 看到火球飛來時有反應的機率（每顆火球只判斷一次）
  dashDodgeChance: 0.5,          // 有反應時用衝刺躲的機率（其他時候只是側移）
  dodgeLookAheadSec: 0.4,        // 火球多久內會打到才閃
  strafeSwitchTicks: [30, 75],   // 繞圈方向多久換一次
  wallMargin: 40,                // 離牆多近就往中間推
};

const FIREBALL_INDEX = SKILLS.findIndex((s) => s.texture === "fireball");
const BLAST_INDEX = SKILLS.findIndex((s) => s.type === "blast");
const ULTIMATE_INDEX = SKILLS.findIndex((s) => s.ultimate);

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = ([min, max]) => Math.floor(rand(min, max + 1));

/** 方向向量轉成輸入用的整數（-INPUT_SCALE ~ INPUT_SCALE） */
function toInput(dx, dy) {
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: 0, y: 0 };
  return { x: Math.round((dx / len) * INPUT_SCALE), y: Math.round((dy / len) * INPUT_SCALE) };
}

/** 兩點之間有沒有被柱子擋住（每 6 單位取樣一次） */
function hasLineOfSight(ax, ay, bx, by, radius) {
  const dist = Math.hypot(bx - ax, by - ay);
  const steps = Math.ceil(dist / 6);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (circleHitsObstacle(ax + (bx - ax) * t, ay + (by - ay) * t, radius)) return false;
  }
  return true;
}

/**
 * 一隻電腦對手的大腦。每個 tick 看一下場上狀況，產生和真人一樣的輸入
 * { moveX, moveY, skill, aimX, aimY }，之後跟真人走完全相同的流程（移動、冷卻、命中）。
 */
export class BotBrain {
  strafeDir = Math.random() < 0.5 ? 1 : -1;
  nextStrafeSwitch = 0;
  /** 已經判斷過要不要閃的火球、預告圈 */
  seenProjectiles = new Set();
  seenBlasts = new Set();
  /** 正在閃避：{ x, y, until }（側移方向、持續到哪個 tick） */
  dodge = null;
  /** 卡住偵測 */
  lastPos = { x: 0, y: 0 };
  stuckTicks = 0;
  unstickUntil = 0;
  unstickDir = { x: 0, y: 0 };

  /**
   * @param {object} ctx { id, player, players, projectiles, blasts, tick, canCast(skillIndex) }
   */
  think({ id, player, players, projectiles, blasts, tick, canCast }) {
    const input = { moveX: 0, moveY: 0, skill: 0, aimX: 0, aimY: 0 };
    const target = this.findTarget(id, player, players);
    const threat = this.findThreat(id, player, projectiles, tick);

    // 1. 閃避飛來的火球（最優先）
    if (threat && !this.dodge) {
      const side = Math.random() < 0.5 ? 1 : -1;
      // 垂直於火球飛行方向
      const dir = { x: -threat.vy * side, y: threat.vx * side };
      this.dodge = { ...toInput(dir.x, dir.y), until: tick + 8 };
      if (Math.random() < BOT_CONFIG.dashDodgeChance && player.dashCd === 0 && DASH_INDEX >= 0) {
        input.skill = DASH_INDEX + 1; // 衝刺方向 = 這個 tick 的移動方向
      }
    }
    if (this.dodge && tick >= this.dodge.until) this.dodge = null;

    // 站在別人的預告圈裡 → 往圈外跑
    const zone = this.findBlastZone(id, player, blasts);
    if (zone) {
      const away = toInput(player.x - zone.x || 1, player.y - zone.y);
      this.dodge = { ...away, until: tick + 6 };
      if (Math.random() < BOT_CONFIG.dashDodgeChance && player.dashCd === 0 && DASH_INDEX >= 0) {
        input.skill = DASH_INDEX + 1;
      }
    }

    // 2. 移動
    let move;
    if (this.dodge) move = { x: this.dodge.x, y: this.dodge.y };
    else if (tick < this.unstickUntil) move = this.unstickDir;
    else move = this.chooseMove(player, target, tick);
    input.moveX = move.x;
    input.moveY = move.y;

    // 3. 攻擊（衝刺的這個 tick 不攻擊，一次只能送一個技能）
    if (!input.skill && target) {
      const shot = this.chooseShot(player, target, canCast);
      if (shot) Object.assign(input, shot);
    }

    this.checkStuck(player, input, tick);
    return input;
  }

  findTarget(id, player, players) {
    let best = null;
    let bestDist = Infinity;
    for (const [otherId, other] of players) {
      if (otherId === id || !other.alive) continue;
      const dist = Math.hypot(other.x - player.x, other.y - player.y);
      if (dist < bestDist) { best = other; bestDist = dist; }
    }
    return best;
  }

  /** 找出接下來會打到自己的火球（每顆只擲一次骰子決定有沒有反應） */
  findThreat(id, player, projectiles, tick) {
    for (const [projectileId, p] of projectiles) {
      if (p.owner === id || this.seenProjectiles.has(projectileId)) continue;
      const rx = player.x - p.x;
      const ry = player.y - p.y;
      const speed2 = p.vx * p.vx + p.vy * p.vy;
      // 最接近的時間點（秒）和那時的距離
      const t = (rx * p.vx + ry * p.vy) / speed2;
      if (t < 0 || t > BOT_CONFIG.dodgeLookAheadSec) continue;
      const missBy = Math.hypot(rx - p.vx * t, ry - p.vy * t);
      if (missBy > PLAYER_HALF + SKILLS[p.skill].radius + 4) continue;

      this.seenProjectiles.add(projectileId);
      if (Math.random() < BOT_CONFIG.dodgeChance) return p;
    }
    // 清掉已經消失的火球紀錄
    if (tick % TICK_RATE === 0) {
      for (const pid of this.seenProjectiles) if (!projectiles.has(pid)) this.seenProjectiles.delete(pid);
    }
    return null;
  }

  /** 自己在不在別人的預告圈裡（每個圈只擲一次骰子決定有沒有反應） */
  findBlastZone(id, player, blasts) {
    for (const [blastId, b] of blasts) {
      if (b.owner === id || this.seenBlasts.has(blastId)) continue;
      const reach = SKILLS[b.skill].radius + PLAYER_HALF + 4;
      if (Math.hypot(player.x - b.x, player.y - b.y) > reach) continue;
      this.seenBlasts.add(blastId);
      if (Math.random() < BOT_CONFIG.blastEscapeChance) return b;
    }
    if (this.seenBlasts.size > 50) this.seenBlasts.clear();
    return null;
  }

  /** 保持距離 + 繞圈 + 離牆遠一點 */
  chooseMove(player, target, tick) {
    if (tick >= this.nextStrafeSwitch) {
      this.strafeDir = Math.random() < 0.5 ? 1 : -1;
      this.nextStrafeSwitch = tick + randInt(BOT_CONFIG.strafeSwitchTicks);
    }
    let dx = 0;
    let dy = 0;

    if (target) {
      const tx = target.x - player.x;
      const ty = target.y - player.y;
      const dist = Math.hypot(tx, ty) || 1;
      const [near, far] = BOT_CONFIG.preferredDistance;
      // 太遠就靠近、太近就後退
      const approach = dist > far ? 1 : dist < near ? -1 : 0;
      dx += (tx / dist) * approach;
      dy += (ty / dist) * approach;
      // 繞著目標側移，比較難被打中
      dx += (-ty / dist) * this.strafeDir * 0.8;
      dy += (tx / dist) * this.strafeDir * 0.8;
    }

    // 太靠牆就往中間推，免得被逼到角落
    const m = BOT_CONFIG.wallMargin;
    if (player.x < m) dx += 1;
    if (player.x > ARENA_WIDTH - m) dx -= 1;
    if (player.y < m) dy += 1;
    if (player.y > ARENA_HEIGHT - m) dy -= 1;

    return toInput(dx, dy);
  }

  /** 冷卻好、看得到目標就開火；瞄準預判走位，再加一點誤差 */
  chooseShot(player, target, canCast) {
    if (Math.random() > BOT_CONFIG.fireChance) return null;
    const dist = Math.hypot(target.x - player.x, target.y - player.y);

    // 大招：怒氣滿了、目標在射程內就放，瞄準目標現在的位置（流星雨範圍大，不用預判太多）
    if (ULTIMATE_INDEX >= 0 && canCast(ULTIMATE_INDEX)) {
      const ult = SKILLS[ULTIMATE_INDEX];
      if (dist < ult.range) {
        const aim = aimToward(player.x, player.y, target.x, target.y, ult);
        return { skill: ULTIMATE_INDEX + 1, aimX: aim.x, aimY: aim.y };
      }
    }

    // 爆炎：目標在射程內就丟，落點預判對手爆炸時會走到哪
    if (BLAST_INDEX >= 0 && canCast(BLAST_INDEX)) {
      const blast = SKILLS[BLAST_INDEX];
      if (dist < blast.range + blast.radius * 0.5) {
        const fuse = (blast.fuseTicks / TICK_RATE) * BOT_CONFIG.leadFactor;
        const err = BOT_CONFIG.blastErrorPx;
        const aim = aimToward(
          player.x, player.y,
          target.x + target.vx * fuse + rand(-err, err),
          target.y + target.vy * fuse + rand(-err, err),
          blast,
        );
        return { skill: BLAST_INDEX + 1, aimX: aim.x, aimY: aim.y };
      }
    }

    const skillIndex = FIREBALL_INDEX;
    if (skillIndex < 0 || !canCast(skillIndex)) return null;

    const skill = SKILLS[skillIndex];
    if (dist > skill.speed * (skill.lifetimeTicks / TICK_RATE)) return null; // 射不到
    if (!hasLineOfSight(player.x, player.y, target.x, target.y, skill.radius)) return null;

    // 預判：火球飛到那裡要多久，目標那時會在哪
    const flight = (dist / skill.speed) * BOT_CONFIG.leadFactor;
    const aimX = target.x + target.vx * flight - player.x;
    const aimY = target.y + target.vy * flight - player.y;
    const error = (rand(-1, 1) * BOT_CONFIG.aimErrorDeg * Math.PI) / 180;
    const angle = Math.atan2(aimY, aimX) + error;
    const aim = toInput(Math.cos(angle), Math.sin(angle));
    // aim 不能剛好是 (0,0)，那代表「自動瞄準」
    return { skill: skillIndex + 1, aimX: aim.x || 1, aimY: aim.y };
  }

  /** 想移動卻一直沒動（卡在柱子上）→ 隨便換個方向走一下 */
  checkStuck(player, input, tick) {
    const moved = Math.hypot(player.x - this.lastPos.x, player.y - this.lastPos.y);
    const wantsMove = input.moveX !== 0 || input.moveY !== 0;
    this.stuckTicks = wantsMove && moved < 0.5 ? this.stuckTicks + 1 : 0;
    this.lastPos = { x: player.x, y: player.y };
    if (this.stuckTicks > 8) {
      const angle = rand(0, Math.PI * 2);
      this.unstickDir = toInput(Math.cos(angle), Math.sin(angle));
      this.unstickUntil = tick + 20;
      this.strafeDir *= -1;
      this.stuckTicks = 0;
    }
  }
}

import { ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF, SKILLS, DASH_SLOT, ULTIMATE_SLOT, INPUT_SCALE, TICK_RATE, kitOf } from "../shared/constants.js";
import { circleHitsObstacle } from "../shared/obstacles.js";
import { aimToward } from "../shared/blast.js";

/**
 * 電腦對手的難度。數值越「準、快」越難，可以直接調。
 */
export const BOT_CONFIG = {
  preferredDistance: [110, 170], // 想和目標保持的距離範圍（太近就退、太遠就追）
  aimErrorDeg: 22,               // 瞄準誤差（±度）
  leadFactor: 0.45,              // 預判走位的程度（0 = 瞄現在位置，1 = 完全預判）
  fireChance: 0.07,              // 每個 tick 冷卻好了、有射線時開火的機率（模擬反應時間）
  blastErrorPx: 24,              // 爆炎落點誤差（±單位）
  blastEscapeChance: 0.45,       // 站在預告圈裡時跑出去的機率（每個預告圈只判斷一次）
  dodgeChance: 0.3,              // 看到火球飛來時有反應的機率（每顆火球只判斷一次）
  dashDodgeChance: 0.3,          // 有反應時用衝刺躲的機率（其他時候只是側移）
  dodgeLookAheadSec: 0.4,        // 火球多久內會打到才閃
  strafeSwitchTicks: [30, 75],   // 繞圈方向多久換一次
  strafeWeight: 0.5,             // 繞圈側移的力道（越大越難打中）
  standChance: 0.35,             // 每次換方向時，這段時間改成站著不側移的機率（像真人停下來打）
  wallMargin: 40,                // 離牆多近就往中間推
  midDistance: [70, 130],        // 中距離角色（子彈射程短，例如金武僧）想保持的距離
  // 近戰角色（紅劍士）
  meleeDistance: [0, 30],        // 近戰想貼多近
  guardChance: 0.5,              // 看到攻擊來時舉盾的機率（盾牌冷卻好才會舉）
  gapCloseChance: 0.04,          // 每個 tick 衝刺拉近距離的機率（目標在 gapCloseRange 內時）
  gapCloseRange: [70, 140],
  slashErrorDeg: 16,             // 揮砍方向誤差
};

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = ([min, max]) => Math.floor(rand(min, max + 1));

/** 方向向量轉成輸入用的整數（-INPUT_SCALE ~ INPUT_SCALE） */
function toInput(dx, dy) {
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: 0, y: 0 };
  return { x: Math.round((dx / len) * INPUT_SCALE), y: Math.round((dy / len) * INPUT_SCALE) };
}

/** 兩點之間有沒有被（還在的）柱子擋住（每 6 單位取樣一次） */
function hasLineOfSight(ax, ay, bx, by, radius, solid) {
  const dist = Math.hypot(bx - ax, by - ay);
  const steps = Math.ceil(dist / 6);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (circleHitsObstacle(ax + (bx - ax) * t, ay + (by - ay) * t, radius, solid)) return false;
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
   * @param {object} ctx { id, player, players, projectiles, blasts, zones, solid, tick, canCast(slot) }
   *   zones = 別人的毒沼（ArenaRoom.slowZonesFor）
   */
  think({ id, player, players, projectiles, blasts, zones = [], solid, tick, canCast }) {
    const input = { moveX: 0, moveY: 0, skill: 0, aimX: 0, aimY: 0 };
    const target = this.findTarget(id, player, players);
    const threat = this.findThreat(id, player, projectiles, tick);
    // 這隻電腦的技能組：每種技能在第幾格（沒有就是 -1）
    const kit = kitOf(player.skin);
    const slotOf = (type) => kit.findIndex((s) => s.type === type);
    const guardSlot = slotOf("guard") >= 0 ? slotOf("guard") : slotOf("barrier");
    const melee = slotOf("slash") >= 0;
    // 子彈射程（決定要保持多遠）
    const shot = kit.find((s) => !s.type);
    const shotRange = shot ? shot.speed * (shot.lifetimeTicks / TICK_RATE) : 0;
    const distance = melee ? BOT_CONFIG.meleeDistance : shotRange < 280 ? BOT_CONFIG.midDistance : BOT_CONFIG.preferredDistance;
    // 有盾牌（舉盾、金鐘罩）、冷卻好了：朝攻擊來的方向舉盾（取代閃避）
    const tryGuard = (fromX, fromY) => {
      if (guardSlot < 0 || !canCast(guardSlot) || Math.random() > BOT_CONFIG.guardChance) return false;
      const aim = toInput(fromX - player.x, fromY - player.y);
      Object.assign(input, { skill: guardSlot + 1, aimX: aim.x || 1, aimY: aim.y });
      return true;
    };

    // 1. 閃避飛來的火球（最優先）
    if (threat && !this.dodge && !tryGuard(threat.x, threat.y)) {
      const side = Math.random() < 0.5 ? 1 : -1;
      // 垂直於火球飛行方向
      const dir = { x: -threat.vy * side, y: threat.vx * side };
      this.dodge = { ...toInput(dir.x, dir.y), until: tick + 8 };
      if (Math.random() < BOT_CONFIG.dashDodgeChance && player.dashCd === 0) {
        input.skill = DASH_SLOT + 1; // 衝刺方向 = 這個 tick 的移動方向
      }
    }
    if (this.dodge && tick >= this.dodge.until) this.dodge = null;

    // 站在別人的預告圈裡 → 往圈外跑
    const zone = this.findBlastZone(id, player, blasts);
    if (zone && !input.skill && tryGuard(zone.x, zone.y)) {
      // 舉盾擋爆炸，不用跑
    } else if (zone) {
      const away = toInput(player.x - zone.x || 1, player.y - zone.y);
      this.dodge = { ...away, until: tick + 6 };
      if (Math.random() < BOT_CONFIG.dashDodgeChance && player.dashCd === 0) {
        input.skill = DASH_SLOT + 1;
      }
    }

    // 站在別人的毒沼裡 → 往外走（毒沼一直都看得到，不用擲骰子）
    const swamp = zones.find((z) => (player.x - z.x) ** 2 + (player.y - z.y) ** 2 <= (z.radius + 4) ** 2);
    if (swamp && !this.dodge) this.dodge = { ...toInput(player.x - swamp.x || 1, player.y - swamp.y), until: tick + 6 };

    // 2. 移動
    let move;
    if (this.dodge) move = { x: this.dodge.x, y: this.dodge.y };
    else if (tick < this.unstickUntil) move = this.unstickDir;
    else move = this.chooseMove(player, target, tick, distance);
    input.moveX = move.x;
    input.moveY = move.y;

    // 3. 攻擊（衝刺的這個 tick 不攻擊，一次只能送一個技能）
    if (!input.skill && target) {
      const shot = this.chooseShot(player, target, canCast, solid, kit);
      if (shot) Object.assign(input, shot);
    }
    // 近戰：距離中等時衝過去（衝刺方向 = 移動方向，這時正往目標走）
    if (!input.skill && target && melee && player.dashCd === 0 && Math.random() < BOT_CONFIG.gapCloseChance) {
      const dist = Math.hypot(target.x - player.x, target.y - player.y);
      const [min, max] = BOT_CONFIG.gapCloseRange;
      if (dist > min && dist < max && !this.dodge) {
        const toward = toInput(target.x - player.x, target.y - player.y);
        Object.assign(input, { moveX: toward.x, moveY: toward.y, skill: DASH_SLOT + 1 });
      }
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
  chooseMove(player, target, tick, [near, far]) {
    if (tick >= this.nextStrafeSwitch) {
      // 0 = 這段時間不側移（站著打），比較好被打中
      this.strafeDir = Math.random() < BOT_CONFIG.standChance ? 0 : Math.random() < 0.5 ? 1 : -1;
      this.nextStrafeSwitch = tick + randInt(BOT_CONFIG.strafeSwitchTicks);
    }
    let dx = 0;
    let dy = 0;

    if (target) {
      const tx = target.x - player.x;
      const ty = target.y - player.y;
      const dist = Math.hypot(tx, ty) || 1;
      // 太遠就靠近、太近就後退
      const approach = dist > far ? 1 : dist < near ? -1 : 0;
      dx += (tx / dist) * approach;
      dy += (ty / dist) * approach;
      // 繞著目標側移，比較難被打中
      dx += (-ty / dist) * this.strafeDir * BOT_CONFIG.strafeWeight;
      dy += (tx / dist) * this.strafeDir * BOT_CONFIG.strafeWeight;
    }

    // 太靠牆就往中間推，免得被逼到角落
    const m = BOT_CONFIG.wallMargin;
    if (player.x < m) dx += 1;
    if (player.x > ARENA_WIDTH - m) dx -= 1;
    if (player.y < m) dy += 1;
    if (player.y > ARENA_HEIGHT - m) dy -= 1;

    return toInput(dx, dy);
  }

  /**
   * 冷卻好、打得到目標就出招；瞄準預判走位，再加一點誤差。
   * 依技能組裡有什麼技能決定怎麼打（回傳的 skill 是格子編號 + 1）。
   */
  chooseShot(player, target, canCast, solid, kit) {
    if (Math.random() > BOT_CONFIG.fireChance) return null;
    const dist = Math.hypot(target.x - player.x, target.y - player.y);
    const slotOf = (test) => kit.findIndex(test);

    // 大招：怒氣滿了、目標在範圍內就放
    const ult = kit[ULTIMATE_SLOT];
    if (ult && canCast(ULTIMATE_SLOT)) {
      // 流星雨：瞄準目標現在的位置（範圍大，不用預判太多）
      if (ult.type === "meteor" && dist < ult.range) {
        const aim = aimToward(player.x, player.y, target.x, target.y, ult);
        return { skill: ULTIMATE_SLOT + 1, aimX: aim.x, aimY: aim.y };
      }
      // 藤蔓：預判對手預告結束時的位置
      if (ult.type === "root" && dist < ult.range) {
        const fuse = (ult.fuseTicks / TICK_RATE) * BOT_CONFIG.leadFactor;
        const aim = aimToward(player.x, player.y, target.x + target.vx * fuse, target.y + target.vy * fuse, ult);
        return { skill: ULTIMATE_SLOT + 1, aimX: aim.x, aimY: aim.y };
      }
      // 旋風斬、獅子吼：貼近了才放
      if ((ult.type === "whirl" || ult.type === "roar") && dist < ult.radius + PLAYER_HALF - 6) return { skill: ULTIMATE_SLOT + 1, aimX: 0, aimY: 0 };
    }

    // 爆炎、毒沼：目標在射程內就丟，落點預判對手爆炸時（毒沼是幾個 tick 後）會走到哪
    const blastSlot = slotOf((s) => s.type === "blast" || s.type === "zone");
    if (blastSlot >= 0 && canCast(blastSlot)) {
      const blast = kit[blastSlot];
      if (dist < blast.range + blast.radius * 0.5) {
        const fuse = ((blast.fuseTicks ?? 6) / TICK_RATE) * BOT_CONFIG.leadFactor;
        const err = BOT_CONFIG.blastErrorPx;
        const aim = aimToward(
          player.x, player.y,
          target.x + target.vx * fuse + rand(-err, err),
          target.y + target.vy * fuse + rand(-err, err),
          blast,
        );
        return { skill: blastSlot + 1, aimX: aim.x, aimY: aim.y };
      }
    }

    // 揮砍：刀子搆得到才砍
    const slashSlot = slotOf((s) => s.type === "slash");
    if (slashSlot >= 0 && canCast(slashSlot) && dist < kit[slashSlot].range + PLAYER_HALF - 4) {
      const error = (rand(-1, 1) * BOT_CONFIG.slashErrorDeg * Math.PI) / 180;
      const angle = Math.atan2(target.y - player.y, target.x - player.x) + error;
      const aim = toInput(Math.cos(angle), Math.sin(angle));
      return { skill: slashSlot + 1, aimX: aim.x || 1, aimY: aim.y };
    }

    // 子彈（沒有 type 的就是直線飛行的子彈，例如火球）
    const shotSlot = slotOf((s) => !s.type);
    if (shotSlot < 0 || !canCast(shotSlot)) return null;

    const skill = kit[shotSlot];
    if (dist > skill.speed * (skill.lifetimeTicks / TICK_RATE)) return null; // 射不到
    if (!hasLineOfSight(player.x, player.y, target.x, target.y, skill.radius, solid)) return null;

    // 預判：火球飛到那裡要多久，目標那時會在哪
    const flight = (dist / skill.speed) * BOT_CONFIG.leadFactor;
    const aimX = target.x + target.vx * flight - player.x;
    const aimY = target.y + target.vy * flight - player.y;
    const error = (rand(-1, 1) * BOT_CONFIG.aimErrorDeg * Math.PI) / 180;
    const angle = Math.atan2(aimY, aimX) + error;
    const aim = toInput(Math.cos(angle), Math.sin(angle));
    // aim 不能剛好是 (0,0)，那代表「自動瞄準」
    return { skill: shotSlot + 1, aimX: aim.x || 1, aimY: aim.y };
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

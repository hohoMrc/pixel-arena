import { Room } from "colyseus";
import { ArenaState, Player, PlayerInput, Projectile } from "./schema.js";
import { stepEntity } from "../../shared/movement.js";
import { circleHitsObstacle } from "../../shared/obstacles.js";
import {
  TICK_RATE, ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF, PLAYER_MAX_HP,
  RESPAWN_TICKS, SKILLS, DASH_INDEX, SPAWN_POINTS, MAX_PLAYERS, ROUND, INPUT_SCALE,
  SKIN_COUNT, NAME_MAX_LENGTH,
} from "../../shared/constants.js";

/** 不能動的時候（死亡、倒數、結算）用的空輸入 */
const IDLE_INPUT = { moveX: 0, moveY: 0, skill: 0, aimX: 0, aimY: 0 };

/** 去掉控制字元和前後空白，限制長度（用 Array.from 才不會把 emoji 切一半） */
function cleanName(raw) {
  const text = String(raw ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return Array.from(text).slice(0, NAME_MAX_LENGTH).join("");
}

/**
 * 對戰房間：伺服器說了算。
 * 客戶端只送輸入，移動、命中、扣血、復活、勝負全部在這裡計算。
 *
 * 一局的流程（state.phase）：
 *   waiting   不到 ROUND.minPlayers 人，可以自由練習，不計分
 *   countdown 倒數，所有人回出生點、不能動
 *   playing   對戰中，先拿到 ROUND.killsToWin 殺的獲勝
 *   ended     結算，顯示勝利者，時間到自動開下一局
 */
export class ArenaRoom extends Room {
  maxClients = MAX_PLAYERS;
  state = new ArenaState();

  // 每個玩家的輸入緩衝；sanitize 會把超出範圍的值夾回來（防竄改）
  inputs = this.defineInput(PlayerInput, {
    bufferMaxSize: 64,
    sanitize: {
      moveX: [-INPUT_SCALE, INPUT_SCALE], moveY: [-INPUT_SCALE, INPUT_SCALE],
      aimX: [-INPUT_SCALE, INPUT_SCALE], aimY: [-INPUT_SCALE, INPUT_SCALE],
      skill: [0, SKILLS.length],
    },
  });

  tick = 0;
  nextProjectileId = 0;
  joinCount = 0;
  /** 目前階段在哪個 tick 結束（倒數、結算用） */
  phaseEndTick = 0;
  /** 不需要同步給客戶端的玩家資料：sessionId → { spawn, lastCastTick[], respawnTick } */
  meta = new Map();
  /** 火球到期時間：projectileId → tick */
  projectileExpire = new Map();

  onCreate() {
    this.state.phase = "waiting";
    this.state.killsToWin = ROUND.killsToWin;
    // 狀態同步頻率跟模擬頻率一致（預設是 50ms = 每秒 20 次），網路不穩時畫面能拿到更多樣本
    this.patchRate = 1000 / TICK_RATE;
    this.setFixedTimestep((ctx) => this.step(ctx), TICK_RATE);
  }

  onJoin(client, options) {
    const index = this.joinCount++;
    const spawn = SPAWN_POINTS[index % SPAWN_POINTS.length];
    // 名稱、角色由玩家在進場畫面選，伺服器再檢查一次（不能相信客戶端送來的值）
    const name = cleanName(options?.name) || `P${index + 1}`;
    const skin = Number.isInteger(options?.skin) && options.skin >= 0 && options.skin < SKIN_COUNT
      ? options.skin
      : index % SKIN_COUNT;

    this.state.players.set(client.sessionId, new Player({
      name,
      skin,
      x: spawn.x, y: spawn.y, vx: 0, vy: 0,
      faceX: spawn.x < ARENA_WIDTH / 2 ? INPUT_SCALE : -INPUT_SCALE, faceY: 0, dashTicks: 0, dashCd: 0,
      hp: PLAYER_MAX_HP, alive: true, kills: 0, deaths: 0,
    }));
    this.meta.set(client.sessionId, { spawn, lastCastTick: SKILLS.map(() => -Infinity), respawnTick: 0 });
    console.log(`[${this.roomId}] ${name} 加入`);
    this.checkPlayerCount();
  }

  onLeave(client) {
    this.state.players.delete(client.sessionId);
    this.meta.delete(client.sessionId);
    this.checkPlayerCount();
  }

  /** 人數夠了就開始倒數；對戰中人數不夠就回到等待 */
  checkPlayerCount() {
    this.removeGhostPlayers();
    if (!this.state.phase) this.state.phase = "waiting";
    const enough = this.state.players.size >= ROUND.minPlayers;
    if (this.state.phase === "waiting" && enough) this.startCountdown();
    else if (!enough && this.state.phase !== "waiting") this.setPhase("waiting");
  }

  /**
   * 開發模式重啟伺服器時，Colyseus 會從 .devmode.json 還原房間，
   * 但只還原同步狀態（state），不會還原 meta（出生點等）。
   * 這些玩家的連線早就斷了，沒有 meta 的就是這種「幽靈玩家」，直接移除。
   */
  removeGhostPlayers() {
    for (const id of [...this.state.players.keys()]) {
      if (!this.meta.has(id)) {
        console.log(`[${this.roomId}] 移除還原留下的玩家 ${this.state.players.get(id)?.name}`);
        this.state.players.delete(id);
      }
    }
  }

  setPhase(phase, durationTicks = 0) {
    this.state.phase = phase;
    this.phaseEndTick = this.tick + durationTicks;
    this.updateCountdown();
  }

  startCountdown() {
    this.resetRound();
    this.state.winner = "";
    this.setPhase("countdown", ROUND.countdownTicks);
  }

  endRound(winnerId) {
    this.state.winner = winnerId;
    this.clearProjectiles();
    this.setPhase("ended", ROUND.endTicks);
    console.log(`[${this.roomId}] ${this.state.players.get(winnerId)?.name} 獲勝`);
  }

  /** 所有人回出生點、補滿血、分數和冷卻歸零 */
  resetRound() {
    for (const [id, player] of this.state.players) {
      const meta = this.meta.get(id);
      Object.assign(player, {
        x: meta.spawn.x, y: meta.spawn.y, vx: 0, vy: 0,
        faceX: meta.spawn.x < ARENA_WIDTH / 2 ? INPUT_SCALE : -INPUT_SCALE, faceY: 0, dashTicks: 0, dashCd: 0,
        hp: PLAYER_MAX_HP, alive: true, kills: 0, deaths: 0,
      });
      meta.lastCastTick = SKILLS.map(() => -Infinity);
    }
    this.clearProjectiles();
  }

  clearProjectiles() {
    this.state.projectiles.clear();
    this.projectileExpire.clear();
  }

  /** 倒數 / 結算剩幾秒（只在數字變了才會同步給客戶端） */
  updateCountdown() {
    const ticksLeft = Math.max(0, this.phaseEndTick - this.tick);
    this.state.countdown = Math.ceil(ticksLeft / TICK_RATE);
  }

  step(ctx) {
    this.tick++;

    // 0. 階段時間到
    if (this.tick >= this.phaseEndTick) {
      if (this.state.phase === "countdown") this.setPhase("playing");
      else if (this.state.phase === "ended") {
        if (this.state.players.size >= ROUND.minPlayers) this.startCountdown();
        else { this.resetRound(); this.setPhase("waiting"); }
      }
    }
    this.updateCountdown();

    // 倒數和結算時不能動、不能放技能
    const frozen = this.state.phase === "countdown" || this.state.phase === "ended";

    // 1. 處理每個玩家的輸入：移動 + 施放技能
    for (const [id, player] of this.state.players) {
      const channel = this.inputs.get(id);
      if (!channel) continue;

      for (const input of channel) {
        // 不能動時當作沒有輸入，但仍要跑 stepEntity（冷卻倒數），才會和客戶端預測一致
        const canAct = player.alive && !frozen;
        stepEntity(player, canAct ? input : IDLE_INPUT, ctx.dt);
        if (canAct && input.skill > 0) this.tryCastSkill(id, player, input.skill - 1, input);
      }
    }

    // 2. 移動火球、判定命中
    this.updateProjectiles(ctx.dt);

    // 3. 復活
    for (const [id, player] of this.state.players) {
      const meta = this.meta.get(id);
      if (!player.alive && this.tick >= meta.respawnTick) {
        Object.assign(player, { x: meta.spawn.x, y: meta.spawn.y, vx: 0, vy: 0, hp: PLAYER_MAX_HP, alive: true, dashTicks: 0, dashCd: 0 });
      }
    }
  }

  tryCastSkill(id, player, skillIndex, input) {
    const skill = SKILLS[skillIndex];
    if (!skill || skill.type === "dash") return; // 衝刺在 stepEntity 處理
    const meta = this.meta.get(id);
    if (this.tick - meta.lastCastTick[skillIndex] < skill.cooldownTicks) return;
    meta.lastCastTick[skillIndex] = this.tick;

    const [dirX, dirY] = this.aimDirection(id, player, input);
    const projectileId = String(this.nextProjectileId++);

    this.state.projectiles.set(projectileId, new Projectile({
      owner: id,
      skill: skillIndex,
      x: player.x + dirX * (PLAYER_HALF + skill.radius + 1),
      y: player.y + dirY * (PLAYER_HALF + skill.radius + 1),
      vx: dirX * skill.speed,
      vy: dirY * skill.speed,
    }));
    this.projectileExpire.set(projectileId, this.tick + skill.lifetimeTicks);
  }

  /**
   * 技能方向（單位向量）：
   *   有拖曳瞄準 → 照玩家瞄的方向
   *   輕點 → 自動瞄準最近的敵人（用伺服器上的真實位置，比客戶端看到的準）
   *   場上沒有敵人 → 面向
   */
  aimDirection(id, player, input) {
    let dx = input.aimX;
    let dy = input.aimY;
    if (dx === 0 && dy === 0) {
      const target = this.nearestEnemy(id, player);
      if (target) { dx = target.x - player.x; dy = target.y - player.y; }
      else { dx = player.faceX; dy = player.faceY; }
    }
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  }

  nearestEnemy(id, player) {
    let best = null;
    let bestDist = Infinity;
    for (const [otherId, other] of this.state.players) {
      if (otherId === id || !other.alive) continue;
      const dist = Math.hypot(other.x - player.x, other.y - player.y);
      if (dist < bestDist) { best = other; bestDist = dist; }
    }
    return best;
  }

  updateProjectiles(dt) {
    for (const [projectileId, p] of this.state.projectiles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      const outOfArena = p.x < 0 || p.y < 0 || p.x > ARENA_WIDTH || p.y > ARENA_HEIGHT;
      const blocked = circleHitsObstacle(p.x, p.y, SKILLS[p.skill].radius);
      const expired = this.tick >= this.projectileExpire.get(projectileId);
      const target = blocked ? null : this.findHit(p);

      if (target || blocked || outOfArena || expired) {
        // 通知所有人播特效：hit = 打中人（爆炸），否則是撞牆或時間到（冒煙）
        this.broadcast("impact", { x: Math.round(p.x), y: Math.round(p.y), skill: p.skill, hit: !!target });
        this.state.projectiles.delete(projectileId);
        this.projectileExpire.delete(projectileId);
      }
      // 扣血放在刪除之後：致勝一擊會清空所有火球
      if (target) this.applyDamage(target.id, target.player, p.owner, SKILLS[p.skill].damage);
      if (this.state.phase === "ended") return;
    }
  }

  /** 圓形碰撞：找出第一個被打中的敵人 */
  findHit(p) {
    const radius = SKILLS[p.skill].radius;
    for (const [id, player] of this.state.players) {
      if (id === p.owner || !player.alive) continue;
      if (player.dashTicks > 0 && SKILLS[DASH_INDEX]?.invulnerable) continue; // 衝刺中閃過
      if (Math.hypot(player.x - p.x, player.y - p.y) <= PLAYER_HALF + radius) {
        return { id, player };
      }
    }
    return null;
  }

  applyDamage(targetId, target, attackerId, damage) {
    target.hp = Math.max(0, target.hp - damage);
    if (target.hp > 0) return;

    target.alive = false;
    target.dashTicks = 0;
    this.meta.get(targetId).respawnTick = this.tick + RESPAWN_TICKS;

    // 只有正式對戰中才計分（等待中的練習不算）
    if (this.state.phase !== "playing") return;
    target.deaths++;
    const attacker = this.state.players.get(attackerId);
    if (!attacker) return;
    attacker.kills++;
    if (attacker.kills >= ROUND.killsToWin) this.endRound(attackerId);
  }
}

import { Room } from "colyseus";
import { ArenaState, Player, PlayerInput, Projectile } from "./schema.js";
import { stepEntity } from "../../shared/movement.js";
import { circleHitsObstacle } from "../../shared/obstacles.js";
import {
  TICK_RATE, ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF, PLAYER_MAX_HP,
  RESPAWN_TICKS, SKILLS, SPAWN_POINTS, MAX_PLAYERS,
} from "../../shared/constants.js";

/**
 * 對戰房間：伺服器說了算。
 * 客戶端只送輸入，移動、命中、扣血、復活全部在這裡計算。
 */
export class ArenaRoom extends Room {
  maxClients = MAX_PLAYERS;
  state = new ArenaState();

  // 每個玩家的輸入緩衝；sanitize 會把超出範圍的值夾回來（防竄改）
  inputs = this.defineInput(PlayerInput, {
    bufferMaxSize: 64,
    sanitize: { moveX: [-1, 1], moveY: [-1, 1], skill: [0, SKILLS.length] },
  });

  tick = 0;
  nextProjectileId = 0;
  joinCount = 0;
  /** 不需要同步給客戶端的玩家資料：sessionId → { spawn, lastCastTick[], respawnTick } */
  meta = new Map();
  /** 火球到期時間：projectileId → tick */
  projectileExpire = new Map();

  onCreate() {
    this.setFixedTimestep((ctx) => this.step(ctx), TICK_RATE);
  }

  onJoin(client, options) {
    const index = this.joinCount++;
    const spawn = SPAWN_POINTS[index % SPAWN_POINTS.length];
    const name = String(options?.name || `P${index + 1}`).slice(0, 12);

    this.state.players.set(client.sessionId, new Player({
      name,
      skin: index % SPAWN_POINTS.length,
      x: spawn.x, y: spawn.y, vx: 0, vy: 0,
      faceX: spawn.x < ARENA_WIDTH / 2 ? 1 : -1, faceY: 0,
      hp: PLAYER_MAX_HP, alive: true, kills: 0, deaths: 0,
    }));
    this.meta.set(client.sessionId, { spawn, lastCastTick: SKILLS.map(() => -Infinity), respawnTick: 0 });
    console.log(`[${this.roomId}] ${name} 加入`);
  }

  onLeave(client) {
    this.state.players.delete(client.sessionId);
    this.meta.delete(client.sessionId);
  }

  step(ctx) {
    this.tick++;

    // 1. 處理每個玩家的輸入：移動 + 施放技能
    for (const [id, player] of this.state.players) {
      const channel = this.inputs.get(id);
      if (!channel) continue;

      for (const input of channel) {
        if (!player.alive) continue; // 死亡時丟棄輸入
        stepEntity(player, input, ctx.dt);

        if (input.moveX !== 0 || input.moveY !== 0) {
          player.faceX = input.moveX;
          player.faceY = input.moveY;
        }
        if (input.skill > 0) this.tryCastSkill(id, player, input.skill - 1);
      }
    }

    // 2. 移動火球、判定命中
    this.updateProjectiles(ctx.dt);

    // 3. 復活
    for (const [id, player] of this.state.players) {
      const meta = this.meta.get(id);
      if (!player.alive && this.tick >= meta.respawnTick) {
        Object.assign(player, { x: meta.spawn.x, y: meta.spawn.y, vx: 0, vy: 0, hp: PLAYER_MAX_HP, alive: true });
      }
    }
  }

  tryCastSkill(id, player, skillIndex) {
    const skill = SKILLS[skillIndex];
    const meta = this.meta.get(id);
    if (!skill || this.tick - meta.lastCastTick[skillIndex] < skill.cooldownTicks) return;
    meta.lastCastTick[skillIndex] = this.tick;

    const len = Math.hypot(player.faceX, player.faceY) || 1;
    const dirX = player.faceX / len;
    const dirY = player.faceY / len;
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

  updateProjectiles(dt) {
    for (const [projectileId, p] of this.state.projectiles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      const outOfArena = p.x < 0 || p.y < 0 || p.x > ARENA_WIDTH || p.y > ARENA_HEIGHT;
      const blocked = circleHitsObstacle(p.x, p.y, SKILLS[p.skill].radius);
      const expired = this.tick >= this.projectileExpire.get(projectileId);
      const target = blocked ? null : this.findHit(p);

      if (target) this.applyDamage(target.id, target.player, p.owner, SKILLS[p.skill].damage);
      if (target || blocked || outOfArena || expired) {
        // 通知所有人播特效：hit = 打中人（爆炸），否則是撞牆或時間到（冒煙）
        this.broadcast("impact", { x: Math.round(p.x), y: Math.round(p.y), skill: p.skill, hit: !!target });
        this.state.projectiles.delete(projectileId);
        this.projectileExpire.delete(projectileId);
      }
    }
  }

  /** 圓形碰撞：找出第一個被打中的敵人 */
  findHit(p) {
    const radius = SKILLS[p.skill].radius;
    for (const [id, player] of this.state.players) {
      if (id === p.owner || !player.alive) continue;
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
    target.deaths++;
    this.meta.get(targetId).respawnTick = this.tick + RESPAWN_TICKS;

    const attacker = this.state.players.get(attackerId);
    if (attacker) attacker.kills++;
  }
}

import { Room } from "colyseus";
import { ArenaState, Player, PlayerInput, Projectile, Blast, Pillar } from "./schema.js";
import { stepEntity } from "../../shared/movement.js";
import { OBSTACLE_RECTS, obstacleIndexHitByCircle, circleOverlapsRect, obstacleHitByBox } from "../../shared/obstacles.js";
import { BotBrain } from "../bot.js";
import { blastTarget, aimToward, meteorTargets } from "../../shared/blast.js";
import {
  TICK_RATE, ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF, PLAYER_MAX_HP,
  RESPAWN_TICKS, SKILLS, DASH_INDEX, SPAWN_POINTS, MAX_PLAYERS, ROUND, INPUT_SCALE,
  SKIN_COUNT, NAME_MAX_LENGTH, ENERGY, RAGE, OBSTACLES, PILLAR,
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
 *
 * 電腦對手：等待時玩家可以按「跟電腦對戰」加入一隻（addBot 訊息）。
 * 電腦是 state.players 裡的一般玩家，只是輸入由 bot.js 產生；有真人加入時電腦會讓位。
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
  botCount = 0;
  /** 不需要同步給客戶端的玩家資料：sessionId → { spawn, lastCastTick[], respawnTick, brain? }（brain = 電腦對手） */
  meta = new Map();
  /** 火球到期時間：projectileId → tick */
  projectileExpire = new Map();
  /** 爆炸時間：blastId → tick */
  blastDetonate = new Map();
  /** 每根柱子還在不在（每個 tick 從 state.pillars 更新），傳給移動和碰撞判定 */
  solid = OBSTACLES.map(() => true);
  /** 打壞的柱子哪個 tick 長回來 */
  pillarRespawnTick = OBSTACLES.map(() => 0);

  onCreate() {
    this.state.phase = "waiting";
    this.state.killsToWin = ROUND.killsToWin;
    this.ensurePillars();
    // 狀態同步頻率跟模擬頻率一致（預設是 50ms = 每秒 20 次），網路不穩時畫面能拿到更多樣本
    this.patchRate = 1000 / TICK_RATE;
    this.setFixedTimestep((ctx) => this.step(ctx), TICK_RATE);
    this.onMessage("addBot", () => this.addBot());
  }

  onJoin(client, options) {
    // 有電腦在場就請它讓位，這一局重新開始
    const replacedBot = this.removeOneBot();

    const index = this.joinCount++;
    const spawn = this.pickSpawn(index);
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
      hp: PLAYER_MAX_HP, alive: true, kills: 0, deaths: 0, energy: ENERGY.max, rage: 0,
    }));
    this.meta.set(client.sessionId, { spawn, lastCastTick: SKILLS.map(() => -Infinity), respawnTick: 0, energy: ENERGY.max });
    console.log(`[${this.roomId}] ${name} 加入`);
    if (replacedBot && this.state.phase !== "waiting") this.startCountdown();
    else this.checkPlayerCount();
  }

  /** 加入一隻電腦對手（只在等待中、還有空位時） */
  addBot() {
    if (this.state.phase !== "waiting" || this.state.players.size >= MAX_PLAYERS) return;
    const id = `bot-${++this.botCount}`;
    const spawn = this.pickSpawn(this.joinCount++);
    // 盡量選和其他人不一樣的外觀
    const usedSkins = new Set([...this.state.players.values()].map((p) => p.skin));
    const freeSkins = [...Array(SKIN_COUNT).keys()].filter((s) => !usedSkins.has(s));
    const pool = freeSkins.length ? freeSkins : [...Array(SKIN_COUNT).keys()];
    const skin = pool[Math.floor(Math.random() * pool.length)];

    this.state.players.set(id, new Player({
      name: `電腦${this.botCount}`,
      skin,
      x: spawn.x, y: spawn.y, vx: 0, vy: 0,
      faceX: spawn.x < ARENA_WIDTH / 2 ? INPUT_SCALE : -INPUT_SCALE, faceY: 0, dashTicks: 0, dashCd: 0,
      hp: PLAYER_MAX_HP, alive: true, kills: 0, deaths: 0, energy: ENERGY.max, rage: 0,
    }));
    this.meta.set(id, { spawn, lastCastTick: SKILLS.map(() => -Infinity), respawnTick: 0, energy: ENERGY.max, brain: new BotBrain() });
    console.log(`[${this.roomId}] 加入電腦對手 ${id}`);
    this.checkPlayerCount();
  }

  /** 移除一隻電腦，回傳是否有移除 */
  removeOneBot() {
    const botId = [...this.meta.keys()].find((id) => this.meta.get(id).brain);
    if (!botId) return false;
    this.state.players.delete(botId);
    this.meta.delete(botId);
    console.log(`[${this.roomId}] 電腦對手 ${botId} 讓位給真人`);
    return true;
  }

  /** 選一個沒人用的出生點（都有人用時才依加入順序輪流） */
  pickSpawn(index) {
    const used = new Set([...this.meta.values()].map((m) => m.spawn));
    return SPAWN_POINTS.find((s) => !used.has(s)) ?? SPAWN_POINTS[index % SPAWN_POINTS.length];
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

  /** 每根柱子一筆血量（開發模式從舊版狀態還原時可能沒有，補上） */
  ensurePillars() {
    while (this.state.pillars.length < OBSTACLES.length) this.state.pillars.push(new Pillar({ hp: PILLAR.hp }));
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

  /** 所有人回出生點、補滿血和能量，分數、怒氣、冷卻歸零 */
  resetRound() {
    for (const [id, player] of this.state.players) {
      const meta = this.meta.get(id);
      Object.assign(player, {
        x: meta.spawn.x, y: meta.spawn.y, vx: 0, vy: 0,
        faceX: meta.spawn.x < ARENA_WIDTH / 2 ? INPUT_SCALE : -INPUT_SCALE, faceY: 0, dashTicks: 0, dashCd: 0,
        hp: PLAYER_MAX_HP, alive: true, kills: 0, deaths: 0, energy: ENERGY.max, rage: 0,
      });
      meta.lastCastTick = SKILLS.map(() => -Infinity);
      meta.energy = ENERGY.max;
    }
    this.clearProjectiles();
    for (const pillar of this.state.pillars) pillar.hp = PILLAR.hp;
  }

  clearProjectiles() {
    this.state.projectiles.clear();
    this.projectileExpire.clear();
    this.state.blasts.clear();
    this.blastDetonate.clear();
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

    this.updatePillars();

    // 倒數和結算時不能動、不能放技能
    const frozen = this.state.phase === "countdown" || this.state.phase === "ended";

    // 1. 處理每個玩家的輸入：移動 + 施放技能
    const canAct = (player) => player.alive && !frozen;
    for (const [id, player] of this.state.players) {
      // 電腦：每個 tick 由 bot.js 想一個輸入
      const brain = this.meta.get(id)?.brain;
      if (brain) {
        const input = canAct(player) ? this.botThink(id, player, brain) : IDLE_INPUT;
        stepEntity(player, input, ctx.dt, this.solid);
        if (input.skill > 0) this.tryCastSkill(id, player, input.skill - 1, input);
        continue;
      }

      const channel = this.inputs.get(id);
      if (!channel) continue;
      for (const input of channel) {
        // 不能動時當作沒有輸入，但仍要跑 stepEntity（冷卻倒數），才會和客戶端預測一致
        const ok = canAct(player);
        stepEntity(player, ok ? input : IDLE_INPUT, ctx.dt, this.solid);
        if (ok && input.skill > 0) this.tryCastSkill(id, player, input.skill - 1, input);
      }
    }

    // 2. 移動火球、判定命中；預告時間到的爆炸
    this.updateProjectiles(ctx.dt);
    if (this.state.phase !== "ended") this.updateBlasts();

    // 3. 復活（能量補滿，怒氣保留）、回復能量
    const regen = ENERGY.regenPerSec / TICK_RATE;
    for (const [id, player] of this.state.players) {
      const meta = this.meta.get(id);
      if (!player.alive && this.tick >= meta.respawnTick) {
        Object.assign(player, { x: meta.spawn.x, y: meta.spawn.y, vx: 0, vy: 0, hp: PLAYER_MAX_HP, alive: true, dashTicks: 0, dashCd: 0 });
        meta.energy = ENERGY.max;
      }
      if (player.alive) meta.energy = Math.min(ENERGY.max, meta.energy + regen);
      player.energy = Math.floor(meta.energy); // 只有整數變了才會同步出去
    }
  }

  botThink(id, player, brain) {
    const meta = this.meta.get(id);
    return brain.think({
      id, player,
      players: this.state.players,
      projectiles: this.state.projectiles,
      blasts: this.state.blasts,
      solid: this.solid,
      tick: this.tick,
      canCast: (i) => this.canCast(meta, player, i),
    });
  }

  /** 冷卻好了，而且能量（或大招的怒氣）夠 */
  canCast(meta, player, skillIndex) {
    const skill = SKILLS[skillIndex];
    if (this.tick - meta.lastCastTick[skillIndex] < skill.cooldownTicks) return false;
    if (skill.ultimate) return player.rage >= RAGE.max;
    return meta.energy >= (skill.energyCost ?? 0);
  }

  tryCastSkill(id, player, skillIndex, input) {
    const skill = SKILLS[skillIndex];
    if (!skill || skill.type === "dash") return; // 衝刺在 stepEntity 處理
    const meta = this.meta.get(id);
    if (!this.canCast(meta, player, skillIndex)) return;
    meta.lastCastTick[skillIndex] = this.tick;
    // 付出代價：大招清空怒氣，其他技能扣能量
    if (skill.ultimate) player.rage = 0;
    else meta.energy -= skill.energyCost ?? 0;

    if (skill.type === "blast" || skill.type === "meteor") {
      this.castBlast(id, player, skillIndex, skill, input);
      return;
    }

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
   * 指定地點爆炸：輕點 = 丟向最近的敵人（超過射程就丟到最遠），拖曳 = 丟到瞄準的位置。
   * 流星雨（meteor）同樣瞄準方式，只是在落點附近依序落下好幾顆。
   */
  castBlast(id, player, skillIndex, skill, input) {
    let aim = { x: input.aimX, y: input.aimY };
    if (aim.x === 0 && aim.y === 0) {
      const target = this.nearestEnemy(id, player);
      aim = target
        ? aimToward(player.x, player.y, target.x, target.y, skill)
        : { x: Math.round(player.faceX * 0.6), y: Math.round(player.faceY * 0.6) }; // 沒有敵人就丟到前方
    }
    const points = skill.type === "meteor"
      ? meteorTargets(player.x, player.y, aim.x, aim.y, skill)
      : [{ ...blastTarget(player.x, player.y, aim.x, aim.y, skill), fuseTicks: skill.fuseTicks }];
    for (const { x, y, fuseTicks } of points) {
      const blastId = String(this.nextProjectileId++);
      this.state.blasts.set(blastId, new Blast({ owner: id, skill: skillIndex, x, y, fuse: fuseTicks }));
      this.blastDetonate.set(blastId, this.tick + fuseTicks);
    }
  }

  /** 預告時間到就爆炸：範圍內的敵人全部受傷（衝刺中無敵一樣有效） */
  updateBlasts() {
    for (const [blastId, b] of this.state.blasts) {
      if (this.tick < this.blastDetonate.get(blastId)) continue;
      const skill = SKILLS[b.skill];
      const targets = [];
      for (const [id, player] of this.state.players) {
        if (id === b.owner || !player.alive) continue;
        if (player.dashTicks > 0 && SKILLS[DASH_INDEX]?.invulnerable) continue;
        if (Math.hypot(player.x - b.x, player.y - b.y) <= skill.radius + PLAYER_HALF) targets.push({ id, player });
      }
      this.broadcast("impact", { x: Math.round(b.x), y: Math.round(b.y), skill: b.skill, hit: targets.length > 0, area: true });
      // 範圍內的柱子也會受傷
      OBSTACLE_RECTS.forEach((r, i) => {
        if (this.solid[i] && circleOverlapsRect(b.x, b.y, skill.radius, r)) this.damagePillar(i, skill.damage, b.owner);
      });
      this.state.blasts.delete(blastId);
      this.blastDetonate.delete(blastId);
      for (const t of targets) {
        this.applyDamage(t.id, t.player, b.owner, skill.damage);
        if (this.state.phase === "ended") return; // 致勝一擊會清空場上所有技能
      }
    }
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
      const pillarIndex = obstacleIndexHitByCircle(p.x, p.y, SKILLS[p.skill].radius, this.solid);
      const blocked = pillarIndex >= 0;
      const expired = this.tick >= this.projectileExpire.get(projectileId);
      const target = blocked ? null : this.findHit(p);
      if (blocked) this.damagePillar(pillarIndex, SKILLS[p.skill].damage, p.owner);

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

  /** 柱子受傷；打壞後不再擋人和技能，PILLAR.respawnTicks 後長回來 */
  damagePillar(i, damage, attackerId) {
    const pillar = this.state.pillars.at(i);
    if (!pillar || pillar.hp === 0) return;
    const dealt = Math.min(pillar.hp, damage);
    pillar.hp -= dealt;
    const attacker = this.state.players.get(attackerId);
    if (attacker) attacker.rage = Math.min(RAGE.max, attacker.rage + dealt * RAGE.perStructureDamage);
    if (pillar.hp === 0) {
      this.solid[i] = false;
      this.pillarRespawnTick[i] = this.tick + PILLAR.respawnTicks;
    }
  }

  /** 更新 solid；時間到的柱子長回來（有人站在原地就等他離開，免得把人卡在裡面） */
  updatePillars() {
    this.ensurePillars();
    this.state.pillars.forEach((pillar, i) => {
      if (pillar.hp === 0 && this.tick >= this.pillarRespawnTick[i]) {
        const onlyThis = OBSTACLES.map((_, j) => j === i);
        const occupied = [...this.state.players.values()].some((p) => obstacleHitByBox(p.x, p.y, PLAYER_HALF, onlyThis));
        if (!occupied) pillar.hp = PILLAR.hp;
      }
      this.solid[i] = pillar.hp > 0;
    });
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
    const dealt = Math.min(target.hp, damage);
    target.hp -= dealt;
    // 怒氣：被打的人和打人的人都會累積
    target.rage = Math.min(RAGE.max, target.rage + dealt * RAGE.perDamageTaken);
    const source = this.state.players.get(attackerId);
    if (source) source.rage = Math.min(RAGE.max, source.rage + dealt * RAGE.perDamageDealt);
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

import { Room, matchMaker } from "colyseus";
import { ArenaState, Player, PlayerInput, Projectile, Blast, Pillar, Zone } from "./schema.js";
import { stepEntity } from "../../shared/movement.js";
import { OBSTACLE_RECTS, obstacleIndexHitByCircle, circleOverlapsRect, obstacleHitByBox } from "../../shared/obstacles.js";
import { BotBrain } from "../bot.js";
import { blastTarget, aimToward, meteorTargets } from "../../shared/blast.js";
import {
  TICK_RATE, ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF, maxHpOf, moveStatsOf,
  RESPAWN_TICKS, SKILLS, DASH_SLOT, SLOT_COUNT, kitSkill, kitOf, isTargeted, SPAWN_POINTS, MAX_PLAYERS, ROUND, INPUT_SCALE,
  SKIN_COUNT, NAME_MAX_LENGTH, ROOM_CODE_LENGTH, ENERGY, RAGE, OBSTACLES, PILLAR,
} from "../../shared/constants.js";

/** 新玩家、復活、新的一局時，技能狀態歸零的欄位 */
const FRESH_STATUS = { dashTicks: 0, dashCd: 0, guardTicks: 0, whirlTicks: 0, rootTicks: 0, poisonTicks: 0, barrier: 0, knockTicks: 0, knockX: 0, knockY: 0 };

/** 兩個方向的夾角是否在 arcDeg 的一半以內（方向不用是單位向量） */
function withinArc(dirX, dirY, toX, toY, arcDeg) {
  const len = Math.hypot(dirX, dirY) * Math.hypot(toX, toY);
  if (len === 0) return true; // 重疊在同一點時算在範圍內
  return (dirX * toX + dirY * toY) / len >= Math.cos(((arcDeg / 2) * Math.PI) / 180);
}

/** 不能動的時候（死亡、倒數、結算）用的空輸入 */
const IDLE_INPUT = { moveX: 0, moveY: 0, skill: 0, aimX: 0, aimY: 0 };

/** 去掉控制字元和前後空白，限制長度（用 Array.from 才不會把 emoji 切一半） */
function cleanName(raw) {
  const text = String(raw ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return Array.from(text).slice(0, NAME_MAX_LENGTH).join("");
}

/** 產生還沒被用掉的數字房號。房間太多、一直撞號時回傳 undefined（沿用 Colyseus 預設的亂數 id） */
async function uniqueRoomCode() {
  for (let i = 0; i < 20; i++) {
    const code = String(Math.floor(Math.random() * 10 ** ROOM_CODE_LENGTH)).padStart(ROOM_CODE_LENGTH, "0");
    if (!(await matchMaker.getRoomById(code))) return code;
  }
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
 * 房間：房號是 ROOM_CODE_LENGTH 位數字。建立時帶 { private: true } 就是私人房間，
 * 快速配對（joinOrCreate）不會配到，只能輸入房號或點邀請連結加入。
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
      skill: [0, SLOT_COUNT],
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
  /** 穿透子彈（氣功波）已經打過誰：projectileId → Set(sessionId)，同一發不會重複打同一個人 */
  projectileHits = new Map();
  /** 爆炸時間：blastId → tick */
  blastDetonate = new Map();
  /** 毒沼：zoneId → { start, end }（哪個 tick 放的、哪個 tick 消失） */
  zoneTimes = new Map();
  /** 這個 tick 場上的毒沼（給 stepEntity 判斷緩速），每個 tick 開頭更新 */
  activeZones = [];
  /** 每根柱子還在不在（每個 tick 從 state.pillars 更新），傳給移動和碰撞判定 */
  solid = OBSTACLES.map(() => true);
  /** 打壞的柱子哪個 tick 長回來 */
  pillarRespawnTick = OBSTACLES.map(() => 0);

  async onCreate(options) {
    // roomId 只能在建立時改
    const code = await uniqueRoomCode();
    if (code) this.roomId = code;
    this.state.isPrivate = options?.private === true;
    if (this.state.isPrivate) this.setPrivate(true);

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
      faceX: spawn.x < ARENA_WIDTH / 2 ? INPUT_SCALE : -INPUT_SCALE, faceY: 0, ...FRESH_STATUS,
      hp: maxHpOf(skin), alive: true, kills: 0, deaths: 0, energy: ENERGY.max, rage: 0,
    }));
    this.meta.set(client.sessionId, { spawn, lastCastTick: Array(SLOT_COUNT).fill(-Infinity), respawnTick: 0, energy: ENERGY.max });
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
      faceX: spawn.x < ARENA_WIDTH / 2 ? INPUT_SCALE : -INPUT_SCALE, faceY: 0, ...FRESH_STATUS,
      hp: maxHpOf(skin), alive: true, kills: 0, deaths: 0, energy: ENERGY.max, rage: 0,
    }));
    this.meta.set(id, { spawn, lastCastTick: Array(SLOT_COUNT).fill(-Infinity), respawnTick: 0, energy: ENERGY.max, brain: new BotBrain() });
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
        faceX: meta.spawn.x < ARENA_WIDTH / 2 ? INPUT_SCALE : -INPUT_SCALE, faceY: 0, ...FRESH_STATUS,
        hp: maxHpOf(player.skin), alive: true, kills: 0, deaths: 0, energy: ENERGY.max, rage: 0,
      });
      meta.lastCastTick = Array(SLOT_COUNT).fill(-Infinity);
      meta.energy = ENERGY.max;
    }
    this.clearProjectiles();
    for (const pillar of this.state.pillars) pillar.hp = PILLAR.hp;
  }

  clearProjectiles() {
    this.state.projectiles.clear();
    this.projectileExpire.clear();
    this.projectileHits.clear();
    this.state.blasts.clear();
    this.blastDetonate.clear();
    this.state.zones.clear();
    this.zoneTimes.clear();
    this.activeZones = [];
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
    this.updateActiveZones();
    for (const [id, player] of this.state.players) {
      // 電腦：每個 tick 由 bot.js 想一個輸入
      const brain = this.meta.get(id)?.brain;
      if (brain) {
        const input = canAct(player) ? this.botThink(id, player, brain) : IDLE_INPUT;
        stepEntity(player, input, ctx.dt, this.solid, moveStatsOf(player.skin), this.slowZonesFor(id));
        if (input.skill > 0) this.tryCastSkill(id, player, input.skill - 1, input);
        continue;
      }

      const channel = this.inputs.get(id);
      if (!channel) continue;
      for (const input of channel) {
        // 不能動時當作沒有輸入，但仍要跑 stepEntity（冷卻倒數），才會和客戶端預測一致
        const ok = canAct(player);
        stepEntity(player, ok ? input : IDLE_INPUT, ctx.dt, this.solid, moveStatsOf(player.skin), this.slowZonesFor(id));
        if (ok && input.skill > 0) this.tryCastSkill(id, player, input.skill - 1, input);
      }
    }

    // 2. 持續型技能（舉盾、旋風斬）；移動火球、判定命中；預告時間到的爆炸
    if (!frozen) this.updateStatuses();
    if (this.state.phase === "ended") return;
    this.updateProjectiles(ctx.dt);
    if (this.state.phase !== "ended") this.updateBlasts();

    // 3. 復活（能量補滿，怒氣保留）、回復能量
    const regen = ENERGY.regenPerSec / TICK_RATE;
    for (const [id, player] of this.state.players) {
      const meta = this.meta.get(id);
      if (!player.alive && this.tick >= meta.respawnTick) {
        Object.assign(player, { x: meta.spawn.x, y: meta.spawn.y, vx: 0, vy: 0, hp: maxHpOf(player.skin), alive: true, ...FRESH_STATUS });
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
      zones: this.slowZonesFor(id),
      solid: this.solid,
      tick: this.tick,
      canCast: (i) => this.canCast(meta, player, i),
    });
  }

  /** 第 slot 格技能冷卻好了，而且能量（或大招的怒氣）夠 */
  canCast(meta, player, slot) {
    const skill = kitSkill(player.skin, slot);
    if (!skill || this.tick - meta.lastCastTick[slot] < skill.cooldownTicks) return false;
    if (skill.ultimate) return player.rage >= RAGE.max;
    return meta.energy >= (skill.energyCost ?? 0);
  }

  /** 施放自己技能組第 slot 格的技能 */
  tryCastSkill(id, player, slot, input) {
    const skill = kitSkill(player.skin, slot);
    if (!skill || skill.type === "dash") return; // 衝刺在 stepEntity 處理
    const meta = this.meta.get(id);
    if (!this.canCast(meta, player, slot)) return;
    meta.lastCastTick[slot] = this.tick;
    // 付出代價：大招清空怒氣，其他技能扣能量
    if (skill.ultimate) player.rage = 0;
    else meta.energy -= skill.energyCost ?? 0;

    if (skill.type === "zone") return this.castZone(id, player, skill, input);
    if (isTargeted(skill)) return this.castBlast(id, player, skill, input);
    if (skill.type === "slash") return this.castSlash(id, player, skill, input);
    if (skill.type === "guard") {
      const [dirX, dirY] = this.aimDirection(id, player, input);
      Object.assign(player, { guardTicks: skill.durationTicks, guardX: Math.round(dirX * INPUT_SCALE), guardY: Math.round(dirY * INPUT_SCALE) });
      return;
    }
    if (skill.type === "barrier") {
      player.barrier = skill.amount;
      meta.barrierEnd = this.tick + skill.durationTicks;
      return;
    }
    if (skill.type === "roar") return this.castRoar(id, player, skill);
    if (skill.type === "whirl") {
      player.whirlTicks = skill.durationTicks;
      meta.whirlSkill = skill;
      return;
    }

    const [dirX, dirY] = this.aimDirection(id, player, input);
    const projectileId = String(this.nextProjectileId++);

    this.state.projectiles.set(projectileId, new Projectile({
      owner: id,
      skill: skill.id,
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
  castBlast(id, player, skill, input) {
    const aim = this.targetAim(id, player, skill, input);
    const points = skill.type === "meteor"
      ? meteorTargets(player.x, player.y, aim.x, aim.y, skill)
      : [{ ...blastTarget(player.x, player.y, aim.x, aim.y, skill), fuseTicks: skill.fuseTicks }];
    for (const { x, y, fuseTicks } of points) {
      const blastId = String(this.nextProjectileId++);
      this.state.blasts.set(blastId, new Blast({ owner: id, skill: skill.id, x, y, fuse: fuseTicks }));
      this.blastDetonate.set(blastId, this.tick + fuseTicks);
    }
  }

  /** 指定地點技能的瞄準：拖曳 = 玩家瞄的位置，輕點 = 最近的敵人（超過射程就丟到最遠），沒有敵人 = 前方 */
  targetAim(id, player, skill, input) {
    if (input.aimX !== 0 || input.aimY !== 0) return { x: input.aimX, y: input.aimY };
    const target = this.nearestEnemy(id, player);
    return target
      ? aimToward(player.x, player.y, target.x, target.y, skill)
      : { x: Math.round(player.faceX * 0.6), y: Math.round(player.faceY * 0.6) };
  }

  /** 毒沼：丟到哪就在哪出現（沒有預告），持續 durationTicks */
  castZone(id, player, skill, input) {
    const aim = this.targetAim(id, player, skill, input);
    const { x, y } = blastTarget(player.x, player.y, aim.x, aim.y, skill);
    const zoneId = String(this.nextProjectileId++);
    this.state.zones.set(zoneId, new Zone({ owner: id, skill: skill.id, x, y }));
    this.zoneTimes.set(zoneId, { start: this.tick, end: this.tick + skill.durationTicks });
  }

  /** 移除時間到的毒沼，整理出這個 tick 場上的毒沼 */
  updateActiveZones() {
    this.activeZones = [];
    for (const [zoneId, z] of this.state.zones) {
      const times = this.zoneTimes.get(zoneId);
      if (!times || this.tick >= times.end) {
        this.state.zones.delete(zoneId);
        this.zoneTimes.delete(zoneId);
        continue;
      }
      const skill = SKILLS[z.skill];
      this.activeZones.push({ zoneId, owner: z.owner, x: z.x, y: z.y, radius: skill.radius, slowFactor: skill.slowFactor, skill, start: times.start });
    }
  }

  /** 會讓這個玩家變慢的毒沼（自己放的不算） */
  slowZonesFor(id) {
    return this.activeZones.length ? this.activeZones.filter((z) => z.owner !== id) : this.activeZones;
  }

  /** 毒沼每 hitEveryTicks 扣一次站在裡面的敵人（剛放下時不扣，給人反應時間） */
  updateZoneDamage() {
    for (const z of this.activeZones) {
      const age = this.tick - z.start;
      if (age === 0 || age % z.skill.hitEveryTicks !== 0) continue;
      for (const [id, player] of this.state.players) {
        if (id === z.owner || !player.alive) continue;
        if ((player.x - z.x) ** 2 + (player.y - z.y) ** 2 > z.radius * z.radius) continue;
        this.applyDamage(id, player, z.owner, z.skill.damage);
        if (this.state.phase === "ended") return;
      }
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
        if (this.dashInvulnerable(player)) continue;
        if (Math.hypot(player.x - b.x, player.y - b.y) > skill.radius + PLAYER_HALF) continue;
        if (this.blockedByGuard(player, b.x, b.y, skill.damage)) continue;
        targets.push({ id, player });
      }
      this.broadcast("impact", { x: Math.round(b.x), y: Math.round(b.y), skill: b.skill, hit: targets.length > 0, area: true });
      // 範圍內的柱子也會受傷
      OBSTACLE_RECTS.forEach((r, i) => {
        if (this.solid[i] && circleOverlapsRect(b.x, b.y, skill.radius, r)) this.damagePillar(i, skill.damage, b.owner);
      });
      this.state.blasts.delete(blastId);
      this.blastDetonate.delete(blastId);
      for (const t of targets) {
        // 藤蔓：定身（衝刺也會被打斷）
        if (skill.rootTicks) Object.assign(t.player, { rootTicks: skill.rootTicks, dashTicks: 0 });
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
      const skill = SKILLS[p.skill];
      let target = blocked ? null : this.findHit(p, this.projectileHits.get(projectileId));
      if (blocked) this.damagePillar(pillarIndex, SKILLS[p.skill].damage, p.owner);
      // 從盾牌那一側飛來的火球：擋掉（往回推一步當作來的方向）
      const shielded = target && this.blockedByGuard(target.player, p.x - p.vx, p.y - p.vy, SKILLS[p.skill].damage);
      if (shielded) target = null;

      // 穿透子彈打中人不會消失，記下打過誰，繼續往前飛
      const pierced = target && skill.pierce;
      if (pierced) {
        if (!this.projectileHits.has(projectileId)) this.projectileHits.set(projectileId, new Set());
        this.projectileHits.get(projectileId).add(target.id);
        this.broadcast("impact", { x: Math.round(target.player.x), y: Math.round(target.player.y), skill: p.skill, hit: true });
      }
      if ((target && !pierced) || blocked || shielded || outOfArena || expired) {
        // 通知所有人播特效：hit = 打中人（爆炸），否則是撞牆或時間到（冒煙）
        this.broadcast("impact", { x: Math.round(p.x), y: Math.round(p.y), skill: p.skill, hit: !!target });
        this.state.projectiles.delete(projectileId);
        this.projectileExpire.delete(projectileId);
        this.projectileHits.delete(projectileId);
      }
      // 扣血放在刪除之後：致勝一擊會清空所有火球
      if (target) {
        // 毒液彈：中毒（再中一次重新計時）
        if (skill.poison) {
          target.player.poisonTicks = skill.poison.ticks;
          this.meta.get(target.id).poison = { owner: p.owner, ...skill.poison };
        }
        this.applyDamage(target.id, target.player, p.owner, skill.damage);
      }
      if (this.state.phase === "ended") return;
    }
  }

  /**
   * 揮砍：瞬間判定前方扇形，範圍內的敵人和柱子都會受傷。
   * 方向：拖曳 = 瞄準方向，輕點 = 自動朝最近的敵人。
   */
  castSlash(id, player, skill, input) {
    const [dirX, dirY] = this.aimDirection(id, player, input);
    const reach = skill.range + PLAYER_HALF;
    const targets = [];
    for (const [otherId, other] of this.state.players) {
      if (otherId === id || !other.alive) continue;
      if (this.dashInvulnerable(other)) continue;
      const dx = other.x - player.x;
      const dy = other.y - player.y;
      // 貼身（重疊）時不管方向都砍得到
      const touching = Math.hypot(dx, dy) <= PLAYER_HALF * 2;
      if (Math.hypot(dx, dy) > reach || (!touching && !withinArc(dirX, dirY, dx, dy, skill.arcDeg))) continue;
      if (this.blockedByGuard(other, player.x, player.y, skill.damage)) continue;
      targets.push({ id: otherId, player: other });
    }
    // 刀尖附近的柱子
    const tipX = player.x + dirX * skill.range * 0.6;
    const tipY = player.y + dirY * skill.range * 0.6;
    OBSTACLE_RECTS.forEach((r, i) => {
      if (this.solid[i] && circleOverlapsRect(tipX, tipY, skill.range * 0.5, r)) this.damagePillar(i, skill.damage, id);
    });
    this.broadcast("swing", {
      x: Math.round(player.x), y: Math.round(player.y),
      dx: Math.round(dirX * INPUT_SCALE), dy: Math.round(dirY * INPUT_SCALE),
      skill: skill.id, hit: targets.length > 0,
    });
    for (const t of targets) {
      this.applyDamage(t.id, t.player, id, skill.damage);
      if (this.state.phase === "ended") return;
    }
  }

  /**
   * 獅子吼：周圍的敵人受傷並往外震飛（撞到牆、柱子會停），附近敵人的子彈直接震散。
   * 舉盾朝著武僧的人擋得住（不受傷也不會被震飛）。
   */
  castRoar(id, player, skill) {
    const reach = skill.radius + PLAYER_HALF;
    this.broadcast("roar", { x: Math.round(player.x), y: Math.round(player.y), skill: skill.id });
    for (const [projectileId, p] of this.state.projectiles) {
      if (p.owner === id || Math.hypot(p.x - player.x, p.y - player.y) > reach) continue;
      this.broadcast("impact", { x: Math.round(p.x), y: Math.round(p.y), skill: p.skill, hit: false });
      this.state.projectiles.delete(projectileId);
      this.projectileExpire.delete(projectileId);
      this.projectileHits.delete(projectileId);
    }
    OBSTACLE_RECTS.forEach((r, i) => {
      if (this.solid[i] && circleOverlapsRect(player.x, player.y, skill.radius, r)) this.damagePillar(i, skill.damage, id);
    });
    const targets = [];
    for (const [otherId, other] of this.state.players) {
      if (otherId === id || !other.alive || this.dashInvulnerable(other)) continue;
      const dx = other.x - player.x;
      const dy = other.y - player.y;
      const dist = Math.hypot(dx, dy);
      if (dist > reach || this.blockedByGuard(other, player.x, player.y, skill.damage)) continue;
      // 疊在一起時往武僧面向的方向震
      const [nx, ny] = dist > 0.01 ? [dx / dist, dy / dist] : [player.faceX / INPUT_SCALE, player.faceY / INPUT_SCALE];
      Object.assign(other, {
        knockTicks: skill.knockTicks, dashTicks: 0,
        knockX: Math.round(nx * skill.knockSpeed), knockY: Math.round(ny * skill.knockSpeed),
      });
      targets.push({ id: otherId, player: other });
    }
    for (const t of targets) {
      this.applyDamage(t.id, t.player, id, skill.damage);
      if (this.state.phase === "ended") return;
    }
  }

  /** 每個 tick：盾牌倒數；旋風斬每 hitEveryTicks 砍一次周圍的人（剛放的那一下就會砍） */
  updateStatuses() {
    this.updateZoneDamage();
    if (this.state.phase === "ended") return;
    for (const [id, player] of this.state.players) {
      if (player.guardTicks > 0) player.guardTicks--;
      if (player.barrier > 0 && this.tick >= (this.meta.get(id)?.barrierEnd ?? 0)) player.barrier = 0; // 金鐘罩時間到
      // 中毒：每 everyTicks 扣一次血（算施毒者的傷害，毒死也算他的擊殺）
      if (player.poisonTicks > 0 && player.alive) {
        player.poisonTicks--;
        const poison = this.meta.get(id)?.poison;
        if (poison && player.poisonTicks % poison.everyTicks === 0) {
          this.applyDamage(id, player, poison.owner, poison.damage);
          if (this.state.phase === "ended") return;
        }
      }
      if (player.whirlTicks === 0) continue;
      const skill = this.meta.get(id)?.whirlSkill;
      const hitNow = skill && player.whirlTicks % skill.hitEveryTicks === 0;
      player.whirlTicks--;
      if (!hitNow || !player.alive) continue;

      const targets = [];
      for (const [otherId, other] of this.state.players) {
        if (otherId === id || !other.alive) continue;
        if (this.dashInvulnerable(other)) continue;
        if (Math.hypot(other.x - player.x, other.y - player.y) > skill.radius + PLAYER_HALF) continue;
        if (this.blockedByGuard(other, player.x, player.y, skill.damage)) continue;
        targets.push({ id: otherId, player: other });
      }
      OBSTACLE_RECTS.forEach((r, i) => {
        if (this.solid[i] && circleOverlapsRect(player.x, player.y, skill.radius, r)) this.damagePillar(i, skill.damage, id);
      });
      for (const t of targets) {
        this.broadcast("impact", { x: Math.round(t.player.x), y: Math.round(t.player.y), skill: skill.id, hit: true });
        this.applyDamage(t.id, t.player, id, skill.damage);
        if (this.state.phase === "ended") return;
      }
    }
  }

  /**
   * 盾牌有沒有擋下從 (fromX, fromY) 來的攻擊。擋下時播特效、累積一點怒氣。
   * 攻擊來源在盾牌朝向的 arcDeg 範圍內才擋得到（背後被打一樣會受傷）。
   */
  blockedByGuard(target, fromX, fromY, damage) {
    if (target.guardTicks === 0) return false;
    const guard = kitOf(target.skin).find((s) => s.type === "guard");
    if (!guard || !withinArc(target.guardX, target.guardY, fromX - target.x, fromY - target.y, guard.arcDeg)) return false;
    target.rage = Math.min(RAGE.max, target.rage + damage * RAGE.perDamageTaken);
    this.broadcast("block", { x: Math.round(target.x), y: Math.round(target.y), dx: target.guardX, dy: target.guardY });
    return true;
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

  /** 正在衝刺而且衝刺有無敵（看這個角色自己的衝刺技能） */
  dashInvulnerable(player) {
    return player.dashTicks > 0 && !!kitSkill(player.skin, DASH_SLOT)?.invulnerable;
  }

  /** 圓形碰撞：找出第一個被打中的敵人（skip = 這發已經打過的人，穿透子彈用） */
  findHit(p, skip) {
    const radius = SKILLS[p.skill].radius;
    for (const [id, player] of this.state.players) {
      if (id === p.owner || !player.alive || skip?.has(id)) continue;
      if (this.dashInvulnerable(player)) continue; // 衝刺中閃過
      if (Math.hypot(player.x - p.x, player.y - p.y) <= PLAYER_HALF + radius) {
        return { id, player };
      }
    }
    return null;
  }

  applyDamage(targetId, target, attackerId, damage) {
    // 金鐘罩：先扣護盾。被護盾吸收的也算「打到」，雙方照樣累積怒氣
    let absorbed = 0;
    if (target.barrier > 0) {
      absorbed = Math.min(target.barrier, damage);
      target.barrier -= absorbed;
      this.broadcast("barrier", { x: Math.round(target.x), y: Math.round(target.y), broke: target.barrier === 0 });
    }
    const hpLoss = Math.min(target.hp, damage - absorbed);
    target.hp -= hpLoss;
    const dealt = hpLoss + absorbed;
    // 怒氣：被打的人和打人的人都會累積
    target.rage = Math.min(RAGE.max, target.rage + dealt * RAGE.perDamageTaken);
    const source = this.state.players.get(attackerId);
    if (source) source.rage = Math.min(RAGE.max, source.rage + dealt * RAGE.perDamageDealt);
    if (target.hp > 0) return;

    target.alive = false;
    Object.assign(target, { dashTicks: 0, guardTicks: 0, whirlTicks: 0, rootTicks: 0, poisonTicks: 0, barrier: 0, knockTicks: 0 });
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

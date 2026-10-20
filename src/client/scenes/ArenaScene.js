import * as Phaser from "phaser";
import { Callbacks } from "@colyseus/sdk";
import { ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF, maxHpOf, SKILLS, DASH_INDEX, DASH_SLOT, kitSkill, isTargeted, TICK_RATE, INPUT_SCALE, ENERGY, PILLAR } from "../../shared/constants.js";
import { theme, playerTextureKey, walkTextureKey, facingTextureKey, IDLE_FRAME } from "../theme.js";
import { createMissingTextures } from "../placeholders.js";
import { OBSTACLE_RECTS, circleHitsObstacle } from "../../shared/obstacles.js";
import { RoundOverlay } from "../roundOverlay.js";
import { blastTarget, meteorTargets } from "../../shared/blast.js";

/**
 * 角色朝哪個方向：上下走得比左右多就用正面 / 背面圖，其他（含斜走）用側面圖
 * @returns {"side" | "front" | "back"}
 */
function facingOf(faceX, faceY) {
  if (Math.abs(faceY) > Math.abs(faceX)) return faceY > 0 ? "front" : "back";
  return "side";
}

/** 停下來多久後才切回站立圖（ms），避免插值的小停頓讓動畫一直閃 */
const WALK_HOLD_MS = 120;

/** 被打中的回饋。數值可以直接調 */
const HIT_FEEDBACK = {
  flashMs: 90,          // 角色閃白多久
  jitterMs: 150,        // 角色原地抖動多久
  jitterPx: 1,          // 抖動幅度（像素）
  // 只有「自己」被打中時才震鏡頭和手機
  shake: { ms: 140, intensity: 0.008 },
  deathShake: { ms: 260, intensity: 0.018 },
  vibrateMs: 40,        // 手機震動（Android 支援，iPhone Safari 不支援）
  deathVibrateMs: [60, 40, 90],
};

/** 柱子受傷、倒塌、長回來的效果 */
const PILLAR_FX = {
  flashMs: 80,
  jitterMs: 140,
  jitterPx: 1,
  damagedTint: 0x7a7f90,   // 血越少越接近這個顏色（看起來快碎了）
  debrisCount: 10,         // 倒塌時噴出幾塊碎石
  debrisMs: 450,
  regrowMs: 400,
};

/** 鏡頭跟隨：越小越平滑（0~1）；角色原點在腳底，往上偏一點讓身體在畫面中間 */
const CAMERA = { lerp: 0.15, offsetY: 20 };

/** 拖曳瞄準時的指示線：一排小點，長度 = 技能射程 */
const AIM_GUIDE = { spacing: 10, dotRadius: 2, alpha: 0.9 };

/** 腳下的影子（橢圓）。深度固定在地板上一層，所以會被柱子、角色蓋住 */
const SHADOW = {
  depth: 0.5,
  player: { w: 24, h: 8, alpha: 0.6 },
  projectile: { w: 12, h: 5, alpha: 0.35, offsetY: PLAYER_HALF + 2 }, // 火球在空中飛，影子落在地上
};

/** 指定地點爆炸的預告：紅圈 + 從天上掉下來的火球 */
const BLAST_FX = {
  color: 0xff4d2e,
  ringAlpha: 0.9,
  fillAlpha: 0.28,
  dropHeight: 150,   // 火球從落點上方多高開始掉
  ultimateFlash: { ms: 180, color: [255, 160, 60] }, // 有人放大招時畫面閃一下
};

/**
 * 對戰場景：只負責「畫出伺服器狀態」和「送出輸入」。
 * 遊戲規則都在 server/rooms/ArenaRoom.js。
 */
export class ArenaScene extends Phaser.Scene {
  constructor() {
    super("arena");
  }

  /** @param {{ room, predict, netInput, controls, solid, slowZones }} data 由 main.js 傳入（solid：每根柱子還在不在；slowZones：別人的毒沼。都和預測移動共用） */
  init(data) {
    Object.assign(this, data);
    this.playerViews = new Map();     // sessionId → { sprite, label, lastX, lastY, walkUntil, lastHp, flashUntil, jitterUntil }
    this.projectileViews = new Map(); // projectileId → { sprite, shadow, x, y, at, sampleX, sampleY, sampleAt }
    this.blastViews = new Map();      // blastId → { fireball, shadow, startAt, fuseMs }（藤蔓沒有 fireball）
    this.zoneStartAt = new Map();     // zoneId → 出現的時間（畫消失前的閃爍）
  }

  preload() {
    // 找不到的圖片忽略，之後由 placeholder 補上
    this.load.on("loaderror", (file) => console.info(`[theme] 沒有 ${file.src}，使用 placeholder`));
    for (const [key, path] of Object.entries(theme.sounds)) this.load.audio(key, path);
    for (const [key, asset] of Object.entries(theme.assets)) {
      if (!asset.path) continue;
      if (asset.sheet) {
        const [frameWidth, frameHeight] = asset.sheet;
        this.load.spritesheet(key, asset.path, { frameWidth, frameHeight });
      } else {
        this.load.image(key, asset.path);
      }
    }
  }

  create() {
    createMissingTextures(this);
    this.createWalkAnimations();
    this.createImpactAnimations();

    this.add.tileSprite(0, 0, ARENA_WIDTH, ARENA_HEIGHT, "floor").setOrigin(0);
    this.createBorder();
    this.createObstacles();
    this.bars = this.add.graphics().setDepth(1000); // 血條統一畫在最上層
    this.aimGuide = this.add.graphics().setDepth(999);
    this.blastGraphics = this.add.graphics().setDepth(SHADOW.depth + 0.1); // 預告圈畫在地上
    this.floorFx = this.add.graphics().setDepth(SHADOW.depth + 0.2);        // 旋風斬的圈（地上）
    this.statusFx = this.add.graphics().setDepth(998);                       // 盾牌（蓋在角色上面）
    this.createShadowTexture("shadow-player", SHADOW.player);
    this.createShadowTexture("shadow-projectile", SHADOW.projectile);
    // 固定在畫面中間（不跟著鏡頭捲動）
    this.deadText = this.add.text(theme.viewport.width / 2, theme.viewport.height / 2, "復活中…", {
      fontFamily: "monospace", fontSize: "12px", color: "#ffffff", resolution: 4,
    }).setOrigin(0.5).setDepth(1001).setScrollFactor(0).setVisible(false);
    this.minimap = this.add.graphics().setDepth(3000).setScrollFactor(0);

    const callbacks = Callbacks.get(this.room);

    callbacks.onAdd("players", (player, id) => {
      // 原點設在腳底，畫的時候對齊碰撞圓底部
      const sprite = this.add.sprite(player.x, player.y, playerTextureKey(player.skin)).setOrigin(0.5, 1);
      const label = this.add.text(0, 0, player.name, {
        fontFamily: "monospace", fontSize: "8px", color: id === this.room.sessionId ? "#ffe066" : "#ffffff",
        resolution: 4,
      }).setOrigin(0.5, 1);
      const shadow = this.add.image(player.x, player.y, "shadow-player").setDepth(SHADOW.depth).setAlpha(SHADOW.player.alpha);
      this.playerViews.set(id, {
        sprite, label, shadow, lastX: player.x, lastY: player.y, walkUntil: 0,
        lastHp: player.hp, lastAlive: player.alive, flashUntil: 0, jitterUntil: 0,
        wasDashing: false, nextTrailAt: 0,
      });
    });
    callbacks.onRemove("players", (_player, id) => {
      const view = this.playerViews.get(id);
      view?.sprite.destroy();
      view?.label.destroy();
      view?.shadow.destroy();
      this.playerViews.delete(id);
    });

    callbacks.onAdd("projectiles", (p, id) => {
      const sprite = this.add.image(p.x, p.y, SKILLS[p.skill]?.texture ?? "fireball");
      sprite.setDepth(p.y + 0.1);
      sprite.setRotation(Math.atan2(p.vy, p.vx));
      const shadow = this.add.image(p.x, p.y + SHADOW.projectile.offsetY, "shadow-projectile")
        .setDepth(SHADOW.depth).setAlpha(SHADOW.projectile.alpha);
      const now = performance.now();
      this.projectileViews.set(id, { sprite, shadow, x: p.x, y: p.y, at: now, sampleX: p.x, sampleY: p.y, sampleAt: now });
      this.playSfx(theme.skillSounds[p.skill]?.cast, p.owner === this.room.sessionId ? 1 : theme.othersVolume);
      if (SKILLS[p.skill]?.pierce) this.spawnQiLaunch(p.x, p.y, Math.atan2(p.vy, p.vx));
    });
    callbacks.onRemove("projectiles", (_p, id) => {
      this.projectileViews.get(id)?.sprite.destroy();
      this.projectileViews.get(id)?.shadow.destroy();
      this.projectileViews.delete(id);
    });

    // 指定地點爆炸：預告期間火球從天上掉下來，地上的紅圈慢慢填滿
    callbacks.onAdd("blasts", (b, id) => {
      const skill = SKILLS[b.skill];
      // 流星雨一次會新增好幾顆，音效和畫面閃光只做一次
      const now = performance.now();
      const firstOfVolley = now - (this.lastBlastSfxAt?.[b.skill] ?? 0) > 100;
      if (firstOfVolley) {
        (this.lastBlastSfxAt ??= {})[b.skill] = now;
        this.playSfx(theme.skillSounds[b.skill]?.cast, b.owner === this.room.sessionId ? 1 : theme.othersVolume);
        if (skill.ultimate) {
          const { ms, color } = BLAST_FX.ultimateFlash;
          this.cameras.main.flash(ms, ...color);
        }
      }
      // 有圖的技能（爆炎、流星雨）才有從天上掉下來的火球
      const fireball = skill.texture
        ? this.add.image(b.x, b.y - BLAST_FX.dropHeight, skill.texture).setRotation(Math.PI / 2).setDepth(1002) // 圖片朝右，轉成朝下
        : null;
      const shadow = this.add.image(b.x, b.y, "shadow-projectile").setDepth(SHADOW.depth).setAlpha(0);
      const fuseTicks = b.fuse || skill.fuseTicks;
      this.blastViews.set(id, { fireball, shadow, startAt: now, fuseMs: (fuseTicks / TICK_RATE) * 1000 });
    });
    callbacks.onRemove("blasts", (_b, id) => {
      const view = this.blastViews.get(id);
      view?.fireball?.destroy();
      view?.shadow.destroy();
      this.blastViews.delete(id);
    });

    // 毒沼：出現時播冒泡聲，畫面在 drawZones 每幀畫
    callbacks.onAdd("zones", (z, id) => {
      this.zoneStartAt.set(id, performance.now());
      this.playSfx(theme.skillSounds[z.skill]?.cast, z.owner === this.room.sessionId ? 1 : theme.othersVolume);
      this.spawnSwampSplash(z.x, z.y, SKILLS[z.skill].radius);
    });
    callbacks.onRemove("zones", (z, id) => {
      this.zoneStartAt.delete(id);
      this.spawnSwampFade(z.x, z.y, SKILLS[z.skill].radius);
    });

    this.room.onMessage("impact", (impact) => this.spawnImpact(impact));
    this.room.onMessage("swing", (swing) => this.spawnSwing(swing));
    this.room.onMessage("block", (block) => this.spawnBlock(block));
    this.room.onMessage("barrier", (hit) => this.spawnBarrierHit(hit));
    this.room.onMessage("roar", (roar) => this.spawnRoar(roar));
    this.roundOverlay = new RoundOverlay(document.getElementById("overlay"), this.room, (key) => this.playSfx(key));
  }

  update() {
    const now = performance.now();

    // predict.tick 回傳這一幀該跑幾個固定 tick，每個 tick 送一次輸入
    // 別人的毒沼：預測移動要知道哪裡會變慢（陣列原地更新，main.js 的預測共用同一個）
    this.slowZones.length = 0;
    for (const [, z] of this.room.state.zones) {
      if (z.owner === this.room.sessionId) continue;
      const skill = SKILLS[z.skill];
      this.slowZones.push({ x: z.x, y: z.y, radius: skill.radius, slowFactor: skill.slowFactor });
    }

    const steps = this.predict.tick(now);
    const self = this.room.state.players.get(this.room.sessionId);
    // 死亡、倒數、結算時送空輸入（伺服器也會忽略），預測才不會偏掉
    const { phase } = this.room.state;
    const canAct = (self?.alive ?? false) && phase !== "countdown" && phase !== "ended";
    for (let i = 0; i < steps; i++) {
      const cmd = this.controls.read(canAct);
      this.netInput.data.moveX = canAct ? cmd.moveX : 0;
      this.netInput.data.moveY = canAct ? cmd.moveY : 0;
      this.netInput.data.skill = canAct ? cmd.skill : 0;
      this.netInput.data.aimX = cmd.aimX;
      this.netInput.data.aimY = cmd.aimY;
      this.netInput.send();
    }
    this.roundOverlay.update();
    if (phase === "countdown" && this.lastPhase !== "countdown") this.controls.resetCooldowns();
    this.lastPhase = phase;
    this.controls.updateCooldowns(now, {
      dashCd: self ? this.predict.value(self, "dashCd") : 0,
      energy: self?.energy ?? 0,
      rage: self?.rage ?? 0,
    });

    this.bars.clear();
    this.floorFx.clear();
    this.statusFx.clear();
    for (const [id, player] of this.room.state.players) {
      const view = this.playerViews.get(id);
      if (!view) continue;

      // 自己是「預測位置」，其他人是「插值位置」，讀法都一樣
      const x = this.predict.value(player, "x");
      const y = this.predict.value(player, "y");

      // 血量變少 = 被打中（伺服器判定，所以每個玩家的畫面都會看到）
      const isSelf = id === this.room.sessionId;
      const feetY = Math.round(y + PLAYER_HALF);
      if (player.hp < view.lastHp) {
        this.onHit(view, isSelf, player.hp === 0, now);
        this.spawnDamageNumber(x, feetY - view.sprite.height, view.lastHp - player.hp, isSelf, player.poisonTicks > 0 || this.inEnemySwamp(id, x, y));
      }
      if (!player.alive && view.lastAlive) this.spawnDeath(view, player);
      if (player.alive && !view.lastAlive) {
        if (isSelf) this.playSfx("respawn");
        // 用伺服器位置：其他人的插值位置這時還在死掉的地方
        this.spawnRespawn(view, player.x, Math.round(player.y + PLAYER_HALF), player.skin);
      }
      view.lastHp = player.hp;
      view.lastAlive = player.alive;

      const headY = feetY - view.sprite.height;
      const jitter = now < view.jitterUntil ? Math.round((Math.random() * 2 - 1) * HIT_FEEDBACK.jitterPx) : 0;
      view.sprite.setPosition(Math.round(x) + jitter, feetY);
      // 面向：自己讀預測值（轉身不用等伺服器），其他人讀伺服器狀態
      const faceX = isSelf ? this.predict.value(player, "faceX") : player.faceX;
      const faceY = isSelf ? this.predict.value(player, "faceY") : player.faceY;
      view.sprite.setDepth(feetY); // 依腳底位置排前後：越下面的越前面（和柱子同一個基準）
      // 死掉：倒在地上、半透明（倒下的動畫在 spawnDeath；中途加入看到的直接是倒下的樣子）
      if (!player.alive && !view.deadPose) view.sprite.setAngle(view.sprite.flipX ? -90 : 90).setAlpha(0.25);
      if (player.alive) view.sprite.setAlpha(1);
      view.deadPose = !player.alive;
      this.updateWalk(view, player, x, y, now, faceX, faceY);
      this.updateFlash(view, now, player.poisonTicks > 0 && player.alive);
      this.updateDash(view, player, isSelf, now);
      this.updateMelee(view, player, x, y, isSelf, now);
      this.drawRoot(view, player, x, y, now);
      this.drawWading(id, player, x, y, now);
      this.drawPoisoned(view, player, x, y, now);
      this.drawBarrier(view, player, x, y, isSelf, now);
      view.label.setPosition(Math.round(x), headY - 4).setDepth(feetY + 0.5);
      view.shadow.setPosition(Math.round(x), feetY).setAlpha(player.alive ? SHADOW.player.alpha : SHADOW.player.alpha * 0.4);

      if (player.alive) this.drawHpBar(x, headY, player.hp / maxHpOf(player.skin), isSelf ? player.energy / ENERGY.max : null);
    }

    for (const [id, p] of this.room.state.projectiles) {
      const view = this.projectileViews.get(id);
      if (view) this.drawProjectile(view, p, now);
    }
    this.drawBlasts(now);
    this.drawZones(now);

    this.drawAimGuide(self, canAct);

    // 結算、倒數時由中間的提示說明狀態，不顯示「復活中」
    this.deadText.setVisible(!!self && !self.alive && (phase === "playing" || phase === "waiting"));
    this.updatePillars(now);
    this.followSelf();
    this.drawMinimap(self);
  }

  /** 預告圈：外圈固定，內圈隨時間填滿；火球從上方掉到落點，影子越來越深 */
  drawBlasts(now) {
    this.blastGraphics.clear();
    for (const [id, b] of this.room.state.blasts) {
      const view = this.blastViews.get(id);
      if (!view) continue;
      const radius = SKILLS[b.skill].radius;
      const color = theme.targetColors?.[b.skill] ?? BLAST_FX.color;
      const t = Math.min(1, (now - view.startAt) / view.fuseMs);
      this.blastGraphics.lineStyle(1, color, BLAST_FX.ringAlpha).strokeCircle(b.x, b.y, radius);
      this.blastGraphics.fillStyle(color, BLAST_FX.fillAlpha).fillCircle(b.x, b.y, radius * t);
      // 加速落下（t²），越接近爆炸掉越快；流星斜著掉
      const fall = BLAST_FX.dropHeight * (1 - t * t);
      const slant = SKILLS[b.skill].type === "meteor" ? theme.fireFx.meteorSlant : 0;
      if (view.fireball) {
        view.fireball.setPosition(Math.round(b.x - fall * slant), Math.round(b.y - fall)).setRotation(Math.atan2(1, slant));
      }
      view.shadow.setAlpha(SHADOW.projectile.alpha * 1.5 * t).setScale(0.6 + t);
      if (SKILLS[b.skill].type === "root") this.drawRootWarning(b.x, b.y, radius, t, now);
      if (theme.fireFx.skills.includes(b.skill)) {
        this.drawRuneCircle(b.x, b.y, radius, t, now);
        if (view.fireball) this.trailEmbers(view, view.fireball.x, view.fireball.y, now, 2);
      }
    }
  }

  /**
   * 畫一條彎彎曲曲的藤蔓：從 (x0,y0) 到 (x1,y1)，沿途左右擺動。
   * 先畫暗色粗線當外框，再畫亮色細線，像素風看起來比較立體。
   */
  drawVine(g, x0, y0, x1, y1, { wiggle = 3, phase = 0, width = 2, alpha = 1 } = {}) {
    const fx = theme.witchFx;
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const nx = -(y1 - y0) / len; // 垂直方向（左右擺動用）
    const ny = (x1 - x0) / len;
    const segments = Math.max(3, Math.round(len / 5));
    const points = [];
    for (let i = 0; i <= segments; i++) {
      const s = i / segments;
      const off = Math.sin(s * Math.PI * 2 + phase) * wiggle * s; // 根部不動，越往尖端擺越大
      points.push([x0 + (x1 - x0) * s + nx * off, y0 + (y1 - y0) * s + ny * off]);
    }
    for (const [w, color] of [[width + 2, fx.vineDark], [width, fx.vineColor]]) {
      g.lineStyle(w, color, alpha).beginPath().moveTo(points[0][0], points[0][1]);
      for (const [px, py] of points.slice(1)) g.lineTo(px, py);
      g.strokePath();
    }
    // 尖端一片葉子
    const [tx, ty] = points.at(-1);
    g.fillStyle(fx.leafColor, alpha).fillRect(Math.round(tx) - 1, Math.round(ty) - 1, 3, 2);
  }

  /** 藤蔓預告：圈的邊緣長出藤蔓，隨時間往中心蔓延（快纏住了） */
  drawRootWarning(x, y, radius, t, now) {
    const fx = theme.witchFx;
    for (let k = 0; k < fx.rootTendrils; k++) {
      const a = (k / fx.rootTendrils) * Math.PI * 2 + 0.3;
      const reach = radius * (0.15 + 0.6 * t);
      const sx = x + Math.cos(a) * radius;
      const sy = y + Math.sin(a) * radius * 0.85;
      const ex = x + Math.cos(a) * (radius - reach);
      const ey = y + Math.sin(a) * (radius - reach) * 0.85;
      this.drawVine(this.blastGraphics, sx, sy, ex, ey, { wiggle: 3, phase: now / 120 + k, alpha: 0.5 + 0.5 * t });
    }
  }

  /** 腳下影子的橢圓材質（像素風：不做模糊，直接一個實心橢圓） */
  createShadowTexture(key, { w, h }) {
    if (this.textures.exists(key)) return;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0x000000, 1).fillEllipse(w / 2, h / 2, w, h);
    g.generateTexture(key, w, h);
    g.destroy();
  }

  /**
   * 拖曳技能鍵時的瞄準指示：
   *   子彈 → 從自己身上往瞄準方向畫一排點，長度等於射程，碰到柱子或場地邊緣就停
   *   指定地點 → 自己周圍畫射程圈，落點畫爆炸範圍
   */
  drawAimGuide(self, canAct) {
    this.aimGuide.clear();
    const aim = this.controls.aiming;
    if (!aim || !self || !canAct) return;
    const skill = aim.skill;
    const x = this.predict.value(self, "x");
    const y = this.predict.value(self, "y");
    const color = theme.aimGuideColors?.[skill.id] ?? 0xffffff;
    const angle = Math.atan2(aim.y, aim.x);

    // 揮砍：前方的扇形範圍；舉盾：盾牌會擋的角度；旋風斬：周圍一圈
    if (skill.type === "slash" || skill.type === "guard") {
      const reach = skill.type === "slash" ? skill.range + PLAYER_HALF : PLAYER_HALF + 14;
      const half = (skill.arcDeg / 2) * (Math.PI / 180);
      this.aimGuide.fillStyle(color, 0.18).slice(x, y, reach, angle - half, angle + half).fillPath();
      this.aimGuide.lineStyle(1, color, AIM_GUIDE.alpha).slice(x, y, reach, angle - half, angle + half).strokePath();
      return;
    }
    if (skill.type === "whirl" || skill.type === "roar") {
      this.aimGuide.lineStyle(1, color, AIM_GUIDE.alpha).strokeCircle(x, y, skill.radius + PLAYER_HALF);
      this.aimGuide.fillStyle(color, 0.12).fillCircle(x, y, skill.radius + PLAYER_HALF);
      return;
    }
    if (skill.type === "barrier") {
      this.aimGuide.lineStyle(1, color, AIM_GUIDE.alpha).strokeCircle(x, y - 4, PLAYER_HALF + 9);
      return;
    }

    if (isTargeted(skill)) {
      // 和伺服器用同一個函式算落點，看到哪就炸哪
      const aimX = aim.x * aim.power * INPUT_SCALE;
      const aimY = aim.y * aim.power * INPUT_SCALE;
      const points = skill.type === "meteor"
        ? meteorTargets(x, y, aimX, aimY, skill)
        : [blastTarget(x, y, aimX, aimY, skill)];
      this.aimGuide.lineStyle(1, color, 0.35).strokeCircle(x, y, skill.range);
      for (const p of points) {
        this.aimGuide.lineStyle(1, color, AIM_GUIDE.alpha).strokeCircle(p.x, p.y, skill.radius);
        this.aimGuide.fillStyle(color, 0.15).fillCircle(p.x, p.y, skill.radius);
      }
      return;
    }

    const range = skill.speed * (skill.lifetimeTicks / TICK_RATE);
    this.aimGuide.fillStyle(color, AIM_GUIDE.alpha);
    for (let d = PLAYER_HALF + AIM_GUIDE.spacing; d <= range; d += AIM_GUIDE.spacing) {
      const px = x + aim.x * d;
      const py = y + aim.y * d;
      if (px < 0 || py < 0 || px > ARENA_WIDTH || py > ARENA_HEIGHT || circleHitsObstacle(px, py, skill.radius, this.solid)) break;
      this.aimGuide.fillCircle(Math.round(px), Math.round(py), AIM_GUIDE.dotRadius);
    }
  }

  /**
   * 場地外框。遊戲座標不變（場地仍是 0~ARENA），外框畫在負座標，
   * 鏡頭的範圍包含外框。
   */
  createBorder() {
    const { top, side, bottom } = theme.border;
    const fullH = top + ARENA_HEIGHT + bottom;
    // 鏡頭最多捲到外框邊緣，不會看到場地外的空白
    this.cameras.main.setBounds(-side, -top, ARENA_WIDTH + side * 2, fullH);

    // 角色的深度 = y（>0），外框用負深度，角色的頭才會疊在牆上
    this.add.tileSprite(-side, -top, ARENA_WIDTH + side * 2, top, "wallFace").setOrigin(0).setDepth(-2);
    this.add.tileSprite(-side, -top, side, fullH, "wallTop").setOrigin(0).setDepth(-1);
    this.add.tileSprite(ARENA_WIDTH, -top, side, fullH, "wallTop").setOrigin(0).setDepth(-1);
    this.add.tileSprite(0, ARENA_HEIGHT, ARENA_WIDTH, bottom, "wallTop").setOrigin(0).setDepth(-1);

    // 牆腳陰影，讓邊界更清楚
    const shadow = this.add.graphics().setDepth(-0.5);
    shadow.fillStyle(0x000000, 0.35).fillRect(0, 0, ARENA_WIDTH, 3);
    shadow.fillStyle(0x000000, 0.15).fillRect(0, 3, ARENA_WIDTH, 3);
    shadow.fillStyle(0x000000, 0.3).fillRect(0, 0, 2, ARENA_HEIGHT).fillRect(ARENA_WIDTH - 2, 0, 2, ARENA_HEIGHT);
    shadow.fillStyle(0x000000, 0.4).fillRect(-side, ARENA_HEIGHT, ARENA_WIDTH + side * 2, 1);
  }

  /**
   * 障礙物：圖片底部對齊佔地底部，深度 = 佔地底部的 y。
   * 角色深度是自己的 y，所以站在柱子後面（y 較小）會被擋住，站在前面會蓋過柱子。
   */
  /** 柱子：一般狀態 + 倒塌後的碎石（平常隱藏） */
  createObstacles() {
    this.pillarViews = OBSTACLE_RECTS.map((r) => {
      const x = (r.left + r.right) / 2;
      const sprite = this.add.image(x, r.bottom, "pillar").setOrigin(0.5, 1).setDepth(r.bottom);
      const rubble = this.add.image(x, r.bottom, "rubble").setOrigin(0.5, 1).setDepth(SHADOW.depth + 0.05).setVisible(false);
      return { sprite, rubble, x, lastHp: PILLAR.hp, flashUntil: 0, jitterUntil: 0 };
    });
  }

  /** 從伺服器狀態更新柱子：受傷閃白、越破越暗、倒塌噴碎石、時間到長回來 */
  updatePillars(now) {
    const pillars = this.room.state.pillars;
    this.pillarViews.forEach((view, i) => {
      const hp = pillars?.at(i)?.hp ?? PILLAR.hp;
      this.solid[i] = hp > 0;

      if (hp < view.lastHp) {
        view.flashUntil = now + PILLAR_FX.flashMs;
        view.jitterUntil = now + PILLAR_FX.jitterMs;
        if (hp === 0) this.breakPillar(view);
        else this.playSfx("pillar_hit", 0.6);
      } else if (hp > 0 && view.lastHp === 0) {
        this.regrowPillar(view);
      }
      view.lastHp = hp;
      if (hp === 0) return;

      const jitter = now < view.jitterUntil ? Math.round((Math.random() * 2 - 1) * PILLAR_FX.jitterPx) : 0;
      view.sprite.x = view.x + jitter;
      if (now < view.flashUntil) {
        view.sprite.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
      } else {
        // 血越少越暗：在白色（原色）和 damagedTint 之間內插
        const t = 1 - hp / PILLAR.hp;
        const c = Phaser.Display.Color.Interpolate.ColorWithColor(
          Phaser.Display.Color.ValueToColor(0xffffff), Phaser.Display.Color.ValueToColor(PILLAR_FX.damagedTint), 1, t);
        view.sprite.setTint(Phaser.Display.Color.GetColor(c.r, c.g, c.b)).setTintMode(Phaser.TintModes.MULTIPLY);
      }
    });
  }

  breakPillar(view) {
    this.playSfx("pillar_break");
    this.tweens.killTweensOf(view.sprite);
    view.sprite.setVisible(false);
    view.rubble.setVisible(true);
    // 碎石往四周噴，帶一點重力往下掉
    const baseY = view.sprite.y - 12;
    for (let k = 0; k < PILLAR_FX.debrisCount; k++) {
      const size = 2 + Math.floor(Math.random() * 3);
      const bit = this.add.rectangle(view.x, baseY - Math.random() * 30, size, size, 0x8a92a8).setDepth(view.sprite.depth + 1);
      const angle = Math.random() * Math.PI * 2;
      const dist = 14 + Math.random() * 22;
      this.tweens.add({
        targets: bit,
        x: view.x + Math.cos(angle) * dist,
        y: { value: view.sprite.y + Math.random() * 6, ease: "Quad.easeIn" },
        alpha: 0,
        duration: PILLAR_FX.debrisMs,
        onComplete: () => bit.destroy(),
      });
    }
  }

  regrowPillar(view) {
    view.rubble.setVisible(false);
    view.sprite.setVisible(true).clearTint().setAlpha(0).setScale(1, 0.2);
    this.tweens.add({ targets: view.sprite, alpha: 1, scaleY: 1, duration: PILLAR_FX.regrowMs, ease: "Back.easeOut" });
  }

  /** 鏡頭跟著自己的角色（第一次找到自己時開始跟隨，之後由 Phaser 平滑移動） */
  followSelf() {
    if (this.following) return;
    const view = this.playerViews.get(this.room.sessionId);
    if (!view) return;
    this.cameras.main.startFollow(view.sprite, true, CAMERA.lerp, CAMERA.lerp, 0, CAMERA.offsetY);
    this.following = true;
  }

  /** 右上角小地圖：柱子、玩家位置，以及目前畫面看到的範圍 */
  drawMinimap(self) {
    const { width, margin, alpha } = theme.minimap;
    const scale = width / ARENA_WIDTH;
    const height = Math.round(ARENA_HEIGHT * scale);
    const left = theme.viewport.width - width - margin;
    const top = margin;
    const g = this.minimap.clear();
    g.fillStyle(0x0b0c12, alpha).fillRect(left - 1, top - 1, width + 2, height + 2);
    g.lineStyle(1, 0xffffff, 0.25).strokeRect(left - 1, top - 1, width + 2, height + 2);

    OBSTACLE_RECTS.forEach((r, i) => {
      if (!this.solid[i]) return;
      g.fillStyle(0x8a92a8, 0.9).fillRect(left + Math.round(r.left * scale), top + Math.round(r.top * scale), 2, 2);
    });
    for (const [, b] of this.room.state.blasts) {
      g.fillStyle(BLAST_FX.color, 0.8).fillCircle(left + b.x * scale, top + b.y * scale, 2);
    }
    for (const [id, p] of this.room.state.players) {
      if (!p.alive) continue;
      const isSelf = id === this.room.sessionId;
      const x = this.predict.value(p, "x");
      const y = this.predict.value(p, "y");
      g.fillStyle(isSelf ? 0xffe066 : 0xff5c5c).fillRect(left + Math.round(x * scale) - 1, top + Math.round(y * scale) - 1, 3, 3);
    }
    // 目前畫面範圍
    const view = this.cameras.main.worldView;
    const x0 = Math.max(0, view.x), x1 = Math.min(ARENA_WIDTH, view.right);
    const y0 = Math.max(0, view.y), y1 = Math.min(ARENA_HEIGHT, view.bottom);
    g.lineStyle(1, 0xffffff, 0.35).strokeRect(left + x0 * scale, top + y0 * scale, (x1 - x0) * scale, (y1 - y0) * scale);
  }


  /** 被打中：所有人都看得到閃白和抖動；自己被打中再加鏡頭震動和手機震動 */
  onHit(view, isSelf, died, now) {
    view.flashUntil = now + HIT_FEEDBACK.flashMs;
    view.jitterUntil = now + HIT_FEEDBACK.jitterMs;
    if (died) this.playSfx("death", isSelf ? 1 : theme.othersVolume);
    if (!isSelf) return;
    if (!died) this.playSfx("hurt");

    const shake = died ? HIT_FEEDBACK.deathShake : HIT_FEEDBACK.shake;
    this.cameras.main.shake(shake.ms, shake.intensity);
    navigator.vibrate?.(died ? HIT_FEEDBACK.deathVibrateMs : HIT_FEEDBACK.vibrateMs);
  }

  /** 頭上浮起一段字（傷害數字、格擋…）：先彈大一下，再往上飄、淡掉 */
  spawnFloatText(x, y, text, color, size = 10) {
    const t = this.add.text(Math.round(x + (Math.random() - 0.5) * 12), Math.round(y), text, {
      fontFamily: "monospace", fontSize: `${size}px`, fontStyle: "bold", color,
      stroke: "#000000", strokeThickness: 3, resolution: 4,
    }).setOrigin(0.5, 1).setDepth(1100).setScale(1.6);
    this.tweens.add({ targets: t, scale: 1, duration: 90, ease: "Quad.easeOut" });
    this.tweens.add({
      targets: t, y: t.y - 18, duration: theme.damageText.riseMs, ease: "Quad.easeOut",
      onComplete: () => t.destroy(),
    });
    this.tweens.add({ targets: t, alpha: 0, delay: theme.damageText.riseMs * 0.55, duration: theme.damageText.riseMs * 0.45 });
  }

  /** 傷害數字：自己被打紅色、打別人白色、重擊黃色放大、中毒或毒沼綠色 */
  spawnDamageNumber(x, headY, amount, isSelf, poison) {
    const fx = theme.damageText;
    const big = amount >= fx.bigAt;
    const color = poison && amount < 10 ? fx.poisonColor : big ? fx.bigColor : isSelf ? fx.selfColor : fx.otherColor;
    this.spawnFloatText(x, headY - 2, String(amount), color, big ? 13 : 10);
  }

  /** 死亡：身體往面向那邊倒下再變淡，噴出角色顏色的碎片，一個白色魂魄往上飄走 */
  spawnDeath(view, player) {
    const s = view.sprite;
    const color = theme.skinColors[player.skin] ?? 0xffffff;
    view.deadPose = true;
    this.tweens.add({ targets: s, angle: s.flipX ? -90 : 90, duration: 240, ease: "Quad.easeIn" });
    this.tweens.add({ targets: s, alpha: 0.25, delay: 400, duration: 300 });
    const cx = s.x;
    const cy = s.y - s.displayHeight / 2;
    // 碎片：往四周噴，帶一點重力
    for (let k = 0; k < 12; k++) {
      const a = Math.random() * Math.PI * 2;
      const d = 12 + Math.random() * 16;
      const bit = this.add.rectangle(cx, cy, 3, 3, k % 3 ? color : 0xffffff).setDepth(1001);
      this.tweens.add({
        targets: bit, x: cx + Math.cos(a) * d,
        y: { value: cy + Math.sin(a) * d * 0.6 + 10, ease: "Quad.easeIn" },
        alpha: 0, duration: 450 + Math.random() * 200, onComplete: () => bit.destroy(),
      });
    }
    // 魂魄：角色的白色剪影，左右飄著往上升
    const soul = this.add.image(s.x, s.y, s.texture.key, s.frame.name).setOrigin(0.5, 1).setFlipX(s.flipX)
      .setTint(0xffffff).setTintMode(Phaser.TintModes.FILL).setAlpha(0.6).setDepth(1001).setBlendMode(Phaser.BlendModes.ADD);
    const anim = { t: 0 };
    this.tweens.add({
      targets: anim, t: 1, duration: 1000, ease: "Sine.easeOut",
      onUpdate: () => {
        soul.setPosition(cx + Math.sin(anim.t * Math.PI * 3) * 4, s.y - anim.t * 36).setScale(1 - anim.t * 0.4).setAlpha(0.6 * (1 - anim.t));
      },
      onComplete: () => soul.destroy(),
    });
    this.spawnDashDust(s.x, s.y, 0.8);
  }

  /** 復活：天上降下一道角色顏色的光柱，地上一圈光環擴散，角色從地上彈出來，周圍冒出光點 */
  spawnRespawn(view, x, feetY, skin) {
    const color = theme.skinColors[skin] ?? 0xffffff;
    const s = view.sprite;
    this.tweens.killTweensOf(s);
    s.setAngle(0).setAlpha(1).setScale(1, 0.2);
    this.tweens.add({ targets: s, scaleY: 1, duration: 260, ease: "Back.easeOut" });
    view.deadPose = false;
    // 光柱：外層角色色、裡面白色，從上往下打下來後變細消失
    for (const [w, c, a] of [[18, color, 0.55], [6, 0xffffff, 0.9]]) {
      const beam = this.add.rectangle(x, feetY, w, 120, c, a).setOrigin(0.5, 1).setDepth(1002)
        .setBlendMode(Phaser.BlendModes.ADD).setScale(1, 0);
      this.tweens.add({ targets: beam, scaleY: 1, duration: 120, ease: "Quad.easeOut" });
      this.tweens.add({ targets: beam, scaleX: 0, alpha: 0, delay: 150, duration: 380, ease: "Quad.easeIn", onComplete: () => beam.destroy() });
    }
    const ring = this.add.ellipse(x, feetY, 16, 6).setStrokeStyle(2, color, 1).setDepth(SHADOW.depth + 0.3);
    this.tweens.add({ targets: ring, scale: 3.5, alpha: 0, duration: 450, ease: "Quad.easeOut", onComplete: () => ring.destroy() });
    // 光點往上飄
    for (let k = 0; k < 10; k++) {
      const px = x + (Math.random() - 0.5) * 22;
      const dot = this.add.rectangle(px, feetY - Math.random() * 6, 2, 2, k % 2 ? color : 0xffffff).setDepth(1002)
        .setBlendMode(Phaser.BlendModes.ADD);
      this.tweens.add({
        targets: dot, y: dot.y - 20 - Math.random() * 24, alpha: 0,
        delay: 100 + Math.random() * 200, duration: 500 + Math.random() * 300, onComplete: () => dot.destroy(),
      });
    }
  }

  /** 受擊閃白優先，其次獅子吼的金光、中毒染綠，都沒有就原色（狀態變了才改，不每幀重設） */
  updateFlash(view, now, poisoned = false) {
    const state = now < view.flashUntil ? "flash" : now < (view.roarUntil ?? 0) ? "roar" : poisoned ? "poison" : "none";
    if (state === view.tintState) return;
    view.tintState = state;
    if (state === "flash") view.sprite.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
    else if (state === "roar") view.sprite.setTint(theme.monkFx.roarColor).setTintMode(Phaser.TintModes.FILL);
    else if (state === "poison") view.sprite.setTint(theme.witchFx.poisonTint).setTintMode(Phaser.TintModes.MULTIPLY);
    else view.sprite.clearTint();
  }

  /** 命中爆炸（完整 5 格）和沒打中的冒煙（最後 2 格） */
  /** 每張爆炸圖各一組（動畫 key：impact-hit-圖名、impact-miss-圖名） */
  createImpactAnimations() {
    const frameRate = theme.impactFrameRate;
    for (const tex of new Set(["explosion", ...Object.values(theme.impactTextures ?? {})])) {
      if (!this.textures.exists(tex) || this.anims.exists(`impact-hit-${tex}`)) continue;
      this.anims.create({ key: `impact-hit-${tex}`, frames: this.anims.generateFrameNumbers(tex), frameRate });
      this.anims.create({ key: `impact-miss-${tex}`, frames: this.anims.generateFrameNumbers(tex, { start: 3, end: 4 }), frameRate });
    }
  }

  /** area = 指定地點爆炸：不管有沒有打到人都是完整的大爆炸 */
  spawnImpact({ x, y, skill, hit, area }) {
    const big = hit || area;
    this.playSfx(big ? theme.skillSounds[skill]?.hit : "fizzle", big ? 1 : 0.5);
    if (hit && theme.meleeFx.cutSkills?.includes(skill)) return this.spawnCut(x, y);
    if (area && SKILLS[skill]?.type === "root") return this.spawnVineBurst(x, y, SKILLS[skill].radius);
    if (SKILLS[skill]?.poison) return this.spawnPoisonSplat(x, y, hit);
    if (SKILLS[skill]?.pierce) return this.spawnQiHit(x, y, hit);
    if (area) this.cameras.main.shake(100, 0.004);
    const tex = theme.impactTextures?.[skill] ?? "explosion";
    const key = `${big ? "impact-hit" : "impact-miss"}-${tex}`;
    if (!this.anims.exists(key)) return;
    // 範圍技能的爆炸圖放大到和範圍差不多
    const scale = big ? (SKILLS[skill]?.impactScale ?? (area ? SKILLS[skill].radius / 15 : 1)) : 1;
    const fx = this.add.sprite(x, y, tex).setScale(scale).setDepth(1001);
    fx.play(key);
    fx.once("animationcomplete", () => fx.destroy());
    if (theme.fireFx.skills.includes(skill)) this.spawnFireExtras(x, y, area ? SKILLS[skill].radius / 8 : 1, big);
  }

  /**
   * 衝刺：開始時播音效，衝刺中留下殘影。
   * 自己讀預測值（按下就立刻有反應），其他人讀伺服器狀態。
   */
  updateDash(view, player, isSelf, now) {
    const dashTicks = isSelf ? this.predict.value(player, "dashTicks") : player.dashTicks;
    const dashing = dashTicks > 0 && player.alive;

    // 劍士的衝刺有自己的特效（紅色殘影、劍氣軌跡、揚塵）
    const fx = theme.meleeFx;
    const swordDash = fx.dashSkills.includes(kitSkill(player.skin, DASH_SLOT)?.id);
    const s = view.sprite;
    const skinDash = theme.dashFx[player.skin]; // 其他角色：依角色換顏色、沿路灑粒子
    if (dashing && !view.wasDashing) {
      this.playSfx(theme.skillSounds[DASH_INDEX]?.cast, isSelf ? 1 : theme.othersVolume);
      view.dashFrom = { x: s.x, y: s.y };
      this.spawnDashDust(s.x, s.y, swordDash ? 1 : 0.6);
    }
    if (!dashing && view.wasDashing && player.alive) this.spawnDashDust(s.x, s.y, swordDash ? 0.6 : 0.4); // 煞車
    if (dashing && swordDash) this.drawDashStreak(view, now);
    if (dashing && !swordDash && skinDash) this.spawnDashParticles(s, skinDash.particles);
    view.wasDashing = dashing;

    // 被獅子吼震飛時也留殘影（金色），看得出是被打飛的
    const knockTicks = isSelf ? this.predict.value(player, "knockTicks") : player.knockTicks;
    const knocked = knockTicks > 0 && player.alive;
    const dashTint = swordDash ? fx.dashTint : skinDash?.tint ?? 0x9fdcff;
    const trail = knocked ? theme.monkFx.knockTrail : dashing ? { ...theme.dashTrail, tint: dashTint } : null;
    if (trail && now >= view.nextTrailAt) {
      view.nextTrailAt = now + trail.everyMs;
      const ghost = this.add.image(s.x, s.y, s.texture.key, s.frame.name)
        .setOrigin(0.5, 1).setFlipX(s.flipX).setDepth(s.depth - 0.1).setAlpha(trail.alpha)
        .setTint(trail.tint).setTintMode(Phaser.TintModes.FILL);
      this.tweens.add({ targets: ghost, alpha: 0, duration: trail.fadeMs, onComplete: () => ghost.destroy() });
    }
  }

  /**
   * 劍士衝刺中：從起點到目前位置，地上拉出一道劍氣軌跡（每幀補一段，各自淡掉），
   * 身後再加幾條白色風切線。
   */
  drawDashStreak(view, now) {
    const fx = theme.meleeFx;
    const s = view.sprite;
    const from = view.dashFrom ?? { x: s.x, y: s.y };
    const dx = s.x - from.x;
    const dy = s.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len < 2) return;
    // 軌跡：這一幀走過的那一段，畫成一條發光的線（貼在地上：腳底高度）
    const seg = this.add.graphics().setDepth(SHADOW.depth + 0.3).setBlendMode(Phaser.BlendModes.ADD);
    seg.lineStyle(4, fx.dashTint, 0.5).lineBetween(from.x, from.y - 2, s.x, s.y - 2);
    seg.lineStyle(2, fx.dashStreakColor, 0.9).lineBetween(from.x, from.y - 2, s.x, s.y - 2);
    this.tweens.add({ targets: seg, alpha: 0, duration: fx.dashStreakMs, onComplete: () => seg.destroy() });
    view.dashFrom = { x: s.x, y: s.y };
    // 風切線：身體後方，和移動方向平行
    const ux = dx / len;
    const uy = dy / len;
    const midY = s.y - s.displayHeight / 2;
    for (let k = -1; k <= 1; k++) {
      const off = k * 6 + Math.sin(now / 30 + k) * 1.5; // 垂直方向錯開
      const bx = s.x - ux * 10 - uy * off;
      const by = midY - uy * 10 + ux * off;
      const lineLen = 10 - Math.abs(k) * 3; // 中間那條最長
      this.statusFx.lineStyle(1, 0xffffff, 0.7).lineBetween(bx, by, bx - ux * lineLen, by - uy * lineLen);
    }
  }

  /** 一般衝刺中：身體周圍灑出角色顏色的小粒子（藍色星點、綠葉、金色氣），往後飄散 */
  spawnDashParticles(s, colors) {
    for (let k = 0; k < 2; k++) {
      const px = s.x + (Math.random() - 0.5) * 14;
      const py = s.y - Math.random() * s.displayHeight;
      const dot = this.add.rectangle(px, py, 2, 2, colors[Math.floor(Math.random() * colors.length)])
        .setDepth(s.depth - 0.05).setBlendMode(Phaser.BlendModes.ADD);
      this.tweens.add({
        targets: dot, x: px + (Math.random() - 0.5) * 10, y: py - 4 - Math.random() * 6,
        alpha: 0, duration: 300 + Math.random() * 200, onComplete: () => dot.destroy(),
      });
    }
  }

  /** 衝刺起步、煞車：腳邊揚起一圈塵土（strength 越大越多越遠） */
  spawnDashDust(x, y, strength) {
    const count = Math.round(theme.meleeFx.dashDust * strength);
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const d = (8 + Math.random() * 10) * strength;
      const puff = this.add.circle(x, y - 1, 2 + Math.random() * 1.5, 0xc9b79c, 0.7).setDepth(y + 0.2);
      this.tweens.add({
        targets: puff, x: x + Math.cos(a) * d, y: y - 1 + Math.sin(a) * d * 0.4, // 地面是斜看的，上下壓扁
        scale: 1.8, alpha: 0, duration: 280 + Math.random() * 120, ease: "Quad.easeOut", onComplete: () => puff.destroy(),
      });
    }
  }

  /**
   * 紅劍士的持續型技能（伺服器狀態，所有人都看得到）：
   *   舉盾 → 身體前方一面弧形的能量盾（展開、反光、擋下時變白、放下時散掉）
   *   旋風斬 → 兩道拖著殘光的刀刃繞圈、身體高度再一層小旋風，每次砍擊震出一圈波，邊緣甩出碎屑；角色快速左右翻面
   */
  updateMelee(view, player, x, y, isSelf, now) {
    const fx = theme.meleeFx;
    const volume = isSelf ? 1 : theme.othersVolume;
    const cx = Math.round(x);
    const cy = Math.round(y) - 4; // 身體中間（碰撞圓心在腳底上方一點）

    const guarding = player.guardTicks > 0 && player.alive;
    const guard = SKILLS.find((s) => s.type === "guard");
    const half = (guard.arcDeg / 2) * (Math.PI / 180);
    if (guarding) view.guardAngle = Math.atan2(player.guardY, player.guardX);
    if (guarding && !view.wasGuarding) {
      this.playSfx("guard", volume);
      view.guardStart = now;
    }
    if (!guarding && view.wasGuarding) this.spawnShieldDrop(cx, cy, view.guardAngle, half);
    view.wasGuarding = guarding;
    if (guarding) {
      // 快結束時閃爍，提醒盾牌要放下了
      const fading = player.guardTicks < 8 && Math.floor(now / 60) % 2 === 0;
      const raise = Math.min(1, (now - view.guardStart) / fx.guardRaiseMs);
      const flash = now < (view.blockFlashUntil ?? 0); // 剛擋下攻擊：整面變白、往後縮一下
      this.drawShield(this.statusFx, cx, cy, view.guardAngle, half * (0.4 + 0.6 * raise), {
        radius: PLAYER_HALF + 8 - (flash ? 2 : 0) - (1 - raise) * 4, // 展開時從身邊往外推
        alpha: fading ? 0.4 : 1, flash, now,
      });
    }

    const whirling = player.whirlTicks > 0 && player.alive;
    const whirl = SKILLS.find((s) => s.type === "whirl");
    const r = whirl.radius + PLAYER_HALF;
    if (whirling && !view.wasWhirling) {
      this.playSfx("whirl", volume);
      view.whirlStart = now;
      this.spawnWhirlBurst(cx, Math.round(y), r * 0.6);
    }
    if (!whirling && view.wasWhirling && player.alive) this.spawnWhirlBurst(cx, Math.round(y), r); // 收招
    view.wasWhirling = whirling;
    if (whirling) {
      const gy = Math.round(y);
      const spin = now / 60; // 順時針轉（角度變大）
      // 地上：淡淡的範圍 + 外圈一圈轉動的虛線
      this.floorFx.fillStyle(fx.whirlColor, 0.1).fillCircle(cx, gy, r);
      this.floorFx.lineStyle(1, fx.whirlColor, 0.6);
      for (let k = 0; k < 16; k += 2) {
        const a = -spin * 0.3 + (k * Math.PI * 2) / 16;
        this.floorFx.beginPath().arc(cx, gy, r, a, a + Math.PI / 16).strokePath();
      }
      // 兩道刀刃：前端最亮，後面拖著越來越淡、越來越細的殘光
      for (let k = 0; k < 2; k++) {
        const lead = spin + k * Math.PI;
        // 刀刃掃過的地方留一片扇形殘影（動態模糊），轉起來比較有感覺
        this.floorFx.fillStyle(fx.whirlColor, 0.22).slice(cx, gy, r * 0.9, lead - 1.1, lead, false).fillPath();
        for (let j = 0; j < 6; j++) {
          const a1 = lead - j * 0.22;
          this.floorFx.lineStyle(4 - j * 0.5, j === 0 ? fx.whirlBladeColor : fx.whirlColor, 0.9 - j * 0.14)
            .beginPath().arc(cx, gy, r * 0.85, a1 - 0.22, a1).strokePath();
        }
      }
      // 身體高度的小旋風：轉得更快，畫在角色上層，看起來是捲起來的風
      for (let k = 0; k < 3; k++) {
        const a = spin * 1.6 + (k * Math.PI * 2) / 3;
        this.statusFx.lineStyle(1, 0xffffff, 0.45).beginPath().arc(cx, cy - 2, r * 0.5, a, a + 0.8).strokePath();
      }
      // 每次砍擊（和伺服器扣血同一個節奏）從中間震出一圈波
      const hitMs = (whirl.hitEveryTicks / TICK_RATE) * 1000;
      const pulse = ((now - (view.whirlStart ?? now)) % hitMs) / hitMs; // 中途加入的人沒有開始時間
      this.floorFx.lineStyle(2, fx.whirlBladeColor, 0.6 * (1 - pulse)).strokeCircle(cx, gy, r * (0.4 + 0.6 * pulse));
      // 邊緣甩出碎屑（順著旋轉方向往外飛）
      if (now >= (view.nextDebrisAt ?? 0)) {
        view.nextDebrisAt = now + fx.whirlDebrisEveryMs;
        this.spawnWhirlDebris(cx, gy, r * 0.85, spin);
      }
      view.sprite.setFlipX(Math.floor(now / fx.whirlSpinMs) % 2 === 0);
    }
  }

  /** 旋風斬甩出的碎屑：從刀刃前端沿切線方向飛出去 */
  spawnWhirlDebris(cx, cy, r, angle) {
    const fx = theme.meleeFx;
    const sx = cx + Math.cos(angle) * r;
    const sy = cy + Math.sin(angle) * r;
    // 順時針的切線方向是 (-sin, cos)，再往外偏一點
    const tx = -Math.sin(angle) + Math.cos(angle) * 0.5;
    const ty = Math.cos(angle) + Math.sin(angle) * 0.5;
    const d = 14 + Math.random() * 10;
    const bit = this.add.rectangle(sx, sy, 2, 2, Math.random() < 0.5 ? 0xc9b79c : fx.whirlBladeColor).setDepth(sy + 0.2);
    this.tweens.add({
      targets: bit, x: sx + tx * d, y: sy + ty * d * 0.7, alpha: 0,
      duration: 260 + Math.random() * 120, ease: "Quad.easeOut", onComplete: () => bit.destroy(),
    });
  }

  /** 旋風斬起手、收招：一圈刀氣往外擴散，腳邊揚塵 */
  spawnWhirlBurst(x, y, r) {
    const fx = theme.meleeFx;
    const ring = this.add.circle(x, y, r).setStrokeStyle(3, fx.whirlBladeColor, 0.9).setDepth(SHADOW.depth + 0.3);
    this.tweens.add({ targets: ring, scale: 1.5, alpha: 0, duration: 260, ease: "Quad.easeOut", onComplete: () => ring.destroy() });
    this.spawnDashDust(x, y, 1);
  }

  /**
   * 毒沼：一灘邊緣會蠕動的毒液（外淺內深），裡面冒泡泡、往上飄毒氣；
   * 每 0.5 秒（和伺服器扣血同步）從中間擴散一圈毒波；快消失時閃爍。
   */
  drawZones(now) {
    const fx = theme.witchFx;
    for (const [id, z] of this.room.state.zones) {
      const skill = SKILLS[z.skill];
      const age = now - (this.zoneStartAt.get(id) ?? now);
      const leftMs = (skill.durationTicks / TICK_RATE) * 1000 - age;
      const blink = leftMs < 600 && Math.floor(now / 100) % 2 === 0;
      const grow = 1 - (1 - Math.min(1, age / 180)) ** 3; // 出現時從中間快速攤開
      const r = skill.radius * grow;
      const a = blink ? 0.5 : 1; // 閃爍時整體變淡
      // 邊緣蠕動的一灘：外層淺、內層深
      this.floorFx.fillStyle(fx.swampColor, 0.3 * a).fillPoints(this.blobPoints(z.x, z.y, r, now, 0), true);
      this.floorFx.fillStyle(fx.swampDark, 0.35 * a).fillPoints(this.blobPoints(z.x, z.y, r * 0.62, now, 2), true);
      this.floorFx.lineStyle(1, fx.swampColor, 0.85 * a).strokePoints(this.blobPoints(z.x, z.y, r, now, 0), true);
      // 毒波：每次扣血時從中間擴散到邊緣
      const pulseMs = (skill.hitEveryTicks / TICK_RATE) * 1000;
      const pulse = (age % pulseMs) / pulseMs;
      this.floorFx.lineStyle(2, fx.swampMist, 0.5 * (1 - pulse) * a).strokeEllipse(z.x, z.y, r * 2 * pulse, r * 1.7 * pulse);
      // 毒氣：幾縷綠煙往上飄、越飄越淡（畫在角色上層，看起來是浮在空中）
      for (let k = 0; k < 5; k++) {
        const t = ((now / 1300) + k * 0.21) % 1;
        const ang = k * 2.1 + Math.floor((now / 1300) + k * 0.21) * 0.9;
        const mx = z.x + Math.cos(ang) * r * 0.55 + Math.sin(t * 6 + k) * 2;
        const my = z.y + Math.sin(ang) * r * 0.45 - t * 18;
        const size = 2 + Math.round(t * 2);
        this.statusFx.fillStyle(fx.swampMist, 0.35 * (1 - t) * a).fillRect(Math.round(mx) - 1, Math.round(my) - 1, size, size);
      }
      // 泡泡：用固定的「亂數」決定位置，每顆泡泡循環變大再破掉
      for (let k = 0; k < 6; k++) {
        const phase = ((now / 700) + k * 0.37) % 1;
        const a = k * 2.4 + Math.floor((now / 700) + k * 0.37) * 1.3;
        const d = r * (0.2 + ((k * 0.61) % 0.7));
        this.floorFx.lineStyle(1, 0xcfffc4, 0.8 * (1 - phase))
          .strokeCircle(Math.round(z.x + Math.cos(a) * d), Math.round(z.y + Math.sin(a) * d * 0.7), 1 + phase * 2.5);
      }
    }
  }

  /** 邊緣會蠕動的圓（毒沼用）：半徑隨角度和時間微微起伏，seed 讓內外層動得不一樣 */
  blobPoints(x, y, r, now, seed) {
    const points = [];
    const n = 20;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const wobble = 1 + 0.07 * Math.sin(ang * 3 + now / 380 + seed) + 0.04 * Math.sin(ang * 5 - now / 260 + seed);
      points.push({ x: x + Math.cos(ang) * r * wobble, y: y + Math.sin(ang) * r * wobble * 0.85 });
    }
    return points;
  }

  /** 這個玩家是不是站在別人的毒沼裡 */
  inEnemySwamp(id, x, y) {
    for (const z of this.room.state.zones.values()) {
      if (z.owner !== id && (x - z.x) ** 2 + (y - z.y) ** 2 <= SKILLS[z.skill].radius ** 2) return true;
    }
    return false;
  }

  /** 踩在別人的毒沼裡：腳邊一圈圈漣漪，偶爾濺起小水滴 */
  drawWading(id, player, x, y, now) {
    if (!player.alive || !this.inEnemySwamp(id, x, y)) return;
    const fx = theme.witchFx;
    const cx = Math.round(x);
    const feetY = Math.round(y + PLAYER_HALF);
    for (let k = 0; k < 2; k++) {
      const t = ((now / 600) + k * 0.5) % 1;
      this.floorFx.lineStyle(1, fx.swampMist, 0.8 * (1 - t)).strokeEllipse(cx, feetY, 10 + t * 18, 4 + t * 6);
    }
    // 腳邊兩滴往上濺的毒液（拋物線）
    for (let k = 0; k < 2; k++) {
      const t = ((now / 450) + k * 0.5) % 1;
      const dx = (k ? 1 : -1) * (3 + t * 6);
      const dy = -24 * t * (1 - t); // 拋物線，最高 6px
      this.statusFx.fillStyle(fx.swampColor, 1 - t).fillRect(cx + Math.round(dx), feetY + Math.round(dy) - 1, 2, 2);
    }
  }

  /** 毒沼落地：一圈毒液水花往外噴，加一道擴散的漣漪 */
  spawnSwampSplash(x, y, radius) {
    const fx = theme.witchFx;
    const ring = this.add.ellipse(x, y, 8, 7).setStrokeStyle(2, fx.swampMist, 0.9).setDepth(SHADOW.depth + 0.3);
    this.tweens.add({
      targets: ring, displayWidth: radius * 2.3, displayHeight: radius * 2,
      alpha: 0, duration: 380, ease: "Quad.easeOut", onComplete: () => ring.destroy(),
    });
    this.spawnDroplets(x, y, fx.swampSplash, radius, 10);
  }

  /** 毒液水滴：往四周噴出去，每滴畫一道拋物線（先往上再落回地面） */
  spawnDroplets(x, y, count, spread, height) {
    const fx = theme.witchFx;
    for (let k = 0; k < count; k++) {
      const ang = (k / count) * Math.PI * 2 + Math.random() * 0.4;
      const d = spread * (0.6 + Math.random() * 0.6);
      const drop = this.add.rectangle(x, y, 3, 3, k % 2 ? fx.swampColor : fx.swampMist).setDepth(1001);
      const h = height * (1 + Math.random() * 1.2);
      const anim = { t: 0 };
      this.tweens.add({
        targets: anim, t: 1, duration: 360 + Math.random() * 160,
        onUpdate: () => {
          drop.setPosition(x + Math.cos(ang) * d * anim.t, y + Math.sin(ang) * d * 0.85 * anim.t - h * 4 * anim.t * (1 - anim.t));
          drop.setAlpha(1 - anim.t * 0.6);
        },
        onComplete: () => drop.destroy(),
      });
    }
  }

  /**
   * 毒液彈打中：啪一聲濺開（中間一團綠色炸開、水滴噴四周），地上留下一灘毒液慢慢淡掉。
   * 沒打中人（撞牆、飛到底）只有小小一灘和幾滴。
   */
  spawnPoisonSplat(x, y, hit) {
    const fx = theme.witchFx;
    const size = hit ? 1 : 0.55;
    const groundY = y + SHADOW.projectile.offsetY * 0.6;
    const stain = this.add.ellipse(x, groundY, 22 * size, 9 * size, fx.swampDark, 0.6).setDepth(SHADOW.depth + 0.3);
    this.tweens.add({ targets: stain, scaleX: 1.2, alpha: 0, duration: fx.splatMs, ease: "Quad.easeIn", onComplete: () => stain.destroy() });
    const blob = this.add.circle(x, y, 7 * size, fx.swampColor, 0.9).setDepth(1001);
    this.tweens.add({ targets: blob, scale: 1.8, alpha: 0, duration: 200, ease: "Quad.easeOut", onComplete: () => blob.destroy() });
    this.spawnDroplets(x, y, hit ? fx.splatDrops : 4, 20 * size, 8 * size);
  }

  /**
   * 中毒中：頭上冒綠色泡泡（每顆往上飄、變大、破掉）；
   * 每次毒發扣血時從身上噴出幾滴毒液。
   */
  drawPoisoned(view, player, x, y, now) {
    const poisoned = player.poisonTicks > 0 && player.alive;
    const every = SKILLS.find((s) => s.poison)?.poison.everyTicks ?? 15;
    const step = Math.ceil(player.poisonTicks / every); // 每毒發一次少 1
    // 最後一次毒發時 poisonTicks 剛好變 0，所以不檢查 poisoned
    if (player.alive && view.poisonStep !== undefined && step < view.poisonStep) this.spawnDroplets(x, y, 5, 10, 6);
    view.poisonStep = poisoned ? step : undefined;
    if (!poisoned) return;
    const fx = theme.witchFx;
    const headY = Math.round(y + PLAYER_HALF) - view.sprite.height;
    for (let k = 0; k < 3; k++) {
      const t = ((now / 800) + k / 3) % 1;
      // 從頭的兩側往上冒（正上方是名字，會被擋住）
      const bx = Math.round(x) + (k - 1) * 9 + Math.round(Math.sin(t * 7 + k) * 1.5);
      const by = Math.round(headY + 10 - t * 14);
      const r = 1.5 + t * 1.5;
      this.statusFx.fillStyle(fx.swampColor, 0.8 * (1 - t)).fillCircle(bx, by, r);
      this.statusFx.lineStyle(1, fx.swampMist, 1 - t).strokeCircle(bx, by, r);
    }
  }

  /** 毒沼消失：剩下的毒液蒸發成幾團綠煙往上飄 */
  spawnSwampFade(x, y, radius) {
    const fx = theme.witchFx;
    for (let k = 0; k < 10; k++) {
      const ang = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * radius * 0.9;
      const puff = this.add.rectangle(x + Math.cos(ang) * d, y + Math.sin(ang) * d * 0.85, 4, 4, fx.swampMist, 0.5).setDepth(998);
      this.tweens.add({
        targets: puff, y: puff.y - 16 - Math.random() * 10, scale: 1.8, alpha: 0,
        duration: 500 + Math.random() * 300, delay: Math.random() * 120, onComplete: () => puff.destroy(),
      });
    }
  }

  /**
   * 被藤蔓定身：藤蔓從腳邊往上纏到腰（剛被纏住時會長上來），隨風擺動；
   * 快解除時閃爍，解除的瞬間藤蔓斷掉、葉子散開。
   */
  drawRoot(view, player, x, y, now) {
    const rooted = player.rootTicks > 0 && player.alive;
    const fx = theme.witchFx;
    const cx = Math.round(x);
    const feetY = Math.round(y + PLAYER_HALF);
    if (rooted && !view.rootStart) view.rootStart = now;
    if (!rooted) {
      if (view.rootStart && player.alive) this.spawnLeaves(cx, feetY - 8, 8, 18); // 掙脫
      view.rootStart = 0;
      return;
    }
    if (player.rootTicks < 8 && Math.floor(now / 60) % 2 === 0) return;
    const grow = Math.min(1, (now - view.rootStart) / fx.wrapGrowMs);
    // 地上一圈纏繞的藤蔓
    this.statusFx.lineStyle(3, fx.vineDark, 0.9).strokeEllipse(cx, feetY, 28, 9);
    this.statusFx.lineStyle(1, fx.vineColor, 1).strokeEllipse(cx, feetY, 28, 9);
    // 從腳邊往上纏的藤蔓：左右交錯，高度隨 grow 長到腰部
    for (let k = 0; k < 5; k++) {
      const bx = cx + (k - 2) * 5;
      const height = (14 + (k % 2) * 6) * grow;
      const lean = (k - 2) * -1.5; // 往身體中間靠
      this.drawVine(this.statusFx, bx, feetY + 2, bx + lean, feetY + 2 - height, { wiggle: 2.5, phase: now / 150 + k * 1.7, width: 1 });
    }
  }

  /** 藤蔓爆發：範圍內一堆藤蔓從地面竄起再縮回去，葉子往外噴，外圈閃一下綠光 */
  spawnVineBurst(x, y, radius) {
    const fx = theme.witchFx;
    this.cameras.main.shake(140, 0.006);
    const g = this.add.graphics().setDepth(997);
    const vines = Array.from({ length: fx.burstVines }, (_, k) => {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * radius * 0.9;
      return { x: x + Math.cos(a) * d, y: y + Math.sin(a) * d * 0.85, h: 14 + Math.random() * 14, lean: (Math.random() - 0.5) * 10, phase: k };
    });
    const anim = { t: 0 };
    this.tweens.add({
      targets: anim, t: 1, duration: fx.burstMs,
      onUpdate: () => {
        g.clear();
        // 前 30% 竄起，之後慢慢縮回、變淡
        const rise = Math.min(1, anim.t / 0.3);
        const fade = anim.t < 0.5 ? 1 : 1 - (anim.t - 0.5) / 0.5;
        g.lineStyle(2, fx.leafColor, 0.8 * (1 - anim.t)).strokeCircle(x, y, radius * (0.9 + 0.2 * anim.t));
        for (const v of vines) {
          const h = v.h * (rise < 1 ? 1 - (1 - rise) ** 3 : 1 - 0.3 * anim.t);
          this.drawVine(g, v.x, v.y, v.x + v.lean, v.y - h, { wiggle: 3, phase: v.phase + anim.t * 6, alpha: fade });
        }
      },
      onComplete: () => g.destroy(),
    });
    this.spawnLeaves(x, y, 16, radius);
  }

  /** 葉子：小綠方塊往外噴，帶一點往下掉的重力 */
  spawnLeaves(x, y, count, spread) {
    const fx = theme.witchFx;
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const d = spread * (0.5 + Math.random() * 0.7);
      const leaf = this.add.rectangle(x, y, 3, 2, k % 3 ? fx.leafColor : fx.vineColor).setDepth(1001).setRotation(a);
      this.tweens.add({
        targets: leaf,
        x: x + Math.cos(a) * d,
        y: { value: y + Math.sin(a) * d * 0.6 + 8, ease: "Quad.easeIn" },
        rotation: a + (Math.random() - 0.5) * 6,
        alpha: 0, duration: 450 + Math.random() * 250, onComplete: () => leaf.destroy(),
      });
    }
  }

  /**
   * 金鐘罩：一口半透明的金鐘從天上罩下來（落地時「噹」一聲、震出兩圈波紋），
   * 鐘身有花紋和一道來回掃過的反光；越被打越淡、出現裂痕；快到期時閃爍；
   * 時間到自己消失時，鐘往上升起淡出（被打破的另外在 spawnBarrierHit 碎掉）。
   */
  drawBarrier(view, player, x, y, isSelf, now) {
    const on = player.barrier > 0 && player.alive;
    const fx = theme.monkFx;
    const skill = SKILLS.find((s) => s.type === "barrier");
    const feetY = Math.round(y + PLAYER_HALF) + 2;
    const height = view.sprite.displayHeight + 8;
    if (on && !view.hadBarrier) {
      view.barrierStart = now;
      this.playSfx("barrier", isSelf ? 1 : theme.othersVolume);
      this.time.delayedCall(fx.bellDropMs, () => this.spawnBellRings(view));
    }
    if (!on && view.hadBarrier && player.alive && now - (view.barrierBrokeAt ?? 0) > 300) {
      this.spawnBellLift(x, feetY, height); // 時間到，不是被打破
    }
    view.hadBarrier = on;
    if (!on) return;
    const left = player.barrier / skill.amount;
    const leftMs = (skill.durationTicks / TICK_RATE) * 1000 - (now - view.barrierStart);
    if (leftMs < 600 && Math.floor(now / 90) % 2 === 0) return;
    // 罩下來：從上方掉下，落地彈一下
    const t = Math.min(1, (now - view.barrierStart) / fx.bellDropMs);
    const drop = -40 * (1 - Phaser.Math.Easing.Bounce.Out(t));
    // 被打到時鐘身左右晃
    const shake = now < (view.bellShakeUntil ?? 0) ? Math.round(Math.sin(now / 12) * 2) : 0;
    this.drawBell(this.statusFx, Math.round(x) + shake, feetY + drop, height, left, now);
  }

  /** 畫一口金鐘：(cx, bottomY) 是鐘口中間，left = 剩下的護盾比例（越少越淡、裂痕越多） */
  drawBell(g, cx, bottomY, height, left, now, alpha = 1) {
    const fx = theme.monkFx;
    const w = PLAYER_HALF + 8; // 鐘口半寬
    const h = height;
    // 輪廓：鐘口外擴 → 鐘身 → 圓頂（右半邊算好再鏡像）
    const half = [[1, 0], [0.94, -0.05], [0.78, -0.14], [0.7, -0.45], [0.66, -0.72], [0.56, -0.88], [0.32, -0.98], [0, -1]];
    const pts = [...half.map(([px, py]) => ({ x: cx + px * w, y: bottomY + py * h })),
      ...half.slice(0, -1).reverse().map(([px, py]) => ({ x: cx - px * w, y: bottomY + py * h }))];
    g.fillStyle(fx.barrierColor, (0.1 + 0.14 * left) * alpha).fillPoints(pts, true);
    g.lineStyle(2, fx.barrierColor, (0.4 + 0.55 * left) * alpha).strokePoints(pts, true);
    // 頂上的鐘鈕
    g.fillStyle(fx.barrierColor, (0.5 + 0.5 * left) * alpha).fillRect(cx - 2, bottomY - h - 3, 4, 3);
    // 兩條橫紋（鐘身的花紋）
    g.lineStyle(1, fx.bellDark, 0.7 * alpha);
    for (const [py, px] of [[-0.18, 0.86], [-0.72, 0.72]]) g.lineBetween(cx - px * w, bottomY + py * h, cx + px * w, bottomY + py * h);
    // 反光：一道亮線從左掃到右
    const s = ((now / 900) % 1) * 1.2 - 0.6;
    g.lineStyle(2, 0xffffff, 0.35 * alpha).lineBetween(cx + s * w, bottomY - 0.82 * h, cx + s * w * 1.15, bottomY - 0.25 * h);
    // 裂痕：護盾剩不到 60% 開始出現，越少越多條
    const cracks = left < 0.6 ? (left < 0.3 ? 3 : 1) : 0;
    g.lineStyle(1, 0xffffff, 0.8 * alpha);
    for (let k = 0; k < cracks; k++) {
      const sx = cx + [-0.4, 0.35, -0.05][k] * w;
      const sy = bottomY - [0.6, 0.45, 0.85][k] * h;
      g.beginPath().moveTo(sx, sy).lineTo(sx + 3, sy + 4).lineTo(sx + 1, sy + 7).lineTo(sx + 4, sy + 11).strokePath();
    }
  }

  /** 金鐘落地「噹」：從鐘口震出兩圈金色波紋 */
  spawnBellRings(view) {
    if (!view.hadBarrier) return;
    const x = view.sprite.x;
    const y = view.sprite.y + 2;
    for (let k = 0; k < 2; k++) {
      const ring = this.add.ellipse(x, y, 30, 10).setStrokeStyle(2, theme.monkFx.barrierColor, 0.9).setDepth(SHADOW.depth + 0.3);
      this.tweens.add({
        targets: ring, scale: 2.4, alpha: 0, delay: k * 110, duration: 380, ease: "Quad.easeOut", onComplete: () => ring.destroy(),
      });
    }
  }

  /** 金鐘時間到：往上升起、慢慢淡掉 */
  spawnBellLift(x, bottomY, height) {
    const g = this.add.graphics().setDepth(998);
    const anim = { t: 0 };
    this.tweens.add({
      targets: anim, t: 1, duration: 350, ease: "Quad.easeIn",
      onUpdate: () => {
        g.clear();
        this.drawBell(g, Math.round(x), bottomY - 30 * anim.t, height, 1, performance.now(), 1 - anim.t);
      },
      onComplete: () => g.destroy(),
    });
  }

  /** 金鐘罩吸收傷害：鐘身晃一下、閃一圈光；被打破時碎成金色碎片往外飛 */
  spawnBarrierHit({ x, y, broke }) {
    this.playSfx(broke ? "barrier_break" : "block", broke ? 1 : 0.5);
    this.spawnFloatText(x, y - 24, broke ? "破！" : "吸收", broke ? "#ffffff" : "#ffd23f", broke ? 11 : 9);
    const fx = theme.monkFx;
    // 找出是誰的鐘（訊息只有位置：取最近的玩家）
    let view;
    let best = Infinity;
    for (const [id, p] of this.room.state.players) {
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < best) { best = d; view = this.playerViews.get(id); }
    }
    const now = performance.now();
    const cy = y - 4;
    const flash = this.add.ellipse(x, cy, 30, 34).setStrokeStyle(2, broke ? 0xffffff : fx.barrierColor, 1).setDepth(1001);
    this.tweens.add({ targets: flash, scale: broke ? 1.8 : 1.3, alpha: 0, duration: broke ? 300 : 160, onComplete: () => flash.destroy() });
    if (!broke) {
      if (view) view.bellShakeUntil = now + 160;
      return;
    }
    if (view) view.barrierBrokeAt = now;
    this.cameras.main.shake(100, 0.004);
    for (let k = 0; k < fx.bellShards; k++) {
      const a = (k / fx.bellShards) * Math.PI * 2 + Math.random() * 0.3;
      const sx = x + Math.cos(a) * 12;
      const sy = cy + Math.sin(a) * 14;
      const shard = this.add.triangle(sx, sy, 0, 0, 4 + Math.random() * 3, 1, 1, 4 + Math.random() * 3, k % 3 ? fx.barrierColor : 0xffffff)
        .setDepth(1001).setRotation(Math.random() * 6);
      const d = 18 + Math.random() * 16;
      this.tweens.add({
        targets: shard,
        x: sx + Math.cos(a) * d,
        y: { value: sy + Math.sin(a) * d + 10, ease: "Quad.easeIn" }, // 往外飛再往下掉
        rotation: shard.rotation + (Math.random() - 0.5) * 8,
        alpha: 0, duration: 450 + Math.random() * 200, onComplete: () => shard.destroy(),
      });
    }
  }

  /**
   * 獅子吼：
   *   武僧閃金光、身體一縮一放（蓄力再吼出來）
   *   三圈震波接連擴散，加上往外噴的速度線和地上揚起的塵土
   *   被震到的人身上爆出金色衝擊
   */
  spawnRoar({ x, y, skill, owner, targets = [] }) {
    const def = SKILLS[skill];
    const fx = theme.monkFx;
    this.playSfx(theme.skillSounds[skill]?.cast);
    this.cameras.main.shake(220, 0.01);
    this.cameras.main.flash(120, 255, 226, 138);
    const reach = def.radius + PLAYER_HALF;

    // 武僧本人：閃金光＋縮放
    const view = this.playerViews.get(owner);
    if (view) {
      view.roarUntil = performance.now() + 180; // updateFlash 會在這段時間染成金色
      this.tweens.add({ targets: view.sprite, scaleX: 1.25, scaleY: 0.85, duration: 70, yoyo: true, ease: "Quad.easeOut" });
    }

    // 震波：一圈一圈往外擴，越後面的越淡
    for (let k = 0; k < fx.roarRings; k++) {
      const ring = { r: PLAYER_HALF };
      const g = this.add.graphics().setDepth(997);
      const strength = 1 - k * 0.25;
      this.tweens.add({
        targets: ring, r: reach * (1 + k * 0.12), duration: fx.roarMs, delay: k * fx.roarRingGapMs, ease: "Cubic.easeOut",
        onUpdate: (tween) => {
          const t = tween.progress;
          g.clear();
          if (k === 0) g.fillStyle(fx.roarColor, 0.2 * (1 - t)).fillCircle(x, y, ring.r);
          g.lineStyle(4 - k, fx.roarColor, strength * (1 - t)).strokeCircle(x, y, ring.r);
          g.lineStyle(1, 0xffffff, 0.8 * strength * (1 - t)).strokeCircle(x, y, ring.r - 3);
        },
        onComplete: () => g.destroy(),
      });
    }

    // 速度線：從身體往外射出的短線
    const lines = this.add.graphics().setDepth(998);
    const burst = { t: 0 };
    const angles = Array.from({ length: fx.roarLines }, (_, k) => (k / fx.roarLines) * Math.PI * 2 + Math.random() * 0.3);
    this.tweens.add({
      targets: burst, t: 1, duration: 260, ease: "Quad.easeOut",
      onUpdate: () => {
        lines.clear().lineStyle(2, 0xffffff, 1 - burst.t);
        for (const a of angles) {
          const r0 = PLAYER_HALF + reach * 0.9 * burst.t;
          const r1 = r0 + 10 * (1 - burst.t) + 4;
          lines.lineBetween(x + Math.cos(a) * r0, y - 4 + Math.sin(a) * r0, x + Math.cos(a) * r1, y - 4 + Math.sin(a) * r1);
        }
      },
      onComplete: () => lines.destroy(),
    });

    // 塵土：地上的小方塊往外滾開
    for (let k = 0; k < fx.roarDust; k++) {
      const a = Math.random() * Math.PI * 2;
      const size = 2 + Math.floor(Math.random() * 3);
      const dust = this.add.rectangle(x, y + PLAYER_HALF, size, size, 0xc9b98a, 0.8).setDepth(SHADOW.depth + 0.3);
      const dist = reach * (0.6 + Math.random() * 0.5);
      this.tweens.add({
        targets: dust, x: x + Math.cos(a) * dist, y: y + PLAYER_HALF + Math.sin(a) * dist * 0.6,
        alpha: 0, duration: 380 + Math.random() * 200, ease: "Quad.easeOut", onComplete: () => dust.destroy(),
      });
    }

    // 被震到的人：金色衝擊
    for (const [tx, ty] of targets) this.spawnImpact({ x: tx, y: ty, skill, hit: true });
  }

  /**
   * 刀光：一道斜斜的白色劈痕（外圈紅色），先快速拉長再淡掉，旁邊噴幾顆火花。
   * 角度每次隨機，連續砍中時看起來像亂刀。
   */
  spawnCut(x, y) {
    const fx = theme.meleeFx;
    const angle = (Math.random() * 0.8 + 0.2) * Math.PI * (Math.random() < 0.5 ? 1 : -1);
    const half = fx.cutLength / 2;
    const dx = Math.cos(angle) * half;
    const dy = Math.sin(angle) * half;
    // 畫在 (0,0) 附近再移到目標身上，縮放時才會以中心為基準
    const g = this.add.graphics({ x, y: y - 6 }).setDepth(1001);
    g.lineStyle(5, fx.cutColor, 0.9).lineBetween(-dx, -dy, dx, dy);
    g.lineStyle(2, 0xffffff, 1).lineBetween(-dx * 0.9, -dy * 0.9, dx * 0.9, dy * 0.9);
    g.setScale(0.3);
    this.tweens.add({ targets: g, scale: 1.1, duration: 60, ease: "Quad.easeOut" });
    this.tweens.add({ targets: g, alpha: 0, delay: 60, duration: fx.cutMs - 60, onComplete: () => g.destroy() });
    // 火花：往刀痕的垂直方向噴
    for (let k = 0; k < 3; k++) {
      const side = k % 2 ? 1 : -1;
      const spread = angle + side * (Math.PI / 2) + (Math.random() - 0.5) * 0.8;
      const spark = this.add.rectangle(x, y - 6, 2, 2, 0xfff4d6).setDepth(1001);
      this.tweens.add({
        targets: spark,
        x: x + Math.cos(spread) * (8 + Math.random() * 8),
        y: y - 6 + Math.sin(spread) * (8 + Math.random() * 8),
        alpha: 0, duration: fx.cutMs, onComplete: () => spark.destroy(),
      });
    }
  }

  /** 揮砍：沿著扇形畫一道刀光，很快淡掉 */
  /**
   * 揮砍：一道新月形的刀光從扇形一邊快速掃到另一邊（外圈紅、中間白），再淡掉。
   * 砍中的人身上各加一道刀光（和旋風斬一樣）。
   */
  spawnSwing({ x, y, dx, dy, skill, hit, targets = [] }) {
    const def = SKILLS[skill];
    const fx = theme.meleeFx;
    const sounds = theme.skillSounds[skill] ?? {};
    this.playSfx(hit ? sounds.hit : sounds.cast);
    const angle = Math.atan2(dy, dx);
    const half = (def.arcDeg / 2) * (Math.PI / 180);
    const reach = def.range + PLAYER_HALF;
    const cy = y - 4;
    const g = this.add.graphics().setDepth(997);
    const sweep = { t: 0 };
    // 掃過的部分：前端最亮最粗，尾巴漸細（分三段疊出新月形）
    const draw = () => {
      g.clear();
      const end = angle - half + 2 * half * sweep.t;
      const start = Math.max(angle - half, end - 2 * half * 0.8);
      g.lineStyle(6, fx.cutColor, 0.5).beginPath().arc(x, cy, reach - 4, start, end).strokePath();
      g.lineStyle(3, fx.slashColor, 0.95).beginPath().arc(x, cy, reach - 4, start + (end - start) * 0.3, end).strokePath();
      g.lineStyle(1, 0xffffff, 1).beginPath().arc(x, cy, reach - 2, start + (end - start) * 0.6, end).strokePath();
    };
    this.tweens.add({
      targets: sweep, t: 1, duration: fx.slashSweepMs, ease: "Quad.easeOut",
      onUpdate: draw,
      onComplete: () => this.tweens.add({ targets: g, alpha: 0, duration: fx.slashMs, onComplete: () => g.destroy() }),
    });
    for (const [tx, ty] of targets) this.spawnCut(tx, ty);
    if (hit) this.cameras.main.shake(60, 0.003);
  }

  /** 盾牌擋下攻擊：盾牌位置冒一圈火花 */
  /**
   * 弧形能量盾：內外兩條弧之間填半透明的藍，外緣一條亮邊，中間幾條肋紋，
   * 一道反光沿著盾面來回掃。flash = 剛擋下攻擊（整面變白）。
   */
  drawShield(g, cx, cy, angle, half, { radius, alpha = 1, flash = false, now = 0 }) {
    const fx = theme.meleeFx;
    const rIn = radius - 3;
    const rOut = radius + 2;
    const steps = 12;
    const arcPts = (r) => Array.from({ length: steps + 1 }, (_, i) => {
      const a = angle - half + (2 * half * i) / steps;
      return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
    });
    const band = [...arcPts(rOut), ...arcPts(rIn).reverse()];
    g.fillStyle(flash ? 0xffffff : fx.guardColor, (flash ? 0.7 : 0.35) * alpha).fillPoints(band, true);
    g.lineStyle(1, fx.guardColor, 0.9 * alpha).strokePoints(arcPts(rIn), false);
    g.lineStyle(2, flash ? 0xffffff : fx.guardEdge, alpha).strokePoints(arcPts(rOut), false);
    // 肋紋：把盾面分成幾塊
    g.lineStyle(1, fx.guardEdge, 0.5 * alpha);
    for (let k = 1; k < 4; k++) {
      const a = angle - half + (2 * half * k) / 4;
      g.lineBetween(cx + Math.cos(a) * rIn, cy + Math.sin(a) * rIn, cx + Math.cos(a) * rOut, cy + Math.sin(a) * rOut);
    }
    // 反光：沿著盾面來回掃
    const s = Math.sin(now / 260) * half * 0.8;
    g.lineStyle(2, 0xffffff, 0.6 * alpha)
      .lineBetween(cx + Math.cos(angle + s) * rIn, cy + Math.sin(angle + s) * rIn, cx + Math.cos(angle + s) * rOut, cy + Math.sin(angle + s) * rOut);
  }

  /** 放下盾牌：盾面往外擴散、變淡消失 */
  spawnShieldDrop(cx, cy, angle, half) {
    if (angle === undefined) return;
    const g = this.add.graphics().setDepth(998);
    const anim = { t: 0 };
    this.tweens.add({
      targets: anim, t: 1, duration: 180,
      onUpdate: () => {
        g.clear();
        this.drawShield(g, cx, cy, angle, half, { radius: PLAYER_HALF + 8 + anim.t * 6, alpha: 1 - anim.t });
      },
      onComplete: () => g.destroy(),
    });
  }

  /** 盾牌擋下攻擊：盾面閃白、往後縮一下，擋點噴出火花，往外震出一道弧形衝擊 */
  spawnBlock({ x, y, dx, dy }) {
    this.playSfx("block");
    this.spawnFloatText(x, y - 24, "格擋", "#bfe9ff", 9);
    const fx = theme.meleeFx;
    const angle = Math.atan2(dy, dx);
    const r = PLAYER_HALF + 8;
    const bx = x + Math.cos(angle) * r;
    const by = y - 4 + Math.sin(angle) * r;
    // 找出是誰的盾（訊息只有位置：取最近的玩家）
    let best = Infinity;
    let view;
    for (const [id, p] of this.room.state.players) {
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < best) { best = d; view = this.playerViews.get(id); }
    }
    if (view) view.blockFlashUntil = performance.now() + 90;
    // 擋點的白光
    const spark = this.add.circle(bx, by, 5, 0xffffff, 1).setDepth(1001).setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({ targets: spark, scale: 0.2, alpha: 0, duration: 160, onComplete: () => spark.destroy() });
    // 往外震出一道弧形衝擊
    const wave = this.add.graphics().setDepth(1001);
    const anim = { t: 0 };
    this.tweens.add({
      targets: anim, t: 1, duration: 220, ease: "Quad.easeOut",
      onUpdate: () => {
        const rr = r + 4 + anim.t * 14;
        wave.clear().lineStyle(2, fx.guardEdge, 1 - anim.t)
          .beginPath().arc(x, y - 4, rr, angle - 0.6, angle + 0.6).strokePath();
      },
      onComplete: () => wave.destroy(),
    });
    // 火花：往盾牌外側噴，帶一點重力
    for (let k = 0; k < fx.blockSparks; k++) {
      const a = angle + (Math.random() - 0.5) * 1.8;
      const d = 10 + Math.random() * 14;
      const dot = this.add.rectangle(bx, by, 2, 2, k % 3 ? 0xffe9a8 : 0xffffff).setDepth(1001);
      this.tweens.add({
        targets: dot, x: bx + Math.cos(a) * d,
        y: { value: by + Math.sin(a) * d + 6, ease: "Quad.easeIn" },
        alpha: 0, duration: 220 + Math.random() * 120, onComplete: () => dot.destroy(),
      });
    }
  }

  /**
   * 火球是等速直線飛行，不用插值緩衝，改用推算：
   * - 每幀照速度往前移動
   * - 收到伺服器的新位置時，用「新位置 + 速度 × 收到後經過的時間」當候選
   * - 候選比較後面（網路晚到的舊資料）→ 不理它，火球不會往回跳
   * - 候選比較前面 → 每幀追上落差的 30%，不會突然往前跳一大段
   * 這樣火球只會晚「網路延遲」那麼多，網路一陣一陣時也接近等速飛行。
   * （用通道實測的資料模擬：往回跳 7 次 → 0 次，最大一步 25px → 11px）
   */
  drawProjectile(view, p, now) {
    if (p.x !== view.sampleX || p.y !== view.sampleY) {
      view.sampleX = p.x;
      view.sampleY = p.y;
      view.sampleAt = now;
    }
    const dt = (now - view.at) / 1000;
    const advanced = { x: view.x + p.vx * dt, y: view.y + p.vy * dt };
    // 候選最多往前推 250ms，網路斷很久時不會一路飛出去
    const sinceSample = Math.min(now - view.sampleAt, 250) / 1000;
    const fromSample = { x: view.sampleX + p.vx * sinceSample, y: view.sampleY + p.vy * sinceSample };

    // 沿著飛行方向比較誰比較前面；照速度推進的那個若超前太多（> 250ms 的距離）就以伺服器為準
    const along = (pt) => pt.x * p.vx + pt.y * p.vy;
    const speedSq = p.vx * p.vx + p.vy * p.vy;
    const lead = along(advanced) - along(fromSample);
    let pos;
    if (lead >= 0 && lead <= speedSq * 0.25) pos = advanced;
    else if (lead < 0) pos = { x: advanced.x + (fromSample.x - advanced.x) * 0.3, y: advanced.y + (fromSample.y - advanced.y) * 0.3 };
    else pos = fromSample;

    view.x = pos.x;
    view.y = pos.y;
    view.at = now;
    view.sprite.setPosition(Math.round(pos.x), Math.round(pos.y)).setDepth(pos.y + 0.1); // 跟角色、柱子一樣依 y 排前後
    view.shadow.setPosition(Math.round(pos.x), Math.round(pos.y + SHADOW.projectile.offsetY));
    if (SKILLS[p.skill]?.poison) this.updatePoisonBall(view, now);
    if (SKILLS[p.skill]?.pierce) this.updateQiBall(view, now);
    if (theme.fireFx.skills.includes(p.skill)) this.updateFireball(view, now);
  }

  /** 火球飛行中：外圍一圈閃爍的火光，後面拖著往上飄的火星 */
  updateFireball(view, now) {
    const fx = theme.fireFx;
    const flicker = 1 + Math.sin(now / 35) * 0.12 + Math.sin(now / 53) * 0.08;
    this.statusFx.fillStyle(fx.embers[1], 0.22).fillCircle(Math.round(view.x), Math.round(view.y), 9 * flicker);
    this.trailEmbers(view, view.x, view.y, now, 1);
  }

  /** 沿路噴火星：每隔 emberEveryMs 在 (x,y) 留下幾顆，往上飄、變暗、淡掉 */
  trailEmbers(view, x, y, now, count) {
    const fx = theme.fireFx;
    if (now < (view.nextEmberAt ?? 0)) return;
    view.nextEmberAt = now + fx.emberEveryMs;
    for (let k = 0; k < count; k++) {
      const ember = this.add.rectangle(x + (Math.random() - 0.5) * 6, y + (Math.random() - 0.5) * 6, 2, 2, fx.embers[0])
        .setDepth(1000).setBlendMode(Phaser.BlendModes.ADD);
      this.tweens.add({
        targets: ember, x: ember.x + (Math.random() - 0.5) * 8, y: ember.y - 6 - Math.random() * 8, alpha: 0,
        duration: 300 + Math.random() * 200, onComplete: () => ember.destroy(),
        onUpdate: (tw) => ember.setFillStyle(tw.progress < 0.4 ? fx.embers[0] : tw.progress < 0.7 ? fx.embers[1] : fx.embers[2]),
      });
    }
  }

  /** 火系的預告圈：圈裡一個慢慢轉的魔法陣（兩個反向旋轉的三角形 + 刻度環），越接近爆炸越亮越快 */
  drawRuneCircle(x, y, radius, t, now) {
    const g = this.blastGraphics;
    const fx = theme.fireFx;
    const spin = (now / 1000) * (1 + 3 * t);
    const r = radius * 0.78;
    g.lineStyle(1, fx.runeColor, 0.35 + 0.5 * t);
    for (const dir of [1, -1]) {
      const pts = [0, 1, 2].map((k) => {
        const a = dir * spin + (k * Math.PI * 2) / 3 - Math.PI / 2;
        return { x: x + Math.cos(a) * r, y: y + Math.sin(a) * r };
      });
      g.strokePoints(pts, true);
    }
    // 刻度環：一圈短線
    const ticks = 12;
    for (let k = 0; k < ticks; k++) {
      const a = -spin * 0.5 + (k * Math.PI * 2) / ticks;
      g.lineBetween(x + Math.cos(a) * (radius - 4), y + Math.sin(a) * (radius - 4), x + Math.cos(a) * (radius - 1), y + Math.sin(a) * (radius - 1));
    }
  }

  /**
   * 火系命中的附加效果（爆炸圖之外）：一圈衝擊波、四散的火星、地上一塊焦痕慢慢淡掉。
   * size：1 = 火球打中，越大越誇張（爆炎、流星依範圍放大）；沒打中只冒一點火星。
   */
  spawnFireExtras(x, y, size, hit) {
    const fx = theme.fireFx;
    if (!hit) {
      this.spawnEmberBurst(x, y, 4, 8);
      return;
    }
    const scorch = this.add.ellipse(x, y + 2, 16 * size, 7 * size, 0x1a0f0a, 0.45).setDepth(SHADOW.depth + 0.25);
    const glow = this.add.ellipse(x, y + 2, 18 * size, 8 * size).setStrokeStyle(1, fx.embers[2], 0.8).setDepth(SHADOW.depth + 0.26);
    this.tweens.add({ targets: scorch, alpha: 0, delay: fx.scorchMs * 0.4, duration: fx.scorchMs * 0.6, onComplete: () => scorch.destroy() });
    this.tweens.add({ targets: glow, alpha: 0, duration: fx.scorchMs * 0.35, onComplete: () => glow.destroy() });
    const ring = this.add.circle(x, y, 6 * size).setStrokeStyle(2, fx.embers[0], 0.9).setDepth(1001);
    this.tweens.add({ targets: ring, scale: 2.2, alpha: 0, duration: 260, ease: "Quad.easeOut", onComplete: () => ring.destroy() });
    this.spawnEmberBurst(x, y, Math.round(8 * Math.sqrt(size)), 14 * size);
  }

  /** 火星往四周噴開，再往下掉一點（有重量感） */
  spawnEmberBurst(x, y, count, spread) {
    const fx = theme.fireFx;
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const d = spread * (0.5 + Math.random() * 0.7);
      const ember = this.add.rectangle(x, y, 2, 2, fx.embers[k % 2]).setDepth(1002).setBlendMode(Phaser.BlendModes.ADD);
      this.tweens.add({
        targets: ember, x: x + Math.cos(a) * d,
        y: { value: y + Math.sin(a) * d * 0.7 + 6, ease: "Quad.easeIn" },
        alpha: 0, duration: 350 + Math.random() * 250, onComplete: () => ember.destroy(),
      });
    }
  }

  /** 氣功波飛行中：外圍一圈會脈動的金色光暈、兩顆繞著轉的氣，後面拖著漸淡的殘影 */
  updateQiBall(view, now) {
    const fx = theme.monkFx;
    const x = Math.round(view.x);
    const y = Math.round(view.y);
    const pulse = 1 + Math.sin(now / 50) * 0.15;
    this.statusFx.fillStyle(fx.qiColor, 0.18).fillCircle(x, y, 11 * pulse);
    this.statusFx.fillStyle(fx.qiColor, 0.3).fillCircle(x, y, 7 * pulse);
    for (let k = 0; k < 2; k++) {
      const a = now / 70 + k * Math.PI;
      this.statusFx.fillStyle(fx.qiCore, 0.9).fillRect(Math.round(x + Math.cos(a) * 9) - 1, Math.round(y + Math.sin(a) * 6) - 1, 2, 2);
    }
    if (now < (view.nextTrailAt ?? 0)) return;
    view.nextTrailAt = now + fx.qiTrail.everyMs;
    const ghost = this.add.image(x, y, view.sprite.texture.key).setRotation(view.sprite.rotation)
      .setDepth(view.sprite.depth - 0.05).setAlpha(0.5).setTint(fx.qiColor).setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({ targets: ghost, alpha: 0, scale: 0.4, duration: fx.qiTrail.fadeMs, onComplete: () => ghost.destroy() });
  }

  /** 氣功波出手：手前一圈金色氣爆，往前噴幾道光 */
  spawnQiLaunch(x, y, angle) {
    const fx = theme.monkFx;
    const ring = this.add.circle(x, y, 4).setStrokeStyle(2, fx.qiColor, 1).setDepth(1001);
    this.tweens.add({ targets: ring, scale: 3.5, alpha: 0, duration: 220, ease: "Quad.easeOut", onComplete: () => ring.destroy() });
    this.spawnQiLines(x, y, angle, 4, 0.5, 14);
  }

  /** 從 (x,y) 沿著 angle（±spread 弧度內）噴出 count 道金色光線 */
  spawnQiLines(x, y, angle, count, spread, length) {
    const fx = theme.monkFx;
    for (let k = 0; k < count; k++) {
      const a = angle + (Math.random() - 0.5) * 2 * spread;
      const len = length * (0.7 + Math.random() * 0.6);
      const line = this.add.rectangle(x, y, len, 2, k % 2 ? fx.qiColor : fx.qiCore)
        .setOrigin(0, 0.5).setRotation(a).setDepth(1001).setBlendMode(Phaser.BlendModes.ADD);
      this.tweens.add({
        targets: line, x: x + Math.cos(a) * len * 1.5, y: y + Math.sin(a) * len * 1.5,
        scaleX: 0.2, alpha: 0, duration: 200 + Math.random() * 100, ease: "Quad.easeOut", onComplete: () => line.destroy(),
      });
    }
  }

  /**
   * 氣功波打中：hit = 貫穿一個人（金色衝擊環 + 沿飛行方向往前噴光線，看得出「打穿了」）；
   * 沒打中（撞牆、飛到底）= 氣散開成一圈光點。
   */
  spawnQiHit(x, y, hit) {
    const fx = theme.monkFx;
    const flash = this.add.circle(x, y, hit ? 10 : 6, fx.qiCore, 0.9).setDepth(1001).setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({ targets: flash, scale: 0.2, alpha: 0, duration: 160, onComplete: () => flash.destroy() });
    const ring = this.add.ellipse(x, y, 8, 7).setStrokeStyle(2, fx.qiColor, 1).setDepth(1001);
    this.tweens.add({ targets: ring, scale: hit ? 4.5 : 3, alpha: 0, duration: 260, ease: "Quad.easeOut", onComplete: () => ring.destroy() });
    if (hit) {
      // 飛行方向：找離打中點最近的氣功波（它還在繼續飛）
      let angle = Math.random() * Math.PI * 2;
      let best = Infinity;
      for (const [id, p] of this.room.state.projectiles) {
        const view = this.projectileViews.get(id);
        if (!view || !SKILLS[p.skill]?.pierce) continue;
        const d = (view.x - x) ** 2 + (view.y - y) ** 2;
        if (d < best) { best = d; angle = Math.atan2(p.vy, p.vx); }
      }
      this.spawnQiLines(x, y, angle, fx.qiPierceLines, 0.35, 18);
      this.cameras.main.shake(70, 0.003);
    } else {
      this.spawnQiLines(x, y, 0, 6, Math.PI, 8); // 往四面八方散開
    }
  }

  /** 毒液彈飛行中：一團會晃動的毒液，沿路滴下毒液（落到地上濺開） */
  updatePoisonBall(view, now) {
    const wobble = Math.sin(now / 40);
    view.sprite.setScale(1 + wobble * 0.12, 1 - wobble * 0.12);
    if (now < (view.nextDripAt ?? 0)) return;
    view.nextDripAt = now + theme.witchFx.dripEveryMs;
    const fx = theme.witchFx;
    const groundY = view.y + SHADOW.projectile.offsetY;
    const drop = this.add.rectangle(Math.round(view.x), Math.round(view.y + 3), 2, 2, fx.swampColor).setDepth(view.y);
    this.tweens.add({
      targets: drop, y: groundY, duration: 180, ease: "Quad.easeIn",
      onComplete: () => {
        drop.destroy();
        // 落地：一個小小的毒液點慢慢淡掉
        const spot = this.add.ellipse(Math.round(view.x), Math.round(groundY), 4, 2, fx.swampDark, 0.7).setDepth(SHADOW.depth + 0.3);
        this.tweens.add({ targets: spot, alpha: 0, duration: 400, onComplete: () => spot.destroy() });
      },
    });
  }

  /** 播音效；靜音中或檔案沒載入成功就略過 */
  playSfx(key, volume = 1) {
    if (this.registry.get("muted")) return;
    if (key && this.cache.audio.exists(key)) this.sound.play(key, { volume });
  }

  /** 每個角色外觀一組走路動畫（key 跟圖片同名） */
  /** 每個角色的走路動畫：側面、正面、背面（有圖才建立） */
  createWalkAnimations() {
    for (let skin = 0; theme.assets[playerTextureKey(skin)]; skin++) {
      for (const key of [walkTextureKey(skin), facingTextureKey(skin, "front"), facingTextureKey(skin, "back")]) {
        if (!this.textures.exists(key) || this.anims.exists(key)) continue;
        this.anims.create({ key, frames: this.anims.generateFrameNumbers(key), frameRate: theme.walkFrameRate, repeat: -1 });
      }
    }
  }


  /** 看畫面上的位置有沒有在動，決定播走路動畫還是顯示站立圖 */
  /** 依面向和有沒有在走，切換側面 / 正面 / 背面的走路動畫或站立圖 */
  updateWalk(view, player, x, y, now, faceX, faceY) {
    const moved = Math.hypot(x - view.lastX, y - view.lastY) > 0.05;
    view.lastX = x;
    view.lastY = y;
    if (moved && player.alive) view.walkUntil = now + WALK_HOLD_MS;
    const walking = now < view.walkUntil;

    let dir = facingOf(faceX, faceY);
    // 沒有正面 / 背面圖的角色，上下走也用側面
    if (dir !== "side" && !this.textures.exists(facingTextureKey(player.skin, dir))) dir = "side";
    view.sprite.setFlipX(dir === "side" && faceX < 0);

    // 方向或走 / 停改變時才換圖，避免每幀重設
    const pose = `${dir}:${walking}`;
    if (pose === view.pose) return;
    view.pose = pose;

    const animKey = dir === "side" ? walkTextureKey(player.skin) : facingTextureKey(player.skin, dir);
    if (walking && this.anims.exists(animKey)) {
      view.sprite.play(animKey);
    } else {
      view.sprite.stop();
      if (dir === "side") view.sprite.setTexture(playerTextureKey(player.skin));
      else view.sprite.setTexture(animKey, IDLE_FRAME);
    }
  }


  /** 血條畫在頭頂上方 */
  /** 頭上的血條；energyRatio 有值時（自己）在下面多畫一條藍色能量條 */
  drawHpBar(x, headY, ratio, energyRatio = null) {
    const w = 20;
    const left = Math.round(x - w / 2);
    const top = headY - 2;
    const h = energyRatio === null ? 4 : 6;
    this.bars.fillStyle(0x000000, 0.6).fillRect(left - 1, top - 1, w + 2, h);
    this.bars.fillStyle(ratio > 0.5 ? 0x5fd17a : ratio > 0.25 ? 0xffd23f : 0xff5c5c);
    this.bars.fillRect(left, top, Math.ceil(w * ratio), 2);
    if (energyRatio !== null) {
      this.bars.fillStyle(0x4fc3f7).fillRect(left, top + 3, Math.ceil(w * energyRatio), 1);
    }
  }
}

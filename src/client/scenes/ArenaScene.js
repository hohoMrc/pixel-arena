import * as Phaser from "phaser";
import { Callbacks } from "@colyseus/sdk";
import { ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF, PLAYER_MAX_HP, SKILLS, DASH_INDEX, TICK_RATE, INPUT_SCALE, ENERGY, PILLAR } from "../../shared/constants.js";
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

  /** @param {{ room, predict, netInput, controls, solid }} data 由 main.js 傳入（solid：每根柱子還在不在，和預測移動共用） */
  init(data) {
    Object.assign(this, data);
    this.playerViews = new Map();     // sessionId → { sprite, label, lastX, lastY, walkUntil, lastHp, flashUntil, jitterUntil }
    this.projectileViews = new Map(); // projectileId → { sprite, shadow, x, y, at, sampleX, sampleY, sampleAt }
    this.blastViews = new Map();      // blastId → { fireball, shadow, startAt, fuseMs }
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
      const fireball = this.add.image(b.x, b.y - BLAST_FX.dropHeight, skill.texture)
        .setRotation(Math.PI / 2).setDepth(1002); // 圖片朝右，轉成朝下
      const shadow = this.add.image(b.x, b.y, "shadow-projectile").setDepth(SHADOW.depth).setAlpha(0);
      const fuseTicks = b.fuse || skill.fuseTicks;
      this.blastViews.set(id, { fireball, shadow, startAt: now, fuseMs: (fuseTicks / TICK_RATE) * 1000 });
    });
    callbacks.onRemove("blasts", (_b, id) => {
      const view = this.blastViews.get(id);
      view?.fireball.destroy();
      view?.shadow.destroy();
      this.blastViews.delete(id);
    });

    this.room.onMessage("impact", (impact) => this.spawnImpact(impact));
    this.room.onMessage("swing", (swing) => this.spawnSwing(swing));
    this.room.onMessage("block", (block) => this.spawnBlock(block));
    this.roundOverlay = new RoundOverlay(document.getElementById("overlay"), this.room, (key) => this.playSfx(key));
  }

  update() {
    const now = performance.now();

    // predict.tick 回傳這一幀該跑幾個固定 tick，每個 tick 送一次輸入
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
      if (player.hp < view.lastHp) this.onHit(view, isSelf, player.hp === 0, now);
      if (player.alive && !view.lastAlive && isSelf) this.playSfx("respawn");
      view.lastHp = player.hp;
      view.lastAlive = player.alive;

      const feetY = Math.round(y + PLAYER_HALF);
      const headY = feetY - view.sprite.height;
      const jitter = now < view.jitterUntil ? Math.round((Math.random() * 2 - 1) * HIT_FEEDBACK.jitterPx) : 0;
      view.sprite.setPosition(Math.round(x) + jitter, feetY);
      // 面向：自己讀預測值（轉身不用等伺服器），其他人讀伺服器狀態
      const faceX = isSelf ? this.predict.value(player, "faceX") : player.faceX;
      const faceY = isSelf ? this.predict.value(player, "faceY") : player.faceY;
      view.sprite.setDepth(feetY); // 依腳底位置排前後：越下面的越前面（和柱子同一個基準）
      view.sprite.setAlpha(player.alive ? 1 : 0.25);
      this.updateWalk(view, player, x, y, now, faceX, faceY);
      this.updateFlash(view, now);
      this.updateDash(view, player, isSelf, now);
      this.updateMelee(view, player, x, y, isSelf, now);
      view.label.setPosition(Math.round(x), headY - 4).setDepth(feetY + 0.5);
      view.shadow.setPosition(Math.round(x), feetY).setAlpha(player.alive ? SHADOW.player.alpha : SHADOW.player.alpha * 0.4);

      if (player.alive) this.drawHpBar(x, headY, player.hp / PLAYER_MAX_HP, isSelf ? player.energy / ENERGY.max : null);
    }

    for (const [id, p] of this.room.state.projectiles) {
      const view = this.projectileViews.get(id);
      if (view) this.drawProjectile(view, p, now);
    }
    this.drawBlasts(now);

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
      const t = Math.min(1, (now - view.startAt) / view.fuseMs);
      this.blastGraphics.lineStyle(1, BLAST_FX.color, BLAST_FX.ringAlpha).strokeCircle(b.x, b.y, radius);
      this.blastGraphics.fillStyle(BLAST_FX.color, BLAST_FX.fillAlpha).fillCircle(b.x, b.y, radius * t);
      // 加速落下（t²），越接近爆炸掉越快
      view.fireball.setPosition(Math.round(b.x), Math.round(b.y - BLAST_FX.dropHeight * (1 - t * t)));
      view.shadow.setAlpha(SHADOW.projectile.alpha * 1.5 * t).setScale(0.6 + t);
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
    if (skill.type === "whirl") {
      this.aimGuide.lineStyle(1, color, AIM_GUIDE.alpha).strokeCircle(x, y, skill.radius + PLAYER_HALF);
      this.aimGuide.fillStyle(color, 0.12).fillCircle(x, y, skill.radius + PLAYER_HALF);
      return;
    }

    if (skill.type === "blast" || skill.type === "meteor") {
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

  updateFlash(view, now) {
    const flashing = now < view.flashUntil;
    if (flashing && view.sprite.tintMode !== Phaser.TintModes.FILL) {
      view.sprite.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
    } else if (!flashing && view.sprite.tintMode === Phaser.TintModes.FILL) {
      view.sprite.clearTint();
    }
  }

  /** 命中爆炸（完整 5 格）和沒打中的冒煙（最後 2 格） */
  createImpactAnimations() {
    if (!this.textures.exists("explosion")) return;
    const frameRate = theme.impactFrameRate;
    this.anims.create({ key: "impact-hit", frames: this.anims.generateFrameNumbers("explosion"), frameRate });
    this.anims.create({ key: "impact-miss", frames: this.anims.generateFrameNumbers("explosion", { start: 3, end: 4 }), frameRate });
  }

  /** area = 指定地點爆炸：不管有沒有打到人都是完整的大爆炸 */
  spawnImpact({ x, y, skill, hit, area }) {
    const big = hit || area;
    this.playSfx(big ? theme.skillSounds[skill]?.hit : "fizzle", big ? 1 : 0.5);
    if (area) this.cameras.main.shake(100, 0.004);
    const key = big ? "impact-hit" : "impact-miss";
    if (!this.anims.exists(key)) return;
    const scale = big ? (SKILLS[skill]?.impactScale ?? 1) : 1;
    const fx = this.add.sprite(x, y, "explosion").setScale(scale).setDepth(1001);
    fx.play(key);
    fx.once("animationcomplete", () => fx.destroy());
  }

  /**
   * 衝刺：開始時播音效，衝刺中留下殘影。
   * 自己讀預測值（按下就立刻有反應），其他人讀伺服器狀態。
   */
  updateDash(view, player, isSelf, now) {
    const dashTicks = isSelf ? this.predict.value(player, "dashTicks") : player.dashTicks;
    const dashing = dashTicks > 0 && player.alive;

    if (dashing && !view.wasDashing) {
      this.playSfx(theme.skillSounds[DASH_INDEX]?.cast, isSelf ? 1 : theme.othersVolume);
    }
    view.wasDashing = dashing;

    if (dashing && now >= view.nextTrailAt) {
      const { everyMs, fadeMs, alpha } = theme.dashTrail;
      view.nextTrailAt = now + everyMs;
      const s = view.sprite;
      const ghost = this.add.image(s.x, s.y, s.texture.key, s.frame.name)
        .setOrigin(0.5, 1).setFlipX(s.flipX).setDepth(s.depth - 0.1).setAlpha(alpha)
        .setTint(0x9fdcff).setTintMode(Phaser.TintModes.FILL);
      this.tweens.add({ targets: ghost, alpha: 0, duration: fadeMs, onComplete: () => ghost.destroy() });
    }
  }

  /**
   * 紅劍士的持續型技能（伺服器狀態，所有人都看得到）：
   *   舉盾 → 身體前方一道藍色弧線
   *   旋風斬 → 地上一圈旋轉的刀光，角色快速左右翻面
   */
  updateMelee(view, player, x, y, isSelf, now) {
    const fx = theme.meleeFx;
    const volume = isSelf ? 1 : theme.othersVolume;
    const cx = Math.round(x);
    const cy = Math.round(y) - 4; // 身體中間（碰撞圓心在腳底上方一點）

    const guarding = player.guardTicks > 0 && player.alive;
    if (guarding && !view.wasGuarding) this.playSfx("guard", volume);
    view.wasGuarding = guarding;
    if (guarding) {
      const angle = Math.atan2(player.guardY, player.guardX);
      const guard = SKILLS.find((s) => s.type === "guard");
      const half = (guard.arcDeg / 2) * (Math.PI / 180);
      // 快結束時閃爍，提醒盾牌要放下了
      const fading = player.guardTicks < 8 && Math.floor(now / 60) % 2 === 0;
      this.statusFx.lineStyle(3, fx.guardColor, fading ? 0.35 : 0.9);
      this.statusFx.beginPath().arc(cx, cy, PLAYER_HALF + 8, angle - half, angle + half).strokePath();
    }

    const whirling = player.whirlTicks > 0 && player.alive;
    if (whirling && !view.wasWhirling) this.playSfx("whirl", volume);
    view.wasWhirling = whirling;
    if (whirling) {
      const whirl = SKILLS.find((s) => s.type === "whirl");
      const r = whirl.radius + PLAYER_HALF;
      const spin = (now / 90) % (Math.PI * 2);
      this.floorFx.fillStyle(fx.whirlColor, 0.12).fillCircle(cx, Math.round(y), r);
      this.floorFx.lineStyle(2, fx.whirlColor, 0.85);
      // 三道刀光繞著轉
      for (let k = 0; k < 3; k++) {
        const a = spin + (k * Math.PI * 2) / 3;
        this.floorFx.beginPath().arc(cx, Math.round(y), r, a, a + 0.9).strokePath();
      }
      view.sprite.setFlipX(Math.floor(now / fx.whirlSpinMs) % 2 === 0);
    }
  }

  /** 揮砍：沿著扇形畫一道刀光，很快淡掉 */
  spawnSwing({ x, y, dx, dy, skill, hit }) {
    const def = SKILLS[skill];
    const sounds = theme.skillSounds[skill] ?? {};
    this.playSfx(hit ? sounds.hit : sounds.cast);
    const angle = Math.atan2(dy, dx);
    const half = (def.arcDeg / 2) * (Math.PI / 180);
    const reach = def.range + PLAYER_HALF;
    const g = this.add.graphics().setDepth(997);
    const color = theme.meleeFx.slashColor;
    g.fillStyle(color, 0.25).slice(x, y - 4, reach, angle - half, angle + half).fillPath();
    g.lineStyle(3, color, 0.95).beginPath().arc(x, y - 4, reach - 3, angle - half, angle + half).strokePath();
    this.tweens.add({ targets: g, alpha: 0, duration: theme.meleeFx.slashMs, onComplete: () => g.destroy() });
    if (hit) this.cameras.main.shake(60, 0.003);
  }

  /** 盾牌擋下攻擊：盾牌位置冒一圈火花 */
  spawnBlock({ x, y, dx, dy }) {
    this.playSfx("block");
    const len = Math.hypot(dx, dy) || 1;
    const bx = x + (dx / len) * (PLAYER_HALF + 8);
    const by = y - 4 + (dy / len) * (PLAYER_HALF + 8);
    const g = this.add.graphics().setDepth(1001);
    g.fillStyle(0xffffff, 1).fillCircle(bx, by, 4);
    g.lineStyle(2, theme.meleeFx.guardColor, 1).strokeCircle(bx, by, 7);
    this.tweens.add({ targets: g, alpha: 0, duration: 200, onComplete: () => g.destroy() });
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

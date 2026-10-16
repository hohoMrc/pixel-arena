import * as Phaser from "phaser";
import { Callbacks } from "@colyseus/sdk";
import { ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF, PLAYER_MAX_HP, SKILLS, DASH_INDEX } from "../../shared/constants.js";
import { theme, playerTextureKey, walkTextureKey } from "../theme.js";
import { createMissingTextures } from "../placeholders.js";
import { OBSTACLE_RECTS } from "../../shared/obstacles.js";
import { RoundOverlay } from "../roundOverlay.js";

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

/**
 * 對戰場景：只負責「畫出伺服器狀態」和「送出輸入」。
 * 遊戲規則都在 server/rooms/ArenaRoom.js。
 */
export class ArenaScene extends Phaser.Scene {
  constructor() {
    super("arena");
  }

  /** @param {{ room, predict, netInput, controls }} data 由 main.js 傳入 */
  init(data) {
    Object.assign(this, data);
    this.playerViews = new Map();     // sessionId → { sprite, label, lastX, lastY, walkUntil, lastHp, flashUntil, jitterUntil }
    this.projectileViews = new Map(); // projectileId → sprite
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
    this.deadText = this.add.text(ARENA_WIDTH / 2, ARENA_HEIGHT / 2, "復活中…", {
      fontFamily: "monospace", fontSize: "12px", color: "#ffffff", resolution: 4,
    }).setOrigin(0.5).setDepth(1001).setVisible(false);

    const callbacks = Callbacks.get(this.room);

    callbacks.onAdd("players", (player, id) => {
      // 原點設在腳底，畫的時候對齊碰撞圓底部
      const sprite = this.add.sprite(player.x, player.y, playerTextureKey(player.skin)).setOrigin(0.5, 1);
      const label = this.add.text(0, 0, player.name, {
        fontFamily: "monospace", fontSize: "8px", color: id === this.room.sessionId ? "#ffe066" : "#ffffff",
        resolution: 4,
      }).setOrigin(0.5, 1);
      this.playerViews.set(id, {
        sprite, label, lastX: player.x, lastY: player.y, walkUntil: 0,
        lastHp: player.hp, lastAlive: player.alive, flashUntil: 0, jitterUntil: 0,
        wasDashing: false, nextTrailAt: 0,
      });
    });
    callbacks.onRemove("players", (_player, id) => {
      const view = this.playerViews.get(id);
      view?.sprite.destroy();
      view?.label.destroy();
      this.playerViews.delete(id);
    });

    callbacks.onAdd("projectiles", (p, id) => {
      const sprite = this.add.image(p.x, p.y, SKILLS[p.skill]?.texture ?? "fireball");
      sprite.setDepth(p.y + 0.1);
      sprite.setRotation(Math.atan2(p.vy, p.vx));
      this.projectileViews.set(id, sprite);
      this.playSfx(theme.skillSounds[p.skill]?.cast, p.owner === this.room.sessionId ? 1 : theme.othersVolume);
    });
    callbacks.onRemove("projectiles", (_p, id) => {
      this.projectileViews.get(id)?.destroy();
      this.projectileViews.delete(id);
    });

    this.room.onMessage("impact", (impact) => this.spawnImpact(impact));
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
      const cmd = this.controls.read();
      this.netInput.data.moveX = canAct ? cmd.moveX : 0;
      this.netInput.data.moveY = canAct ? cmd.moveY : 0;
      this.netInput.data.skill = canAct ? cmd.skill : 0;
      this.netInput.send();
    }
    this.roundOverlay.update();
    this.controls.updateCooldowns(now);

    this.bars.clear();
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
      view.sprite.setFlipX(player.faceX < 0);
      view.sprite.setDepth(feetY); // 依腳底位置排前後：越下面的越前面（和柱子同一個基準）
      view.sprite.setAlpha(player.alive ? 1 : 0.25);
      this.updateWalk(view, player, x, y, now);
      this.updateFlash(view, now);
      this.updateDash(view, player, isSelf, now);
      view.label.setPosition(Math.round(x), headY - 4).setDepth(feetY + 0.5);

      if (player.alive) this.drawHpBar(x, headY, player.hp / PLAYER_MAX_HP);
    }

    for (const [id, p] of this.room.state.projectiles) {
      this.projectileViews.get(id)?.setPosition(
        Math.round(this.predict.value(p, "x")),
        Math.round(this.predict.value(p, "y")),
      ).setDepth(this.predict.value(p, "y") + 0.1); // 跟角色、柱子一樣依 y 排前後
    }

    // 結算、倒數時由中間的提示說明狀態，不顯示「復活中」
    this.deadText.setVisible(!!self && !self.alive && (phase === "playing" || phase === "waiting"));
  }

  /**
   * 場地外框。遊戲座標不變（場地仍是 0~ARENA），外框畫在負座標，
   * 再把鏡頭往左上捲，讓外框出現在畫面裡。
   */
  createBorder() {
    const { top, side, bottom } = theme.border;
    const fullH = top + ARENA_HEIGHT + bottom;
    this.cameras.main.setScroll(-side, -top);

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
  createObstacles() {
    for (const r of OBSTACLE_RECTS) {
      this.add.image((r.left + r.right) / 2, r.bottom, "pillar").setOrigin(0.5, 1).setDepth(r.bottom);
    }
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

  spawnImpact({ x, y, skill, hit }) {
    this.playSfx(hit ? theme.skillSounds[skill]?.hit : "fizzle", hit ? 1 : 0.5);
    const key = hit ? "impact-hit" : "impact-miss";
    if (!this.anims.exists(key)) return;
    const scale = hit ? (SKILLS[skill]?.impactScale ?? 1) : 1;
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

  /** 播音效；靜音中或檔案沒載入成功就略過 */
  playSfx(key, volume = 1) {
    if (this.registry.get("muted")) return;
    if (key && this.cache.audio.exists(key)) this.sound.play(key, { volume });
  }

  /** 每個角色外觀一組走路動畫（key 跟圖片同名） */
  createWalkAnimations() {
    for (let skin = 0; ; skin++) {
      const key = walkTextureKey(skin);
      if (!theme.assets[key]) break;
      if (!this.textures.exists(key) || this.anims.exists(key)) continue;
      this.anims.create({
        key,
        frames: this.anims.generateFrameNumbers(key),
        frameRate: theme.walkFrameRate,
        repeat: -1,
      });
    }
  }

  /** 看畫面上的位置有沒有在動，決定播走路動畫還是顯示站立圖 */
  updateWalk(view, player, x, y, now) {
    const moved = Math.hypot(x - view.lastX, y - view.lastY) > 0.05;
    view.lastX = x;
    view.lastY = y;
    if (moved && player.alive) view.walkUntil = now + WALK_HOLD_MS;

    const walkKey = walkTextureKey(player.skin);
    if (now < view.walkUntil && this.anims.exists(walkKey)) {
      view.sprite.play(walkKey, true); // true = 已經在播就不重來
    } else if (view.sprite.anims.isPlaying) {
      view.sprite.stop();
      view.sprite.setTexture(playerTextureKey(player.skin));
    }
  }

  /** 血條畫在頭頂上方 */
  drawHpBar(x, headY, ratio) {
    const w = 20;
    const left = Math.round(x - w / 2);
    const top = headY - 2;
    this.bars.fillStyle(0x000000, 0.6).fillRect(left - 1, top - 1, w + 2, 4);
    this.bars.fillStyle(ratio > 0.5 ? 0x5fd17a : ratio > 0.25 ? 0xffd23f : 0xff5c5c);
    this.bars.fillRect(left, top, Math.ceil(w * ratio), 2);
  }
}

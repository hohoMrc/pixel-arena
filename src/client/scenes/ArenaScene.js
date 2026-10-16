import * as Phaser from "phaser";
import { Callbacks } from "@colyseus/sdk";
import { ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF, PLAYER_MAX_HP, SKILLS } from "../../shared/constants.js";
import { theme, playerTextureKey, walkTextureKey } from "../theme.js";
import { createMissingTextures } from "../placeholders.js";

/** 停下來多久後才切回站立圖（ms），避免插值的小停頓讓動畫一直閃 */
const WALK_HOLD_MS = 120;

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
    this.playerViews = new Map();     // sessionId → { sprite, label, lastX, lastY, walkUntil }
    this.projectileViews = new Map(); // projectileId → sprite
  }

  preload() {
    // 找不到的圖片忽略，之後由 placeholder 補上
    this.load.on("loaderror", (file) => console.info(`[theme] 沒有 ${file.src}，使用 placeholder`));
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

    this.add.tileSprite(0, 0, ARENA_WIDTH, ARENA_HEIGHT, "floor").setOrigin(0);
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
      this.playerViews.set(id, { sprite, label, lastX: player.x, lastY: player.y, walkUntil: 0 });
    });
    callbacks.onRemove("players", (_player, id) => {
      const view = this.playerViews.get(id);
      view?.sprite.destroy();
      view?.label.destroy();
      this.playerViews.delete(id);
    });

    callbacks.onAdd("projectiles", (p, id) => {
      const sprite = this.add.image(p.x, p.y, SKILLS[p.skill]?.texture ?? "fireball");
      sprite.setRotation(Math.atan2(p.vy, p.vx));
      this.projectileViews.set(id, sprite);
    });
    callbacks.onRemove("projectiles", (_p, id) => {
      this.projectileViews.get(id)?.destroy();
      this.projectileViews.delete(id);
    });
  }

  update() {
    const now = performance.now();

    // predict.tick 回傳這一幀該跑幾個固定 tick，每個 tick 送一次輸入
    const steps = this.predict.tick(now);
    const self = this.room.state.players.get(this.room.sessionId);
    for (let i = 0; i < steps; i++) {
      const cmd = this.controls.read();
      const alive = self?.alive ?? false;
      this.netInput.data.moveX = alive ? cmd.moveX : 0;
      this.netInput.data.moveY = alive ? cmd.moveY : 0;
      this.netInput.data.skill = alive ? cmd.skill : 0;
      this.netInput.send();
    }
    this.controls.updateCooldowns(now);

    this.bars.clear();
    for (const [id, player] of this.room.state.players) {
      const view = this.playerViews.get(id);
      if (!view) continue;

      // 自己是「預測位置」，其他人是「插值位置」，讀法都一樣
      const x = this.predict.value(player, "x");
      const y = this.predict.value(player, "y");

      const feetY = Math.round(y + PLAYER_HALF);
      const headY = feetY - view.sprite.height;
      view.sprite.setPosition(Math.round(x), feetY);
      view.sprite.setFlipX(player.faceX < 0);
      view.sprite.setDepth(y); // 越下面的越前面
      view.sprite.setAlpha(player.alive ? 1 : 0.25);
      this.updateWalk(view, player, x, y, now);
      view.label.setPosition(Math.round(x), headY - 4).setDepth(y + 0.5);

      if (player.alive) this.drawHpBar(x, headY, player.hp / PLAYER_MAX_HP);
    }

    for (const [id, p] of this.room.state.projectiles) {
      this.projectileViews.get(id)?.setPosition(
        Math.round(this.predict.value(p, "x")),
        Math.round(this.predict.value(p, "y")),
      ).setDepth(999);
    }

    this.deadText.setVisible(self ? !self.alive : false);
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

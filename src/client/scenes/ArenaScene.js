import * as Phaser from "phaser";
import { Callbacks } from "@colyseus/sdk";
import { ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF, PLAYER_MAX_HP, SKILLS, DASH_INDEX, TICK_RATE, INPUT_SCALE, ENERGY } from "../../shared/constants.js";
import { theme, playerTextureKey, walkTextureKey } from "../theme.js";
import { createMissingTextures } from "../placeholders.js";
import { OBSTACLE_RECTS, circleHitsObstacle } from "../../shared/obstacles.js";
import { RoundOverlay } from "../roundOverlay.js";
import { blastTarget, meteorTargets } from "../../shared/blast.js";

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

  /** @param {{ room, predict, netInput, controls }} data 由 main.js 傳入 */
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
    this.createShadowTexture("shadow-player", SHADOW.player);
    this.createShadowTexture("shadow-projectile", SHADOW.projectile);
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
    const skill = SKILLS[aim.skill];
    const x = this.predict.value(self, "x");
    const y = this.predict.value(self, "y");
    const color = theme.aimGuideColors?.[aim.skill] ?? 0xffffff;

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
      if (px < 0 || py < 0 || px > ARENA_WIDTH || py > ARENA_HEIGHT || circleHitsObstacle(px, py, skill.radius)) break;
      this.aimGuide.fillCircle(Math.round(px), Math.round(py), AIM_GUIDE.dotRadius);
    }
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

import { TICK_RATE, DASH_SLOT, SLOT_COUNT, INPUT_SCALE, RAGE, kitOf } from "../shared/constants.js";
import { theme } from "./theme.js";

/** 搖桿推超過半徑的這個比例才算有方向 */
const DEAD_ZONE = 0.3;
/** 技能鍵拖超過這個距離（px）才算手動瞄準，沒超過放開 = 自動瞄準 */
const AIM_DEAD_ZONE_PX = 16;
/** 指定地點技能：拖這麼遠（px）= 丟到最遠，拖越短丟越近 */
const AIM_MAX_DRAG_PX = 70;
/** 冷卻總長至少這麼久（ms）才在按鈕上顯示秒數；火球這種很短的冷卻只顯示轉圈，免得數字一直閃 */
const SHOW_SECONDS_MIN_MS = 1000;
/** 放開技能時還在冷卻，最多等這麼久（ms）冷卻好了再自動放出去，免得按太快被吃掉 */
const CAST_BUFFER_MS = 200;

/** 角度轉成輸入用的整數方向向量；power（0~1）是向量長度，指定地點技能用來表示距離 */
const toInputDir = (dx, dy, power = 1) => {
  const len = Math.hypot(dx, dy) || 1;
  return { x: Math.round((dx / len) * power * INPUT_SCALE), y: Math.round((dy / len) * power * INPUT_SCALE) };
};

/** 鍵盤對應（桌機測試用） */
const KEYS = {
  up: ["w", "arrowup"], down: ["s", "arrowdown"],
  left: ["a", "arrowleft"], right: ["d", "arrowright"],
  skills: [["j", " "], ["k"], ["l", "shift"], ["u", "i"]],
};

/**
 * 下方操作區：左邊虛擬搖桿、右邊技能按鈕，桌機同時支援鍵盤。
 * 遊戲迴圈每個 tick 呼叫 read() 取得 { moveX, moveY, skill, aimX, aimY }。
 *
 * 攻擊技能（火球等）：
 *   輕點 → 放開時發射，自動瞄準最近的敵人（aim = 0，由伺服器找目標）
 *   按住拖曳 → 往拖的方向瞄準（畫面會顯示瞄準線），放開才發射
 *   指定地點技能（爆炎）：拖越遠丟越遠，畫面顯示落點圈
 * 衝刺：按下立刻衝，方向 = 移動方向。
 *
 * 按鈕和技能組（KITS）一樣是 4 格，「第幾格」以下都叫 slot；
 * 每個角色同一格的技能不同，進房間後由 setKit(skin) 換成自己的技能組。
 */
export class Controls {
  stick = { x: 0, y: 0 };      // 搖桿方向（-INPUT_SCALE ~ INPUT_SCALE）
  heldSkills = new Set();      // 正在按住的技能格（衝刺、鍵盤）
  heldKeys = new Set();
  /** 正在拖曳瞄準：{ slot, skill, x, y, power }（skill 是技能資料，x/y 是單位向量，power 0~1 是拖多遠），沒有則為 null。ArenaScene 用來畫瞄準線 */
  aiming = null;
  /** 放開後等著送出的技能：{ slot, aimX, aimY, at } */
  pendingCast = null;
  lastCastAt = Array(SLOT_COUNT).fill(-Infinity); // 本地估算的冷卻起點（ms）
  /** 目前的技能組（4 個技能資料） */
  kit = kitOf(0);
  /** 自己目前的能量、怒氣（ArenaScene 每幀從伺服器狀態更新），用來判斷技能能不能放 */
  energy = 0;
  rage = 0;

  constructor({ joystick, knob, skillsEl }) {
    this.setupJoystick(joystick, knob);
    this.skillsEl = skillsEl;
    this.skillButtons = this.setupSkills();
    this.setupKeyboard();
  }

  /** 換成某個角色的技能組（重建按鈕） */
  setKit(skin) {
    this.kit = kitOf(skin);
    this.skillsEl.replaceChildren();
    this.heldSkills.clear();
    this.aiming = null;
    this.resetCooldowns();
    this.skillButtons = this.setupSkills();
  }

  /** @param {boolean} canAct 死亡、倒數、結算時為 false：不放技能，也不開始本地冷卻計時 */
  read(canAct = true) {
    if (!canAct) {
      this.pendingCast = null;
      return { moveX: 0, moveY: 0, skill: 0, aimX: 0, aimY: 0 };
    }
    const key = (names) => names.some((k) => this.heldKeys.has(k));
    const kx = (key(KEYS.right) ? 1 : 0) - (key(KEYS.left) ? 1 : 0);
    const ky = (key(KEYS.down) ? 1 : 0) - (key(KEYS.up) ? 1 : 0);

    const move = kx || ky
      ? { moveX: kx * INPUT_SCALE, moveY: ky * INPUT_SCALE }
      : { moveX: this.stick.x, moveY: this.stick.y };

    // 一次只能送一個技能；衝刺是閃避用的，同時按住時以衝刺優先（放開的技能留到下個 tick）
    const held = (i) => this.heldSkills.has(i) || key(KEYS.skills[i] ?? []);
    if (held(DASH_SLOT)) {
      this.markCast(DASH_SLOT);
      return { ...move, skill: DASH_SLOT + 1, aimX: 0, aimY: 0 };
    }

    // 觸控：放開的技能。冷卻還沒好就再等一下，超過緩衝時間才放棄
    const now = performance.now();
    const pending = this.pendingCast;
    if (pending && this.ready(pending.slot, now)) {
      this.pendingCast = null;
      this.markCast(pending.slot);
      return { ...move, skill: pending.slot + 1, aimX: pending.aimX, aimY: pending.aimY };
    }
    if (pending && now - pending.at > CAST_BUFFER_MS) this.pendingCast = null;

    // 鍵盤：按住連發，自動瞄準
    for (let i = 0; i < this.kit.length; i++) {
      if (held(i)) { this.markCast(i); return { ...move, skill: i + 1, aimX: 0, aimY: 0 }; }
    }
    return { ...move, skill: 0, aimX: 0, aimY: 0 };
  }

  cooldownReady(i, now) {
    return now - this.lastCastAt[i] >= (this.kit[i].cooldownTicks / TICK_RATE) * 1000;
  }

  /** 能量（大招看怒氣）夠不夠 */
  hasResource(i) {
    const skill = this.kit[i];
    return skill.ultimate ? this.rage >= RAGE.max : this.energy >= (skill.energyCost ?? 0);
  }

  ready(i, now) {
    return this.cooldownReady(i, now) && this.hasResource(i);
  }

  /**
   * 技能鍵狀態：冷卻（轉圈遮罩 + 剩餘秒數）、能量不夠（變暗）、大招（怒氣累積進度）。
   * 攻擊技能的冷卻用本地估算（按下的時間）；衝刺用預測狀態裡的 dashCd，是精確值。
   * @param {number} now performance.now()
   * @param {{ dashCd: number, energy: number, rage: number }} stats 自己的狀態
   */
  updateCooldowns(now, { dashCd = 0, energy = 0, rage = 0 } = {}) {
    this.energy = energy;
    this.rage = rage;
    this.kit.forEach((s, i) => {
      const btn = this.skillButtons[i];

      // 大招：遮罩蓋住「還沒集滿」的部分，集滿時發光
      if (s.ultimate) {
        btn.style.setProperty("--cd", 1 - Math.min(1, rage / RAGE.max));
        btn.classList.toggle("ready", rage >= RAGE.max);
        return;
      }

      const totalMs = (s.cooldownTicks / TICK_RATE) * 1000;
      const leftMs = i === DASH_SLOT
        ? (dashCd / TICK_RATE) * 1000
        : Math.max(0, totalMs - (now - this.lastCastAt[i]));
      btn.style.setProperty("--cd", leftMs / totalMs);
      btn.classList.toggle("no-energy", energy < (s.energyCost ?? 0));

      // 秒數：1 秒以上顯示整數（無條件進位），最後 1 秒顯示一位小數
      const text = leftMs <= 0 || totalMs < SHOW_SECONDS_MIN_MS ? ""
        : leftMs >= 1000 ? String(Math.ceil(leftMs / 1000))
        : (leftMs / 1000).toFixed(1);
      // 只在數字變了才改 DOM，每幀都改會浪費效能
      if (btn.cdText.textContent !== text) {
        btn.cdText.textContent = text;
        btn.classList.toggle("cooling", text !== "");
      }
    });
  }

  /** 新的一局開始，伺服器會重置冷卻，這裡跟著重置 */
  resetCooldowns() {
    this.lastCastAt = Array(SLOT_COUNT).fill(-Infinity);
    this.pendingCast = null;
  }

  /** 本地開始冷卻計時（能量不夠時伺服器不會放，這裡也不計時） */
  markCast(i) {
    const now = performance.now();
    if (this.ready(i, now)) this.lastCastAt[i] = now;
  }

  setupJoystick(base, knob) {
    let pointerId = null;

    const move = (e) => {
      const rect = base.getBoundingClientRect();
      const radius = rect.width / 2;
      let dx = e.clientX - (rect.left + radius);
      let dy = e.clientY - (rect.top + radius);
      const dist = Math.hypot(dx, dy);

      // 把搖桿頭限制在底座範圍內
      if (dist > radius) { dx *= radius / dist; dy *= radius / dist; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;

      // 推超過死區就照推的角度走（任意方向，速度固定）
      this.stick = dist < radius * DEAD_ZONE ? { x: 0, y: 0 } : toInputDir(dx, dy);
    };

    const release = (e) => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      this.stick = { x: 0, y: 0 };
      knob.style.transform = "";
      base.classList.remove("active");
    };

    base.addEventListener("pointerdown", (e) => {
      pointerId = e.pointerId;
      base.setPointerCapture(pointerId);
      base.classList.add("active");
      move(e);
    });
    base.addEventListener("pointermove", (e) => { if (e.pointerId === pointerId) move(e); });
    base.addEventListener("pointerup", release);
    base.addEventListener("pointercancel", release);
  }

  setupSkills() {
    return this.kit.map((skill, i) => {
      const btn = document.createElement("button");
      btn.className = `skill skill-${i}`; // 按鈕位置看格子編號（style.css）
      // 右上角的能量消耗標籤（沒有消耗的技能不顯示）
      const cost = skill.energyCost ? `<span class="cost">⚡${skill.energyCost}</span>` : "";
      // 下方的按鍵提示（只有電腦版顯示，見 style.css 的 .keycap）：顯示這格的第一個按鍵
      const keyName = KEYS.skills[i]?.[0];
      const keycap = keyName ? `<span class="keycap">${keyName.toUpperCase()}</span>` : "";
      btn.innerHTML = `<span class="icon">${theme.skillIcons[skill.id] ?? "★"}</span><span class="label">${skill.name}</span>${cost}${keycap}<span class="cd-text"></span>`;
      btn.cdText = btn.querySelector(".cd-text");

      btn.addEventListener("contextmenu", (e) => e.preventDefault()); // 長按不跳選單
      this.skillsEl.appendChild(btn);
      if (skill.type === "dash") this.setupHoldButton(btn, i);
      else this.setupAimButton(btn, i);
      return btn;
    });
  }

  /** 衝刺：按下就觸發 */
  setupHoldButton(btn, i) {
    const release = () => { this.heldSkills.delete(i); btn.classList.remove("pressed"); };
    btn.addEventListener("pointerdown", (e) => {
      btn.setPointerCapture(e.pointerId);
      this.heldSkills.add(i);
      btn.classList.add("pressed");
    });
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
  }

  /** 攻擊技能：拖曳瞄準、放開發射（輕點 = 自動瞄準） */
  setupAimButton(btn, i) {
    let drag = null; // { pointerId, startX, startY }

    btn.addEventListener("pointerdown", (e) => {
      btn.setPointerCapture(e.pointerId);
      drag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
      btn.classList.add("pressed");
    });
    btn.addEventListener("pointermove", (e) => {
      if (e.pointerId !== drag?.pointerId) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      const dist = Math.hypot(dx, dy);
      this.aiming = dist < AIM_DEAD_ZONE_PX
        ? null
        : { slot: i, skill: this.kit[i], x: dx / dist, y: dy / dist, power: Math.min(1, dist / AIM_MAX_DRAG_PX) };
      btn.classList.toggle("aiming", !!this.aiming);
    });
    const finish = (e, cast) => {
      if (e.pointerId !== drag?.pointerId) return;
      if (cast) {
        // 子彈只看方向（伺服器會正規化），指定地點技能用長度決定距離
        const aim = this.aiming ? toInputDir(this.aiming.x, this.aiming.y, this.aiming.power) : { x: 0, y: 0 };
        this.pendingCast = { slot: i, aimX: aim.x, aimY: aim.y, at: performance.now() };
      }
      drag = null;
      this.aiming = null;
      btn.classList.remove("pressed", "aiming");
    };
    btn.addEventListener("pointerup", (e) => finish(e, true));
    btn.addEventListener("pointercancel", (e) => finish(e, false));
  }

  setupKeyboard() {
    addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement) return; // 在輸入框打字不算操作
      this.heldKeys.add(e.key.toLowerCase());
    });
    addEventListener("keyup", (e) => this.heldKeys.delete(e.key.toLowerCase()));
    addEventListener("blur", () => this.heldKeys.clear());
  }
}

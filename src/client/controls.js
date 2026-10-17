import { SKILLS, TICK_RATE, DASH_INDEX, INPUT_SCALE } from "../shared/constants.js";
import { theme } from "./theme.js";

/** 搖桿推超過半徑的這個比例才算有方向 */
const DEAD_ZONE = 0.3;
/** 技能鍵拖超過這個距離（px）才算手動瞄準，沒超過放開 = 自動瞄準 */
const AIM_DEAD_ZONE_PX = 16;
/** 指定地點技能：拖這麼遠（px）= 丟到最遠，拖越短丟越近 */
const AIM_MAX_DRAG_PX = 70;
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
  skills: [["j", " "], ["k"], ["l", "shift"]],
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
 */
export class Controls {
  stick = { x: 0, y: 0 };      // 搖桿方向（-INPUT_SCALE ~ INPUT_SCALE）
  heldSkills = new Set();      // 正在按住的技能索引（衝刺、鍵盤）
  heldKeys = new Set();
  /** 正在拖曳瞄準：{ skill, x, y, power }（x/y 是單位向量，power 0~1 是拖多遠），沒有則為 null。ArenaScene 用來畫瞄準線 */
  aiming = null;
  /** 放開後等著送出的技能：{ skill, aimX, aimY, at } */
  pendingCast = null;
  lastCastAt = SKILLS.map(() => -Infinity); // 本地估算的冷卻起點（ms）

  constructor({ joystick, knob, skillsEl }) {
    this.setupJoystick(joystick, knob);
    this.skillButtons = this.setupSkills(skillsEl);
    this.setupKeyboard();
  }

  read() {
    const key = (names) => names.some((k) => this.heldKeys.has(k));
    const kx = (key(KEYS.right) ? 1 : 0) - (key(KEYS.left) ? 1 : 0);
    const ky = (key(KEYS.down) ? 1 : 0) - (key(KEYS.up) ? 1 : 0);

    const move = kx || ky
      ? { moveX: kx * INPUT_SCALE, moveY: ky * INPUT_SCALE }
      : { moveX: this.stick.x, moveY: this.stick.y };

    // 一次只能送一個技能；衝刺是閃避用的，同時按住時以衝刺優先（放開的技能留到下個 tick）
    const held = (i) => this.heldSkills.has(i) || key(KEYS.skills[i] ?? []);
    if (DASH_INDEX >= 0 && held(DASH_INDEX)) {
      this.markCast(DASH_INDEX);
      return { ...move, skill: DASH_INDEX + 1, aimX: 0, aimY: 0 };
    }

    // 觸控：放開的技能。冷卻還沒好就再等一下，超過緩衝時間才放棄
    const now = performance.now();
    const pending = this.pendingCast;
    if (pending && this.cooldownReady(pending.skill, now)) {
      this.pendingCast = null;
      this.markCast(pending.skill);
      return { ...move, skill: pending.skill + 1, aimX: pending.aimX, aimY: pending.aimY };
    }
    if (pending && now - pending.at > CAST_BUFFER_MS) this.pendingCast = null;

    // 鍵盤：按住連發，自動瞄準
    for (let i = 0; i < SKILLS.length; i++) {
      if (held(i)) { this.markCast(i); return { ...move, skill: i + 1, aimX: 0, aimY: 0 }; }
    }
    return { ...move, skill: 0, aimX: 0, aimY: 0 };
  }

  cooldownReady(i, now) {
    return now - this.lastCastAt[i] >= (SKILLS[i].cooldownTicks / TICK_RATE) * 1000;
  }

  /** 冷卻轉圈顯示（只是本地估算，實際冷卻以伺服器為準） */
  updateCooldowns(now) {
    SKILLS.forEach((s, i) => {
      const total = (s.cooldownTicks / TICK_RATE) * 1000;
      const left = Math.max(0, 1 - (now - this.lastCastAt[i]) / total);
      this.skillButtons[i].style.setProperty("--cd", left);
    });
  }

  markCast(i) {
    const now = performance.now();
    if (this.cooldownReady(i, now)) this.lastCastAt[i] = now;
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

  setupSkills(container) {
    return SKILLS.map((skill, i) => {
      const btn = document.createElement("button");
      btn.className = `skill skill-${i}`;
      btn.innerHTML = `<span class="icon">${theme.skillIcons[i] ?? "★"}</span><span class="label">${skill.name}</span>`;

      btn.addEventListener("contextmenu", (e) => e.preventDefault()); // 長按不跳選單
      container.appendChild(btn);
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
        : { skill: i, x: dx / dist, y: dy / dist, power: Math.min(1, dist / AIM_MAX_DRAG_PX) };
      btn.classList.toggle("aiming", !!this.aiming);
    });
    const finish = (e, cast) => {
      if (e.pointerId !== drag?.pointerId) return;
      if (cast) {
        // 子彈只看方向（伺服器會正規化），指定地點技能用長度決定距離
        const aim = this.aiming ? toInputDir(this.aiming.x, this.aiming.y, this.aiming.power) : { x: 0, y: 0 };
        this.pendingCast = { skill: i, aimX: aim.x, aimY: aim.y, at: performance.now() };
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

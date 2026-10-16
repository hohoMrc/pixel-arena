import { SKILLS, TICK_RATE } from "../shared/constants.js";
import { theme } from "./theme.js";

/** 搖桿推超過半徑的這個比例才算有方向 */
const DEAD_ZONE = 0.3;
/** 8 方向，從右邊開始順時針 */
const DIRECTIONS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** 鍵盤對應（桌機測試用） */
const KEYS = {
  up: ["w", "arrowup"], down: ["s", "arrowdown"],
  left: ["a", "arrowleft"], right: ["d", "arrowright"],
  skills: [["j", " "], ["k"]],
};

/**
 * 下方操作區：左邊虛擬搖桿、右邊技能按鈕，桌機同時支援鍵盤。
 * 遊戲迴圈每個 tick 呼叫 read() 取得 { moveX, moveY, skill }。
 */
export class Controls {
  stick = { x: 0, y: 0 };      // 搖桿方向（-1 / 0 / 1）
  heldSkills = new Set();      // 正在按住的技能索引
  heldKeys = new Set();
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

    let skill = 0;
    for (let i = 0; i < SKILLS.length; i++) {
      if (this.heldSkills.has(i) || key(KEYS.skills[i] ?? [])) { skill = i + 1; break; }
    }
    if (skill) this.markCast(skill - 1);

    return { moveX: kx || this.stick.x, moveY: ky || this.stick.y, skill };
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
    const cooldownMs = (SKILLS[i].cooldownTicks / TICK_RATE) * 1000;
    if (now - this.lastCastAt[i] >= cooldownMs) this.lastCastAt[i] = now;
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

      if (dist < radius * DEAD_ZONE) { this.stick = { x: 0, y: 0 }; return; }
      // 角度切成 8 等分，對應到 8 個方向
      const sector = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
      const [x, y] = DIRECTIONS[(sector + 8) % 8];
      this.stick = { x, y };
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

      const release = () => { this.heldSkills.delete(i); btn.classList.remove("pressed"); };
      btn.addEventListener("pointerdown", (e) => {
        btn.setPointerCapture(e.pointerId);
        this.heldSkills.add(i);
        btn.classList.add("pressed");
      });
      btn.addEventListener("pointerup", release);
      btn.addEventListener("pointercancel", release);
      btn.addEventListener("contextmenu", (e) => e.preventDefault()); // 長按不跳選單

      container.appendChild(btn);
      return btn;
    });
  }

  setupKeyboard() {
    addEventListener("keydown", (e) => this.heldKeys.add(e.key.toLowerCase()));
    addEventListener("keyup", (e) => this.heldKeys.delete(e.key.toLowerCase()));
    addEventListener("blur", () => this.heldKeys.clear());
  }
}

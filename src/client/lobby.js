import { NAME_MAX_LENGTH, SKIN_COUNT, ROOM_CODE_LENGTH, TICK_RATE, PLAYER_SPEED, SKIN_STATS, kitOf, maxHpOf } from "../shared/constants.js";
import { theme, playerTextureKey } from "./theme.js";

/** 上次的名稱和角色存在這台裝置，下次打開自動帶入 */
const STORAGE_KEY = "pixel-arena:profile";
/** 目前這次 showLobby 的選角色函式（角色卡片只綁一次 click，透過它找到這次的狀態） */
let selectSkin = () => {};

/** 技能格的名稱（順序同 KITS 的 4 格） */
const SLOT_NAMES = ["普攻", "技能", "衝刺", "大招"];

/** tick 數換成「x 秒」 */
const sec = (ticks) => `${+(ticks / TICK_RATE).toFixed(1)} 秒`;

/**
 * 技能的數值標籤（直接從 SKILLS 的設定算，改數值時說明會自動跟著變）
 * @returns {string[]}
 */
function skillStats(s) {
  const out = [];
  if (s.damage) {
    if (s.type === "meteor") out.push(`每顆傷害 ${s.damage}`);
    else if (s.type === "whirl" || s.type === "zone") out.push(`每 ${sec(s.hitEveryTicks)}傷害 ${s.damage}`);
    else out.push(`傷害 ${s.damage}`);
  }
  if (s.poison) out.push(`中毒共 ${(s.poison.ticks / s.poison.everyTicks) * s.poison.damage}`);
  if (s.amount) out.push(`吸收 ${s.amount}`);
  if (s.rootTicks) out.push(`定身 ${sec(s.rootTicks)}`);
  if (s.slowFactor) out.push(`減速 ${Math.round((1 - s.slowFactor) * 100)}%`);
  if (s.durationTicks) out.push(`持續 ${sec(s.durationTicks)}`);
  out.push(s.ultimate ? "集滿怒氣施放" : `冷卻 ${sec(s.cooldownTicks)}`);
  if (s.energyCost) out.push(`⚡${s.energyCost}`);
  return out;
}

/** 選角畫面下方：角色基本數值 + 4 個技能的說明 */
function kitHtml(skin) {
  const speed = SKIN_STATS[skin]?.speed ?? PLAYER_SPEED;
  const speedText = speed > PLAYER_SPEED ? "快" : speed < PLAYER_SPEED ? "慢" : "普通";
  const rows = kitOf(skin).map((s, slot) => `
    <li>
      <div class="kit-head"><span class="kit-icon">${theme.skillIcons[s.id] ?? "★"}</span><b>${s.name}</b><span class="kit-slot">${SLOT_NAMES[slot]}</span></div>
      <div class="kit-desc">${s.desc ?? ""}</div>
      <div class="kit-stats">${skillStats(s).map((t) => `<span>${t}</span>`).join("")}</div>
    </li>`).join("");
  return `<div class="kit-base">❤️ 血量 ${maxHpOf(skin)}　👟 移動速度 ${speedText}</div><ul>${rows}</ul>`;
}

/**
 * 角色卡片的呼吸動畫（像素遊戲常見的待機動作）。
 * 用原圖做出兩格橫排圖：第 1 格是原圖，第 2 格是上半身往下沉 1 像素、腳不動，
 * 再用 CSS 每半拍切換一格。圖片載入失敗時就顯示靜態圖。
 * @param {HTMLElement} el 顯示角色的元素（用 background-image）
 * @param {string} path 角色圖路徑
 * @param {number} i 第幾個角色，用來錯開節奏，四個角色才不會一起動
 */
function setupBreathing(el, path, i) {
  if (!path) return;
  el.style.backgroundImage = `url("${path}")`;
  const img = new Image();
  img.onload = () => {
    const { naturalWidth: w, naturalHeight: h } = img;
    const canvas = document.createElement("canvas");
    canvas.width = w * 2;
    canvas.height = h;
    const g = canvas.getContext("2d");
    g.drawImage(img, 0, 0);
    // 第 2 格：先畫不動的腳，再把上半身整塊往下 1 像素疊上去
    const legRows = theme.breath.legRows;
    const split = h - legRows;
    g.drawImage(img, 0, split, w, legRows, w, split, w, legRows);
    g.drawImage(img, 0, 0, w, split, w, 1, w, split);
    el.style.backgroundImage = `url("${canvas.toDataURL()}")`;
    el.style.animationDelay = `${-i * 0.37}s`;
    el.classList.add("breathing");
  };
  img.src = path;
}

/**
 * 進場畫面：輸入名稱、選角色，再選怎麼進場：
 *   quick  快速配對（有空位的公開房間就加入，沒有就開新的）
 *   create 建立私人房間（只能用房號加入）
 *   join   輸入房號加入（網址有 ?room= 時會自動帶入）
 * 伺服器會再檢查一次（名稱長度、角色編號），這裡只是讓輸入方便。
 *
 * 加入失敗（房號不存在、房間已滿）時，main.js 會帶著錯誤訊息再呼叫一次，
 * 所以角色卡片只建立一次，之後只更新選取狀態。
 *
 * @param {HTMLFormElement} form index.html 裡的 #lobby
 * @param {string} [error] 上次加入失敗的原因
 * @returns {Promise<{ name: string, skin: number, mode: "quick"|"create"|"join", code?: string }>}
 */
export function showLobby(form, error = "") {
  const saved = loadProfile();
  const nameInput = form.querySelector("#lobby-name");
  const skinsEl = form.querySelector("#lobby-skins");
  const joinBtn = form.querySelector("#lobby-join");
  const codeInput = form.querySelector("#lobby-code");
  const errorEl = form.querySelector("#lobby-error");
  const params = new URLSearchParams(location.search);

  errorEl.textContent = error;
  nameInput.maxLength = NAME_MAX_LENGTH;
  codeInput.maxLength = ROOM_CODE_LENGTH;
  if (!form.dataset.ready) {
    // 網址有 ?name=xxx 時優先使用（方便測試）
    nameInput.value = params.get("name") ?? saved.name ?? "";
    // 有房號 = 朋友傳來的邀請連結：主按鈕改成直接加入那間
    const invited = params.get("room");
    if (invited) {
      codeInput.value = invited;
      joinBtn.value = "join";
      joinBtn.textContent = "加入朋友的房間";
    }
    // 房號只留數字
    codeInput.addEventListener("input", () => (codeInput.value = codeInput.value.replace(/\D/g, "")));
  }

  let skin = saved.skin ?? Math.floor(Math.random() * SKIN_COUNT);
  if (!form.dataset.ready) {
    for (let i = 0; i < SKIN_COUNT; i++) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "skin-card";
      card.innerHTML = `<i class="skin-sprite"></i><span>${theme.skins?.[i] ?? `角色 ${i + 1}`}</span>`;
      setupBreathing(card.querySelector(".skin-sprite"), theme.assets[playerTextureKey(i)]?.path, i);
      card.addEventListener("click", () => selectSkin(i));
      skinsEl.appendChild(card);
    }
    form.dataset.ready = "1";
  }
  const cards = [...skinsEl.children];
  const kitEl = form.querySelector("#lobby-kit");
  const select = (i) => {
    skin = i;
    cards.forEach((c, j) => c.classList.toggle("selected", i === j));
    // 選中角色的血量、速度和技能說明
    kitEl.innerHTML = kitHtml(i);
  };
  selectSkin = select;
  select(skin);

  form.hidden = false;
  return new Promise((resolve) => {
    const onSubmit = (e) => {
      e.preventDefault();
      // 在房號欄按 Enter 時 submitter 會是第一個按鈕，當成「加入」
      let mode = e.submitter?.value || "quick";
      if (document.activeElement === codeInput) mode = "join";
      const code = codeInput.value.trim();
      if (mode === "join" && code.length !== ROOM_CODE_LENGTH) {
        errorEl.textContent = `請輸入 ${ROOM_CODE_LENGTH} 位數房號`;
        codeInput.focus();
        return;
      }
      form.removeEventListener("submit", onSubmit);
      nameInput.blur(); // 收起手機鍵盤
      codeInput.blur();
      const profile = { name: nameInput.value.trim(), skin };
      saveProfile(profile);
      form.hidden = true;
      resolve({ ...profile, mode, code });
    };
    form.addEventListener("submit", onSubmit);
  });
}

function loadProfile() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function saveProfile(profile) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(profile)); } catch {}
}

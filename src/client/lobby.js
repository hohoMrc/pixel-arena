import { NAME_MAX_LENGTH, SKIN_COUNT, ROOM_CODE_LENGTH, DASH_SLOT, kitOf } from "../shared/constants.js";
import { theme, playerTextureKey } from "./theme.js";

/** 上次的名稱和角色存在這台裝置，下次打開自動帶入 */
const STORAGE_KEY = "pixel-arena:profile";
/** 目前這次 showLobby 的選角色函式（角色卡片只綁一次 click，透過它找到這次的狀態） */
let selectSkin = () => {};

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
      card.innerHTML = `<img alt="" src="${theme.assets[playerTextureKey(i)]?.path ?? ""}"><span>${theme.skins?.[i] ?? `角色 ${i + 1}`}</span>`;
      // 呼吸動畫錯開時間，四個角色才不會一起動
      card.querySelector("img").style.animationDelay = `${-i * 0.37}s`;
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
    // 選中的角色有哪些技能（衝刺大家都有，不列）
    kitEl.textContent = kitOf(i)
      .filter((_, slot) => slot !== DASH_SLOT)
      .map((s) => `${theme.skillIcons[s.id] ?? ""}${s.name}`)
      .join("　");
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

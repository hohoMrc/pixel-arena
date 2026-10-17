import { NAME_MAX_LENGTH, SKIN_COUNT } from "../shared/constants.js";
import { theme, playerTextureKey } from "./theme.js";

/** 上次的名稱和角色存在這台裝置，下次打開自動帶入 */
const STORAGE_KEY = "pixel-arena:profile";

/**
 * 進場畫面：輸入名稱、選角色，按「進入對戰」後回傳 { name, skin }。
 * 伺服器會再檢查一次（名稱長度、角色編號），這裡只是讓輸入方便。
 *
 * @param {HTMLFormElement} form index.html 裡的 #lobby
 * @returns {Promise<{ name: string, skin: number }>}
 */
export function showLobby(form) {
  const saved = loadProfile();
  const nameInput = form.querySelector("#lobby-name");
  const skinsEl = form.querySelector("#lobby-skins");
  const joinBtn = form.querySelector("#lobby-join");

  nameInput.maxLength = NAME_MAX_LENGTH;
  // 網址有 ?name=xxx 時優先使用（方便測試）
  nameInput.value = new URLSearchParams(location.search).get("name") ?? saved.name ?? "";
  // 有房號 = 朋友傳來的邀請連結
  if (new URLSearchParams(location.search).has("room")) joinBtn.textContent = "加入朋友的房間";

  let skin = saved.skin ?? Math.floor(Math.random() * SKIN_COUNT);
  const cards = Array.from({ length: SKIN_COUNT }, (_, i) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "skin-card";
    card.innerHTML = `<img alt="" src="${theme.assets[playerTextureKey(i)]?.path ?? ""}"><span>${theme.skins?.[i] ?? `角色 ${i + 1}`}</span>`;
    card.addEventListener("click", () => select(i));
    skinsEl.appendChild(card);
    return card;
  });
  const select = (i) => {
    skin = i;
    cards.forEach((c, j) => c.classList.toggle("selected", i === j));
  };
  select(skin);

  form.hidden = false;
  return new Promise((resolve) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      nameInput.blur(); // 收起手機鍵盤
      const profile = { name: nameInput.value.trim(), skin };
      saveProfile(profile);
      form.hidden = true;
      resolve(profile);
    }, { once: true });
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

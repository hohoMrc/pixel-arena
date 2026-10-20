import { escapeHtml } from "./escapeHtml.js";
import { MAPS } from "../shared/constants.js";

/**
 * 遊戲畫面中間的提示：等待玩家、開局倒數、勝負結果。
 * 每幀由 ArenaScene 呼叫 update()，只在階段或秒數變了才更新畫面和播音效。
 */
export class RoundOverlay {
  last = { phase: "", countdown: -1 };

  /**
   * @param {HTMLElement} el 疊在遊戲畫面上的元素
   * @param {import("@colyseus/sdk").Room} room
   * @param {(key: string) => void} playSfx
   */
  constructor(el, room, playSfx) {
    this.el = el;
    this.room = room;
    this.playSfx = playSfx;
    // 等待畫面的「跟電腦對戰」按鈕（innerHTML 會重畫，所以用事件委派）
    el.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action=add-bot]");
      if (!btn) return;
      btn.disabled = true;
      this.room.send("addBot");
    });
  }

  update() {
    const { phase, countdown } = this.room.state;
    if (phase === this.last.phase && countdown === this.last.countdown) return;
    const prevPhase = this.last.phase;
    const phaseChanged = phase !== prevPhase;
    this.last = { phase, countdown };

    if (phase === "waiting") this.showWaiting();
    else if (phase === "countdown") this.showCountdown(countdown);
    // 只有從倒數進入對戰才顯示「開始！」；中途加入正在對戰的房間就直接隱藏
    else if (phase === "playing") prevPhase === "countdown" ? this.showStart() : this.render("", "");
    else if (phase === "ended") this.showResult(countdown, phaseChanged);
  }

  showWaiting() {
    this.render("waiting", `
      <div class="title">等待對手加入…</div>
      <div class="sub">房號 <b class="room-code">${this.room.roomId}</b><br>按右上角「邀請」把網址傳給朋友<br>等待時可以自由練習</div>
      <button class="overlay-btn" data-action="add-bot">🤖 跟電腦對戰</button>
      <div class="sub small">朋友加入時，電腦會自動讓位</div>`);
  }

  showCountdown(n) {
    if (n <= 0) return;
    this.render("countdown", `
      <div class="sub">地圖：${MAPS[this.room.state.map]?.name ?? ""}</div>
      <div class="big">${n}</div>
      <div class="sub">先拿到 ${this.room.state.killsToWin} 殺的獲勝</div>`);
    this.playSfx("beep");
  }

  showStart() {
    this.render("go", `<div class="big">開始！</div>`);
    this.playSfx("go");
    // 「開始！」顯示一下就消失
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.room.state.phase === "playing") this.render("", "");
    }, 800);
  }

  showResult(secondsLeft, phaseChanged) {
    const { winner, players } = this.room.state;
    const isMe = winner === this.room.sessionId;
    const winnerName = escapeHtml(players.get(winner)?.name ?? "對手");

    const rows = [...players.entries()]
      .sort(([, a], [, b]) => b.kills - a.kills || a.deaths - b.deaths)
      .map(([id, p]) => `
        <tr class="${id === this.room.sessionId ? "me" : ""}">
          <td>${id === winner ? "🏆" : ""}</td><td>${escapeHtml(p.name)}</td><td>${p.kills} 殺</td><td>${p.deaths} 死</td>
        </tr>`)
      .join("");

    this.render(isMe ? "result win" : "result lose", `
      <div class="title">${isMe ? "你贏了！" : `${winnerName} 獲勝`}</div>
      <table>${rows}</table>
      <div class="sub">${secondsLeft} 秒後開始下一局</div>`);
    if (phaseChanged) this.playSfx(isMe ? "win" : "lose");
  }

  render(className, html) {
    this.el.className = className;
    this.el.innerHTML = html;
    this.el.hidden = !html;
  }
}

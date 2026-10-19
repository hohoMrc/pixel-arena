# Pixel Arena

手機直立的像素風即時對戰遊戲。上方是遊戲畫面，下方是操作區（左邊搖桿、右邊技能）。

- 前端：Phaser 4
- 多人連線：Colyseus 0.18（由伺服器判定一切，自己的角色有客戶端預測）
- 開發：Vite，前後端同一個指令、同一個埠號

## 啟動

```bash
npm install
npm run dev
```

- 電腦：打開 `http://localhost:5173`，再開一個分頁貼上同一個網址（含 `?room=房號`）就能對戰
- 手機（同一個 Wi-Fi）：打開終端機顯示的 `Network: http://192.168.x.x:5173`
- 沒有朋友在線上時，等待畫面按「🤖 跟電腦對戰」；朋友加入時電腦會自動讓位（難度在 `src/server/bot.js` 的 `BOT_CONFIG`）
- 打開網頁先輸入名稱、選角色（會記在這台裝置，下次自動帶入）
- 進場方式：「快速配對」自動找有空位的公開房間；「建立私人房間」開一間只能用房號加入的房間；或輸入 4 位數房號加入朋友的房間（點朋友的邀請連結會自動帶入房號）
- 觸控：搖桿可以往任意角度移動；技能鍵輕點會自動瞄準最近的敵人，按住拖曳可以手動瞄準（顯示瞄準線），放開才發射
- 爆炎是指定地點爆炸：拖越遠丟越遠，地上會先出現紅圈預告 0.7 秒才爆炸，看到紅圈要快跑
- 場地比畫面大，鏡頭跟著自己走；右上角小地圖顯示所有人和柱子的位置
- 柱子可以打壞（100 血），打壞後人和技能都能穿過，20 秒後長回來（有人站在原地會等他離開）
- 能量：火球、爆炎要花能量（按鈕上的 ⚡ 數字），會自動回復；頭上血條下面的藍線是自己的能量
- 怒氣：打人、被打都會累積，集滿後大招鍵發光，可以放大招
- 每個角色有自己的技能組（`src/shared/constants.js` 的 `KITS`）和基本數值（`SKIN_STATS`）：
  - 藍法師：火球、爆炎（指定地點）、大招流星雨（在落點附近依序落下 7 顆隕石）
  - 紅劍士（近戰坦克：血量 150、跑得比較快、衝刺冷卻 1.2 秒）：揮砍（前方扇形近戰）、舉盾（2 秒內擋下盾牌那一側來的攻擊，背後不擋）、大招旋風斬（2 秒內持續砍周圍的人，可以邊轉邊走）
  - 綠巫師、金武僧：還在設計，暫時用法師的技能
- 鍵盤：WASD／方向鍵移動，J 或空白鍵＝普攻，K＝技能，R＝大招（都會自動瞄準），L 或 Shift 衝刺

## 對戰規則

- 2 人以上開始倒數 3 秒，先拿到 5 殺的獲勝，結算 5 秒後自動開下一局
- 只有 1 人時是練習模式，可以自由走動、放技能，不計分
- 規則數值在 `src/shared/constants.js` 的 `ROUND`；能量、怒氣在 `ENERGY`、`RAGE`

## 專案結構

```
src/
  shared/              前後端共用
    constants.js       遊戲數值、技能清單 SKILLS（加技能改這裡）
    movement.js        移動邏輯（伺服器和客戶端預測跑同一支）
    blast.js           指定地點爆炸的落點計算（伺服器和瞄準指示共用）
  server/
    app.config.js      伺服器設定
    rooms/ArenaRoom.js 對戰規則：移動、技能、命中、復活、一局的流程
    rooms/schema.js    同步給客戶端的資料結構
    bot.js             電腦對手的 AI（產生和真人一樣的輸入）
  client/
    theme.js           ★ 主題：素材路徑、顏色、技能圖示（換風格改這裡）
    placeholders.js    沒有圖片時自動產生的色塊
    controls.js        下方操作區（搖桿、技能按鈕、鍵盤）
    network.js         連線與房間
    scenes/ArenaScene.js 畫面
    style.css          版面
public/assets/         圖片放這裡
```

## 換美術風格

把圖片放進 `public/assets/`，檔名對應 `src/client/theme.js`。沒有的圖片會自動用色塊代替
（瀏覽器 console 會出現 `Failed to process file`，這是正常的，放入圖片就會消失）。

| 檔名 | 尺寸 | 用途 |
|---|---|---|
| `floor.png` | 64×64 | 地板（會重複鋪滿，需可無縫拼接） |
| `wall_face.png` | 64×64 | 上方外框：牆的正面，需左右無縫拼接（換成河流、樹叢也可以） |
| `wall_top.png` | 64×64 | 左右下外框：牆頂，需無縫拼接 |
| `pillar.png` | 25×61 | 障礙物（石柱），底部對齊地面。位置和佔地大小在 `src/shared/constants.js` 的 `OBSTACLES`（只寫左上四分之一，自動鏡射成對稱配置） |
| `rubble.png`（選用） | 30×14 | 柱子被打壞後的碎石。沒有這張圖時用程式畫的 placeholder |
| `player0.png` ~ `player3.png` | 32×40 | 角色站立圖，面朝右，腳貼齊底部，透明背景 |
| `player0_walk.png` ~ `player3_walk.png` | 128×40 | 走路動畫，橫排 4 格（每格 32×40）。沒有這張就不播動畫 |
| `fireball.png` | 17×11 | 技能 1，朝右，透明背景 |
| `bigfireball.png` | 39×23 | 技能 2，朝右，透明背景 |
| `explosion.png` | 200×40 | 命中特效，橫排 5 格（每格 40×40）：閃光 → 火球 → 爆炸 → 碎煙 → 淡出 |

音效放在 `public/assets/sfx/`（施放、爆炸、冒煙、被打中、死亡、復活），是用 `node tools/make_sfx.mjs`
合成的 8-bit 音效。要換成其他音效，放入同名的 `.wav`，或修改 `theme.js` 的 `sounds` 路徑。

目前的圖是用 Codex 產生的（AI 畫的「大尺寸像素風」再還原成真正的小像素圖），流程和提示詞見 [tools/README.md](tools/README.md)。

## 部署

線上網址：**https://arena.holin.cc/**（EC2 東京，Caddy 提供 HTTPS）

```bash
deploy/deploy.sh   # 打包前端、上傳、重啟遊戲伺服器
```

- 網頁檔案放在 EC2 的 `/var/www/pixel-arena`，由 Caddy 直接提供
- 遊戲伺服器：`~/pixel-arena`，systemd 服務 `pixel-arena`（`deploy/pixel-arena.service`），只監聽 `127.0.0.1:8003`
- Caddy 設定見 `deploy/Caddyfile.snippet`；舊網址 `hoho-game.duckdns.org/arena/` 會轉到新網址
- 正式環境的伺服器啟動檔是 `src/server/main.js`（`npm start`，可用 `PORT`、`HOST` 環境變數設定）
- 前端預設連到「網頁所在的位置」；前後端分開放時，打包前設定 `VITE_SERVER_URL`

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

- 電腦：打開 `http://localhost:5173`，再開一個分頁貼上同一個網址（含 `?room=...`）就能對戰
- 手機（同一個 Wi-Fi）：打開終端機顯示的 `Network: http://192.168.x.x:5173`
- 鍵盤：WASD／方向鍵移動，J 或空白鍵放火球，K 放爆炎

## 專案結構

```
src/
  shared/              前後端共用
    constants.js       遊戲數值、技能清單 SKILLS（加技能改這裡）
    movement.js        移動邏輯（伺服器和客戶端預測跑同一支）
  server/
    app.config.js      伺服器設定
    rooms/ArenaRoom.js 對戰規則：移動、技能、命中、復活
    rooms/schema.js    同步給客戶端的資料結構
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
| `pillar.png` | 25×61 | 障礙物（石柱），底部對齊地面。位置和佔地大小在 `src/shared/constants.js` 的 `OBSTACLES` |
| `player0.png` ~ `player3.png` | 32×40 | 角色站立圖，面朝右，腳貼齊底部，透明背景 |
| `player0_walk.png` ~ `player3_walk.png` | 128×40 | 走路動畫，橫排 4 格（每格 32×40）。沒有這張就不播動畫 |
| `fireball.png` | 17×11 | 技能 1，朝右，透明背景 |
| `bigfireball.png` | 39×23 | 技能 2，朝右，透明背景 |
| `explosion.png` | 200×40 | 命中特效，橫排 5 格（每格 40×40）：閃光 → 火球 → 爆炸 → 碎煙 → 淡出 |

音效放在 `public/assets/sfx/`（施放、爆炸、冒煙、被打中、死亡、復活），是用 `node tools/make_sfx.mjs`
合成的 8-bit 音效。要換成其他音效，放入同名的 `.wav`，或修改 `theme.js` 的 `sounds` 路徑。

目前的圖是用 Codex 產生的（AI 畫的「大尺寸像素風」再還原成真正的小像素圖），流程和提示詞見 [tools/README.md](tools/README.md)。

## 部署

- 前端（GitHub Pages）：`VITE_SERVER_URL=wss://你的伺服器 npm run build:client`，上傳 `dist/client/`
- 後端（Fly.io／Render 等）：`npm run build` 後執行 `npm start`

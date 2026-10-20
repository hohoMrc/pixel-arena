# 美術與音效工具

## 音效

```bash
node tools/make_sfx.mjs
```

用程式合成 8-bit 風格音效，輸出到 `public/assets/sfx/`（會覆蓋同名檔）。
想調整聲音，修改檔案裡 `SOUNDS` 的參數（頻率、長度、衰減、雜訊比例）再重新執行。
每次產生的結果都一樣（雜訊使用固定的亂數種子）。

---

# 產圖

用 Codex 產生像素圖，再還原成遊戲用的小尺寸。

## 為什麼需要還原

Codex 產出的是約 1254px 的大圖，而且不會照提示畫成 16×16。
實際上大約是 36 格寬的「像素風」，每格約 35px。
直接縮小會糊掉，所以要取每一格的中心點顏色，還原成真正的像素圖。

## 環境

```bash
python3 -m venv tools/.venv
tools/.venv/bin/pip install pillow
```

## 流程

### 1. 產圖

```bash
codex exec --skip-git-repo-check [-i 參考圖.png] -- '提示詞' </dev/null
```

- 最後一行會印出圖檔路徑（`~/.codex/generated_images/...`），把它複製出來
- 新角色要和現有角色畫風一致，就用 `-i` 附上一張現有角色的**原始大圖**當風格參考
- `-i` 後面一定要接 `--`，否則 codex 會把提示詞當成檔名

### 2. 還原

| 素材 | 指令 |
|---|---|
| 角色站立圖 | `tools/.venv/bin/python tools/pixelize.py 原圖.png public/assets/player4.png --grid 36 --frame 32x40` |
| 地板（鋪滿） | `tools/.venv/bin/python tools/pixelize.py 原圖.png public/assets/floor.png --grid 64 --opaque` |
| 技能圖示 | `tools/.venv/bin/python tools/pixelize.py 原圖.png public/assets/xxx.png --grid 40` |
| 走路動畫 | `tools/.venv/bin/python tools/slice_walk.py 原圖.png public/assets/player4_walk.png --height 36` |
| 正面 / 背面走路 | `tools/.venv/bin/python tools/slice_walk.py 原圖.png public/assets/player4_front.png --height 36`（背面輸出成 `player4_back.png`） |
| 特效動畫 | `tools/.venv/bin/python tools/slice_walk.py 原圖.png public/assets/explosion.png --frames 5 --height 30 --fw 40 --fh 40 --align center` |

- `--grid`：原圖橫向有幾格，可以目測（圖寬 ÷ 一格寬）。不確定就先輸出，看 `_x8.png` 預覽圖再調整
- 特效的火花、碎煙常常是分開的小塊，`slice_walk.py` 會自動合併間隔最小的區塊，直到剩下 `--frames` 格
- `--height`：填站立圖的內容高度（`pixelize.py` 輸出的「內容尺寸」第二個數字），動畫才會和站立圖一樣大
- `_x8.png` 預覽圖只用來檢查，已經被 `.gitignore` 排除

### 3. 登記到主題

在 `src/client/theme.js` 的 `assets` 加上新圖的路徑。

## 用過的提示詞

**角色**（附 `-i` 參考圖）：
```
Generate one image: A red-armored knight with a small sword and round shield, full body chibi game
character facing right, same proportions and same size in frame as the reference. Match the exact
pixel art style, pixel block size, outline and palette approach of the attached reference image
(reference only: create a NEW character, do not copy it). Strict pixel art, perfectly square
solid-color blocks, no anti-aliasing, no gradients, dark 1-pixel outline. Transparent background.
Square image.
```

**走路動畫**（`-i` 附該角色的原始大圖）：
```
Generate one image: a horizontal sprite sheet of a 4-frame WALK CYCLE animation for the EXACT same
character as the attached image (modification target: keep the identical character design, colors,
outfit, weapon, proportions, pixel block size and outline; only change the pose of legs and arms for
walking). Facing right. The 4 frames are side by side in a single row, evenly spaced, all the same
size and same scale as the original, feet on the same baseline, with clear empty transparent gaps
between frames. Frame order: contact (right foot forward), passing (feet together, body slightly up),
contact (left foot forward), passing. Strict pixel art, perfectly square solid-color blocks, no
anti-aliasing, no gradients. Transparent background. Wide landscape image.
```

**正面 / 背面走路**（`-i` 附該角色的原始大圖；背面把 FRONT 那段換成括號裡的描述）：
```
Generate one image: a horizontal sprite sheet of a 4-frame WALK CYCLE animation for the EXACT same
character as the attached image, but seen FROM THE FRONT: the character faces the viewer and walks
toward the camera (moving DOWN the screen in a top-down RPG), face and front of the outfit visible,
symmetric front view.
(背面：seen STRICTLY FROM BEHIND (rear view): back of the head / helmet visible, NO face, NO visor,
walks away from the camera, moving UP the screen in a top-down RPG.)
Keep the identical character design, colors, outfit, weapon, proportions, pixel block size and dark
outline (modification target: same character, only the viewing angle and leg/arm poses change).
The 4 frames are side by side in a single row, evenly spaced, all the same size and same scale as the
original, feet on the same baseline, with clear empty transparent gaps between frames, nothing
overlapping. Frame order: 1 left foot forward, 2 standing neutral with feet together, 3 right foot
forward, 4 standing neutral with feet together. Strict pixel art, perfectly square solid-color blocks,
no anti-aliasing, no gradients. Transparent background. Wide landscape image.
```
- 第 2 格是站立圖（遊戲裡 `IDLE_FRAME = 1`）
- 戴頭盔的角色容易被畫成正面，背面提示要特別寫 NO visor、NO face
- 同時跑好幾個 `codex exec` 時，log 最後不一定會印出圖檔路徑；用 log 裡的 `session id` 到
  `~/.codex/generated_images/<session id>/` 找，圖片可能在程式結束後幾秒才寫入

**地板**：
```
Generate one image: One seamless tileable top-down dungeon floor tile: dark slate blue-grey stone
bricks, subtle cracks, low contrast so characters stand out. Fill the ENTIRE square edge to edge with
the tile (NO transparent background, no border). Strict pixel art, no anti-aliasing.
```

**特效動畫**（`-i` 附火球的原始大圖）：
```
Generate one image: a horizontal sprite sheet of a 5-frame fiery EXPLOSION impact animation in the
same pixel art style, palette (orange, yellow, red, dark outline) and pixel block size as the attached
fireball (reference only). Frames left to right: 1 small bright white-yellow flash burst, 2 bigger
orange fireball burst with sparks, 3 largest red-orange explosion cloud, 4 breaking up into smoke
puffs with a few embers, 5 small fading grey smoke wisps. Each frame centered in its own cell, all
cells the same size, side by side in a single row, with clear empty transparent gaps between frames,
nothing overlapping. Strict pixel art, perfectly square solid-color blocks, no anti-aliasing, no
gradients. Transparent background. Wide landscape image.
```

**技能**：
```
Generate one image: A single small orange fireball projectile flying to the right, with a short flame
tail on the left, centered, nothing else in the image. Strict pixel art, perfectly square solid-color
blocks, no anti-aliasing, no gradients, dark 1-pixel outline. Transparent background. Square image.
```

**地圖素材**（森林、沙漠；`-i` 附地牢對應的原始大圖當風格參考，還原都用 `--grid 64`，地板和牆加 `--opaque`）：
```
地板：One seamless tileable top-down forest meadow floor tile: muted dark green grass with a few tiny
darker tufts and small specks of dirt, low contrast so characters stand out. Must tile seamlessly in
all directions. Match the pixel art style, pixel block size and palette approach of the attached
reference image (reference only, make a NEW tile). Strict pixel art, perfectly square solid-color
blocks, no anti-aliasing, no gradients. Fill the ENTIRE square edge to edge (NO transparent
background, no border, no frame). Square image.

障礙物：a single small round leafy TREE obstacle for a top-down RPG (3/4 view, like classic 16-bit
Zelda/Pokemon): a round dark green leafy crown on top of a short brown trunk, standing on the ground
with a small dark shadow at its base. The tree is about 1.6 times taller than it is wide, centered,
nothing else in the image. Match the pixel art style, pixel block size and dark outline of the
attached reference pillar (reference only, make a NEW object). Strict pixel art, ... Transparent
background. Square image.
```
牆的正面、牆頂把地板提示的主題換成樹叢 / 砂岩，並沿用地牢牆的描述（正面要左右無縫、上緣亮下緣暗）。

"""把 Codex 產的橫排連續動作圖（走路、爆炸…）切成 N 格，還原像素，排成 Phaser 用的 spritesheet。
用法：
  python tools/slice_walk.py 原始圖.png 輸出.png --height 36 [--frames 4] [--fw 32 --fh 40] [--align bottom|center]

  --height  最高那一格的高度（像素）。走路動畫填站立圖的高度，動畫和站立圖才會一樣大
  --align   bottom：腳貼齊底部（角色，預設）；center：置中（爆炸、特效）
- 以透明欄位切出每一格（不假設等距）。火花、碎煙這類分開的小塊，
  會自動把間隔最小的區塊合併，直到剩下 --frames 格
- 所有格子共用同一個像素格大小（以最高那格的高度 / --height 算出），大小才一致
"""
import argparse, sys
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("src"); ap.add_argument("dst")
ap.add_argument("--height", type=int, required=True)
ap.add_argument("--frames", type=int, default=4)
ap.add_argument("--fw", type=int, default=32); ap.add_argument("--fh", type=int, default=40)
ap.add_argument("--align", choices=["bottom", "center"], default="bottom")
a = ap.parse_args()

img = Image.open(a.src).convert("RGBA")
W, H = img.size
alpha = img.getchannel("A").point(lambda v: 255 if v >= 128 else 0)
px = alpha.load()

# 找出有內容的欄位區段
cols = [any(px[x, y] for y in range(0, H, 2)) for x in range(W)]
spans, start = [], None
for x, filled in enumerate(cols + [False]):
    if filled and start is None: start = x
    if not filled and start is not None:
        spans.append((start, x)); start = None
# 先丟掉太窄的雜點；格數還是不對，就把間隔最小的相鄰區段合併，直到剩 N 格
wide = [s for s in spans if s[1] - s[0] > W * 0.03]
if len(wide) == a.frames:
    spans = wide
else:
    while len(spans) > a.frames:
        gaps = [spans[i + 1][0] - spans[i][1] for i in range(len(spans) - 1)]
        i = gaps.index(min(gaps))
        spans[i:i + 2] = [(spans[i][0], spans[i + 1][1])]
if len(spans) != a.frames:
    sys.exit(f"偵測到 {len(spans)} 格，預期 {a.frames}：{spans}")

boxes = []
for x0, x1 in spans:
    bb = alpha.crop((x0, 0, x1, H)).getbbox()
    boxes.append((x0 + bb[0], bb[1], x0 + bb[2], bb[3]))
block = max(b[3] - b[1] for b in boxes) / a.height
print(f"block = {block:.1f}px")

sheet = Image.new("RGBA", (a.fw * a.frames, a.fh))
src = img.load()
for i, (x0, y0, x1, y1) in enumerate(boxes):
    w, h = round((x1 - x0) / block), round((y1 - y0) / block)
    frame = Image.new("RGBA", (w, h)); out = frame.load()
    for y in range(h):
        for x in range(w):
            r, g, b, al = src[min(W - 1, int(x0 + (x + 0.5) * block)), min(H - 1, int(y1 - (h - y - 0.5) * block))]
            out[x, y] = (r, g, b, 255) if al >= 128 else (0, 0, 0, 0)
    bb = frame.getbbox(); frame = frame.crop(bb)
    if frame.width > a.fw or frame.height > a.fh:
        sys.exit(f"第 {i} 格 {frame.size} 超出 {a.fw}x{a.fh}")
    top = a.fh - frame.height if a.align == "bottom" else (a.fh - frame.height) // 2
    sheet.paste(frame, (i * a.fw + (a.fw - frame.width) // 2, top))
    print(f"frame {i}: {frame.size}")
sheet.save(a.dst)
sheet.resize((sheet.width * 8, sheet.height * 8), Image.NEAREST).save(a.dst.replace(".png", "_x8.png"))

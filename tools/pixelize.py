"""把 AI 產生的「大尺寸像素風圖」還原成真正的小像素圖。

用法：
  python tools/pixelize.py 原圖.png 輸出.png --grid 36 [--frame 32x40] [--opaque]

  --grid    原圖橫向有幾格（目測：圖寬 ÷ 一格的像素寬）。高度依同樣格子大小推算
  --frame   把內容放進固定尺寸的透明圖框：水平置中、貼齊底部（角色腳踩地）
  --opaque  不處理透明（地板這類鋪滿的圖）

會另外輸出 *_x8.png 放大預覽圖（不要放進 public/assets）。
"""
import argparse, sys
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("src"); ap.add_argument("dst")
ap.add_argument("--grid", type=int, required=True)
ap.add_argument("--frame")
ap.add_argument("--opaque", action="store_true")
a = ap.parse_args()

img = Image.open(a.src).convert("RGBA")
W, H = img.size
block = W / a.grid
cols, rows = a.grid, round(H / block)

# 取每一格中心點的顏色
small = Image.new("RGBA", (cols, rows))
src, out = img.load(), small.load()
for y in range(rows):
    for x in range(cols):
        out[x, y] = src[min(W - 1, int((x + 0.5) * block)), min(H - 1, int((y + 0.5) * block))]

if not a.opaque:
    # 像素圖不要半透明邊：alpha 二值化，再裁掉四周透明
    small.putdata([(r, g, b, 255) if al >= 128 else (0, 0, 0, 0) for r, g, b, al in small.getdata()])
    small = small.crop(small.getbbox())
print(f"block = {block:.1f}px, 內容尺寸 = {small.size}")

if a.frame:
    fw, fh = map(int, a.frame.lower().split("x"))
    if small.width > fw or small.height > fh:
        sys.exit(f"內容 {small.size} 放不進 {fw}x{fh}，請把 --grid 調小，或加大圖框")
    canvas = Image.new("RGBA", (fw, fh))
    canvas.paste(small, ((fw - small.width) // 2, fh - small.height))
    small = canvas

small.save(a.dst)
small.resize((small.width * 8, small.height * 8), Image.NEAREST).save(a.dst.rsplit(".", 1)[0] + "_x8.png")
print(f"已輸出 {a.dst} {small.size}")

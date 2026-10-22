"""从图标源图抠出透明底 logo，供 UI 内联显示（解锁页 / 顶栏）。

原理：底色是均匀米白，按色距把背景像素变透明（30~80 线性过渡防锯齿边），
再裁到主体外接框 + 少量留白，输出 256px 与原图两种。
"""
import os

from PIL import Image, ImageChops

from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
SRC = PROJECT / "assets" / "icon-source.jpg"
OUT_DIR = PROJECT / "assets"

img = Image.open(SRC).convert("RGB")
w, h = img.size

# 采样四角均值作为背景色
corners = [img.getpixel(p) for p in [(4, 4), (w - 5, 4), (4, h - 5), (w - 5, h - 5)]]
bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))

# 色距 → alpha：<=30 全透明，>=80 全不透明，之间线性
diff = ImageChops.difference(img, Image.new("RGB", img.size, bg)).convert("L")
alpha = diff.point(lambda d: 0 if d < 30 else (255 if d > 80 else int((d - 30) * 255 / 50)))
rgba = img.convert("RGBA")
rgba.putalpha(alpha)

# 裁到主体外接框 + 4% 留白
bbox = rgba.getchannel("A").getbbox()
pad = int(max(bbox[2] - bbox[0], bbox[3] - bbox[1]) * 0.04)
box = (
    max(0, bbox[0] - pad),
    max(0, bbox[1] - pad),
    min(w, bbox[2] + pad),
    min(h, bbox[3] + pad),
)
cropped = rgba.crop(box)

cropped.save(os.path.join(OUT_DIR, "logo-transparent.png"))
cropped.resize((256, 256), Image.LANCZOS).save(
    os.path.join(OUT_DIR, "logo-256.png")
)
print("logo written:", os.listdir(OUT_DIR))

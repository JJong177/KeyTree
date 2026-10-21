"""生成托盘状态图标（锁定 / 已解锁），直接用正式 logo（assets/icon-source.jpg）。

托盘只有 16–32 px，整张 1024 图缩下去树会糊成一粒，所以先自动裁出内容包围盒
（背景是米色纸纹，按颜色差阈值找树干/树叶），再补成正方形、留一点边距、切圆角。
状态区分靠颜色：解锁 = 品牌原色，锁定 = 去饱和压暗（形状一样，tooltip 兜底说明）。

产物：src-tauri/icons/tray-unlocked.png、tray-locked.png（32×32）
跑法：python scripts/gen_tray_icons.py（需要 Pillow）
"""
import os

from PIL import Image, ImageDraw, ImageEnhance

OUT = "D:/workbuddy/Easy/keylite/src-tauri/icons"
SRC = "D:/workbuddy/Easy/keylite/assets/icon-source.jpg"
SIZE = 32
SS = 8  # 超采样倍数：圆角和缩放都在大图上做，边缘才不毛
MARGIN = 1.10  # 内容外留白比例（1.0 = 贴边）
RADIUS = 0.28  # 圆角半径 / 边长（与应用图标一致）

os.makedirs(OUT, exist_ok=True)

src = Image.open(SRC).convert("RGB")
w, h = src.size
px = src.load()
bg = px[4, 4]


def is_content(x: int, y: int) -> bool:
    c = px[x, y]
    return max(abs(c[0] - bg[0]), abs(c[1] - bg[1]), abs(c[2] - bg[2])) > 30


xs, ys = [], []
for y in range(0, h, 2):
    for x in range(0, w, 2):
        if is_content(x, y):
            xs.append(x)
            ys.append(y)
x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)

side = int(max(x1 - x0, y1 - y0) * MARGIN)
cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
left = max(0, min(w - side, cx - side // 2))
top = max(0, min(h - side, cy - side // 2))
crop = src.crop((left, top, left + side, top + side))
print(f"crop: {left},{top} side={side}")

big = crop.resize((SIZE * SS, SIZE * SS), Image.LANCZOS).convert("RGBA")
mask = Image.new("L", big.size, 0)
ImageDraw.Draw(mask).rounded_rectangle(
    [0, 0, big.size[0] - 1, big.size[1] - 1], radius=int(SIZE * SS * RADIUS), fill=255
)
big.putalpha(mask)

unlocked = big.resize((SIZE, SIZE), Image.LANCZOS)
unlocked.save(f"{OUT}/tray-unlocked.png")

# 锁定：只去饱和 + 压暗，保留 logo 形状，避免出现"另一个图标"
gray = ImageEnhance.Brightness(big.convert("LA").convert("RGBA")).enhance(0.88)
locked = gray.resize((SIZE, SIZE), Image.LANCZOS)
locked.save(f"{OUT}/tray-locked.png")

print("tray icons written:", unlocked.size)

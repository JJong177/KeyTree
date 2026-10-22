"""生成 KeyTree 正式应用图标（源图：assets/icon-source.jpg，树形钥匙）。

处理：米白 JPG 底 → RGBA → 圆角透明（radius 18%）→ 全套尺寸。
产物：src-tauri/icons/{32x32,128x128,128x128@2x,icon.png, icon.ico}
跑法：python scripts/gen_icons.py（需要 Pillow）
"""
import os

from PIL import Image, ImageDraw

from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
OUT = PROJECT / "src-tauri" / "icons"
SRC = PROJECT / "assets" / "icon-source.jpg"
SIZE = 1024
RADIUS = 180  # 约 17.5%，与自然有机风的圆角比例一致

os.makedirs(OUT, exist_ok=True)

base = Image.open(SRC).convert("RGBA")
if base.size != (SIZE, SIZE):
    base = base.resize((SIZE, SIZE), Image.LANCZOS)

# 圆角透明遮罩
mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=RADIUS, fill=255)
icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
icon.paste(base, (0, 0), mask)

icon.save(f"{OUT}/icon.png")
icon.resize((32, 32), Image.LANCZOS).save(f"{OUT}/32x32.png")
icon.resize((128, 128), Image.LANCZOS).save(f"{OUT}/128x128.png")
icon.resize((256, 256), Image.LANCZOS).save(f"{OUT}/128x128@2x.png")
# ICO：从 256 母版生成全部内嵌尺寸
icon.resize((256, 256), Image.LANCZOS).save(
    f"{OUT}/icon.ico",
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("icons written:", sorted(os.listdir(OUT)))

"""一次性脚本：生成 KeyLite 占位图标（自然有机风：米色底 + sage 叶子）。"""
import os
from PIL import Image, ImageDraw

OUT = "D:/workbuddy/Easy/keylite/src-tauri/icons"
os.makedirs(OUT, exist_ok=True)

img = Image.new("RGBA", (1024, 1024), (250, 246, 241, 255))  # #faf6f1
d = ImageDraw.Draw(img)
d.ellipse([332, 332, 692, 692], fill=(139, 157, 119, 255))  # sage #8b9d77
d.rectangle([500, 200, 524, 824], fill=(92, 64, 51, 255))  # stem #5c4033

img.save(f"{OUT}/icon.png")
img.resize((32, 32), Image.LANCZOS).save(f"{OUT}/32x32.png")
img.resize((128, 128), Image.LANCZOS).save(f"{OUT}/128x128.png")
img.resize((256, 256), Image.LANCZOS).save(f"{OUT}/128x128@2x.png")
img.resize((256, 256), Image.LANCZOS).save(
    f"{OUT}/icon.ico",
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("icons written:", sorted(os.listdir(OUT)))

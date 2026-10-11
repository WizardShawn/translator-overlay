"""Render docs/media/social-preview.png (1280x640): the test scene wiped from original (left) to translated (right)."""
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

root = sys.argv[1]
W, H = 1280, 640
before = Image.open(f"{root}/docs/media/before.png").convert("RGB")
after = Image.open(f"{root}/docs/media/after.png").convert("RGB")
scale = W / before.width
size = (W, round(before.height * scale))
before, after = before.resize(size, Image.LANCZOS), after.resize(size, Image.LANCZOS)
top = size[1] - H                                   # keep the dialogue box, drop sky from the top
before, after = before.crop((0, top, W, top + H)), after.crop((0, top, W, top + H))

split = 640
img = before.copy()
img.paste(after.crop((split, 0, W, H)), (split, 0))

# darken the sky behind the title so it reads
shade = Image.new("L", (W, H), 0)
d = ImageDraw.Draw(shade)
for y in range(300):
    for x in range(0, W, 4):
        a = (1 - y / 300) * max(0.0, 1 - x / 700)
        d.line([(x, y), (x + 3, y)], fill=int(200 * a))
img = Image.composite(Image.new("RGB", (W, H), (8, 10, 22)), img, shade)

draw = ImageDraw.Draw(img)
F = "C:/Windows/Fonts/"
title = ImageFont.truetype(F + "segoeuib.ttf", 60)
sub = ImageFont.truetype(F + "segoeui.ttf", 25)
tag = ImageFont.truetype(F + "seguisb.ttf", 20)

draw.text((56, 42), "Translator Overlay", font=title, fill=(246, 241, 228))
for i, line in enumerate(["Play any game in your language.", "A click-through overlay paints Gemini", "translations over the original text."]):
    draw.text((58, 116 + 31 * i), line, font=sub, fill=(205, 208, 220))

# the wipe line
draw.rectangle((split - 2, 0, split + 1, H), fill=(229, 186, 82))

def pill(x, y, text, anchor_right=False):
    w = draw.textlength(text, font=tag) + 28
    x0 = x - w if anchor_right else x
    draw.rounded_rectangle((x0, y, x0 + w, y + 36), radius=18, fill=(20, 23, 32), outline=(229, 186, 82), width=2)
    draw.text((x0 + 14, y + 6), text, font=tag, fill=(246, 241, 228))

pill(split - 16, 352, "Original", anchor_right=True)
pill(split + 16, 352, "Translated")

img.save(f"{root}/docs/media/social-preview.png", optimize=True)
print(img.size)

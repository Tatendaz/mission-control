#!/usr/bin/env python3
"""Turn a generated icon render (squircle on flat gray) into a masked macOS
AppIcon.iconset + .icns. Usage: make-icon.py <render> <outdir-name>.
Finds the squircle by background-diff bbox, re-composes it onto a transparent
1024 canvas at Apple's ~80% content size, applies a rounded-rect alpha mask,
and emits every iconset size. Needs Pillow; iconutil does the final .icns."""
import sys, os, subprocess
from PIL import Image, ImageDraw, ImageOps

src, name = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")
w, h = im.size
bg = im.getpixel((6, 6))

def diff(px):
    return abs(px[0]-bg[0]) + abs(px[1]-bg[1]) + abs(px[2]-bg[2])

# bbox of everything that is not background (sample every 4th px for speed)
minx, miny, maxx, maxy = w, h, 0, 0
px = im.load()
for y in range(0, h, 4):
    for x in range(0, w, 4):
        if diff(px[x, y]) > 42:
            if x < minx: minx = x
            if x > maxx: maxx = x
            if y < miny: miny = y
            if y > maxy: maxy = y
# drop soft drop-shadow fringe: inset a touch
inset = int((maxx - minx) * 0.012)
box = (minx + inset, miny + inset, maxx - inset, maxy - inset)
sq = im.crop(box)
side = max(sq.size)
sq = ImageOps.fit(sq, (side, side), Image.LANCZOS)

CANVAS, CONTENT = 1024, 824          # Apple margin: content ~80% of canvas
sq = sq.resize((CONTENT, CONTENT), Image.LANCZOS)
mask = Image.new("L", (CONTENT, CONTENT), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, CONTENT, CONTENT), radius=int(CONTENT*0.225), fill=255)
out = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
off = (CANVAS - CONTENT) // 2
out.paste(sq, (off, off), mask)

base = os.path.dirname(os.path.abspath(src))
iconset = os.path.join(base, name + ".iconset")
os.makedirs(iconset, exist_ok=True)
for s in (16, 32, 64, 128, 256, 512):
    out.resize((s, s), Image.LANCZOS).save(f"{iconset}/icon_{s}x{s}.png")
    out.resize((s*2, s*2), Image.LANCZOS).save(f"{iconset}/icon_{s}x{s}@2x.png")
out.save(os.path.join(base, name + "-1024.png"))
subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(base, name + ".icns")], check=True)
print("icns written:", os.path.join(base, name + ".icns"))

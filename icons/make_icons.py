"""Generate the app icons (a small pixel-heart nonogram). Run: python3 icons/make_icons.py
Requires Pillow. The picture stays inside the central 60% so the icon is maskable."""
from pathlib import Path
from PIL import Image, ImageDraw

HEART = [
    "..........",
    ".XX....XX.",
    "XXXX..XXXX",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    ".XXXXXXXX.",
    "..XXXXXX..",
    "...XXXX...",
    "....XX....",
    "..........",
]
BG, CELL, FILL = (40, 54, 56), (68, 95, 98), (238, 238, 231)  # Vectors-style ink, slate teal, paper

def make(size: int) -> None:
    img = Image.new("RGB", (size, size), BG)
    d = ImageDraw.Draw(img)
    n = len(HEART)
    board = size * 0.6
    step = board / n
    off = (size - board) / 2
    gap = max(1, round(step * 0.08))
    for r, row in enumerate(HEART):
        for c, ch in enumerate(row):
            x0, y0 = off + c * step + gap, off + r * step + gap
            d.rectangle([x0, y0, x0 + step - 2 * gap, y0 + step - 2 * gap], fill=FILL if ch == "X" else CELL)
    img.save(Path(__file__).with_name(f"icon-{size}.png"), optimize=True)

for s in (192, 512):
    make(s)

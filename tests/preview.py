"""Rasterise out/preview.json (or another preview payload) to PNG.

    python tests/preview.py                      # out/preview.json  -> preview-top/-bottom.png
    python tests/preview.py out/preview-rot.json # rotated layout     -> rot-top/-bottom.png
"""
import json, os, sys
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join("out", "preview.json")
if not os.path.isabs(src):
    src = os.path.join(ROOT, src)
prefix = sys.argv[2] if len(sys.argv) > 2 else "preview"

with open(src, "r", encoding="utf-8") as fh:
    data = json.load(fh)

S = 4.0  # px per mm
W = int(round(data["W"] * S)) + 2
H = int(round(data["H"] * S)) + 2


def to_px(p):
    return (p["x"] * S + 1, p["y"] * S + 1)


def render(face, name):
    img = Image.new("RGB", (W, H), (255, 255, 255))
    dr = ImageDraw.Draw(img, "RGBA")
    for c in data["cells"]:
        cx, cy = to_px(c)
        r = c["r"] * S
        dr.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(205, 205, 205), width=1)
    for g in data["groups"]:
        if g["face"] != face:
            continue
        col = g["color"].lstrip("#")
        rgb = tuple(int(col[i:i + 2], 16) for i in (0, 2, 4))
        for loop in g["loops"]:
            pts = [to_px(p) for p in loop]
            if len(pts) < 3:
                continue
            dr.polygon(pts, fill=rgb + (45,))
            dr.line(pts + [pts[0]], fill=rgb + (255,), width=2)
    out = os.path.join(ROOT, "out", name)
    img.save(out)
    print("wrote", out, img.size)


render("top", prefix + "-top.png")
render("bottom", prefix + "-bottom.png")

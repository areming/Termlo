"""Generate native icons from the simple vector geometry in assets/termlo.svg.

Requires Pillow only when refreshing brand assets; application builds use committed files.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
S = 1024
K = S / 256

image = Image.new("RGBA", (S, S), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((8*K, 8*K, 248*K, 248*K), radius=52*K, fill="#162733")
def diamond(top, right, bottom, left):
    return [(128*K, top*K), (right*K, 128*K), (128*K, bottom*K), (left*K, 128*K)]

draw.polygon(diamond(34, 222, 222, 34), fill="#73DCC4")
draw.polygon(diamond(54, 202, 202, 54), fill="#162733")
draw.polygon(diamond(77, 179, 179, 77), fill="#B7F5E6")
draw.polygon(diamond(91, 165, 165, 91), fill="#265750")

image.resize((512, 512), Image.Resampling.LANCZOS).save(ASSETS / "termlo.png")
image.save(ASSETS / "termlo.ico", format="ICO", sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
image.save(ASSETS / "termlo.icns", format="ICNS")
print("Generated Termlo PNG, ICO and ICNS from the diamond logo")

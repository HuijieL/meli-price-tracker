from PIL import Image, ImageDraw, ImageFont
import os

SIZE = 512
BG = (255, 255, 255, 255)
PRIMARY = (52, 109, 245)   # Meli-style blue
ACCENT = (255, 193, 7)     # amber accent
DARK = (30, 40, 60)

img = Image.new("RGBA", (SIZE, SIZE), BG)
d = ImageDraw.Draw(img)

# Rounded square backdrop
pad = 24
d.rounded_rectangle([pad, pad, SIZE - pad, SIZE - pad], radius=72, fill=PRIMARY)

# Bar chart (ascending bars) — represents price tracking
base_y = 380
bar_w = 54
gap = 24
start_x = 120
heights = [120, 170, 220, 280]
for i, h in enumerate(heights):
    x0 = start_x + i * (bar_w + gap)
    y0 = base_y - h
    d.rounded_rectangle([x0, y0, x0 + bar_w, base_y], radius=12, fill=(255, 255, 255, 255))

# Arrow / trend line on top of bars (accent color)
points = [
    (start_x + bar_w // 2, base_y - heights[0]),
    (start_x + bar_w + gap + bar_w // 2, base_y - heights[1]),
    (start_x + 2 * (bar_w + gap) + bar_w // 2, base_y - heights[2]),
    (start_x + 3 * (bar_w + gap) + bar_w // 2, base_y - heights[3]),
]
d.line(points, fill=ACCENT, width=10, joint="curve")
# dots at each vertex
for p in points:
    d.ellipse([p[0] - 10, p[1] - 10, p[0] + 10, p[1] + 10], fill=ACCENT)

# Text "PT" monogram at the bottom — optional subtle brand mark
try:
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 64)
except Exception:
    font = ImageFont.load_default()

text = "PRICE TRACKER"
try:
    font2 = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 38)
except Exception:
    font2 = font

bbox = d.textbbox((0, 0), text, font=font2)
tw = bbox[2] - bbox[0]
th = bbox[3] - bbox[1]
d.text(((SIZE - tw) / 2, 410), text, fill=(255, 255, 255, 255), font=font2)

out = "/Users/li/Desktop/Meli- tracker/logo.png"
img.save(out, "PNG", optimize=True)
size_kb = os.path.getsize(out) / 1024
print(f"Saved: {out}  ({size_kb:.1f} KB)")

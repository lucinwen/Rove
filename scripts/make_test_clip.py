"""Reproduce the original 24-second Rove sync clip; Pillow and ffmpeg required.

This is a synthetic media-clock test, not captured footage or a real user study.
"""
from pathlib import Path
import math
import subprocess
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "web/public/media/rove-sync.webm"
DEST.parent.mkdir(parents=True, exist_ok=True)
FPS, SECONDS, W, H = 12, 24, 640, 360
font_file = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
font = ImageFont.truetype(font_file, 12)
title = ImageFont.truetype(font_file, 22)
number = ImageFont.truetype(font_file, 15)
process = subprocess.Popen([
    "ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-vcodec", "rawvideo",
    "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-an",
    "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "42", "-row-mt", "1", "-pix_fmt", "yuv420p", str(DEST)
], stdin=subprocess.PIPE)
for i in range(FPS * SECONDS):
    t = i / FPS
    frame = Image.new("RGB", (W, H), "#273e34")
    draw = ImageDraw.Draw(frame)
    draw.text((35, 24), "R O V E   /   S A M E   M O M E N T", fill="#a9b8a0", font=font)
    draw.text((35, 305), "A little closer.", fill="#f1e9d9", font=title)
    draw.text((545, 311), f"{t:05.1f}s", fill="#b7c7ad", font=number)
    for radius in (47, 82, 117):
        draw.ellipse((320-radius, 174-radius, 320+radius, 174+radius), outline="#3d5546", width=1)
    angle = 2 * math.pi * t / 12
    for phase, color in ((0, "#d49a83"), (math.pi, "#afc3a3")):
        x, y = 320+92*math.cos(angle+phase), 174+60*math.sin(angle+phase)
        draw.ellipse((x-15,y-15,x+15,y+15), fill=color)
        draw.ellipse((x-6,y-8,x-1,y-3), fill="#f7efdd")
    draw.line((35, 285, 605, 285), fill="#48604f", width=2)
    draw.line((35, 285, 35 + 570*t/SECONDS, 285), fill="#d9c7a6", width=3)
    process.stdin.write(frame.tobytes())
process.stdin.close()
if process.wait() != 0:
    raise SystemExit("ffmpeg failed")
print(f"Created {DEST.name}: {DEST.stat().st_size} bytes, {SECONDS} seconds")

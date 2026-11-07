"""Builds the photographic ghost sprites in assets/ghosts/ from openly
licensed source photos (see assets/ghosts/CREDITS.md).

    python3 tools/make_sprites.py <dir with source jpgs>

Sources are not committed; download them from the URLs in CREDITS.md and
name them as below. Each sprite is cut out with a feathered mask, graded
cold and dead, dirtied, and has its eyes made wrong.
"""
import sys
import numpy as np
from PIL import Image, ImageFilter

SRC = sys.argv[1] if len(sys.argv) > 1 else '.'
OUT = 'assets/ghosts'
rng = np.random.default_rng(7)


def load(name):
    return np.asarray(Image.open(f'{SRC}/{name}.jpg').convert('RGB')).astype(np.float32) / 255


def lum(a):
    return a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114


def sstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def oval(h, w, cx, cy, rx, ry, feather=0.25):
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2)
    return 1 - sstep(1 - feather, 1, d)


def blur_noise(h, w, scale, seed):
    r = np.random.default_rng(seed)
    small = r.random((max(2, h // scale), max(2, w // scale))).astype(np.float32)
    im = Image.fromarray((small * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)
    return np.asarray(im).astype(np.float32) / 255


def grade(rgb, tint=(0.86, 0.93, 0.92), sat=0.12, gamma=1.0, contrast=1.15):
    l = lum(rgb)[..., None]
    g = l + (rgb - l) * sat
    g = np.clip((g - 0.5) * contrast + 0.5, 0, 1) ** gamma
    return np.clip(g * np.array(tint, np.float32), 0, 1)


def grime(rgb, amount, seed):
    h, w = rgb.shape[:2]
    # soft, large-scale stains and a little fine grain: dirt, not camouflage
    n = blur_noise(h, w, 60, seed) * 0.7 + blur_noise(h, w, 22, seed + 1) * 0.3
    dirt = sstep(0.55, 0.95, n)[..., None]
    grain = (rng.random((h, w, 1)).astype(np.float32) - 0.5) * 0.04
    return np.clip(rgb * (1 - dirt * amount * np.array([0.9, 1.0, 1.05])) + grain, 0, 1)


def paint_eye(rgb, a, cx, cy, rx, ry, glint=True):
    h, w = rgb.shape[:2]
    m = oval(h, w, cx, cy, rx, ry, 0.45)[..., None]
    rgb[:] = rgb * (1 - m) + np.array([0.01, 0.01, 0.012]) * m
    a[:] = np.maximum(a, m[..., 0])
    if glint:
        g = oval(h, w, cx - rx * 0.28, cy - ry * 0.3, rx * 0.1, ry * 0.12, 0.6)[..., None]
        rgb[:] = rgb * (1 - g * 0.8) + 0.92 * g * 0.8


def save(name, rgb, a, crop, size):
    x0, y0, x1, y1 = crop
    arr = np.dstack([rgb, a])[y0:y1, x0:x1]
    im = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8), 'RGBA')
    im.thumbnail(size, Image.LANCZOS)
    im.save(f'{OUT}/{name}.webp', 'WEBP', quality=86, method=6)
    print(name, im.size)


# 1. Plaster death mask -> hollow-eyed face (Whisperer, Hollow Man, Lantern, jumpscares)
m = load('death_mask')
h, w = m.shape[:2]
a = oval(h, w, 410, 520, 350, 510, 0.3) * (0.5 + 0.5 * sstep(0.08, 0.35, lum(m)))
rgb = grade(m, tint=(0.88, 0.94, 0.92), sat=0.0, contrast=1.25)
rgb = grime(rgb, 0.25, 3)
for cx, cy, rx, ry in [(268, 512, 92, 55), (552, 515, 88, 50)]:
    paint_eye(rgb, a, cx, cy, rx, ry, glint=False)
save('mask', rgb, a, (40, 0, 767, 1023), (512, 720))

# 2. Baby doll -> Little Wren's face, eyes blacked out
d = load('baby_doll')
h, w = d.shape[:2]
a = oval(h, w, 510, 400, 360, 390, 0.5)
rgb = grade(d, tint=(0.85, 0.9, 0.92), sat=0.15, contrast=1.3, gamma=1.25)
rgb = grime(rgb, 0.3, 5)
for cx, cy, rx, ry in [(345, 332, 70, 52), (645, 347, 68, 52)]:
    paint_eye(rgb, a, cx, cy, rx, ry)
# a hairline crack down from the right eye
cx, cy = 655.0, 392.0
cr = np.random.default_rng(3)
for _ in range(260):
    cx += cr.normal(0.25, 0.9); cy += abs(cr.normal(0.9, 0.5))
    rgb[int(cy), int(cx)] *= 0.3
save('doll_wren', rgb, a, (150, 0, 870, 678), (512, 512))

# 3. Half-lit porcelain doll -> the Mimic. One eye in shadow, one gone black.
p = load('dark_doll')
h, w = p.shape[:2]
a = oval(h, w, 420, 420, 330, 520, 0.35) * sstep(0.04, 0.3, lum(p))
rgb = grade(p, tint=(0.92, 0.9, 0.86), sat=0.25, contrast=1.2)
rgb = grime(rgb, 0.2, 9)
paint_eye(rgb, a, 422, 212, 92, 58)
save('doll_mimic', rgb, a, (120, 0, 683, 980), (480, 840))

# 4. Crouching mourning statue -> the Weeping Widow's body
s = load('mourning')
h, w = s.shape[:2]
L = lum(s)
red = s[..., 0] - (s[..., 1] + s[..., 2]) / 2  # background is warm brown; the stone is grey
a = sstep(0.3, 0.48, L) * (1 - sstep(0.05, 0.14, red)) * (1 - sstep(470, 495, np.mgrid[0:h, 0:w][0]))
a = np.asarray(Image.fromarray((a * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))).astype(np.float32) / 255
rgb = grade(s, tint=(0.84, 0.9, 0.9), sat=0.0, contrast=1.2, gamma=1.05)
rgb = grime(rgb, 0.3, 11)
save('weeper', rgb, a, (40, 130, 343, 499), (420, 520))

# 5. Carved stone face -> the Drowned. Milky eyes, mouth open, wet and green.
f = load('stone')
h, w = f.shape[:2]
k = w / 960.0  # coordinates below were measured on a 960 px wide copy
a = oval(h, w, 490 * k, 300 * k, 235 * k, 330 * k, 0.3)
rgb = grade(f, tint=(0.72, 0.9, 0.86), sat=0.35, contrast=1.25, gamma=1.1)
rgb = grime(rgb, 0.35, 13)
for cx, cy in [(368, 197), (581, 197)]:
    # cataract-white, with a pinprick of pupil
    m = oval(h, w, cx * k, cy * k, 44 * k, 22 * k, 0.5)[..., None]
    rgb[:] = rgb * (1 - m * 0.85) + np.array([0.82, 0.86, 0.84]) * m * 0.85
    pdot = oval(h, w, cx * k, cy * k, 5 * k, 5 * k, 0.6)[..., None]
    rgb[:] = rgb * (1 - pdot * 0.7)
mo = oval(h, w, 480 * k, 395 * k, 52 * k, 46 * k, 0.4)[..., None]
rgb[:] = rgb * (1 - mo) + np.array([0.0, 0.015, 0.012]) * mo
# dark water running from the mouth and eyes: soft, uneven, fading
wet = np.zeros((h, w), np.float32)
wr = np.random.default_rng(5)
for sx, sy, n, L in [(470, 425, 5, 240), (368, 212, 2, 200), (581, 212, 2, 170)]:
    for _ in range(n):
        x, y = (sx + wr.normal(0, 14)) * k, sy * k
        width = wr.uniform(1.5, 4.5) * k
        y0 = y
        while y < h - 2 and y < y0 + L * k * wr.uniform(0.6, 1.1):
            x += wr.normal(0, 0.5) * k
            y += 1
            fade = 1 - (y - y0) / (L * k)
            r0 = max(1, int(width * (0.6 + 0.4 * fade)))
            wet[int(y), max(0, int(x) - r0):int(x) + r0] = np.maximum(wet[int(y), max(0, int(x) - r0):int(x) + r0], fade * wr.uniform(0.5, 0.8))
wet = np.asarray(Image.fromarray((wet * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2.2 * k))).astype(np.float32) / 255
rgb[:] = rgb * (1 - wet[..., None] * 0.8)
# a wet sheen alongside each run
sheen = np.roll(wet, int(3 * k), axis=1) - wet
rgb[:] = np.clip(rgb + np.clip(sheen, 0, 1)[..., None] * 0.18, 0, 1)
save('stone_drowned', rgb, a, (int(240 * k), int(0 * k), int(740 * k), int(620 * k)), (420, 540))

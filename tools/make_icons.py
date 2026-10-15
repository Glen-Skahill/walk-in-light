#!/usr/bin/env python3
"""Generate the Walk in Light app icons (pure python, no PIL).

A midnight-blue rounded square, a soft electric-blue glow, and a clean cross.
Run: python3 tools/make_icons.py
"""
import struct, zlib, os, math

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def render(size):
    bg0 = (11, 18, 32); bg1 = (20, 36, 72)
    blue = (59, 130, 246); ice = (147, 197, 253); white = (240, 246, 255)
    cx = cy = size / 2
    arm = size * 0.095     # half width of the cross bars
    v_top, v_bot = size * 0.17, size * 0.84
    h_half = size * 0.26
    h_y = size * 0.40
    radius = size * 0.22
    px = bytearray()
    def dist_rect(x, y, x0, y0, x1, y1):
        dx = max(x0 - x, 0, x - x1); dy = max(y0 - y, 0, y - y1)
        return math.hypot(dx, dy)
    for y in range(size):
        px.append(0)
        for x in range(size):
            # rounded-square mask
            qx = abs(x - cx) - (cx - radius); qy = abs(y - cy) - (cy - radius)
            outside = math.hypot(max(qx, 0), max(qy, 0)) - radius
            if outside > 0.5:
                px.extend((0, 0, 0)); continue
            t = (y / size) * 0.7 + (x / size) * 0.3
            c = lerp(bg0, bg1, t)
            # glow from cross distance
            d = min(dist_rect(x, y, cx - arm, v_top, cx + arm, v_bot), dist_rect(x, y, cx - h_half, h_y - arm, cx + h_half, h_y + arm))
            g = math.exp(-(d / (size * 0.11)) ** 2)
            c = lerp(c, blue, g * 0.75)
            # cross body with 1px antialias
            if d <= 0: c = lerp(white, ice, (y - v_top) / (v_bot - v_top) * 0.6)
            elif d < 1.2: c = lerp(c, white, 1 - d / 1.2)
            px.extend(c)
    return bytes(px)

def png(size, path):
    raw = render(size)
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    outdir = os.path.join(here, '..', 'icons'); os.makedirs(outdir, exist_ok=True)
    for name, size in (('icon-192.png', 192), ('icon-512.png', 512), ('apple-touch-icon.png', 180), ('favicon-32.png', 32)):
        png(size, os.path.join(outdir, name)); print('wrote', name)

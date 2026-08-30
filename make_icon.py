#!/usr/bin/env python3
"""產生 PNG 圖示，圖案與 favicon.svg 一致：雨滴＋中心點。

    apple-touch-icon.png  180  iOS 加入主畫面
    icon-192.png          192  web app manifest
    icon-512.png          512  web app manifest（Android 安裝與啟動畫面）

macOS 上沒有 Pillow 也沒有 SVG 轉檔工具，所以用 stdlib 自己畫。
形狀＝圓形與「由頂點拉出的切線錐」的聯集，3×3 超取樣做去鋸齒。

    python3 make_icon.py
"""

import math
import struct
import zlib

SS = 3  # 超取樣倍率

BG_TOP = (0x16, 0x21, 0x2C)
BG_BOTTOM = (0x0D, 0x13, 0x19)
DROP_TOP = (0x6F, 0xC0, 0xFF)
DROP_BOTTOM = (0x2B, 0x7F, 0xD4)

# 幾何以 180 為基準，其他尺寸等比例縮放
BASE = 180.0
APEX_Y = 26.0
CX, CY, R = 90.0, 116.0, 44.0
DOT_R = 14.0
HALO_R = 21.0

OUTPUTS = [("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)]

# 頂點到圓心的距離與切線半角
_D = CY - APEX_Y
_ALPHA = math.asin(R / _D)
_PROJ_T = math.sqrt(_D * _D - R * R) * math.cos(_ALPHA)  # 切點在軸上的投影
_TAN_A = math.tan(_ALPHA)


def in_drop(x, y):
    if (x - CX) ** 2 + (y - CY) ** 2 <= R * R:
        return True
    proj = y - APEX_Y  # 軸為鉛直向下
    if proj < 0 or proj > _PROJ_T:
        return False
    return abs(x - CX) <= proj * _TAN_A


def lerp(a, b, t):
    return tuple(round(p + (q - p) * t) for p, q in zip(a, b))


def blend(base, over, alpha):
    return tuple(round(b + (o - b) * alpha) for b, o in zip(base, over))


def sample(x, y):
    """回傳單一取樣點的顏色（座標為 180 基準）。"""
    colour = lerp(BG_TOP, BG_BOTTOM, y / BASE)
    if in_drop(x, y):
        t = min(1.0, max(0.0, (y - APEX_Y) / (CY + R - APEX_Y)))
        colour = lerp(DROP_TOP, DROP_BOTTOM, t)
        d2 = (x - CX) ** 2 + (y - CY) ** 2
        if d2 <= HALO_R * HALO_R:
            colour = blend(colour, (255, 255, 255), 0.22)
        if d2 <= DOT_R * DOT_R:
            colour = (255, 255, 255)
    return colour


def render(size):
    rows = []
    unit = BASE / size          # 一個輸出像素等於幾個基準單位
    step = unit / SS
    offset = step / 2
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = 0
            for sy in range(SS):
                y = py * unit + offset + sy * step
                for sx in range(SS):
                    c = sample(px * unit + offset + sx * step, y)
                    r += c[0]
                    g += c[1]
                    b += c[2]
            n = SS * SS
            row += bytes((r // n, g // n, b // n))
        rows.append(row)
    return rows


def write_png(path, size, rows):
    raw = b''.join(b'\x00' + bytes(row) for row in rows)  # filter type 0

    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body))

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


if __name__ == '__main__':
    for name, size in OUTPUTS:
        write_png(name, size, render(size))
        print(f'wrote {name} ({size}×{size})')

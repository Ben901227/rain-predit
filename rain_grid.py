#!/usr/bin/env python3
"""把 CWA 定量降水預報圖解析成「雨量等級網格」，供網頁查詢指定點位的雨量。

瀏覽器不能讀 CWA 圖的像素（那些圖沒有 CORS 標頭，畫進 canvas 會 taint），
所以改由 GitHub Actions 定時執行本程式，把結果與網站一起部署成同源檔案。

輸出 rain/<kind>_<hour>.json，內容是整張圖框的等級陣列（RLE 壓縮）：

    0        < 0.5 毫米
    1..17    對應色階的 17 個區間，見 BINS
    255      無資料（被色階、署徽、離島放大框等圖上元素遮住）

全解析度、每張 gzip 後約 13 KB。

    python3 rain_grid.py [輸出目錄]     # 預設 rain/
"""

import json
import os
import subprocess
import sys
import time

from calibrate import EXCLUDE, decode_png

# 主圖框內緣，與 qpf.js 的 FRAME 一致
X0, Y0, X1, Y1 = 13, 152, 1230, 1488

BACKGROUND = (237, 249, 254)  # 圖面底色＝未達 0.5 毫米

# 色階由小到大，顏色取自圖上色條中線；區間上界對應 CWA 的分級
BINS = [
    (0.5, 1, (194, 194, 194)),
    (1, 2, (156, 252, 255)),
    (2, 5, (3, 200, 255)),
    (5, 10, (5, 155, 255)),
    (10, 15, (3, 99, 255)),
    (15, 20, (5, 153, 2)),
    (20, 30, (57, 255, 3)),
    (30, 40, (255, 251, 3)),
    (40, 50, (255, 200, 0)),
    (50, 70, (255, 149, 0)),
    (70, 90, (255, 0, 0)),
    (90, 110, (204, 0, 0)),
    (110, 130, (153, 0, 0)),
    (130, 150, (150, 0, 153)),
    (150, 200, (201, 0, 204)),
    (200, 300, (251, 0, 255)),
    (300, None, (253, 201, 255)),
]

FRAMES = [(6, h) for h in (6, 12, 18, 24, 30, 36, 42, 48)] + \
         [(12, h) for h in (12, 24, 36, 48)]

UNKNOWN = 255   # 最終的無資料
UNFILLED = 254  # 待補（county 界線、海岸線等細線）

URL = "https://www.cwa.gov.tw/Data/fcst_img/QPF_ChFcstPrecip_{kind}_{hour:02d}.png"


def cache_bust(now=None):
    """與網頁端 cacheBustToken 相同的規則，確保拿到的是最新的圖而非 CDN 舊物件。"""
    t = time.localtime(now)
    return f"{time.strftime('%Y%m%d%H', t)}-{t.tm_min // 10}"


def fetch(url, path):
    """用 curl 而非 urllib：某些環境的 Python SSL 對這個憑證鏈會驗證失敗。
    回傳 CWA 標示的 Last-Modified，也就是這次預報的發布時間。"""
    out = subprocess.run(
        ["curl", "-sS", "--fail", "--max-time", "60", "-D", "-", "-o", path, url],
        capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        if line.lower().startswith("last-modified:"):
            return line.split(":", 1)[1].strip()
    return None


def classify(w, h, nch, px):
    """把每個像素分成等級 0..17、UNFILLED（細線）或 UNKNOWN（圖上元素遮住）。"""
    index = {c: i + 1 for i, (_, _, c) in enumerate(BINS)}
    index[BACKGROUND] = 0

    gw, gh = X1 - X0, Y1 - Y0
    grid = bytearray(gw * gh)
    masked = [(max(x0 - X0, 0), max(y0 - Y0, 0), x1 - X0, y1 - Y0)
              for x0, y0, x1, y1 in EXCLUDE]

    for gy in range(gh):
        row = (Y0 + gy) * w
        out = gy * gw
        for gx in range(gw):
            i = (row + X0 + gx) * nch
            grid[out + gx] = index.get((px[i], px[i + 1], px[i + 2]), UNFILLED)

    for mx0, my0, mx1, my1 in masked:
        for gy in range(max(my0, 0), min(my1, gh)):
            out = gy * gw
            for gx in range(max(mx0, 0), min(mx1, gw)):
                grid[out + gx] = UNKNOWN
    return gw, gh, grid


def fill_lines(gw, gh, grid, radius=2):
    """縣市界與海岸線是畫在色塊上的細線，用鄰近像素的多數決補回來。

    包含 0（無雨）一起投票，所以乾燥區裡的線不會被補成有雨。
    """
    todo = [i for i, v in enumerate(grid) if v == UNFILLED]
    for i in todo:
        gx, gy = i % gw, i // gw
        tally = {}
        for dy in range(-radius, radius + 1):
            y = gy + dy
            if not 0 <= y < gh:
                continue
            base = y * gw
            for dx in range(-radius, radius + 1):
                x = gx + dx
                if not 0 <= x < gw:
                    continue
                v = grid[base + x]
                if v <= len(BINS):
                    tally[v] = tally.get(v, 0) + 1
        grid[i] = max(tally, key=tally.get) if tally else UNKNOWN
    return len(todo)


def rle(grid):
    out = []
    cur, n = grid[0], 0
    for v in grid:
        if v == cur and n < 0xFFFFFF:
            n += 1
        else:
            out.append(cur)
            out.append(n)
            cur, n = v, 1
    out.append(cur)
    out.append(n)
    return out


def build(kind, hour, outdir, tmp):
    url = URL.format(kind=kind, hour=hour) + "?T=" + cache_bust()
    png = os.path.join(tmp, f"{kind}_{hour:02d}.png")
    issued = fetch(url, png)
    w, h, nch, px = decode_png(png)
    gw, gh, grid = classify(w, h, nch, px)
    filled = fill_lines(gw, gh, grid)
    payload = {
        "x0": X0, "y0": Y0, "w": gw, "h": gh,
        # generated 是網格的產生時間，網頁顯示這個。
        # issued 只留作除錯：CWA 的 Last-Modified 與圖上標示的「發布時間」不一致
        # （例如檔案 22:57 寫入、圖上卻標 23:30），拿來對使用者說明只會互相打架。
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "issued": issued,
        "rle": rle(grid),
    }
    path = os.path.join(outdir, f"{kind}_{hour:02d}.json")
    with open(path, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    return path, filled, os.path.getsize(path)


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else "rain"
    tmp = os.path.join(outdir, ".png")
    os.makedirs(tmp, exist_ok=True)
    total = 0
    for kind, hour in FRAMES:
        t = time.time()
        path, filled, size = build(kind, hour, outdir, tmp)
        total += size
        print(f"{path}  {size/1024:6.0f} KB  補了 {filled} 個線條像素  {time.time()-t:.1f}s",
              flush=True)
    for name in os.listdir(tmp):
        os.remove(os.path.join(tmp, name))
    os.rmdir(tmp)
    print(f"共 {total/1024:.0f} KB（未壓縮）")


if __name__ == "__main__":
    main()

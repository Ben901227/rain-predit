#!/usr/bin/env python3
"""一次性校正：擬合 CWA QPF 圖的經緯度↔像素轉換。

只用 stdlib。輸出最佳參數、殘差統計，以及一張把海岸線疊在原圖上的 PNG 供目視確認。

data/ 不進版控，重跑前先取得輸入：

  mkdir -p data
  curl -o data/twCounty.geo.json \
    https://raw.githubusercontent.com/g0v/twgeojson/master/json/twCounty2010.geo.json
  curl -o data/QPF_ChFcstPrecip_12_12.png \
    https://www.cwa.gov.tw/Data/fcst_img/QPF_ChFcstPrecip_12_12.png
  python3 calibrate.py data/QPF_ChFcstPrecip_12_12.png
"""
import json
import math
import struct
import sys
import zlib

# 從黑色遮罩中排除的區域（左上離島放大框、標題文字、色階、署徽、單位文字、外框）
EXCLUDE = [
    (0, 0, 1245, 162),        # 標題與發布/有效時間
    (0, 1472, 1245, 1500),    # 下外框
    (0, 0, 22, 1500),         # 左外框
    (1222, 0, 1245, 1500),    # 右外框
    (55, 178, 360, 525),      # 金門/馬祖放大框
    (1095, 650, 1245, 1440),  # 色階
    (0, 1180, 325, 1420),     # 中央氣象署署徽
    (730, 1325, 1110, 1405),  # 「（單位：毫米）」
]

# 目視驗收用的地標
LANDMARKS = {
    "龍洞": (25.1100179, 121.9202884),
    "鵝鑾鼻": (21.8975, 120.8517),
    "富貴角": (25.2977, 121.5375),
    "三貂角": (25.0075, 121.9967),
    "蘭嶼": (22.0417, 121.5375),
    "日月潭": (23.8500, 120.9150),
}


def decode_png(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    i, idat = 8, []
    while i < len(data):
        ln = struct.unpack(">I", data[i:i + 4])[0]
        typ = data[i + 4:i + 8]
        chunk = data[i + 8:i + 8 + ln]
        if typ == b"IHDR":
            w, h, bit_depth, color_type = struct.unpack(">IIBB", chunk[:10])
            assert bit_depth == 8, "only 8-bit PNGs supported"
        elif typ == b"IDAT":
            idat.append(chunk)
        elif typ == b"IEND":
            break
        i += 8 + ln + 4
    raw = zlib.decompress(b"".join(idat))
    nch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
    stride = w * nch
    out = bytearray(h * stride)
    prev = bytearray(stride)
    pos = 0
    for y in range(h):
        filt = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        if filt == 1:
            for x in range(nch, stride):
                line[x] = (line[x] + line[x - nch]) & 255
        elif filt == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif filt == 3:
            for x in range(stride):
                a = line[x - nch] if x >= nch else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif filt == 4:
            for x in range(stride):
                a = line[x - nch] if x >= nch else 0
                c = prev[x - nch] if x >= nch else 0
                b = prev[x]
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pred) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, nch, bytes(out)


def encode_png(w, h, rgb):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += rgb[y * w * 3:(y + 1) * w * 3]
    def chunk(typ, payload):
        return (struct.pack(">I", len(payload)) + typ + payload
                + struct.pack(">I", zlib.crc32(typ + payload) & 0xFFFFFFFF))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
            + chunk(b"IEND", b""))


def black_mask(w, h, nch, px, threshold=90):
    mask = bytearray(w * h)
    for y in range(h):
        row = y * w
        for x in range(w):
            o = (row + x) * nch
            if px[o] < threshold and px[o + 1] < threshold and px[o + 2] < threshold:
                mask[row + x] = 1
    for x0, y0, x1, y1 in EXCLUDE:
        for y in range(max(0, y0), min(h, y1)):
            row = y * w
            for x in range(max(0, x0), min(w, x1)):
                mask[row + x] = 0
    return mask


def distance_transform(mask, w, h):
    """Chamfer 3-4 兩遍掃描，回傳每個像素到最近黑點的近似歐氏距離。"""
    INF = 1 << 20
    dt = [0 if m else INF for m in mask]
    for y in range(h):
        row = y * w
        prow = row - w
        for x in range(w):
            i = row + x
            d = dt[i]
            if d == 0:
                continue
            if y > 0:
                if dt[prow + x] + 3 < d:
                    d = dt[prow + x] + 3
                if x > 0 and dt[prow + x - 1] + 4 < d:
                    d = dt[prow + x - 1] + 4
                if x + 1 < w and dt[prow + x + 1] + 4 < d:
                    d = dt[prow + x + 1] + 4
            if x > 0 and dt[i - 1] + 3 < d:
                d = dt[i - 1] + 3
            dt[i] = d
    for y in range(h - 1, -1, -1):
        row = y * w
        nrow = row + w
        for x in range(w - 1, -1, -1):
            i = row + x
            d = dt[i]
            if d == 0:
                continue
            if y + 1 < h:
                if dt[nrow + x] + 3 < d:
                    d = dt[nrow + x] + 3
                if x > 0 and dt[nrow + x - 1] + 4 < d:
                    d = dt[nrow + x - 1] + 4
                if x + 1 < w and dt[nrow + x + 1] + 4 < d:
                    d = dt[nrow + x + 1] + 4
            if x + 1 < w and dt[i + 1] + 3 < d:
                d = dt[i + 1] + 3
            dt[i] = d
    return [d / 3.0 for d in dt]


def load_boundary_points(path, step=3):
    """回傳圖上有原位繪製的縣市界／海岸線點。金門連江在放大框內，排除。"""
    doc = json.load(open(path))
    pts = []
    for feat in doc["features"]:
        name = feat["properties"].get("name", "")
        if name in ("金門縣", "連江縣"):
            continue
        geom = feat["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for poly in polys:
            for ring in poly:
                for lon, lat in ring[::step]:
                    if 119.2 <= lon <= 122.1 and 21.7 <= lat <= 25.4:
                        pts.append((lon, lat))
    return pts


def make_project(model):
    if model == "mercator":
        def fwd(lat):
            return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    else:
        def fwd(lat):
            return lat
    def project(params, lon, lat):
        x0, sx, y0, sy = params
        return (x0 + lon * sx, y0 - fwd(lat) * sy)
    return project


def cost(params, project, pts, dt, w, h, clamp=25.0):
    total = 0.0
    for lon, lat in pts:
        x, y = project(params, lon, lat)
        xi, yi = int(x), int(y)
        if 0 <= xi < w and 0 <= yi < h:
            d = dt[yi * w + xi]
            total += d if d < clamp else clamp
        else:
            total += clamp
    return total / len(pts)


def nelder_mead(fn, start, steps, iters=400):
    n = len(start)
    simplex = [list(start)]
    for i in range(n):
        p = list(start)
        p[i] += steps[i]
        simplex.append(p)
    scores = [fn(p) for p in simplex]
    for _ in range(iters):
        order = sorted(range(n + 1), key=lambda i: scores[i])
        simplex = [simplex[i] for i in order]
        scores = [scores[i] for i in order]
        if scores[-1] - scores[0] < 1e-7:
            break
        centroid = [sum(p[i] for p in simplex[:-1]) / n for i in range(n)]
        refl = [centroid[i] + (centroid[i] - simplex[-1][i]) for i in range(n)]
        fr = fn(refl)
        if fr < scores[0]:
            exp = [centroid[i] + 2 * (centroid[i] - simplex[-1][i]) for i in range(n)]
            fe = fn(exp)
            simplex[-1], scores[-1] = (exp, fe) if fe < fr else (refl, fr)
        elif fr < scores[-2]:
            simplex[-1], scores[-1] = refl, fr
        else:
            con = [centroid[i] + 0.5 * (simplex[-1][i] - centroid[i]) for i in range(n)]
            fc = fn(con)
            if fc < scores[-1]:
                simplex[-1], scores[-1] = con, fc
            else:
                for i in range(1, n + 1):
                    simplex[i] = [simplex[0][j] + 0.5 * (simplex[i][j] - simplex[0][j])
                                  for j in range(n)]
                    scores[i] = fn(simplex[i])
    best = min(range(n + 1), key=lambda i: scores[i])
    return simplex[best], scores[best]


def largest_component_bbox(mask, w, h):
    """最大的黑色連通區塊 = 台灣本島海岸線加縣市界。"""
    import collections
    seen = bytearray(w * h)
    best = None
    for sy in range(h):
        for sx in range(w):
            i = sy * w + sx
            if not mask[i] or seen[i]:
                continue
            q = collections.deque([(sx, sy)])
            seen[i] = 1
            n = 0
            mnx = mxx = sx
            mny = mxy = sy
            while q:
                x, y = q.popleft()
                n += 1
                mnx = min(mnx, x); mxx = max(mxx, x)
                mny = min(mny, y); mxy = max(mxy, y)
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < w and 0 <= ny < h:
                            j = ny * w + nx
                            if mask[j] and not seen[j]:
                                seen[j] = 1
                                q.append((nx, ny))
            if best is None or n > best[0]:
                best = (n, mnx, mxx, mny, mxy)
    return best


def seed_params(model, pts, mask, w, h):
    """把最大黑色區塊的外框對齊本島經緯度外框，得到初始參數。"""
    fwd = (lambda v: math.log(math.tan(math.pi / 4 + math.radians(v) / 2))) \
        if model == "mercator" else (lambda v: v)
    n, mnx, mxx, mny, mxy = largest_component_bbox(mask, w, h)
    main = [(lon, lat) for lon, lat in pts if lon >= 119.9]
    lon_lo = min(p[0] for p in main); lon_hi = max(p[0] for p in main)
    lat_lo = min(p[1] for p in main); lat_hi = max(p[1] for p in main)
    sx = (mxx - mnx) / (lon_hi - lon_lo)
    sy = (mxy - mny) / (fwd(lat_hi) - fwd(lat_lo))
    return [mnx - lon_lo * sx, sx, mny + fwd(lat_hi) * sy, sy]


def fit(model, pts, mask, dt, w, h):
    project = make_project(model)
    seed = seed_params(model, pts, mask, w, h)
    params, score = nelder_mead(
        lambda p: cost(p, project, pts[::4], dt, w, h),
        seed, [20, 5, 20, 5], iters=800)
    params, score = nelder_mead(
        lambda p: cost(p, project, pts, dt, w, h, clamp=12.0),
        params, [4, 1.0, 4, 1.0], iters=800)
    return project, params, score


def residuals(project, params, pts, dt, w, h):
    ds = []
    for lon, lat in pts:
        x, y = project(params, lon, lat)
        xi, yi = int(x), int(y)
        ds.append(dt[yi * w + xi] if (0 <= xi < w and 0 <= yi < h) else 999.0)
    ds.sort()
    return {
        "mean": sum(ds) / len(ds),
        "median": ds[len(ds) // 2],
        "p90": ds[int(len(ds) * 0.9)],
        "max": ds[-1],
        "n": len(ds),
    }


def write_overlay(path, w, h, nch, px, project, params, pts):
    rgb = bytearray(w * h * 3)
    for i in range(w * h):
        o = i * nch
        rgb[i * 3:i * 3 + 3] = px[o:o + 3]
    for lon, lat in pts:
        x, y = project(params, lon, lat)
        xi, yi = int(x), int(y)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                nx, ny = xi + dx, yi + dy
                if 0 <= nx < w and 0 <= ny < h:
                    o = (ny * w + nx) * 3
                    rgb[o] = 255
                    rgb[o + 1] = 0
                    rgb[o + 2] = 255
    for name, (lat, lon) in LANDMARKS.items():
        x, y = project(params, lon, lat)
        xi, yi = int(x), int(y)
        for d in range(-14, 15):
            for nx, ny in ((xi + d, yi), (xi, yi + d)):
                if 0 <= nx < w and 0 <= ny < h:
                    o = (ny * w + nx) * 3
                    rgb[o], rgb[o + 1], rgb[o + 2] = 0, 0, 0
    open(path, "wb").write(encode_png(w, h, bytes(rgb)))


def main():
    img = sys.argv[1] if len(sys.argv) > 1 else "data/QPF_ChFcstPrecip_12_12.png"
    print("decoding", img)
    w, h, nch, px = decode_png(img)
    mask = black_mask(w, h, nch, px)
    print("black pixels:", sum(mask))
    print("distance transform...")
    dt = distance_transform(mask, w, h)
    pts = load_boundary_points("data/twCounty.geo.json")
    print("boundary points:", len(pts))

    results = {}
    for model in ("platecarree", "mercator"):
        print("fitting", model, "...")
        project, params, score = fit(model, pts, mask, dt, w, h)
        res = residuals(project, params, pts, dt, w, h)
        results[model] = (project, params, score, res)
        print("  params:", [round(v, 4) for v in params])
        print("  residuals:", {k: round(v, 3) if isinstance(v, float) else v
                               for k, v in res.items()})

    model = min(results, key=lambda m: results[m][3]["median"])
    project, params, score, res = results[model]
    print("\nbest model:", model)
    print("params x0=%.4f sx=%.4f y0=%.4f sy=%.4f" % tuple(params))
    for name, (lat, lon) in LANDMARKS.items():
        x, y = project(params, lon, lat)
        print("  %-6s -> px (%.1f, %.1f)" % (name, x, y))

    out = "data/overlay_%s.png" % model
    write_overlay(out, w, h, nch, px, project, params, pts)
    print("overlay written to", out)


if __name__ == "__main__":
    main()

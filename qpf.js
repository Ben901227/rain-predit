// CWA 定量降水預報圖的純函式：投影、圖片網址、地點解析。無 DOM 依賴。

export const IMG_W = 1245;
export const IMG_H = 1500;

// 由 calibrate.py 以 55490 個海岸線／縣市界點擬合（等距圓柱投影）。
// 殘差：中位數 1.0 px、平均 2.4 px。6 小時圖與 12 小時圖的參數差異 < 1.3 px，取兩者平均。
const PROJ = {
  xAtLonZero: -42048.0928,
  pxPerDegLon: 353.6192,
  yAtLatZero: 9274.6249,
  pxPerDegLat: 358.5696,
};

// 圖框內緣。左上角雖有金門／馬祖放大框，但兩者的真實座標本來就在圖幅外。
export const FRAME = { x0: 13, y0: 152, x1: 1230, y1: 1488 };

// 從原圖裁出的區塊（實測 ink 邊界）。
export const CROP_LEGEND = { x0: 1075, y0: 685, x1: 1200, y1: 1422 };
export const CROP_TIMESTAMP = { x0: 45, y0: 52, x1: 890, y1: 150 };

export const PX_PER_DEG_LON = PROJ.pxPerDegLon;

export function lonLatToPixel(lon, lat) {
  return {
    x: PROJ.xAtLonZero + lon * PROJ.pxPerDegLon,
    y: PROJ.yAtLatZero - lat * PROJ.pxPerDegLat,
  };
}

export function pixelToLonLat(x, y) {
  return {
    lon: (x - PROJ.xAtLonZero) / PROJ.pxPerDegLon,
    lat: (PROJ.yAtLatZero - y) / PROJ.pxPerDegLat,
  };
}

export function isInRange(lon, lat) {
  const { x, y } = lonLatToPixel(lon, lat);
  return x >= FRAME.x0 && x <= FRAME.x1 && y >= FRAME.y0 && y <= FRAME.y1;
}

export const FRAMES = [
  { kind: 6, hours: [6, 12, 18, 24, 30, 36, 42, 48] },
  { kind: 12, hours: [12, 24, 36, 48] },
];

/** 與 CWA 官網 GetDataTime('M') 相同：每 10 分鐘換一次快取鍵。 */
export function cacheBustToken(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `${p(date.getHours())}-${Math.floor(date.getMinutes() / 10)}`;
}

export function frameUrl(kind, hour, token) {
  const h = String(hour).padStart(2, '0');
  return `https://www.cwa.gov.tw/Data/fcst_img/QPF_ChFcstPrecip_${kind}_${h}.png?T=${token}`;
}

const SHORT_LINK = /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//i;

function valid(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function placeName(text) {
  const m = text.match(/\/place\/([^/@?]+)/);
  if (!m) return null;
  try {
    const name = decodeURIComponent(m[1]).replace(/\+/g, ' ').trim();
    return name && !/^[\d.,\s-]+$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

/**
 * 解析使用者輸入的內容。
 * 回傳 {lat, lon, label} | {needsExpand: url} | {query: text} | null
 */
export function parseLocation(input) {
  const text = (input || '').trim();
  if (!text) return null;

  if (SHORT_LINK.test(text)) return { needsExpand: text };

  const isUrl = /https?:\/\//i.test(text);
  const label = placeName(text);

  // Google Maps 的 !3d<lat>!4d<lon> 是地點本身的座標，比視野中心 @ 更準確。
  let m = text.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (!m) m = text.match(/[?&](?:q|ll|daddr|destination)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (!m) m = text.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (!m && !isUrl) {
    m = text.match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  }
  // 抓不到座標的網址是壞掉的網址，不是地名，不該拿去搜尋
  if (!m) return isUrl ? null : { query: text };

  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (!valid(lat, lon)) return null;
  return { lat, lon, label };
}

const GEOCODE_ENDPOINT = 'https://nominatim.openstreetmap.org/search';

export function geocodeUrl(query) {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    countrycodes: 'tw',
    limit: '8',
    'accept-language': 'zh-TW',
  });
  return `${GEOCODE_ENDPOINT}?${params}`;
}

/** 把 Nominatim jsonv2 的回應整理成 {lat, lon, label, detail}。 */
export function parseGeocodeResults(json) {
  if (!Array.isArray(json)) return [];
  return json.flatMap((item) => {
    const lat = parseFloat(item.lat);
    const lon = parseFloat(item.lon);
    if (!valid(lat, lon)) return [];
    const detail = (item.display_name || '').trim();
    const label = (item.name || '').trim() || detail.split(',')[0].trim();
    if (!label) return [];
    return [{ lat, lon, label, detail }];
  });
}

export function formatCoords(lat, lon) {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

/* ---------- 雨量色階 ---------- */

// 色階的 17 個區間，顏色取自圖上色條中線；rain_grid.py 用同一組定義產生網格。
export const RAIN_BINS = [
  { min: 0.5, max: 1, color: '#c2c2c2' },
  { min: 1, max: 2, color: '#9cfcff' },
  { min: 2, max: 5, color: '#03c8ff' },
  { min: 5, max: 10, color: '#059bff' },
  { min: 10, max: 15, color: '#0363ff' },
  { min: 15, max: 20, color: '#059902' },
  { min: 20, max: 30, color: '#39ff03' },
  { min: 30, max: 40, color: '#fffb03' },
  { min: 40, max: 50, color: '#ffc800' },
  { min: 50, max: 70, color: '#ff9500' },
  { min: 70, max: 90, color: '#ff0000' },
  { min: 90, max: 110, color: '#cc0000' },
  { min: 110, max: 130, color: '#990000' },
  { min: 130, max: 150, color: '#960099' },
  { min: 150, max: 200, color: '#c900cc' },
  { min: 200, max: 300, color: '#fb00ff' },
  { min: 300, max: null, color: '#fdc9ff' },
];

export const RAIN_NONE = 0;    // 未達 0.5 毫米
export const RAIN_UNKNOWN = 255; // 被圖上元素遮住，判讀不出來

export function rainUrl(kind, hour) {
  // 不加 cache-bust 參數：網格每小時才更新一次，交給 ETag 重新驗證即可
  return `rain/${kind}_${String(hour).padStart(2, '0')}.json`;
}

/** 把 rain_grid.py 產生的 RLE 展開成可直接查詢的陣列。 */
export function decodeRainGrid(data) {
  const { x0, y0, w, h, rle, generated, issued } = data;
  const levels = new Uint8Array(w * h);
  let at = 0;
  for (let i = 0; i < rle.length; i += 2) {
    const end = at + rle[i + 1];
    levels.fill(rle[i], at, end);
    at = end;
  }
  if (at !== levels.length) throw new Error('雨量網格長度不符');
  return { x0, y0, w, h, generated, issued, levels };
}

/** 回傳該像素的雨量等級；落在網格外回傳 null。 */
export function rainLevelAt(grid, x, y) {
  const gx = Math.round(x) - grid.x0;
  const gy = Math.round(y) - grid.y0;
  if (gx < 0 || gy < 0 || gx >= grid.w || gy >= grid.h) return null;
  return grid.levels[gy * grid.w + gx];
}

export function rainText(level) {
  if (level === null || level === undefined) return null;
  if (level === RAIN_UNKNOWN) return '無法判讀';
  if (level === RAIN_NONE) return '未達 0.5 毫米';
  const bin = RAIN_BINS[level - 1];
  if (!bin) return null;
  return bin.max === null ? '300 毫米以上' : `${bin.min}～${bin.max} 毫米`;
}

export function rainColor(level) {
  const bin = RAIN_BINS[level - 1];
  return bin ? bin.color : null;
}

/* ---------- 最愛地點 ---------- */

export const MAX_FAVOURITES = 5;

// 同一個地方用搜尋和貼 Google Maps 網址取得的座標會差上幾十公尺，
// 不留容差就會存進兩筆看起來一模一樣的最愛。0.0005 度約 55 公尺。
const SAME_SPOT_DEG = 0.0005;

export function sameSpot(a, b) {
  return Math.abs(a.lat - b.lat) < SAME_SPOT_DEG &&
    Math.abs(a.lon - b.lon) < SAME_SPOT_DEG;
}

export function isFavourite(list, target) {
  return list.some((fav) => sameSpot(fav, target));
}

/** 回傳新的清單：已收藏就移除，否則附加到尾端並把超出的最舊幾筆砍掉。 */
export function toggleFavourite(list, target) {
  if (isFavourite(list, target)) {
    return list.filter((fav) => !sameSpot(fav, target));
  }
  return [...list, target].slice(-MAX_FAVOURITES);
}

/** 還原 localStorage 內容時的防禦：丟掉壞掉的項目，最多留 MAX_FAVOURITES 筆。 */
export function parseFavourites(json) {
  if (!Array.isArray(json)) return [];
  return json
    .filter((item) => item && Number.isFinite(item.lat) && Number.isFinite(item.lon))
    .map(({ lat, lon, label }) => ({ lat, lon, label: label || null }))
    .slice(-MAX_FAVOURITES);
}

/* ---------- 預報時段的實際時間 ---------- */

// 預報時段的分界固定在臺灣時間的 02/08/14/20 點，與瀏覽器所在時區無關，
// 所以一律用 UTC+8 的牆上時間計算（臺灣全年沒有日光節約時間）。
const TW_OFFSET_MS = 8 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;

/** 把絕對時間換成臺灣時間的年月日時分。 */
function twParts(ms) {
  const d = new Date(ms + TW_OFFSET_MS);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(),
  };
}

/** 臺灣時間當天 00:00 的絕對時間，用來比較「差幾天」。 */
function twDayStart(ms) {
  return Math.floor((ms + TW_OFFSET_MS) / 86400000) * 86400000 - TW_OFFSET_MS;
}

/**
 * 由發布時間推出預報的基準時刻＝發布之後的下一個 02/08/14/20 界線。
 *
 * CWA 沒有把有效時間放進任何可讀的欄位，只畫在圖片上，所以只能推。
 * 實測三組（2026-08-29 22:57→02:00、08-30 11:36→14:00、10-23 17:41→20:00）
 * 都吻合：檔案一律在基準前約 2.5 小時上架，所以「向後取整」有兩小時以上的餘裕。
 */
export function forecastBase(issuedMs) {
  if (!Number.isFinite(issuedMs)) return null;
  const twHours = (issuedMs + TW_OFFSET_MS) / HOUR_MS;
  let h = Math.ceil(twHours);
  while (((h % 6) + 6) % 6 !== 2) h += 1; // 02/08/14/20 的小時數 mod 6 都是 2
  return h * HOUR_MS - TW_OFFSET_MS;
}

/** 某個時距涵蓋的區間：結束於 base + hour，往前推 kind 小時。 */
export function frameWindow(baseMs, kind, hour) {
  return { start: baseMs + (hour - kind) * HOUR_MS, end: baseMs + hour * HOUR_MS };
}

const DAY_WORDS = { '-1': '昨', 0: '今', 1: '明', 2: '後' };

/** 按鈕上的短標示，例如「明14」＝明天 14 點開始的那一段。 */
export function frameLabel(baseMs, kind, hour, nowMs) {
  if (baseMs === null) return `+${hour}`;
  const { start } = frameWindow(baseMs, kind, hour);
  const days = Math.round((twDayStart(start) - twDayStart(nowMs)) / 86400000);
  const p = twParts(start);
  const prefix = DAY_WORDS[days] ?? `${p.day}日`;
  return `${prefix}${String(p.hour).padStart(2, '0')}`;
}

/** 完整區間文字，給 title 與輔助技術用。 */
export function frameRangeText(baseMs, kind, hour) {
  if (baseMs === null) return `${kind} 小時累積，+${hour} 小時`;
  const { start, end } = frameWindow(baseMs, kind, hour);
  const a = twParts(start);
  const b = twParts(end);
  const hhmm = (p) => `${String(p.hour).padStart(2, '0')}:00`;
  const sameDay = a.year === b.year && a.month === b.month && a.day === b.day;
  const tail = sameDay ? hhmm(b) : `${b.month}/${b.day} ${hhmm(b)}`;
  return `${a.month}/${a.day} ${hhmm(a)} ～ ${tail}`;
}

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

import {
  IMG_W, IMG_H, FRAMES, CROP_LEGEND, CROP_TIMESTAMP, PX_PER_DEG_LON,
  lonLatToPixel, isInRange, cacheBustToken, frameUrl, parseLocation, formatCoords,
  geocodeUrl, parseGeocodeResults,
  rainUrl, decodeRainGrid, rainLevelAt, rainText, rainColor, RAIN_UNKNOWN,
  sameSpot, isFavourite, toggleFavourite, parseFavourites, MAX_FAVOURITES,
  forecastBase, frameLabel, frameRangeText,
} from './qpf.js';

const STORE_KEY = 'rain-predit.location';
const FAV_KEY = 'rain-predit.favorites';
const MAX_SCALE = 8;
const FOCUS_SPAN_DEG = 0.35; // 放大到點位時視野涵蓋的經度跨度

const $ = (sel) => document.querySelector(sel);
const viewport = $('#viewport');
const mapImg = $('#map');
const pin = $('#pin');
const overlayMsg = $('#overlayMsg');
const legendPane = $('#legendPane');
const legendBox = $('#legend');
const timestampBox = $('#timestamp');
const framesNav = $('#frames');
const locForm = $('#locForm');
const locInput = $('#locInput');
const locStatus = $('#locStatus');
const resultList = $('#results');
const clearInput = $('#clearInput');
const rainBox = $('#rain');
const favsBox = $('#favs');

const token = cacheBustToken(new Date());
const state = {
  frame: { kind: 6, hour: 6 },
  target: null,
  view: 'fit', // 'fit' 全台 | 'focus' 放大到點位
  base: null,   // 預報基準時刻，由網格的 issued 推出；推不出來就退回 +N 標示
  issued: null,
  scale: 1,
  tx: 0,
  ty: 0,
};

/* ---------- 從原圖裁出區塊 ---------- */

function applyCrop(container, box, scale) {
  const img = container.querySelector('img');
  container.style.width = `${(box.x1 - box.x0) * scale}px`;
  container.style.height = `${(box.y1 - box.y0) * scale}px`;
  img.style.width = `${IMG_W * scale}px`;
  img.style.left = `${-box.x0 * scale}px`;
  img.style.top = `${-box.y0 * scale}px`;
}

function layoutCrops() {
  const stageH = $('#stage').clientHeight;
  const availW = $('#app').clientWidth - 16;
  // 扣掉「毫米」標籤的高度，否則色階會被 #stage 裁掉底部；
  // 另外限制寬度佔比，色階再高也不該把地圖擠掉
  const legendW = CROP_LEGEND.x1 - CROP_LEGEND.x0;
  const legendScale = Math.min(
    clamp((stageH - 18) / (CROP_LEGEND.y1 - CROP_LEGEND.y0), 0.25, 0.7),
    (availW * 0.18) / legendW,
  );
  applyCrop(legendBox, CROP_LEGEND, legendScale);

  const tsScale = clamp(availW / (CROP_TIMESTAMP.x1 - CROP_TIMESTAMP.x0), 0.2, 0.55);
  applyCrop(timestampBox, CROP_TIMESTAMP, tsScale);
}

/* ---------- 檢視變換 ---------- */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 使用者拖曳或縮放過之後，版面變動只平移視野；否則重新套用預設視野。
// 色階與時間列是圖片載入後才出現的，會縮小 viewport，這時必須重算而不是沿用舊倍率。
let userAdjusted = false;

function minScale() {
  return Math.min(viewport.clientWidth / IMG_W, viewport.clientHeight / IMG_H);
}

function clampPan() {
  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;
  const w = IMG_W * state.scale;
  const h = IMG_H * state.scale;
  state.tx = w > vw ? clamp(state.tx, vw - w, 0) : (vw - w) / 2;
  state.ty = h > vh ? clamp(state.ty, vh - h, 0) : (vh - h) / 2;
}

function render() {
  // 視窗尺寸會變（旋轉、鍵盤、首次載入時尚未版面配置），縮放倍率跟著重新夾一次
  state.scale = clamp(state.scale, minScale(), MAX_SCALE);
  clampPan();
  mapImg.style.transform =
    `translate(${state.tx + swipeDX}px, ${state.ty}px) scale(${state.scale})`;
  renderPin();
}

function renderPin() {
  if (!state.target) {
    pin.hidden = true;
    return;
  }
  const p = lonLatToPixel(state.target.lon, state.target.lat);
  const sx = state.tx + swipeDX + p.x * state.scale;
  const sy = state.ty + p.y * state.scale;
  pin.hidden = false;
  pin.style.transform = `translate(${sx}px, ${sy}px)`;
}

function fitWhole() {
  userAdjusted = false;
  state.view = 'fit';
  state.scale = minScale();
  render();
}

function focusTarget() {
  if (!state.target) return fitWhole();
  userAdjusted = false;
  state.view = 'focus';
  const p = lonLatToPixel(state.target.lon, state.target.lat);
  const wanted = viewport.clientWidth / (FOCUS_SPAN_DEG * PX_PER_DEG_LON);
  state.scale = clamp(wanted, minScale(), MAX_SCALE);
  state.tx = viewport.clientWidth / 2 - p.x * state.scale;
  state.ty = viewport.clientHeight / 2 - p.y * state.scale;
  render();
}

function zoomAbout(factor, cx, cy) {
  userAdjusted = true;
  const next = clamp(state.scale * factor, minScale(), MAX_SCALE);
  const ratio = next / state.scale;
  state.tx = cx - (cx - state.tx) * ratio;
  state.ty = cy - (cy - state.ty) * ratio;
  state.scale = next;
  render();
}

/* ---------- 手勢 ---------- */

const pointers = new Map();
let pinchPrev = null;
let lastTap = 0;
let swipeFrom = null; // 單指按下的起點，用來分辨「滑動切時段」與「拖曳平移」
let swipeDX = 0;      // 滑動過程中讓地圖跟著手指讓開一點，否則放開前毫無回饋

// 跟手但有阻尼：時段之間不是真的水平捲動，1:1 跟著跑會很怪，
// 這裡只讓它「讓開」一小段，讀起來像橡皮筋。
const SWIPE_DAMP = 0.35;
const SWIPE_MAX_OFFSET = 70;

// 整張圖都塞得進視窗時，拖曳不會有任何視覺效果（clampPan 會把它置中），
// 這時水平滑動拿來切換時段才不會跟平移打架。
function mapFitsViewport() {
  return IMG_W * state.scale <= viewport.clientWidth + 1 &&
    IMG_H * state.scale <= viewport.clientHeight + 1;
}

const SWIPE_MIN_PX = 48;   // 要夠長才算滑動，避免把點擊的手震誤判
const SWIPE_RATIO = 1.5;   // 水平位移要明顯多於垂直，才不會把縱向捲動誤判
const SWIPE_MAX_MS = 700;

/** 放開手指後把讓開的位移收回去，用過場而不是瞬間跳回。 */
function settleSwipe() {
  swipeDX = 0;
  mapImg.classList.add('settling');
  pin.classList.add('settling');
  render();
  setTimeout(() => {
    mapImg.classList.remove('settling');
    pin.classList.remove('settling');
  }, 200);
}

/** 在同一排（6 或 12 小時）裡往前後移動一格，到頭就停住。 */
function shiftFrame(delta) {
  const row = FRAMES.find((f) => f.kind === state.frame.kind);
  const i = row.hours.indexOf(state.frame.hour);
  const next = clamp(i + delta, 0, row.hours.length - 1);
  if (next !== i) setFrame(state.frame.kind, row.hours[next]);
}

function viewportPoint(e) {
  const r = viewport.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

viewport.addEventListener('pointerdown', (e) => {
  viewport.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pinchPrev = null;
  swipeFrom = pointers.size === 1 ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
});

viewport.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 1) {
    if (mapFitsViewport()) {
      // 塞得下時平移沒有效果，這段手勢是用來切時段的：讓地圖跟著讓開一點當回饋
      if (swipeFrom) {
        swipeDX = clamp((e.clientX - swipeFrom.x) * SWIPE_DAMP,
          -SWIPE_MAX_OFFSET, SWIPE_MAX_OFFSET);
        render();
      }
      return;
    }
    userAdjusted = true;
    state.tx += e.clientX - prev.x;
    state.ty += e.clientY - prev.y;
    render();
    return;
  }
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const r = viewport.getBoundingClientRect();
    const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
    if (pinchPrev && pinchPrev.dist > 0) {
      zoomAbout(dist / pinchPrev.dist, mid.x, mid.y);
    }
    pinchPrev = { dist, mid };
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  pinchPrev = null;
  if (e.type !== 'pointerup' && swipeDX !== 0) settleSwipe();
  if (pointers.size === 0 && e.type === 'pointerup') {
    const now = Date.now();

    // 未放大時的水平滑動＝切換時段
    if (swipeFrom && mapFitsViewport()) {
      const dx = e.clientX - swipeFrom.x;
      const dy = e.clientY - swipeFrom.y;
      const committed = Math.abs(dx) >= SWIPE_MIN_PX &&
        Math.abs(dx) > Math.abs(dy) * SWIPE_RATIO && now - swipeFrom.t <= SWIPE_MAX_MS;
      if (swipeDX !== 0) settleSwipe();
      if (committed) {
        swipeFrom = null;
        lastTap = 0; // 滑動不該被接著算成雙擊
        shiftFrame(dx < 0 ? 1 : -1); // 往左滑看之後的時段
        return;
      }
    }
    swipeFrom = null;

    if (now - lastTap < 320) {
      state.scale > minScale() * 1.5 ? fitWhole() : focusTarget();
      lastTap = 0;
    } else {
      lastTap = now;
    }
  }
}
viewport.addEventListener('pointerup', endPointer);
viewport.addEventListener('pointercancel', endPointer);

viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = viewportPoint(e);
  zoomAbout(Math.exp(-e.deltaY / 400), p.x, p.y);
}, { passive: false });

/* ---------- 預報時段 ---------- */

function buildFrames() {
  for (const { kind, hours } of FRAMES) {
    const row = document.createElement('div');
    row.className = 'frame-row';
    const tag = document.createElement('span');
    tag.className = 'frame-tag';
    tag.textContent = `${kind}小時`;
    row.append(tag);
    for (const hour of hours) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const label = document.createElement('span');
      label.className = 'when';
      label.textContent = frameLabel(state.base, kind, hour, Date.now());
      const bar = document.createElement('i'); // 該時距在點位上的雨量色階
      bar.className = 'lvl';
      btn.append(label, bar);
      btn.dataset.kind = kind;
      btn.dataset.hour = hour;
      btn.addEventListener('click', () => setFrame(kind, hour));
      row.append(btn);
    }
    framesNav.append(row);
  }
}

/** 基準時刻一確定（或 CWA 換版）就把 12 顆按鈕的時間標示重畫。 */
function relabelFrames() {
  const now = Date.now();
  for (const btn of framesNav.querySelectorAll('button')) {
    const kind = Number(btn.dataset.kind);
    const hour = Number(btn.dataset.hour);
    btn.querySelector('.when').textContent = frameLabel(state.base, kind, hour, now);
    btn.title = `${kind} 小時累積 · ${frameRangeText(state.base, kind, hour)}`;
  }
}

/**
 * 網格裡的 issued 是唯一能推出有效時間的線索，拿到就更新標示。
 * 只採用「更新的」發布時間：12 份網格正常來自同一次執行，但 CWA 若在產生
 * 途中換版就會出現兩種時間，不設限的話標示會隨著看哪一格而跳來跳去。
 */
function noteIssued(grid) {
  if (!grid || !grid.issued) return;
  const at = Date.parse(grid.issued);
  if (!Number.isFinite(at) || (state.base !== null && at <= Date.parse(state.issued))) return;
  state.issued = grid.issued;
  state.base = forecastBase(at);
  relabelFrames();
}

function markActiveFrame() {
  for (const btn of framesNav.querySelectorAll('button')) {
    btn.classList.toggle('active',
      Number(btn.dataset.kind) === state.frame.kind &&
      Number(btn.dataset.hour) === state.frame.hour);
  }
}

const SWIPE_HINT = '在地圖上左右滑動可以切換時段';
const HINT_KEY = 'rain-predit.hint.swipe';
let overlayTimer = null;
let firstFrameShown = false;

function setFrame(kind, hour) {
  state.frame = { kind, hour };
  markActiveFrame();
  updateRain();
  const url = frameUrl(kind, hour, token);

  // 圖在快取裡時幾乎瞬間就好，立刻蓋上「載入中」只會閃一下，反而顯得卡。
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => showOverlay('載入中…'), 160);

  const pre = new Image();
  pre.onload = () => {
    clearTimeout(overlayTimer);
    for (const img of [mapImg, legendBox.querySelector('img'), timestampBox.querySelector('img')]) {
      img.src = url;
    }
    timestampBox.hidden = false;
    legendPane.hidden = false;
    hideOverlay();
    relayout(); // 時間列與色階首次出現會壓縮 #stage
    prefetchNeighbours(kind, hour);
    if (!firstFrameShown) {
      firstFrameShown = true;
      maybeHintSwipe();
    }
  };
  pre.onerror = () => {
    clearTimeout(overlayTimer);
    showOverlay(`${frameLabel(state.base, kind, hour, Date.now())} 的 ${kind} 小時累積圖目前無法取得`,
      () => setFrame(kind, hour));
  };
  pre.src = url;
}

// 連續滑動時每一步都在等圖下載會很頓，先把左右相鄰的時段抓進快取。
const prefetched = new Set();

function prefetchNeighbours(kind, hour) {
  const row = FRAMES.find((f) => f.kind === kind);
  const i = row.hours.indexOf(hour);
  for (const j of [i + 1, i - 1]) {
    if (j < 0 || j >= row.hours.length) continue;
    const url = frameUrl(kind, row.hours[j], token);
    if (prefetched.has(url)) continue;
    prefetched.add(url);
    new Image().src = url;
  }
}

/** 滑動沒有任何外觀提示，第一次進來時講一次就好。 */
function maybeHintSwipe() {
  try {
    if (localStorage.getItem(HINT_KEY)) return;
    localStorage.setItem(HINT_KEY, '1');
  } catch {
    return; // 無痕視窗之類存不了，就不提示，也不要每次都跳
  }
  showOverlay(SWIPE_HINT);
  setTimeout(() => {
    if (overlayMsg.textContent === SWIPE_HINT) hideOverlay();
  }, 4500);
}

function showOverlay(text, onRetry) {
  overlayMsg.textContent = text;
  overlayMsg.hidden = false;
  if (onRetry) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '重試';
    btn.addEventListener('click', onRetry);
    overlayMsg.append(btn);
  }
}

function hideOverlay() {
  overlayMsg.hidden = true;
  overlayMsg.textContent = '';
}

/* ---------- 雨量 ---------- */

// CWA 的圖沒有 CORS，瀏覽器讀不到像素，所以雨量改查 GitHub Actions 預先解析好的網格。
const grids = new Map(); // `${kind}_${hour}` -> Promise<grid>
// 這個門檻是用來發現「管線壞掉」，不是「資料有點舊」。
// 網格只在 CWA 換版時才重新產生，所以它的年齡天生等於 CWA 的發布間隔：
// 實測 2026-10 是每 3 小時（8 月還是 6 小時，CWA 自己會變），加上排程最多
// 30 分鐘的偵測延遲，正常情況可以到 3.5～4 小時。設 5 小時留一點餘裕。
// CWA 若再次改變發布頻率，這個值要跟著調。
const STALE_MS = 5 * 3600 * 1000;

function loadGrid(kind, hour) {
  const key = `${kind}_${hour}`;
  if (!grids.has(key)) {
    grids.set(key, fetch(rainUrl(kind, hour))
      .then((res) => {
        if (!res.ok) throw new Error(res.status);
        return res.json();
      })
      .then(decodeRainGrid)
      .catch((err) => {
        grids.delete(key); // 下次再試
        throw err;
      }));
  }
  return grids.get(key);
}

function levelAtTarget(grid) {
  const p = lonLatToPixel(state.target.lon, state.target.lat);
  return rainLevelAt(grid, p.x, p.y);
}

function showRain(nodes) {
  rainBox.replaceChildren(...nodes);
  rainBox.hidden = nodes.length === 0;
  relayout(); // 這一行會改變 #stage 高度
}

function rainMessage(text, tone) {
  const span = document.createElement('span');
  span.textContent = text;
  if (tone) span.className = tone;
  return [span];
}

let rainSeq = 0;

async function updateRain() {
  const seq = ++rainSeq;
  if (!state.target) return showRain([]);
  const { kind, hour } = state.frame;

  let grid;
  try {
    grid = await loadGrid(kind, hour);
  } catch {
    if (seq === rainSeq) showRain(rainMessage('雨量資料暫時無法取得。', 'error'));
    return;
  }
  if (seq !== rainSeq) return;
  noteIssued(grid);

  const level = levelAtTarget(grid);
  const text = rainText(level);
  if (text === null) return showRain([]); // 點位不在網格範圍內

  const chip = document.createElement('i');
  chip.className = 'chip';
  const colour = rainColor(level);
  if (colour) chip.style.background = colour;
  else chip.classList.add(level === RAIN_UNKNOWN ? 'unknown' : 'none');

  const strong = document.createElement('strong');
  strong.textContent = text;

  const nodes = [chip, document.createTextNode(`${kind} 小時累積 `), strong];
  const at = grid.generated ? new Date(grid.generated) : null;
  if (at && !Number.isNaN(+at)) {
    const note = document.createElement('small');
    const stale = Date.now() - +at > STALE_MS;
    const t = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    note.textContent = stale ? ` · 資料 ${t} 更新，可能較舊` : ` · 資料 ${t} 更新`;
    if (stale) note.className = 'warn';
    nodes.push(note);
  }
  showRain(nodes);
}

/** 在 12 個時距按鈕上標出該點位各時段的雨量色階。 */
function refreshFrameLevels() {
  // 以 target 本身當識別，換點位時舊的回應就會被丟掉
  // （不能用 rainSeq：切換時距也會遞增它，會誤殺這裡的回應）
  const target = state.target;
  for (const btn of framesNav.querySelectorAll('button')) {
    const bar = btn.querySelector('.lvl');
    bar.style.background = '';
    bar.className = 'lvl';
    if (!state.target) continue;
    loadGrid(Number(btn.dataset.kind), Number(btn.dataset.hour))
      .then((grid) => {
        if (state.target !== target || !target) return;
        const level = levelAtTarget(grid);
        const colour = rainColor(level);
        if (colour) bar.style.background = colour;
        else if (level === 0) bar.classList.add('none');
        bar.title = rainText(level) || '';
      })
      .catch(() => {});
  }
}

/* ---------- 地點 ---------- */

function setStatus(text, tone) {
  locStatus.textContent = text;
  locStatus.className = tone || '';
  relayout(); // 訊息換行會改變 #stage 高度
}

function applyTarget(target) {
  if (!isInRange(target.lon, target.lat)) {
    setStatus('這個位置在預報圖範圍之外。', 'error');
    return false;
  }
  state.target = target;
  localStorage.setItem(STORE_KEY, JSON.stringify(target));
  const coords = formatCoords(target.lat, target.lon);
  // 輸入框反映目前的地點，貼進來的長網址不留在框裡
  setInput(target.label || coords);
  setStatus(target.label ? `${target.label} · ${coords}` : coords, '');
  fitWhole(); // 維持全台視野，放大交給雙擊或雙指
  updateRain();
  refreshFrameLevels();
  renderFavs(); // ★ 與 .active 要反映新的目前地點
  return true;
}

function setInput(value) {
  locInput.value = value;
  clearInput.hidden = !value;
}

function clearResults() {
  resultList.replaceChildren();
  resultList.hidden = true;
}

function showResults(places) {
  resultList.replaceChildren(...places.map((place) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    const name = document.createElement('strong');
    name.textContent = place.label;
    const detail = document.createElement('span');
    detail.textContent = place.detail;
    btn.append(name, detail);
    btn.addEventListener('click', () => {
      clearResults();
      applyTarget({ lat: place.lat, lon: place.lon, label: place.label });
    });
    li.append(btn);
    return li;
  }));
  resultList.hidden = false;
  relayout(); // 清單會改變 #stage 高度
}

let searchSeq = 0;

async function runSearch(query) {
  const seq = ++searchSeq;
  clearResults();
  setStatus('搜尋中…', '');
  let places;
  try {
    const res = await fetch(geocodeUrl(query));
    if (!res.ok) throw new Error(res.status);
    places = parseGeocodeResults(await res.json());
  } catch {
    if (seq === searchSeq) setStatus('搜尋失敗，請稍後再試，或直接輸入座標。', 'error');
    return;
  }
  if (seq !== searchSeq) return; // 已有更新的搜尋，這筆結果過期了

  if (!places.length) {
    setStatus(`找不到「${query}」。可以換個說法，或貼 Google Maps 網址。`, 'error');
    return;
  }
  const inRange = places.filter((p) => isInRange(p.lon, p.lat)).slice(0, 5);
  if (!inRange.length) {
    setStatus(`「${query}」的搜尋結果都在預報圖範圍之外。`, 'error');
    return;
  }
  setStatus('選一個地點：', '');
  showResults(inRange);
}

locForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const parsed = parseLocation(locInput.value);
  if (!parsed) {
    clearResults();
    setStatus('看不懂這個輸入。可以貼完整的 Google Maps 網址，或直接輸入「25.11, 121.92」。', 'error');
    return;
  }
  if (parsed.query) {
    runSearch(parsed.query);
    locInput.blur();
    return;
  }
  clearResults();
  if (parsed.needsExpand) {
    setStatus('短網址無法在瀏覽器裡展開。', 'error');
    const a = document.createElement('a');
    a.href = parsed.needsExpand;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = '點此開啟，再把跳轉後的完整網址複製回來';
    locStatus.append(' ', a);
    relayout();
    return;
  }
  if (applyTarget(parsed)) locInput.blur();
});

locInput.addEventListener('input', () => {
  clearInput.hidden = !locInput.value;
});

clearInput.addEventListener('click', () => {
  setInput('');
  clearResults();
  setStatus('', '');
  locInput.focus();
});

/* ---------- 最愛地點 ---------- */

let favourites = [];

function favLabel(fav) {
  return fav.label || formatCoords(fav.lat, fav.lon);
}

function saveFavourites() {
  localStorage.setItem(FAV_KEY, JSON.stringify(favourites));
}

function renderFavs() {
  const saved = state.target && isFavourite(favourites, state.target);

  // 地點多或名稱長的時候這一排會超出寬度，所以只讓地點捲動，
  // ★ 留在捲動區外面，否則要先橫向捲到底才點得到。
  const scroller = document.createElement('div');
  scroller.className = 'fav-scroll';
  scroller.append(...favourites.map((fav) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fav';
    btn.textContent = favLabel(fav);
    if (state.target && sameSpot(fav, state.target)) btn.classList.add('active');
    btn.addEventListener('click', () => applyTarget({ ...fav }));
    return btn;
  }));

  const nodes = [scroller];
  if (state.target) {
    const star = document.createElement('button');
    star.type = 'button';
    star.id = 'favToggle';
    star.textContent = saved ? '★' : '☆';
    star.title = saved ? '從最愛移除' : '加入最愛';
    star.setAttribute('aria-label', star.title);
    star.classList.toggle('on', saved);
    star.addEventListener('click', toggleCurrentFavourite);
    nodes.push(star);
  }

  favsBox.replaceChildren(...nodes);
  favsBox.hidden = !favourites.length && !state.target;
  relayout(); // 這一列會改變 #stage 高度
}

function toggleCurrentFavourite() {
  if (!state.target) return;
  const was = isFavourite(favourites, state.target);
  const dropped = was ? null : favourites.length === MAX_FAVOURITES ? favourites[0] : null;
  const first = !was && favourites.length === 0;
  favourites = toggleFavourite(favourites, {
    lat: state.target.lat, lon: state.target.lon, label: state.target.label || null,
  });
  saveFavourites();
  if (dropped) {
    // 自動汰換不該無聲無息
    setStatus(`已加入最愛，並移除最舊的「${favLabel(dropped)}」。`, 'warn');
  } else if (first) {
    // 只在第一次收藏時講一次，之後不再囉嗦
    setStatus('已加入最愛。最愛只存在這台裝置的瀏覽器，換裝置不會同步。', 'warn');
  }
  renderFavs();
}

$('#resetView').addEventListener('click', fitWhole);

/* ---------- 啟動 ---------- */

function restore() {
  try {
    favourites = parseFavourites(JSON.parse(localStorage.getItem(FAV_KEY)));
  } catch {
    favourites = []; // 壞掉的紀錄直接忽略
  }
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon)) {
      applyTarget(saved); // 內含 renderFavs()
      return;
    }
  } catch {
    // 壞掉的紀錄直接忽略
  }
  renderFavs(); // 沒有目前地點時仍要畫出已存的最愛
}

/**
 * 重算版面。回傳 false 代表 viewport 還沒有尺寸 — 此時算出的縮放倍率會是 0，必須稍後重試。
 */
function relayout() {
  layoutCrops();
  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;
  if (!vw || !vh) return false;
  if (userAdjusted && lastVW) {
    // 原本在畫面中央的地圖點維持在中央，否則旋轉手機後看的位置會跑掉
    state.tx += (vw - lastVW) / 2;
    state.ty += (vh - lastVH) / 2;
    render();
  } else if (state.view === 'focus') {
    focusTarget(); // 沒有地點時會退回全台視野
  } else {
    fitWhole();
  }
  lastVW = vw;
  lastVH = vh;
  return true;
}

let lastVW = 0;
let lastVH = 0;

buildFrames();
restore();
setFrame(6, 6);

// 網格的 issued 是唯一能推出各時段實際時間的線索。還沒選地點時不會有人去載
// 網格，按鈕就會一直停在 +N，所以這裡先主動抓一份（之後選地點也用得到）。
loadGrid(state.frame.kind, state.frame.hour).then(noteIssued).catch(() => {});

if (!relayout()) window.addEventListener('load', relayout, { once: true });
window.addEventListener('resize', relayout);

import {
  IMG_W, IMG_H, FRAMES, CROP_LEGEND, CROP_TIMESTAMP, PX_PER_DEG_LON,
  lonLatToPixel, isInRange, cacheBustToken, frameUrl, parseLocation, formatCoords,
} from './qpf.js';

const STORE_KEY = 'rain-predit.location';
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

const token = cacheBustToken(new Date());
const state = {
  frame: { kind: 6, hour: 6 },
  target: null,
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
  // 扣掉「毫米」標籤的高度，否則色階會被 #stage 裁掉底部
  const legendScale = clamp((stageH - 18) / (CROP_LEGEND.y1 - CROP_LEGEND.y0), 0.25, 0.7);
  applyCrop(legendBox, CROP_LEGEND, legendScale);

  const availW = document.body.clientWidth - 16;
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
  mapImg.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
  renderPin();
}

function renderPin() {
  if (!state.target) {
    pin.hidden = true;
    return;
  }
  const p = lonLatToPixel(state.target.lon, state.target.lat);
  const sx = state.tx + p.x * state.scale;
  const sy = state.ty + p.y * state.scale;
  pin.hidden = false;
  pin.style.transform = `translate(${sx}px, ${sy}px)`;
}

function fitWhole() {
  userAdjusted = false;
  state.scale = minScale();
  render();
}

function focusTarget() {
  if (!state.target) return fitWhole();
  userAdjusted = false;
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

function viewportPoint(e) {
  const r = viewport.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

viewport.addEventListener('pointerdown', (e) => {
  viewport.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pinchPrev = null;
});

viewport.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 1) {
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
  if (pointers.size === 0 && e.type === 'pointerup') {
    const now = Date.now();
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
      btn.textContent = `+${hour}`;
      btn.dataset.kind = kind;
      btn.dataset.hour = hour;
      btn.addEventListener('click', () => setFrame(kind, hour));
      row.append(btn);
    }
    framesNav.append(row);
  }
}

function markActiveFrame() {
  for (const btn of framesNav.querySelectorAll('button')) {
    btn.classList.toggle('active',
      Number(btn.dataset.kind) === state.frame.kind &&
      Number(btn.dataset.hour) === state.frame.hour);
  }
}

function setFrame(kind, hour) {
  state.frame = { kind, hour };
  markActiveFrame();
  const url = frameUrl(kind, hour, token);
  showOverlay('載入中…');

  const pre = new Image();
  pre.onload = () => {
    for (const img of [mapImg, legendBox.querySelector('img'), timestampBox.querySelector('img')]) {
      img.src = url;
    }
    timestampBox.hidden = false;
    legendPane.hidden = false;
    hideOverlay();
    relayout(); // 時間列與色階首次出現會壓縮 #stage
  };
  pre.onerror = () => {
    showOverlay(`+${hour} 小時的 ${kind} 小時累積圖目前無法取得`, () => setFrame(kind, hour));
  };
  pre.src = url;
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

/* ---------- 地點 ---------- */

function setStatus(text, tone) {
  locStatus.textContent = text;
  locStatus.className = tone || '';
  relayout(); // 訊息換行會改變 #stage 高度
}

function applyTarget(target, { focus = true } = {}) {
  if (!isInRange(target.lon, target.lat)) {
    setStatus('這個位置在預報圖範圍之外。', 'error');
    return false;
  }
  state.target = target;
  localStorage.setItem(STORE_KEY, JSON.stringify(target));
  const prefix = target.label ? `${target.label} · ` : '';
  setStatus(`${prefix}${formatCoords(target.lat, target.lon)}`, '');
  if (focus) focusTarget(); else renderPin();
  return true;
}

locForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const parsed = parseLocation(locInput.value);
  if (!parsed) {
    setStatus('看不懂這個輸入。可以貼完整的 Google Maps 網址，或直接輸入「25.11, 121.92」。', 'error');
    return;
  }
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

$('#resetView').addEventListener('click', fitWhole);

/* ---------- 啟動 ---------- */

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon)) {
      applyTarget(saved, { focus: false }); // 視野交給隨後的 relayout 決定
    }
  } catch {
    // 壞掉的紀錄直接忽略
  }
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
  } else {
    focusTarget(); // 沒有地點時會退回全台視野
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

if (!relayout()) window.addEventListener('load', relayout, { once: true });
window.addEventListener('resize', relayout);

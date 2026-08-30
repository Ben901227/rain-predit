import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseLocation, lonLatToPixel, pixelToLonLat, isInRange,
  cacheBustToken, frameUrl, geocodeUrl, parseGeocodeResults,
  rainUrl, decodeRainGrid, rainLevelAt, rainText, rainColor, RAIN_BINS,
  sameSpot, isFavourite, toggleFavourite, parseFavourites, MAX_FAVOURITES,
} from '../qpf.js';

const LONGDONG_URL = 'https://www.google.com/maps/place/%E6%96%B0%E5%8C%97%E5%B8%82%E9%BE%8D%E6%B4%9E/@25.110544,121.9131185,16z/data=!3m1!4b1!4m6!3m5!1s0x345d43760d30c4ab:0x955d5b7fe7bf5b6d!8m2!3d25.1100179!4d121.9202884!16s%2Fg%2F1tfsqm55';

test('完整 Google Maps 網址優先取地點座標而非視野中心', () => {
  const r = parseLocation(LONGDONG_URL);
  assert.equal(r.lat, 25.1100179);
  assert.equal(r.lon, 121.9202884);
  assert.equal(r.label, '新北市龍洞');
});

test('只有 @ 視野中心時退而求其次', () => {
  const r = parseLocation('https://www.google.com/maps/@25.033,121.5654,14z');
  assert.equal(r.lat, 25.033);
  assert.equal(r.lon, 121.5654);
});

test('?q= 形式', () => {
  const r = parseLocation('https://maps.google.com/?q=23.85,120.915');
  assert.deepEqual([r.lat, r.lon], [23.85, 120.915]);
});

test('純座標，逗號或空白皆可', () => {
  assert.deepEqual(parseLocation('25.11, 121.92'), { lat: 25.11, lon: 121.92, label: null });
  assert.deepEqual(parseLocation('25.11 121.92'), { lat: 25.11, lon: 121.92, label: null });
});

test('短網址回報需要展開', () => {
  const r = parseLocation('https://maps.app.goo.gl/2udUQpPcQGFNmDjP7');
  assert.equal(r.needsExpand, 'https://maps.app.goo.gl/2udUQpPcQGFNmDjP7');
});

test('無法解析的輸入回傳 null', () => {
  assert.equal(parseLocation(''), null);
  assert.equal(parseLocation('https://example.com/no-coords'), null);
  assert.equal(parseLocation('999, 999'), null);
});

test('自由文字當成搜尋關鍵字', () => {
  assert.deepEqual(parseLocation('龍洞'), { query: '龍洞' });
  assert.deepEqual(parseLocation('  日月潭 '), { query: '日月潭' });
});

test('搜尋網址限定台灣並編碼關鍵字', () => {
  const url = new URL(geocodeUrl('龍洞'));
  assert.equal(url.origin + url.pathname, 'https://nominatim.openstreetmap.org/search');
  assert.equal(url.searchParams.get('q'), '龍洞');
  assert.equal(url.searchParams.get('countrycodes'), 'tw');
  assert.equal(url.searchParams.get('format'), 'jsonv2');
  assert.ok(!url.href.includes('龍洞'), '關鍵字必須做過 URL 編碼');
});

// 實際向 Nominatim 查「龍洞」的回應（節錄欄位）。同名地點分佈在新北與台東，
// 因此不能自動選第一筆，必須列出候選。
const LONGDONG_RESULTS = [
  { lat: '25.1109654', lon: '121.9190344', name: '龍洞', display_name: '龍洞, 新北市, 22451, 臺灣' },
  { lat: '25.1142599', lon: '121.9126948', name: '龍洞', display_name: '龍洞, 龍洞街, 和美里, 貢寮區, 龍洞, 新北市, 22451, 臺灣' },
  { lat: '22.9990266', lon: '121.3140565', name: '龍洞', display_name: '龍洞, 小馬龍洞灌溉水渠人行道, 信義里, 成功鎮, 臺東縣, 961, 臺灣' },
];

test('整理搜尋結果', () => {
  const r = parseGeocodeResults(LONGDONG_RESULTS);
  assert.equal(r.length, 3);
  assert.deepEqual(r[0], {
    lat: 25.1109654, lon: 121.9190344, label: '龍洞', detail: '龍洞, 新北市, 22451, 臺灣',
  });
  assert.equal(r[2].lat, 22.9990266);
});

test('搜尋結果缺欄位時不會壞掉', () => {
  assert.deepEqual(parseGeocodeResults([]), []);
  assert.deepEqual(parseGeocodeResults(null), []);
  assert.deepEqual(parseGeocodeResults([{ lat: 'x', lon: 'y', name: 'a' }]), []);
  assert.equal(parseGeocodeResults([
    { lat: '24.1', lon: '121.2', display_name: '合歡山, 南投縣, 臺灣' },
  ])[0].label, '合歡山');
});

// 期望像素取自 calibrate.py 的擬合結果，已用海岸線疊合圖目視確認。
const LANDMARKS = [
  ['龍洞', 25.1100179, 121.9202884, 1065.3, 270.9],
  ['鵝鑾鼻', 21.8975, 120.8517, 687.4, 1422.9],
  ['富貴角', 25.2977, 121.5375, 929.9, 203.6],
  ['三貂角', 25.0075, 121.9967, 1092.3, 307.7],
  ['蘭嶼', 22.0417, 121.5375, 929.9, 1371.1],
  ['日月潭', 23.85, 120.915, 709.8, 722.7],
];

test('地標投影到預期像素', () => {
  for (const [name, lat, lon, ex, ey] of LANDMARKS) {
    const p = lonLatToPixel(lon, lat);
    assert.ok(Math.abs(p.x - ex) < 1, `${name} x ${p.x} != ${ex}`);
    assert.ok(Math.abs(p.y - ey) < 1, `${name} y ${p.y} != ${ey}`);
  }
});

test('像素與經緯度互為反函式', () => {
  const back = pixelToLonLat(...Object.values(lonLatToPixel(121.9202884, 25.1100179)));
  assert.ok(Math.abs(back.lon - 121.9202884) < 1e-9);
  assert.ok(Math.abs(back.lat - 25.1100179) < 1e-9);
});

test('涵蓋範圍判斷', () => {
  assert.equal(isInRange(121.9202884, 25.1100179), true);  // 龍洞
  assert.equal(isInRange(120.915, 23.85), true);           // 日月潭
  assert.equal(isInRange(119.5667, 23.5667), true);        // 澎湖馬公，圖上為原位繪製
  assert.equal(isInRange(118.32, 24.45), false);           // 金門，只在放大框內
  assert.equal(isInRange(139.7, 35.7), false);             // 東京
});

test('快取鍵每 10 分鐘換一次', () => {
  assert.equal(cacheBustToken(new Date(2026, 7, 29, 11, 34)), '2026082911-3');
  assert.equal(cacheBustToken(new Date(2026, 7, 29, 11, 39)), '2026082911-3');
  assert.equal(cacheBustToken(new Date(2026, 0, 5, 9, 5)), '2026010509-0');
});

test('圖片網址補零', () => {
  assert.equal(frameUrl(6, 6, 'X'),
    'https://www.cwa.gov.tw/Data/fcst_img/QPF_ChFcstPrecip_6_06.png?T=X');
  assert.equal(frameUrl(12, 48, 'X'),
    'https://www.cwa.gov.tw/Data/fcst_img/QPF_ChFcstPrecip_12_48.png?T=X');
});

/* ---------- 雨量網格 ---------- */

test('雨量網格網址', () => {
  assert.equal(rainUrl(6, 6), 'rain/6_06.json');
  assert.equal(rainUrl(12, 48), 'rain/12_48.json');
});

test('展開 RLE 網格並查詢等級', () => {
  // 3×2 的網格，第一列全是 0，第二列是 5,5,255
  const grid = decodeRainGrid({ x0: 10, y0: 20, w: 3, h: 2, generated: '2026-08-29T16:00:00Z',
    rle: [0, 3, 5, 2, 255, 1] });
  assert.equal(grid.levels.length, 6);
  assert.equal(grid.generated, '2026-08-29T16:00:00Z');
  assert.equal(rainLevelAt(grid, 10, 20), 0);
  assert.equal(rainLevelAt(grid, 11, 21), 5);
  assert.equal(rainLevelAt(grid, 12, 21), 255);
  // 網格外
  assert.equal(rainLevelAt(grid, 9, 20), null);
  assert.equal(rainLevelAt(grid, 13, 20), null);
  assert.equal(rainLevelAt(grid, 10, 22), null);
});

test('RLE 長度不符要報錯', () => {
  assert.throws(() => decodeRainGrid({ x0: 0, y0: 0, w: 3, h: 2, rle: [0, 3] }), /長度不符/);
});

test('雨量文字與顏色', () => {
  assert.equal(rainText(0), '未達 0.5 毫米');
  assert.equal(rainText(1), '0.5～1 毫米');
  assert.equal(rainText(5), '10～15 毫米');
  assert.equal(rainText(17), '300 毫米以上');
  assert.equal(rainText(255), '無法判讀');
  assert.equal(rainText(null), null);
  assert.equal(rainColor(5), '#0363ff');
  assert.equal(rainColor(0), null);
  assert.equal(rainColor(255), null);
});

test('色階定義與 rain_grid.py 一致', () => {
  // 兩邊的等級編號必須對得起來，否則讀出來的雨量是錯的
  const py = readFileSync(new URL('../rain_grid.py', import.meta.url), 'utf8');
  const block = py.match(/^BINS = \[$([\s\S]*?)^\]$/m)[1];
  const rows = [...block.matchAll(/\(([\d.]+), (None|[\d.]+), \((\d+), (\d+), (\d+)\)\)/g)];
  assert.equal(rows.length, RAIN_BINS.length);
  rows.forEach(([, min, max, r, g, b], i) => {
    const bin = RAIN_BINS[i];
    assert.equal(Number(min), bin.min, `第 ${i + 1} 級下界`);
    assert.equal(max === 'None' ? null : Number(max), bin.max, `第 ${i + 1} 級上界`);
    const hex = '#' + [r, g, b].map((v) => Number(v).toString(16).padStart(2, '0')).join('');
    assert.equal(hex, bin.color, `第 ${i + 1} 級顏色`);
  });
});

/* ---------- 最愛地點 ---------- */

const LONGDONG = { lat: 25.1109654, lon: 121.9190344, label: '龍洞' };
const SUNMOON = { lat: 23.8523, lon: 120.9286, label: '日月潭' };

test('同一地點的座標微差視為相同', () => {
  // 搜尋與 Google Maps 網址取得的座標會差幾十公尺
  assert.equal(sameSpot(LONGDONG, { lat: 25.1110179, lon: 121.9192884 }), true);
  assert.equal(sameSpot(LONGDONG, SUNMOON), false);
  // 約 110 公尺，超出容差
  assert.equal(sameSpot(LONGDONG, { lat: 25.1119654, lon: 121.9190344 }), false);
});

test('加入與移除最愛', () => {
  const one = toggleFavourite([], LONGDONG);
  assert.deepEqual(one, [LONGDONG]);
  assert.equal(isFavourite(one, LONGDONG), true);
  assert.equal(isFavourite(one, SUNMOON), false);
  assert.deepEqual(toggleFavourite(one, LONGDONG), []);
});

test('重複加入同一點不會變成兩筆', () => {
  const list = toggleFavourite([], LONGDONG);
  // 座標微差仍視為同一點，因此是「移除」而不是新增
  assert.deepEqual(toggleFavourite(list, { lat: 25.1110179, lon: 121.9192884 }), []);
});

test('存滿 5 個再加會砍掉最舊的', () => {
  let list = [];
  for (let i = 0; i < MAX_FAVOURITES; i += 1) {
    list = toggleFavourite(list, { lat: 24 + i * 0.1, lon: 121, label: `第${i}` });
  }
  assert.equal(list.length, MAX_FAVOURITES);
  assert.equal(list[0].label, '第0');

  const after = toggleFavourite(list, SUNMOON);
  assert.equal(after.length, MAX_FAVOURITES);
  assert.equal(after[0].label, '第1');                    // 最舊的被擠掉
  assert.equal(after[MAX_FAVOURITES - 1].label, '日月潭'); // 新的在尾端
});

test('還原時丟掉壞掉的紀錄', () => {
  assert.deepEqual(parseFavourites(null), []);
  assert.deepEqual(parseFavourites('龍洞'), []);
  assert.deepEqual(parseFavourites([{ lat: 'x', lon: 1 }, null, { lon: 121 }]), []);
  assert.deepEqual(parseFavourites([{ lat: 25.11, lon: 121.92 }]),
    [{ lat: 25.11, lon: 121.92, label: null }]);
  // 超過上限只留最新的幾筆
  const many = Array.from({ length: 8 }, (_, i) => ({ lat: 24 + i, lon: 121, label: `${i}` }));
  const kept = parseFavourites(many);
  assert.equal(kept.length, MAX_FAVOURITES);
  assert.equal(kept[0].label, '3');
});

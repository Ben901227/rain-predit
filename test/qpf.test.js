import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLocation, lonLatToPixel, pixelToLonLat, isInRange,
  cacheBustToken, frameUrl,
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
  assert.equal(parseLocation('龍洞'), null);
  assert.equal(parseLocation('https://example.com/no-coords'), null);
  assert.equal(parseLocation('999, 999'), null);
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

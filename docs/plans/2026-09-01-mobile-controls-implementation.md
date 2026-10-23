# 行動裝置控制項可用性調整 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在窄螢幕上維持可點擊的預報時段與圖示控制項，並提供清楚的鍵盤焦點狀態。

**Architecture:** 此變更只調整 `style.css`。時段列的內容寬度改為能容納 44px 控制項，外層保留單一橫向捲動區；按鈕則用最小尺寸確保觸控面積。共用的 `:focus-visible` 規則與既有輸入框 focus 狀態一致。

**Tech Stack:** HTML、CSS、原生 ES modules、Node.js 內建測試。

---

### Task 1: 設定可用的時段列觸控尺寸

**Files:**
- Modify: `style.css:370-419`
- Test: 瀏覽器 320px 寬度版面檢查

**Step 1: 建立失敗條件**

在 320px 寬視窗檢查目前 6 小時按鈕的 `getBoundingClientRect()`；預期可觀察到寬度小於 44px。

**Step 2: 實作最小 CSS 調整**

讓 `#frames` 成為 X 軸捲動容器，並為 `.frame-row` 指定可容納標籤與八個 44px 時段按鈕的最小寬度；讓按鈕最小寬高為 44px。保留 12 小時按鈕跨兩欄的既有格線規則。

**Step 3: 驗證通過**

在 320px 寬視窗確認：

- 所有 6 小時按鈕寬高皆至少 44px。
- 時段區可水平捲動。
- 文件本體 `scrollWidth` 不大於 viewport 寬度。

### Task 2: 擴大圖示控制項的觸控範圍

**Files:**
- Modify: `style.css:81-97`
- Modify: `style.css:158-168`
- Test: 瀏覽器 320px 寬度版面檢查

**Step 1: 建立失敗條件**

在已選定地點時量測 `#clearInput` 與 `#favToggle`；預期至少一個邊長小於 44px。

**Step 2: 實作最小 CSS 調整**

調整兩者寬高至 44px；以定位與內距維持圖示視覺上置中且不侵蝕輸入文字區。

**Step 3: 驗證通過**

確認兩個控制項都至少為 44×44px，且輸入框文字與右側控制不重疊。

### Task 3: 加入一致的鍵盤焦點提示

**Files:**
- Modify: `style.css:99-109`
- Test: 瀏覽器鍵盤 Tab 檢查

**Step 1: 建立失敗條件**

以 Tab 聚焦時段、最愛、全台與頁尾連結；目前它們沒有與背景形成明確對比的焦點環。

**Step 2: 實作最小 CSS 調整**

新增 `button:focus-visible, a:focus-visible` 的一致焦點外框與陰影；不覆寫輸入框既有的 focus 樣式。

**Step 3: 驗證通過**

連續 Tab 操作時，每個互動項目都有可辨識的焦點提示；滑鼠操作不會持續顯示焦點環。

### Task 4: 回歸驗證

**Files:**
- Test: `test/qpf.test.js`

**Step 1: 執行自動化測試**

Run: `node --test test/*.test.js`

Expected: 25 項測試通過、0 failures。

**Step 2: 執行視覺回歸檢查**

在 320px、375px 與預設桌機寬度檢查頁面，確認地圖、色階、時段切換、座標定位和頁尾仍能使用。

**Step 3: 提交**

在使用者要求提交時，僅加入本次 CSS 與計畫文件，建立一筆描述觸控可用性調整的 commit。

---

## 實作結果（2026-10-23）

Task 2（清除與最愛 44×44）與 Task 3（焦點環）照計畫完成。
Task 1 改為只調整高度、不改成橫向捲動，理由見 design 文件的「實作結果」一節。

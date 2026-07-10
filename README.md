# Game

一個純前端（HTML / JavaScript / Canvas）實作的類世紀帝國風格 RTS 小遊戲，玩家對電腦 AI 進行即時戰略對戰。

## 如何開始遊玩

程式使用 ES modules（`import` / `export`）拆分成多個檔案，**不能直接雙擊 `index.html` 開啟**——瀏覽器基於安全限制，不允許用 `file://` 的方式載入 ES modules。必須先在資料夾裡開一個本地伺服器，用 `http://localhost:...` 的網址打開才行。

三選一，看你電腦裝了什麼：

**有裝 Python（Mac 通常內建）：**
```bash
cd 這個資料夾的路徑
python3 -m http.server 8000
```
瀏覽器打開 `http://localhost:8000`

**有裝 Node.js：**
```bash
cd 這個資料夾的路徑
npx serve
```
瀏覽器打開終端機顯示的網址（通常是 `http://localhost:3000`）

**用 VS Code（最簡單，不用打指令）：**
1. 安裝 "Live Server" 擴充套件
2. 在 `index.html` 上按右鍵 → 「Open with Live Server」

## 操作方式

- 滑鼠左鍵：選取單位／建築，拖曳可框選多個單位
- 滑鼠右鍵：對選取的單位下指令（移動／採集／攻擊／協助建造）
- 方向鍵或 WASD：移動視角
- 選取村民後，下方面板會出現「建造建築物」選項；選取建築後會出現訓練單位／科技研究／時代升級等選項

## 專案結構

```
Game/
├── index.html      # 頁面骨架、UI 版面
├── style.css       # 介面樣式
└── js/
    ├── data.js      # 建築/單位/科技樹數值定義
    ├── map.js       # 地圖網格、資源節點、A* 尋路
    ├── entities.js  # Unit / Building 資料結構與基礎函式
    ├── sim.js       # 遊戲核心邏輯：採集、建造、訓練、戰鬥、科技研究
    ├── ai.js        # 電腦對手 AI 決策邏輯
    └── game.js      # 主迴圈、輸入操作、畫面渲染、UI 面板
```

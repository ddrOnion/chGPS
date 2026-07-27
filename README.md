# chGPS — 地圖選點，USB 改 iPhone 定位

在網頁地圖上點一個位置，透過 USB 把該座標寫進 iPhone，讓系統與 App 認為裝置在該地點。
底層使用 [`pymobiledevice3`](https://github.com/doronz88/pymobiledevice3)，走的是 Xcode「Simulate Location」同一個 Apple 官方開發者服務。

## 快速啟動

雙擊 **`start.cmd`**（或 `npm start`）。腳本會先檢查依賴（缺的自動裝），自行提權，
依序拉起 tunneld、bridge、Web UI，並開啟瀏覽器。**關掉那個視窗，三個服務全部一起停**。

## 架構

```
React + Leaflet (:3000)
      │  POST /api/location {lat, lng}
      ▼
Node/Express bridge (:4000)
      │  spawn 長駐行程:
      │  pymobiledevice3 developer dvt simulate-location set --tunnel <udid>
      ▼
RemoteXPC tunneld (:49151) ──USB──▶ iPhone
```

### 為什麼是「長駐行程」

iOS 17+ 的模擬定位由 DVT session 持有：`simulate-location set` 送出座標後印出
`Press ENTER to exit` 就**停在那裡不結束**，session 一斷、定位就還原。因此 bridge
不是「執行完就收工」，而是把該行程留著並記錄下來，換座標時先砍舊的再開新的，
「還原真實 GPS」則單純就是砍掉它。

實作上有三個必要細節：

- **一定要傳 `--tunnel <udid>`**。否則 CLI 會忽略已在跑的 tunneld，自己另開一條
  userspace tunnel，既慢又常卡住。
- **`PYTHONUNBUFFERED=1`**。那句提示沒有換行，Python 在管線模式下會把它留在緩衝區，
  父行程永遠讀不到成功訊號。另外也保留一個「存活即視為成功」的寬限判定作後備。
- **樹狀終止**。`python -m pymobiledevice3` 是父子兩個行程，Windows 上砍父的不會
  連帶砍子的，孤兒會繼續佔住裝置。

### 為什麼啟動腳本用 Job Object

需求是「關視窗就全部停掉」。PowerShell 的 `finally` 或 Ctrl+C handler 擋不住視窗的
X 按鈕，所以改用 Windows Job Object 搭配 `KILL_ON_JOB_CLOSE`：所有子行程掛在同一個
job 上，父行程一消失（正常結束、Ctrl+C、被強制終止都算）核心就會清掉整組。

> `start.ps1` 必須存成 **UTF-8 with BOM**。Windows PowerShell 5.1 在沒有 BOM 時會以
> 系統 ANSI codepage 讀檔，中文字會被拆成無效位元組而產生假的語法錯誤。

### 為什麼依賴檢查在提權之前

`python` 通常裝在呼叫者的 profile 底下，提權後可能是另一個 admin 帳號而看不到；
`node_modules` 若由提權 session 寫入，擁有者也會變成別的帳號。所以檢查與安裝都在
提權前、以原使用者身分完成，再用 `-SkipDepCheck` 讓提權後的那次不重跑。

npm 的部分是逐一比對 `package.json` 的 `dependencies` 有沒有對應的 `node_modules`
子目錄，比單看 `node_modules` 存不存在更能抓到「裝一半」的狀態；Python 的部分用
`importlib.util.find_spec` 只定位不 import，因為 `pymobiledevice3` 的依賴圖很重。
依賴齊全時整個檢查約 40ms。

## 已驗證環境

| 項目 | 值 |
|---|---|
| 主機 | Windows 11 |
| 裝置 | iPhone 14 Plus (iPhone14,8) |
| 系統 | iOS 26.5.2 |
| pymobiledevice3 | 10.1.0 |
| Node | 24.x |

iOS 17 以上（含 iOS 26）走 `developer dvt simulate-location`，**不是**頂層那個
`developer simulate-location`（那個只支援 iOS 16 以下），且必須有 RemoteXPC tunnel。
後端會依裝置回報的 iOS 版本自動選擇路徑，不需手動切換。

## 前置需求（僅需做一次）

機器上要有 **Python 3** 與 **Node 24+**。其餘套件不必手動處理 — `start.cmd` 首次執行
時會自己補上缺少的 npm 套件與 `pymobiledevice3`。

在 Windows 上**不需要安裝 iTunes**，內建的 Apple Mobile Device 驅動即可讓
`pymobiledevice3` 透過 usbmux 連上裝置。

### 1. 在 iPhone 上啟用開發者模式 ⚠️ 會重開機

```bash
python -m pymobiledevice3 amfi enable-developer-mode
```

執行後 iPhone 會**自動重新開機**。重開後：
設定 → 隱私權與安全性 → 開發者模式 → 開啟 → 輸入密碼確認。

> 這步無法完全自動化：Apple 強制要求實體解鎖與密碼確認。

### 2. 掛載 Developer Disk Image

開發者模式開啟後，在網頁的裝置面板點「立即掛載」，或：

```bash
python -m pymobiledevice3 mounter auto-mount
```

iOS 17+ 會從 Apple 下載 personalized DDI，需要連網，約數分鐘。

> 前置需求 3（tunnel）由 `start.cmd` 自動處理，不需要手動開。

## 啟動

```bash
npm start
```

或直接雙擊 `start.cmd`。會依序啟動並顯示進度：

```
  chGPS — 地圖選點改 iPhone 定位
  ────────────────────────────────────────────

  [1/3] RemoteXPC tunneld ... OK
  [2/3] Bridge (:4000)     ... OK
  [3/3] Web UI (:3000)     ... OK

  裝置  iPhone · iOS 26.5.2
  狀態  就緒，可傳送定位
```

**關閉視窗或按 Ctrl+C 即停止全部服務。**

啟動時也會自動清掉前次殘留的 `simulate-location` 行程（那會佔住裝置導致下次失敗）。

### 手動分開啟動

除錯時想個別看 log。這條路徑不經過 `start.ps1`，**不會自動補依賴** — 先跑過一次
`start.cmd`，或自己 `npm install` 與 `pip install pymobiledevice3`：

```bash
npm run tunnel
```

```bash
npm run server
```

```bash
npm run dev
```

`npm run tunnel` 需要**系統管理員權限**。無提權需求的替代方案（較慢）：

```bash
python -m pymobiledevice3 remote tunneld --userspace
```

開啟 http://localhost:3000

## 使用

- **點擊地圖** → 新增座標點
- **📲** → 把該座標傳送到 iPhone
- **🎯** → 地圖移動到該點
- **✕** → 刪除
- 左側可手動微調經緯度到小數點後 6 位
- **還原真實 GPS** → 停止模擬，回到實際定位

裝置面板即時顯示連線狀態，未就緒時會列出具體缺什麼。

## API

| Method | Path | 說明 |
|---|---|---|
| `GET` | `/api/status` | 裝置狀態與阻礙清單（`?fresh=1` 跳過快取） |
| `POST` | `/api/location` | `{lat, lng}` → 設定模擬定位 |
| `POST` | `/api/location/clear` | 還原真實 GPS |
| `POST` | `/api/ddi/mount` | 掛載 Developer Disk Image |

## 疑難排解

| 症狀 | 處理 |
|---|---|
| `未偵測到 iPhone` | 解鎖螢幕、確認已點「信任這台電腦」、換條支援資料傳輸的線 |
| `開發者模式未啟用` | 見前置需求 1 |
| `DDI 未掛載` | 見前置需求 2；需連網 |
| `tunneld 未回應` | 重跑 `start.cmd`；手動啟動時 tunneld 需以管理員身分執行並保持運作 |
| `tunneld 有在跑，但沒有連到這台裝置的 tunnel` | 拔插 USB 後重啟 tunneld — 裝置重連後舊 tunnel 不會自動接回 |
| 傳送逾時 | 檢查 tunneld 是否還活著；`--tunnel` 沒生效時 CLI 會退回自建 userspace tunnel 而卡住 |
| 定位沒變 | 部分 App 會快取位置，重啟該 App；地圖類 App 通常即時反應 |

## 注意

- **模擬定位只在 bridge 持有 session 期間有效。** 關閉啟動視窗、bridge 當掉、或按下
  「還原真實 GPS」都會立即還原。這是 iOS 17+ DVT 的設計，不是缺陷。
- iPhone **重新開機**同樣會清除模擬定位。
- 每次只能有一個模擬座標；設定新座標會自動取代舊的。
- 這使用的是 Apple 官方開發者服務，**不需要越獄**，也不會修改系統檔案。
- 僅適用於自己擁有、且已配對信任的裝置。

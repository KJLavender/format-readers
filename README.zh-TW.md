# format-readers

[English](README.md) | **繁體中文**

三個小型命令列工具，用來打開 app 內部使用的檔案格式，讓你看到 app 在網路上送了什麼、檔案裡裝了什麼。它們只讀取，不會執行你給的檔案。

| 工具 | 讀什麼 | 拿來比對的工具 |
|---|---|---|
| [`protobuf/pbdecode.mjs`](protobuf/pbdecode.mjs) | protobuf 訊息（一種精簡的二進位格式），不需要 schema 檔；也讀 gRPC、gRPC-web 封包，以及 HAR 檔（瀏覽器存下來的網路流量） | `protoc --decode_raw` |
| [`pyinstaller/pyinst.mjs`](pyinstaller/pyinst.mjs) | PyInstaller 打包的執行檔（PyInstaller 會把 Python 程式包成單一執行檔），可還原成能執行的 `.pyc` | `pyinstxtractor`，以及實際執行還原後的結果 |
| [`hermes/hbc.mjs`](hermes/hbc.mjs) | Hermes bytecode，也就是 React Native app 編譯後的形式（`index.android.bundle`），版本 76 到 99 | `hermes-dec` |

三個工具都是純 Node.js，執行時不需要任何套件，也不需要 Python。就算 app 是用你沒裝的 Python 版本打包的，一樣解得開。解開檔案時只會寫進你指定的資料夾。

[![CI](https://github.com/KJLavender/format-readers/actions/workflows/ci.yml/badge.svg)](https://github.com/KJLavender/format-readers/actions/workflows/ci.yml)

## 怎麼用

需要 Node.js 20 以上。

```bash
git clone https://github.com/KJLavender/format-readers
cd format-readers

node protobuf/pbdecode.mjs capture.har --schema      # 把 HAR 裡的 protobuf/gRPC 內容整理成推測的 schema
node pyinstaller/pyinst.mjs app.exe                  # 看 PyInstaller 執行檔裡有什麼
node pyinstaller/pyinst.mjs app.exe --extract out/   # 解開它；out/app.pyc 可用對應版本的 Python 執行
node hermes/hbc.mjs index.android.bundle             # 版本、完整性檢查、有名字的函式、網址和金鑰
```

三個工具都支援 `--json`，輸出給程式讀。

## protobuf

protobuf 訊息其實只是一堆有編號的欄位。欄位名稱寫在 `.proto` 這種 schema 檔裡，而你常常拿不到它。這個工具沒有 schema 也能解碼。

```bash
node protobuf/pbdecode.mjs capture.har               # 擷取檔裡每個 protobuf/gRPC 內容，一個欄位一行
node protobuf/pbdecode.mjs capture.har --schema      # 每個內容整理成一份推測的 schema（短很多）
node protobuf/pbdecode.mjs message.bin --protoc      # 輸出跟 protoc --decode_raw 相同的文字
```

- 每個欄位都標出 byte 位置。
- 有些欄位有歧義。帶長度的欄位可能是字串、原始 bytes、巢狀訊息或 packed 數字。工具會標成「推測」，並列出其他可能的解讀。
- gRPC 方面，會分開資料框和 trailer 框，顯示 `grpc-status`，也處理 `application/grpc-web-text`（包括分段的 base64）和 gzip/deflate 壓縮框。
- `--schema` 會把重複的欄位合併成一棵樹，附上出現次數、數值範圍和範例。

它無法還原欄位名稱，因為名稱只存在 schema 裡。

另外還有 `--record N`、`--all`、`--grpc` 三個選項。不帶參數執行會印出用法。

## pyinstaller

```bash
node pyinstaller/pyinst.mjs app.exe                  # Python 版本、onefile 或 onedir、入口程式、app 自己的模組
node pyinstaller/pyinst.mjs app.exe --extract out/
```

- 封存檔後面接著數位簽章，也找得到。
- 用內建的小型 `marshal` 讀取器（marshal 是 Python 的序列化格式）解析模組表，所以不用安裝對應版本的 Python。
- 會重建 `.pyc` 檔頭，取出的入口程式可以直接執行：`PYTHONPATH=out/PYZ python out/app.pyc`。
- 只列出 app 自己的模組和第三方套件，不列標準庫。

它不會把 `.pyc` 還原成原始碼。要還原請用 pycdc 這類反編譯器。

## hermes

```bash
node hermes/hbc.mjs index.android.bundle             # 摘要
node hermes/hbc.mjs index.android.bundle --strings   # 每個字串和它的類型
```

- 讀檔頭、結尾的 SHA-1 檢查碼、函式表和字串表（Latin-1、UTF-16、長字串）。
- 挑出網址、像金鑰的字串和 API 路徑，有名字的函式排在前面。

它不做反組譯或反編譯，那是 hermes-dec 和 hbctool 的工作。

## 測試

每個工具都用真實編譯器或打包工具產生的檔案，跟對應的標準工具比對。CI 每次推送都會全部重跑。

| 工具 | 測試 | 結果 |
|---|---|---|
| protobuf | 300 則產生的訊息、500 則隨機改壞的訊息、300 組隨機亂碼，與 `protoc --decode_raw` 比對 | 輸出相同，連「合不合法」的判斷也一樣 |
| protobuf | HAR 裡的 gRPC-web、grpc-web-text、gzip 壓縮框和一般 `x-protobuf` | 全部解出，包括 trailer |
| pyinstaller | 用 PyInstaller 打包的範例程式（onefile 和 onedir），Python 3.11 和 3.13 | 取出的每個檔案都和 pyinstxtractor 逐 byte 相同；還原的 `app.pyc` 輸出和原執行檔一樣 |
| hermes | 同一份程式用 hermesc 0.8.0、0.11.0、React Native 0.76 內附的版本和兩個 1.0.0 版編譯（bytecode v83、v84、v96、v98、v99） | 檔頭、字串、函式都和 hermes-dec 一致 |
| hermes | 壓力測試：802 個函式、3,204 個字串、一個 197 KB 的函式 | 每個版本都一致 |

自己跑測試：

```bash
npm ci
npm run test:protobuf
PYTHON=python3 npm run test:pyinstaller
PYTHON=python3 npm run test:hermes
```

PyInstaller 測試需要一個裝了 `pyinstaller` 的 Python。想一併和 pyinstxtractor 比對，要把 `pyinstxtractor.py` 放進 `pyinstaller/test/`（CI 會自動下載），沒放的話會跳過這項比對。Hermes 測試需要一個裝了 `hermes-dec` 的 Python。

v96 的編譯器只附在 `react-native` 套件裡。要一起測，請解開 `react-native@0.76.x`，把 `HERMESC_RN_DIR` 設成它的 `package/` 資料夾。CI 就是這樣做的。

也拿真實的軟體試過：Chrome 設定檔裡的 93 個 protobuf 檔（和 protoc 一致）、一個有數位簽章的 Python 3.14 PyInstaller 程式（151 個模組全部解開；沒裝 Python 3.14 時 pyinstxtractor 會跳過它），以及 BlueWallet 8.0.2 的 Android bundle（40,594 個函式、109,320 個字串，0.16 秒讀完）。

### 比對時發現的 bug

- 本專案自己的 protobuf 解碼器：讀 varint 時可能越過巢狀訊息的結尾。protoc 會默默截掉超過 32 位元的 tag，巢狀超過 10 層就不再印出。解碼器現在三點都和 protoc 一致。
- hermes-dec：只有一個 U+FEFF 的字串會被解成空字串，因為 Python 的 `utf-16` 解碼器把它當成位元組順序標記。Hermes 測試保留了這個案例。

## 背景

這些工具一開始是研究 [REA](https://github.com/morluto/rea)（逆向工程用的 MCP server）時做的原型，部分成果已回饋上游：

- [morluto/rea#5029](https://github.com/morluto/rea/pull/5029)：用 JSON 檔指定要分析的檔案（已合併，收錄於 REA 6.8.0）
- [morluto/rea#4986](https://github.com/morluto/rea/issues/4986)：protobuf/gRPC 內容解碼（已在 REA 6.8.0 實作）
- [morluto/rea#7038](https://github.com/morluto/rea/issues/7038)：Hermes bytecode 支援（提案中）

## 使用須知

請只用在你擁有或有權檢視的軟體上：除錯、相容性、資安研究、學習。這些工具不會解密任何東西，也不會繞過保護機制。檢視任何軟體前，請先確認它的授權條款。

## 授權

[MIT](LICENSE)

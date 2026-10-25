# 🔍 format-readers：看穿 app 內部格式的小工具

[English](README.md) | **繁體中文**

三個小巧、唯讀的命令列讀取工具，處理研究 app 內部時最常卡住的格式：

| 工具 | 讀取的格式 | 對照的標準工具 |
|---|---|---|
| [`protobuf/pbdecode.mjs`](protobuf/pbdecode.mjs) | 沒有 schema 的 protobuf 訊息、gRPC / gRPC-web / grpc-web-text 封包、HAR 擷取檔 | Google 的 `protoc --decode_raw` |
| [`pyinstaller/pyinst.mjs`](pyinstaller/pyinst.mjs) | PyInstaller 打包的執行檔（CArchive + PYZ），可還原成能直接執行的 `.pyc` | `pyinstxtractor`，以及實際執行還原的結果 |
| [`hermes/hbc.mjs`](hermes/hbc.mjs) | Hermes bytecode（React Native 的 `index.android.bundle`），版本 76–99 | `hermes-dec` |

- 📦 純 Node.js，執行時不需要任何套件；也不需要 Python，連用你沒安裝的 Python 版本打包的 PyInstaller 程式都能解開。
- 🧪 每個工具都拿真實的編譯器／打包工具產出，跟業界標準工具比對，每次推送都在 CI 自動重跑。
- 🔒 唯讀：不執行任何東西，取出檔案時只會寫進你指定的資料夾。

[![CI](https://github.com/KJLavender/format-readers/actions/workflows/ci.yml/badge.svg)](https://github.com/KJLavender/format-readers/actions/workflows/ci.yml)

---

## 🚀 快速開始

需要 Node.js 20 以上。

```bash
git clone https://github.com/KJLavender/format-readers
cd format-readers

node protobuf/pbdecode.mjs capture.har --schema      # 把 HAR 裡的 protobuf/gRPC 內容整理成推測的 schema
node pyinstaller/pyinst.mjs app.exe                  # 看 PyInstaller 執行檔裡有什麼
node pyinstaller/pyinst.mjs app.exe --extract out/   # 解開它；out/app.pyc 可以用對應的 Python 執行
node hermes/hbc.mjs index.android.bundle             # 版本、完整性、有名字的函式、網址和金鑰
```

每個工具都支援 `--json` 輸出。

---

## 🧩 三個工具

### 1. protobuf：沒有 `.proto` 也能解 protobuf

```bash
node protobuf/pbdecode.mjs capture.har               # 擷取檔裡每個 protobuf/gRPC 內容，逐欄註解
node protobuf/pbdecode.mjs capture.har --schema      # 每個內容整理成一份推測的 schema（短很多）
node protobuf/pbdecode.mjs message.bin --protoc      # 輸出跟 protoc --decode_raw 一字不差
```

- 每個欄位都標出 byte 位置。有歧義的地方（length-delimited 欄位可能是字串、bytes、巢狀 message 或 packed 數字）會標成「推論」，並列出其他可能的解讀。
- gRPC 分框：資料框和 trailer 框、`grpc-status`、`application/grpc-web-text`（包括分段 base64）、gzip/deflate 壓縮框。
- `--schema` 會把重複的欄位合併成一棵樹，附上出現次數、數值範圍和範例。少數短字串剛好也能解成 message 時，會用多數決判回字串。

做不到的事：告訴你欄位的「名字」。名字只存在 schema 裡，而 schema 通常藏在 client 程式的某處。

### 2. pyinstaller：解開 PyInstaller 執行檔

```bash
node pyinstaller/pyinst.mjs app.exe            # Python 版本、onefile/onedir、入口程式、app 自己的模組
node pyinstaller/pyinst.mjs app.exe --extract out/
```

- 封存檔後面接著數位簽章也找得到。
- 用內建的小型 `marshal` 讀取器解析模組表，不需要安裝對應版本的 Python。
- 會重建 `.pyc` 檔頭，所以取出的入口程式可以直接執行：`PYTHONPATH=out/PYZ python out/app.pyc`。
- 只列出 app 自己的模組和第三方套件（標準庫以外的部分），通常這才是重點。

把 `.pyc` 反編譯回原始碼不在範圍內，請搭配 pycdc 這類反編譯器。

### 3. hermes：讀取 React Native 的 bundle

```bash
node hermes/hbc.mjs index.android.bundle             # 摘要
node hermes/hbc.mjs index.android.bundle --strings   # 每個字串和它的類型
```

- 檔頭、SHA-1 完整性檢查、函式表（包括函式太大或名稱編號放不下時改用的完整格式），以及字串表（Latin-1、UTF-16、長字串）。
- 自動挑出網址、類似金鑰的字串和 API 路徑，有名字的函式優先列出。

不做反組譯或反編譯，那是 hermes-dec 和 hbctool 的工作。

---

## 🧪 怎麼測試的

| 工具 | 測試 | 結果 |
|---|---|---|
| protobuf | 300 則產生的訊息、500 則隨機改壞的訊息、300 組隨機亂碼，跟 `protoc --decode_raw` 比對 | 輸出逐字相同，連「合不合法」的判斷都一樣 |
| protobuf | HAR 裡的 gRPC-web、grpc-web-text、gzip 壓縮框和一般 `x-protobuf` | 全部解出來，包括 trailer |
| pyinstaller | 用 PyInstaller 打包的範例程式（onefile 和 onedir），Python 3.11 和 3.13 | 取出的每個檔案都跟 pyinstxtractor 逐 byte 相同；還原的 `app.pyc` 輸出跟原執行檔一樣 |
| hermes | 同一份程式用 hermesc 0.8.0、0.11.0 和兩個 1.0.0 版編譯（bytecode v83、v84、v98、v99） | 檔頭、字串、函式全部跟 hermes-dec 一致 |
| hermes | 壓力測試：802 個函式、3,204 個字串、一個 197 KB 的函式 | 一致，每個版本都測到溢位格式 |

自己跑測試（PyInstaller 和 Hermes 的測試需要裝有 `pyinstaller`／`hermes-dec` 的 Python）：

```bash
npm ci
npm run test:protobuf
PYTHON=python3 npm run test:pyinstaller
PYTHON=python3 npm run test:hermes
```

自動測試以外，也拿真實安裝的軟體試過：Chrome 設定檔裡的 93 個 protobuf 檔（跟 protoc 一致）、一個有數位簽章的 Python 3.14 PyInstaller 程式（151 個模組全部解開；沒裝 Python 3.14 時 pyinstxtractor 會跳過），以及 BlueWallet 8.0.2 的 Android bundle（40,594 個函式、109,320 個字串，0.16 秒讀完）。

## 🐛 比對過程發現的問題

- 我自己的解碼器：讀 varint 時可能越過巢狀 message 的邊界；protoc 會默默截斷超過 32 位元的 tag；protoc 巢狀超過 10 層就不再展開。三個都已修正成跟 protoc 一致。
- hermes-dec：只有一個 U+FEFF 字元的字串會被解成空字串，因為 Python 的 `utf-16` 解碼器把它當成位元組順序標記。Hermes 測試裡保留了這個案例。

---

## 📚 背景

這些工具一開始是我研究 [REA](https://github.com/morluto/rea)（一個逆向工程用的 MCP server）時做的原型，有些成果已經回饋給上游：

- [morluto/rea#5029](https://github.com/morluto/rea/pull/5029)：用 JSON 檔指定要分析的檔案（已合併，收錄於 REA 6.8.0）
- [morluto/rea#4986](https://github.com/morluto/rea/issues/4986)：protobuf/gRPC 內容解碼（已在 REA 6.8.0 實作）
- [morluto/rea#7038](https://github.com/morluto/rea/issues/7038)：Hermes bytecode 支援（提案中）

## ⚖️ 使用須知

這些工具是用來理解你擁有或有權檢視的軟體：除錯、相容性、資安研究、學習。它們不會解密任何東西，也不會繞過保護機制。研究任何軟體前，請先確認它的授權條款。

## 📄 授權

[MIT](LICENSE)

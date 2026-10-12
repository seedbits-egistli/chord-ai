# Chord AI

開源（MIT）瀏覽器和弦辨識：麥克風 / 上傳音檔 → 和弦時間軸、移調、吉他／烏克麗麗按法、簡易五線譜、歌詞對齊、匿名發布與搜尋。

**音訊永遠只在瀏覽器處理，不上傳、不存到伺服器。**

## 功能（MVP）

- 輸入：麥克風即時錄音、音檔上傳（無串流平台）
- 和弦：自研 MIT chroma 模板比對（含七和弦、sus、dim、aug、延伸、slash）+ 節拍 / 調性 / Viterbi 平滑
- **進階模式（預設關閉）音源分離**：Open-Unmix **UMX-HQ** ONNX（~34MB vocals+bass，MIT）+ ONNX Runtime Web（WASM／WebGPU；ORT wasm 走 CDN，不進 Workers 靜態資產）。授權見 [`docs/models.md`](docs/models.md)
- 「簡化和弦」滑桿 + click-to-fix 編輯
- 移調 ±半音（升降記號依調）、Capo 建議、按法圖同步
- 歌詞貼上後以時間錨點顯示「和弦在歌詞上方」
- 匿名發布：Cloudflare Turnstile（可關閉）、每 IP 限流、秘密編輯連結、檢舉（可只下架歌詞）
- D1 + FTS5（trigram）搜尋歌名／歌手／歌詞／和弦
- 驗證：合成音準確率 + 本機真實錄音 before/after 分離（不進 git）見 [`docs/validation.md`](docs/validation.md)

## 技術架構

| 層 | 技術 |
|---|---|
| 前端 | Vite + React + TypeScript（Cloudflare Pages） |
| 和弦引擎 | `@chord-ai/engine`（純 TS，Web Worker / Node） |
| API | Cloudflare Workers（Hono） |
| DB | D1（含 FTS5） |
| 按法 | `@tombatossals/chords-db` + `svguitar` |
| 五線譜 | `abcjs`（草稿級 lead sheet） |

## 本機開發

### 需求

- **Node ≥ 22**（見 `.nvmrc`；建議 `nvm use`）
- npm
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/)（已在 root `devDependencies`）
- 真實錄音驗證另需 `ffmpeg`

### 安裝與資料庫

```bash
npm install
npm run build:engine
npm run db:migrate:local
```

### 啟動（三個程序）

```bash
# 終端 1 — API + D1（預設 http://127.0.0.1:8787）
npm run dev -w @chord-ai/worker

# 終端 2 — 前端（http://127.0.0.1:5173，/api 代理到 8787）
npm run dev -w @chord-ai/web
```

或一次啟動：

```bash
npm run dev
```

開啟 http://127.0.0.1:5173 。本機預設 `SKIP_TURNSTILE=1`（見 `wrangler.toml`），發布不必過 Turnstile。

### 測試與驗證

```bash
npm test
npm run validate -w @chord-ai/engine

# 可選：本機真實錄音 + UMX-HQ before/after（勿提交 mp3；首次約 34MB ONNX）
CHORD_AI_TEST_AUDIO=/path/to/dir CHORD_AI_SEPARATE=1 CHORD_AI_SEP_MAX_SEC=60 \
  npm run validate:real -w @chord-ai/engine
```

生產環境可把 ONNX 鏡到 R2，並設定 `VITE_UMX_VOCALS_URL` / `VITE_UMX_BASS_URL`。Pages 使用 COOP + COEP `credentialless`（`web/public/_headers`）以啟用多執行緒 WASM，並允許從 CDN 載入 ORT。`npm run dev` 會先建立 stub `web/dist`（含 `.assetsignore`），fresh clone 不必先 `vite build`。

## 部署到 Cloudflare（不要在此環境執行；需你的帳號）

1. 建立 D1：`wrangler d1 create chord-ai`，把 `database_id` 寫進 `wrangler.toml`
2. 套用 migration：`wrangler d1 migrations apply chord-ai --remote`
3. 設定 Turnstile：在 [Turnstile](https://developers.cloudflare.com/turnstile/) 建立站台，把 site key 放進 `[vars]`，secret 用 `wrangler secret put TURNSTILE_SECRET_KEY`
4. `wrangler secret put IP_HASH_SALT`
5. 正式環境設 `SKIP_TURNSTILE=0`（或刪除該變數）
6. 建置前端並部署：

```bash
npm run build
wrangler deploy
```

`wrangler.toml` 的 `[assets]` 指向 `web/dist`，Worker 同時服務 API 與 SPA。

### Turnstile 測試金鑰

開發可用 Cloudflare 官方測試 key（已寫在 `wrangler.toml`）：

- Site：`1x00000000000000000000AA`
- Secret：`1x0000000000000000000000000000000AA`

## 授權與限制

- 程式碼：**MIT**（見 `LICENSE`）
- 刻意避開 Essentia.js（AGPL）與不可商用的和弦 ML 權重；MVP 用自研模板比對
- 和弦準確率：流行歌主和弦約可預期，七和弦／延伸較低 — 請用編輯器修正（詳見 `docs/validation.md`）
- 歌詞有著作權風險：提供「只下架歌詞」與檢舉流程；上線前請自行評估法律風險
- **請勿把商業錄音或衍生音檔 commit 進 repo**

## 目錄

```
packages/chord-engine/   和弦引擎 + 單元測試 + 驗證腳本
worker/                  Workers API
web/                     Pages SPA
migrations/              D1 SQL
docs/validation.md       準確率報告
docs/models.md           分離模型授權與大小
```

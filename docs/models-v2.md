# 精準 v2 模型（瀏覽器內）與 R2 部署

精準 v2 全部在瀏覽器內執行（onnxruntime-web，wasm EP），音訊不離開裝置：
UMX-HQ 分離（既有）→ Beat This! small 節拍/強拍 → BTC 和弦（大小調＋大詞彙，每首歌自動選）→ wav2vec2 int8 歌詞對齊（只有貼了歌詞才下載）。

## 模型檔

| 檔案 | 大小 | 來源 / 授權 | 何時下載 |
|---|---:|---|---|
| `beat-this-small.onnx` | 10.5 MB | [CPJKU/beat_this](https://github.com/CPJKU/beat_this) small0，程式與權重 MIT（訓練資料部分有版權，作者註明） | 精準 v2 首次分析 |
| `btc-majmin.onnx` | 13.0 MB | [jayg996/BTC-ISMIR19](https://github.com/jayg996/BTC-ISMIR19) MIT（權重隨 repo 釋出；訓練音訊有版權） | 同上 |
| `btc-large.onnx` | 13.1 MB | 同上（170 類大詞彙） | 同上 |
| `wav2vec2-base-960h-int8.onnx` | 95.2 MB | torchaudio `WAV2VEC2_ASR_BASE_960H`（fairseq MIT；LibriSpeech CC-BY 4.0），動態 int8 量化。**不是** MMS（CC-BY-NC） | 只有貼歌詞時 |
| `wav2vec2-labels.json` | <1 KB | 同上 | 同上 |
| UMX-HQ vocals/bass | 約 34 MB | 既有（Hugging Face） | 既有 |

首次（無歌詞）約 37 MB＋UMX 34 MB；有歌詞再加 95 MB。之後都從 Cache Storage 讀。

產生方式：`scripts/models-v2/export.py`（從上游 checkpoint 重新匯出；ONNX 不進 git）。

## 設定

- `VITE_MODEL_BASE_URL`：模型根目錄，例如 `https://models.chord-ai.example/v2`。
- 預設 `/models`：Vite dev server 從 `<repo>/models-v2/`（或 `CHORD_AI_MODELS_DIR`）提供，已 gitignore。
- Pages/Workers 靜態資產每檔上限 25 MiB，所以正式環境模型放 **Cloudflare R2**。

## R2 佈局

```
chord-ai-models/            (bucket)
  v2/beat-this-small.onnx
  v2/btc-majmin.onnx
  v2/btc-large.onnx
  v2/wav2vec2-base-960h-int8.onnx
  v2/wav2vec2-labels.json
```
檔名內容變更時改用新前綴（`v3/`），因為快取是 immutable。

上傳（需要 Cloudflare 帳號權限；bucket 請自行建立）：
```bash
for f in beat-this-small.onnx btc-majmin.onnx btc-large.onnx wav2vec2-base-960h-int8.onnx; do
  npx wrangler r2 object put chord-ai-models/v2/$f --file models-v2/$f \
    --content-type application/octet-stream --cache-control "public, max-age=31536000, immutable" --remote
done
npx wrangler r2 object put chord-ai-models/v2/wav2vec2-labels.json --file models-v2/wav2vec2-labels.json \
  --content-type application/json --cache-control "public, max-age=31536000, immutable" --remote
```

Bucket 要開 public（custom domain 或 r2.dev），並設定 CORS（網站有 COOP/COEP credentialless，跨網域 fetch 需要 CORS）：
```json
[{ "AllowedOrigins": ["https://<你的網域>", "http://localhost:5173"], "AllowedMethods": ["GET", "HEAD"],
   "AllowedHeaders": ["*"], "ExposeHeaders": ["Content-Length"], "MaxAgeSeconds": 86400 }]
```
`npx wrangler r2 bucket cors set chord-ai-models --file cors.json`

## 驗證（Node，同一份 TS 程式碼 + onnxruntime-node）

- `packages/chord-engine/scripts/bench-v2.mts`：節拍＋和弦，輸出給 `score-v2` 計分。
- `packages/chord-engine/scripts/align-v2.mts`：歌詞對齊，與 Python 原型比對。
結果見 `docs/validation.md` 的「精準 v2」一節。

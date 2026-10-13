"""Export the v2 in-browser models to ONNX (run once; outputs are NOT committed).

  python3 -m venv .venv && . .venv/bin/activate
  pip install torch torchaudio onnx onnxruntime pyyaml numpy "beat-this @ git+https://github.com/CPJKU/beat_this.git@b95c8ab0c58c2d9fcfd40508ae8dffbc05ac4f5c"
  git clone https://github.com/jayg996/BTC-ISMIR19 /tmp/btc && (cd /tmp/btc && git checkout 2682317be668032e6e4b269ded36adaa2ad57df0)
  python export.py /tmp/btc ../../models-v2

Produces: btc-majmin.onnx, btc-large.onnx, beat-this-small.onnx, wav2vec2-base-960h-int8.onnx, wav2vec2-labels.json
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
import torch

btc_dir, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)

# --- BTC (MIT). Patch NumPy-2 / PyYAML incompatibilities in the clone. ---
for f in btc_dir.rglob("*.py"):
    s = f.read_text()
    s2 = re.sub(r"np\.float\b", "float", re.sub(r"np\.int\b", "int", s)).replace("yaml.load(f)", "yaml.safe_load(f)")
    if s2 != s:
        f.write_text(s2)
sys.path.insert(0, str(btc_dir))
from btc_model import BTC_model  # noqa: E402
from utils.hparams import HParams  # noqa: E402


class BtcWrap(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        h, _ = self.m.self_attn_layers(x)
        return torch.log_softmax(self.m.output_layer.output_projection(h), -1)


for large, name, ck in ((False, "btc-majmin", "btc_model.pt"), (True, "btc-large", "btc_model_large_voca.pt")):
    c = HParams.load(str(btc_dir / "run_config.yaml"))
    if large:
        c.feature["large_voca"] = True
        c.model["num_chords"] = 170
    m = BTC_model(config=c.model)
    d = torch.load(btc_dir / "test" / ck, map_location="cpu", weights_only=False)
    m.load_state_dict(d["model"])
    w = BtcWrap(m).eval()
    torch.onnx.export(w, torch.randn(1, 108, 144), out / f"{name}.onnx", input_names=["x"], output_names=["logp"],
                      opset_version=17, dynamo=False)
    print(name, "mean/std", float(d["mean"]), float(d["std"]), "(must match BTC_NORM in src/v2/btc.ts)")

# --- Beat This! small (MIT) ---
from beat_this.inference import load_model  # noqa: E402


class BeatWrap(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        o = self.m(x)
        return o["beat"], o["downbeat"]


bw = BeatWrap(load_model("small0", "cpu")).eval()
torch.onnx.export(bw, torch.randn(1, 1500, 128), out / "beat-this-small.onnx", input_names=["spect"],
                  output_names=["beat", "downbeat"], opset_version=17,
                  dynamic_axes={"spect": {1: "T"}, "beat": {1: "T"}, "downbeat": {1: "T"}}, dynamo=False)

# --- wav2vec2 base 960h (torchaudio / fairseq, MIT; LibriSpeech CC-BY 4.0) → int8 ---
import torchaudio  # noqa: E402
from onnxruntime.quantization import QuantType, quantize_dynamic  # noqa: E402

b = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H


class W2V(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        e, _ = self.m(x)
        return torch.log_softmax(e, -1)


fp32 = out / "_w2v-fp32.onnx"
torch.onnx.export(W2V(b.get_model()).eval(), torch.randn(1, 16000 * 20), fp32, input_names=["wav"], output_names=["logp"],
                  opset_version=17, dynamic_axes={"wav": {1: "N"}, "logp": {1: "T"}}, dynamo=False)
quantize_dynamic(str(fp32), str(out / "wav2vec2-base-960h-int8.onnx"), weight_type=QuantType.QInt8)
fp32.unlink()
(out / "wav2vec2-labels.json").write_text(json.dumps(list(b.get_labels())))
print("done:", sorted(p.name for p in out.iterdir()))

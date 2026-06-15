#!/usr/bin/env bash
# Download the silero-vad v6.2 ONNX model (2.3 MB, MIT license)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p models
if [[ -f models/silero_vad.onnx ]]; then
  echo "models/silero_vad.onnx already exists, skipping"
  exit 0
fi
curl -fL -o models/silero_vad.onnx \
  https://raw.githubusercontent.com/snakers4/silero-vad/v6.2/src/silero_vad/data/silero_vad.onnx
echo "downloaded models/silero_vad.onnx"

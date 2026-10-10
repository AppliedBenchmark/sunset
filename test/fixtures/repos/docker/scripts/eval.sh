#!/usr/bin/env bash
set -euo pipefail

cat << 'EOF' > "$HOME/.evalrc"
Don't edit: this file is generated.
EOF

CHUNK=$((1<<20))
export JUDGE_MODEL="${JUDGE_MODEL:=gpt-fixture-2-2099-02-15}"
# sunset-ignore-next-line reason="pinned for the baseline"
python eval.py --model gpt-fixture-retired --chunk "$CHUNK"
# gpt-fixture-retired was the default until it retired.
python eval.py --model gpt-fixture-3

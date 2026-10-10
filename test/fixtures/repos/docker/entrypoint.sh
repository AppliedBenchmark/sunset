#!/bin/sh
set -eu
# default: gpt-fixture-3
MODEL="${MODEL:-gpt-fixture-1-2099-01-10}"
exec python app.py --model "$MODEL" --temperature 0
cat <<EOF > /tmp/config.yaml
model: claude-fixture-1-20990101
EOF
echo 'gemini-fixture-1.0-pro-001'

#!/usr/bin/env bash
# Refresh the forecast: polls -> script calls -> market comparison -> Undertow AI final calls (locked).
set -euo pipefail
cd "$(dirname "$0")/.."
PY=.venv/bin/python
TODAY=$(date +%F)
$PY pipeline/polls.py --office senate
$PY pipeline/polls.py --office governor
$PY pipeline/forecast.py "$TODAY"
$PY pipeline/forecast.py "$TODAY" --governor
$PY pipeline/markets.py
$PY pipeline/synth.py --lock
$PY pipeline/synth.py --governor --lock
echo "refresh done $(date)"

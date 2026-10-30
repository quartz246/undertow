#!/usr/bin/env bash
# Public inputs the pipeline needs (not committed): county presidential results 2020/2024 and county shapes.
set -euo pipefail
cd "$(dirname "$0")/../data/raw"
B=https://raw.githubusercontent.com/tonmcg/US_County_Level_Election_Results_08-24/master
curl -fsSL -o county24.csv "$B/2024_US_County_Level_Presidential_Results.csv"
curl -fsSL -o county20.csv "$B/2020_US_County_Level_Presidential_Results.csv"
[ -f counties-10m.json ] || curl -fsSL -o counties-10m.json https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/counties-10m.json
echo "ok"

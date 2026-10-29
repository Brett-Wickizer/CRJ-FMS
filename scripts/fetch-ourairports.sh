#!/usr/bin/env bash
# Downloads the OurAirports public-domain CSVs used by build-navdata.mjs.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/navsrc/ourairports"
mkdir -p "$DIR"
for f in airports runways navaids; do
  curl -fsSL -o "$DIR/$f.csv" "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/$f.csv"
done
echo "Downloaded to $DIR"

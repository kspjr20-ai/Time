#!/bin/sh
# Baixa os dados brutos do mapa oficial (o mesmo exibido em
# salvadornorteshopping.com.br/mapa-de-lojas) para a pasta indicada.
# Uso: sh fetch_sources.sh <pasta_raw> && python3 build_data.py <pasta_raw> ..
set -e
RAW="${1:?informe a pasta de destino}"
P="-osy3mstlvv1_5l9zicd"
API="https://api.zapt.tech/api/v1"
UA="Mozilla/5.0"
mkdir -p "$RAW/tiles"
curl -fsS -A "$UA" "$API/locals/$P/metadata/map" -o "$RAW/map.json"
curl -fsS -A "$UA" "$API/locals/$P/interests?limit=undefined" -o "$RAW/interests.json"
for f in 0 1 2 3; do
  curl -fsS -A "$UA" "$API/locals/$P-floor$f/metadata/map" -o "$RAW/floor$f.json"
  v=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['local']['tilesInfo']['version'])" "$RAW/floor$f.json")
  for x in 0 1 2 3 4 5 6 7 8 9 10 11; do
    for y in 0 1 2 3 4 5 6 7 8; do
      curl -fsS -A "$UA" "https://cdn.zapt.tech/$P-floor$f/$v-tiles/4/$x/$y.png" -o "$RAW/tiles/${f}_${x}_${y}.png"
    done
  done
done
echo "ok: agora rode build_data.py"

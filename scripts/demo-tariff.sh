#!/usr/bin/env bash
SERVER=http://192.168.1.102:3000
T0=$(( $(date +%s) / 1800 * 1800 ))   # start of the current half hour (Unix seconds)

FORECAST=$(python3 - "$T0" <<'EOF'
import json, sys
t0 = int(sys.argv[1])
# (half hours, price in 1/100 p as the server uses, level 0-4)
bands = [(6, 3500, 3), (4, 3000, 2), (4, 2000, 1), (4, 4500, 4), (8, 800, 0), (22, 2500, 2)]
out, t = [], t0
for count, price, level in bands:
    for _ in range(count):
        out.append({"time": t, "price": price, "priceLevel": level})
        t += 1800
print(json.dumps({"currency": 826, "tariffUnit": 0, "forecast": out}))
EOF
)

curl -sS -X POST "$SERVER/api/price-server/set-price" -H 'Content-Type: application/json' \
  -d '{"price": 3500, "priceLevel": 3, "currency": 826, "tariffUnit": 0}'
echo
curl -sS -X POST "$SERVER/api/price-server/set-forecast" -H 'Content-Type: application/json' -d "$FORECAST"
echo

# Price Server Module

Standalone Matter device for hosting CommodityPrice and ElectricalGridConditions clusters.

## Overview

This module provides:
- **Separate, decoupled module**: Can be run independently or integrated with matterjs-evse-demoui
- **Full Matter commissioning**: Proper passcode, discriminator, and QR code generation
- **Subscription-ready**: EVSE can subscribe to prices/grid data; updates trigger reports automatically
- **HTTP API**: UI can push pricing data via REST endpoints
- **Testable**: Works with Matter-repl and other Matter clients

## Architecture

```
src/price-server/
├── index.ts                           # Main entry point (PriceServer class)
├── device.ts                          # Device/Endpoint definitions
├── api.ts                             # HTTP API endpoints
├── behaviors/
│   ├── commodity-price.ts             # CommodityPrice cluster behavior
│   └── electrical-grid-conditions.ts  # EGC cluster behavior
└── README.md                          # This file
```

## Quick Start

### 1. Integrate into matterjs-evse-demoui

**In `src/index.ts`:**

```typescript
import { initializePriceServer } from "./price-server/index.js";

// ... existing setup ...

const priceServer = await initializePriceServer(environment);

// Register HTTP API
const priceServerHandler = priceServer.getAPIHandler();

// In your request handler:
const handled = await priceServerHandler(pathname, method, body);
if (handled.handled) {
  sendJson(response, handled.statusCode || 200, handled.response);
  return;
}
```

### 2. Run and Commission

```bash
npm run dev

# In another terminal, commission the price server:
Matter-repl> commission <passcode-from-logs>
# You'll see: "Passcode: 20202021"
```

### 3. Set Binding on EVSE

Once both price server (0x2000) and EVSE are commissioned:

```bash
chip-tool write <evse-node-id> Binding Binding '[
  {node: 0x2000, endpoint: 1, cluster: 149},
  {node: 0x2000, endpoint: 1, cluster: 160}
]' --fabric-filtered
```

### 4. Test Price Updates

```bash
# Update current price
curl -X POST http://127.0.0.1:3000/api/price-server/set-price \
  -H "Content-Type: application/json" \
  -d '{
    "price": 3000,
    "priceLevel": 3,
    "currency": 826,
    "tariffUnit": 0
  }'

# EVSE will receive subscription update immediately
# Logs will show: "Price update: level=3"
```

## HTTP API

### Set Current Price

```
POST /api/price-server/set-price
{
  "price": <number>,           # smallest currency unit (e.g., 0.01 pence = 1)
  "priceLevel": <number>,      # 0=very-low, 1=low, 2=medium, 3=high, 4=very-high
  "currency": <number>,        # ISO 4217 code (826 = GBP, 978 = EUR, 840 = USD)
  "tariffUnit": <number>       # 0=kWh, 1=MWh, etc.
}

Response: { "success": true, "price": {...} }
```

### Set Price Forecast

```
POST /api/price-server/set-forecast
{
  "currency": <number>,
  "tariffUnit": <number>,
  "forecast": [
    { "time": <unix-seconds>, "price": <number>, "priceLevel": <number> },
    ...
  ]
}

Response: { "success": true, "periods": <count> }
```

### Set Current Grid Conditions

```
POST /api/price-server/set-grid-conditions
{
  "gridCarbonIntensity": <number>,    # gCO2/kWh
  "carbonLevel": <number>,             # 0=very-low, 1=low, 2=medium, 3=high, 4=very-high
  "region": <string>                   # e.g., "uk", "eu"
}

Response: { "success": true, "conditions": {...} }
```

### Set Grid Forecast

```
POST /api/price-server/set-grid-forecast
{
  "region": <string>,
  "forecast": [
    { "time": <unix-seconds>, "intensity": <number>, "carbonLevel": <number> },
    ...
  ]
}

Response: { "success": true, "periods": <count> }
```

### Get Current Values (Debug)

```
GET /api/price-server/price
GET /api/price-server/grid-conditions
```

## Usage Examples

### From UI Form

```javascript
async function updatePrice(price, level) {
  const response = await fetch('/api/price-server/set-price', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      price: Math.round(price * 100), // Convert £ to pence
      priceLevel: level,
      currency: 826,
      tariffUnit: 0
    })
  });
  return response.json();
}

// Usage:
updatePrice(0.25, 2); // 25p, medium level
```

### From Node.js Code

```typescript
import { PriceServer } from "./price-server/index.js";

const server = new PriceServer();
await server.start(environment);

// Directly update (no HTTP):
server.setPrice(2500, 2, 826); // 25p, medium
server.setGridConditions(150, 2, "uk"); // 150 gCO2/kWh, medium
```

### Fetch and Publish from External API

```typescript
import { PriceServer } from "./price-server/index.js";

const server = new PriceServer();
await server.start(environment);

// Periodically fetch from your data source and publish:
setInterval(async () => {
  const forecast = await fetchFromApi('/api/commodity-price/forecast');
  server.setPriceForecast(
    forecast.map(p => ({
      time: p.period_start,
      price: p.price,
      priceLevel: p.price_level
    }))
  );
}, 30 * 60 * 1000); // Every 30 minutes
```

## Constants

```typescript
PRICE_SERVER_NODE_ID = 0x2000
PRICE_SERVER_PASSCODE = 20202021
PRICE_SERVER_DISCRIMINATOR = 0xf00
```

## Testing with Matter-repl

```bash
# Start Matter-repl
matter-repl

# Commission price server
commission 20202021

# Discover the device
discover

# Read current price
read 0x2000 1 CommodityPrice CurrentPrice

# Watch subscription (if EVSE bound):
subscribe 0x2000 1 CommodityPrice CurrentPrice
# Change price via HTTP
# Should see update in Matter-repl

# Check Descriptor
read 0x2000 0 Descriptor ServerList
# Should show: [91, 160] (CommodityPrice, EGC)
```

## Subscription Flow

```
EVSE at startup:
1. Read own Binding cluster (EP0)
2. Find entry: {node: 0x2000, endpoint: 1, cluster: 149}
3. Establish CASE session to 0x2000
4. Subscribe to CommodityPrice::CurrentPrice on 0x2000:1
5. Receive updates when HTTP API changes price
   └─ matterjs automatically sends subscription reports

UI updates price:
6. POST /api/price-server/set-price
7. CommodityPriceServerBehavior.setCurrentPrice()
8. Attribute update triggers subscription notification
9. EVSE receives report
10. EVSE updates charging based on price level
```

## Troubleshooting

### Price server not commissioning

- Check passcode in logs (should be 20202021)
- Verify environment is properly initialized
- Ensure EVSE and price server use same fabric

### EVSE not subscribing

- Verify Binding entries written correctly: `chip-tool read <evse> 0 Binding Binding`
- Check EVSE logs for subscription errors
- Ensure price server endpoint 1 has clusters advertised in Descriptor

### Subscription updates not received

- Verify HTTP POST to set-price returns 200
- Check price server logs for attribute update confirmation
- Verify EVSE logs show "Price update" message

## Development Notes

### Adding New Attributes

To add a new attribute to CommodityPrice:

1. Update `CommodityPriceServerBehavior` in `behaviors/commodity-price.ts`
2. Add getter/setter methods
3. Add corresponding HTTP API endpoint in `api.ts`
4. Test via HTTP and Matter-repl

### Extending for Other Clusters

This pattern can be extended to other clusters (HVAC, Lighting, etc.):

```typescript
// Create new behavior class
export class MyClusterServerBehavior extends MyCluster.Server {
  // ... implement attributes ...
}

// Add to device.ts endpoints
// Add to api.ts HTTP handlers
```

### Decoupling from matterjs-evse-demoui

To run price server independently:

```typescript
// price-server-standalone.ts
import { Environment } from "@matter/main";
import { initializePriceServer } from "./price-server/index.js";

const environment = new Environment();
const server = await initializePriceServer(environment);

// Start HTTP server for API
// ...
```

---

For more information, see `../ARCHITECTURE.md` for full system integration details.

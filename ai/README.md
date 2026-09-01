# Matter EVSE Demo: AI Context

## Purpose

Build a local, browser-based UI commissioner and controller for Matter EVSE
(Electric Vehicle Supply Equipment) devices. The application is a demonstrator,
not a production energy-management system. It uses Matter.js from a Node.js
backend and presents the controller state in a web UI.

The intended protocol baseline is Matter 1.5. Pin and test the Matter.js
version selected for implementation: Matter.js skipped an exact 1.5 release,
and its 0.17.x line maps to Matter 1.5.1. Newer Matter.js releases include
Matter 1.6 model changes, so do not accidentally rely on those additions when
claiming a 1.5 demo.

## Non-negotiable design decisions

- Keep Matter.js in a Node.js process. A browser UI must call a local API or
  WebSocket service; it cannot directly own Matter fabrics, credentials, or
  multicast discovery.
- Target the modern Matter.js controller model: `ServerNode` with
  `ControllerBehavior`, then one `ClientNode` per commissioned peer. The
  initial runnable scaffold pins the currently published 0.17.9 release and
  isolates its temporary `CommissioningController` compatibility adapter in
  `src/matter-controller.ts`; migrate that adapter when the peer API is
  available in the selected release.
- Persist Matter state in a named Matter.js `StorageService` location with a
  stable controller ID. Store application-only state separately from
  Matter.js's fabric/peer state.
- Discover capabilities from Descriptor (`DeviceTypeList`, `ServerList`, and
  `PartsList`) and cluster presence. Never assume endpoint `1`, or that EVSE
  and Device Energy Management (DEM) are on the same endpoint.
- Treat all optional features, attributes, and commands as capability-gated.
  Device support varies materially in real EVSE implementations.
- Use timed invokes for EVSE control commands. Home Assistant's Matter tests
  use a 3-second timed request for `EnergyEvse.Disable` and
  `EnergyEvse.EnableCharging`.
- Decommission a reachable device remotely before deleting local peer state.
  A local-only delete/clean-context action does not remove this controller's
  fabric from the EVSE; label a force-forget path clearly.

## Matter functionality in scope

### Energy EVSE

Discover the Energy EVSE cluster (`0x0099`) and device type (`0x050C`).
Display, when supported:

- EVSE state, supply state, and fault state.
- Circuit capacity/current limits and charge-current settings.
- Session ID, duration, and energy charged/discharged.
- Charging and discharging expiry times.
- SoC, when the EVSE exposes the SoC feature.

Initial control actions:

- `Disable`.
- `EnableCharging(chargingEnabledUntil, minimumChargeCurrent,
  maximumChargeCurrent)`.

The UI wording must distinguish “charging enabled” from “currently charging”:
the latter also depends on plug, vehicle demand, faults, schedules, and device
state.

### Charging preferences

The Matter feature is **Charging Preferences** (`PREF`), not a generic
"Energy Preferences" command. When present, it supplies:

- `SetTargets`, `GetTargets`, and `ClearTargets`.
- Weekly charging-target schedules.
- Target completion time plus either added-energy or target-SoC intent.
- Next-charge start/end and required-energy attributes.

Build the preferences form only after capability discovery. Validate mutually
exclusive/required target fields according to the selected specification
version, send changes with `SetTargets`, then read back the device state.

### EVSE modes

Energy EVSE Mode (`0x009D`) can expose modes such as Manual, Time of Use,
Solar Charging, and V2X. Render device-advertised `SupportedModes`, not a
hard-coded list, and write only the selected supported mode.

Time-of-use mode means the EVSE attempts to schedule from targets. It does not
standardize tariff acquisition or prescribe an optimization algorithm.

### Device Energy Management

Discover Device Energy Management (DEM, `0x0098`) independently, including
its device type (`0x050D`). The future EMS should:

1. Read the advertised ESA state, forecast, absolute min/max power, power
   adjustment capability, and opt-out state.
2. Calculate an adjustment from the local solar, grid, home-load, tariff, and
   charging-target model.
3. Send `PowerAdjustRequest` only if supported and permitted; surface the
   response and respect cancellation/expiry/opt-out.

Direct EVSE enable/current-limit commands remain permission and charge-control
actions. DEM is the standardized surface for app EMS power adjustments.

## Tariffs and EMS boundary

Tariff-provider authentication, tariff retrieval, price normalization,
cost-optimization policy, billing, and choosing the relationship between a
tariff and an EVSE are application responsibilities. Matter does not define
them.

For an Octopus Agile demo, use an adapter that fetches half-hour price slots,
normalizes them into an internal tariff model, caches the source timestamp,
and permits a deterministic fixture/offline mode. Make its tariff endpoint,
region/product selection, units, timezone, and stale-data policy explicit in
settings. Do not expose credentials to the browser.

Commodity Price (`0x0095`) is a provisional Matter price/forecast distribution
cluster available in the Matter 1.5 era, but device support should not be
assumed. Commodity Tariff (`0x0700`) is richer but is provisional and tied to
later 1.6 work; exclude it from the strict Matter 1.5 baseline. The demo's
portable control output is therefore EVSE targets/mode or DEM requests, even
when its input originates from tariff data.

## Recommended architecture

```text
apps/
  controller-service/       Node.js + TypeScript + Matter.js
    matter/                 controller lifecycle, discovery, subscriptions
    evse/                   capability mapper and command services
    ems/                    deterministic local EMS policy and simulation
    tariffs/                Octopus adapter, fixture adapter, normalization
    api/                    REST commands and WebSocket/SSE state stream
  web/                      React + TypeScript UI
packages/
  contracts/                API DTOs and validation schemas; no Matter internals
  domain/                   units, tariff slots, EMS calculation, scheduling
data/                       ignored runtime storage and development fixtures
```

Keep protocol adapters at the service edge. UI components consume a normalized
`EvseViewModel`, not raw Matter attributes. Model every displayed field as
`supported`, `unavailable`, `stale`, or `error`; never display zero as a
stand-in for an unsupported attribute.

Publish state changes from Matter subscriptions to the UI. Commands should
return a command ID and state/result, and the UI should reconcile with
subscribed device state rather than assuming command success changed every
attribute.

## Initial user journeys

1. **Commission new device:** accept QR/manual pairing code, optionally gather
   network credentials where needed, run discovery and commissioning, then
   show progress/errors and capability discovery.
2. **Commissioned devices:** list stable node identity, reachability, detected
   endpoints/clusters, last update, and actions.
3. **Decommission:** provide a button per device. Confirm remote
   decommission, report errors without discarding the peer record, and offer
   clearly separate force-forget only when remote decommission cannot occur.
4. **Clean context:** confirm whether this means remote decommission of every
   reachable peer followed by local reset, or explicit local-only reset.
   Stop/close the controller before erasing its persistence.
5. **EVSE dashboard:** show charger state and telemetry plus enable/disable
   controls for one selected EVSE.

## Home Assistant reference

Home Assistant is useful as a behavioral/UI reference, but it uses
`python-matter-server`, not Matter.js. In particular:

- Its Matter API commissions a supplied code through
  `matter_client.commission_with_code`
  ([source](https://github.com/home-assistant/core/blob/dev/homeassistant/components/matter/api.py)).
- It maps EVSE `SupplyState` to a charging switch and sends timed `Disable` /
  `EnableCharging` commands
  ([implementation](https://github.com/home-assistant/core/blob/dev/homeassistant/components/matter/switch.py),
  [tests](https://github.com/home-assistant/core/blob/dev/tests/components/matter/test_switch.py)).
- It presents EVSE charging/supply status as binary sensors, state/fault and
  capacity/session information as sensors, and EVSE modes as selects
  ([binary sensors](https://github.com/home-assistant/core/blob/dev/homeassistant/components/matter/binary_sensor.py),
  [sensors](https://github.com/home-assistant/core/blob/dev/homeassistant/components/matter/sensor.py),
  [modes](https://github.com/home-assistant/core/blob/dev/homeassistant/components/matter/select.py)).

Reuse the capability-driven entity mapping and timed-command behavior, not its
Python APIs or persistence model.

## Authoritative implementation references

- [Matter.js controller migration guide](https://github.com/matter-js/matter.js/blob/main/docs/MIGRATION_CONTROLLER_018.md)
- [Matter.js compatibility policy](https://github.com/matter-js/matter.js/blob/main/docs/MATTER_COMPATIBILITY.md)
- [Matter.js Energy EVSE model](https://github.com/matter-js/matter.js/blob/main/packages/model/src/standard/elements/energy-evse-cluster.element.ts)
- [Matter.js DEM model](https://github.com/matter-js/matter.js/blob/main/packages/model/src/standard/elements/device-energy-management-cluster.element.ts)
- [CSA Matter specifications portal](https://csa-iot.org/developer-resource/specifications-download-request/)

Use the exact CSA Matter 1.5 specification as the normative source whenever a
generated Matter.js or connectedhomeip model differs or is ambiguous.

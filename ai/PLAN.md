# Delivery Plan

## Constraints and success criteria

Target a local TypeScript application with a real Matter.js controller backend
and a browser UI. Initial success means a user can commission an EVSE, retain
that context across restart, decommission one device safely, deliberately
clear local context, and view/control a discovered EVSE without endpoint or
feature assumptions.

All Matter interactions must work with actual devices where possible and with
a controllable development fixture/device simulator otherwise. Device
capabilities determine what the UI enables.

## Phase 0: Bootstrap and test harness

1. Create a TypeScript workspace with `controller-service`, `web`, shared
   `contracts`, and shared unit-tested `domain` packages.
2. Pin the Matter.js release and record its Matter compatibility. Establish a
   version-upgrade check that identifies generated model changes.
3. Create ignored runtime storage and an explicit development reset mechanism.
4. Add a simulated EVSE/DEM test harness or test doubles for commissioner,
   subscriptions, timed invokes, and command failures.
5. Add unit tests for contracts, unit conversions, capability mapping, and
   lifecycle state transitions.

**Exit criterion:** backend and web app run locally, data does not enter
version control, and automated tests run without physical hardware.

## Phase 1: Controller lifecycle and commissioner

1. Instantiate a persistent non-commissionable Matter.js controller; the
   initial 0.17.9 scaffold uses an isolated `CommissioningController`
   compatibility adapter, which should migrate to `ServerNode` with
   `ControllerBehavior` when the selected release exposes the peer API.
2. Implement commissioning from QR/manual code with progress stages:
   validation, discovery, PASE, attestation, network provisioning where
   relevant, fabric commissioning, and endpoint discovery.
3. Persist and list commissioned peers with reachability, node identity, and
   discovery timestamp.
4. Implement remote decommission as the default per-device action. Preserve
   local context if the remote operation fails; implement force-forget as a
   separately confirmed recovery action.
5. Implement clean context as a workflow: attempt remote decommission for
   reachable peers, show unresolved peers, stop/close controller, and only
   then erase local Matter storage after confirmation. Also support an
   explicitly named local-only reset for test recovery.

**Exit criterion:** restart retains commissioned nodes; remote decommission
removes this fabric from a reachable test device; no reset operation silently
leaves a device's fabric behind.

## Phase 2: EVSE discovery, telemetry, and basic control

1. Traverse Descriptor data and endpoints. Detect Energy EVSE (`0x0099`) and
   DEM (`0x0098`) separately and build a capability report per device.
2. Subscribe/read EVSE attributes. Normalize states, units, null values,
   unavailable values, timestamps, and errors into UI DTOs.
3. Build the charger dashboard: state, supply state, fault state, current and
   circuit limits, power (when available), session duration, and session
   energy. Show raw units only in a diagnostics view.
4. Add capability-gated timed `Disable` and `EnableCharging` commands. The
   enable dialog accepts expiry and safe min/max current values, validates
   against device limits, and displays command errors.
5. Test unsupported fields, offline devices, timed-command failure, fault
   state, stale subscriptions, and a non-default EVSE endpoint.

**Exit criterion:** a supported physical or simulated EVSE can be enabled and
disabled, and the UI reflects subscribed device state rather than optimistic
local state.

## Phase 3: Charging preferences and modes

1. Gate this phase on EVSE `PREF` support.
2. Implement read/edit/clear charging targets for day-of-week, completion
   time, added energy, and target SoC according to the selected Matter 1.5
   schema.
3. Present next-charge information returned by the EVSE. Do not claim that a
   schedule was optimized unless the device reports it.
4. Add an EVSE mode selector driven by advertised `SupportedModes`, including
   Manual and Time of Use only where supplied by the device.
5. Test target serialization, validation, read-after-write, and devices that
   support one target type but not the other.

**Exit criterion:** charging-target intent survives UI reload because the
device remains the source of truth, and unsupported preference controls never
appear actionable.

## Phase 4: Tariff demonstration

1. Define a provider-neutral tariff contract: region/product, currency,
   price unit, start/end instants, import/export direction, source timestamp,
   and confidence/stale status.
2. Implement an Octopus Agile adapter plus a fixed fixture adapter. Convert
   provider prices into a canonical minor-currency-per-kWh unit and use
   timezone-aware half-hour intervals.
3. Provide tariff settings and a clear mode selector:
   - **Manual:** user controls enable/current and targets.
   - **Device TOU:** send charging targets/select EVSE TOU mode; device owns
     scheduling.
   - **App EMS:** app calculates controls/DEM requests from tariff and local
     energy conditions.
4. Make source failures, stale data, missing future slots, and pricing units
   visible. Use fixture data by default in demonstrations that must work
   offline.
5. Keep Commodity Price optional and diagnostic-only unless a selected device
   demonstrably supports it. Do not require Commodity Tariff in the 1.5
   product path.

**Exit criterion:** the UI can explain the tariff input, selected operating
mode, and the resulting schedule/control action without suggesting that
Matter standardized the tariff provider integration.

## Phase 5: Virtual home energy model and DEM EMS

1. Build deterministic sliders for solar generation, grid import/export,
   home load, and an EVSE demand/limit model. Display a signed power balance
   and retain a reproducible scenario seed.
2. Add a pure, tested EMS calculation that prioritizes safety/device
   constraints, opt-out, charging targets/deadlines, solar preference, grid
   limits, then tariff cost. The calculation returns a decision plus
   explanation, not a Matter command.
3. Add a Matter DEM adapter that checks advertised capabilities and opt-out,
   converts an eligible decision to `PowerAdjustRequest`, handles expiry and
   cancellation, and records request/result history.
4. Render why a request was or was not sent. Never conceal unsupported DEM,
   rejected requests, device opt-out, or a fallback to direct EVSE controls.
5. Test power balance, priorities, constraints, opt-out, future target
   deadlines, request cancellation, and offline/recovery behavior.

**Exit criterion:** sliders change a transparent EMS recommendation and, for
a compatible non-opted-out device, issue standards-aligned DEM power-adjust
requests.

## Cross-cutting implementation rules

- Use UTC instants internally and a configured local timezone for all tariff
  and charging-target presentation.
- Use integer/decimal value objects for energy, power, current, money, and
  time; do not use binary floating point for tariff costs or energy targets.
- Audit every command with requested payload, node/endpoint, response, and
  correlation ID. Never store pairing codes, network credentials, or API keys
  in browser state or logs.
- UI errors must name whether a failure is discovery, reachability,
  authorization, unsupported capability, validation, timed invoke, or device
  rejection.
- Retain a diagnostics page for endpoint topology, cluster/feature discovery,
  raw attribute timestamps, and command history.

## Deferred scope

Do not include in the first demo: production multi-user authentication,
remote internet access, billing, real grid-service integration (OpenADR/IEEE
2030.5), automatic device firmware updates, multi-EVSE optimization, DC
charging support, or guarantees about EV/PLC interoperability.

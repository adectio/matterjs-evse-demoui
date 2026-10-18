const days = [
    ["monday", "Mon"], ["tuesday", "Tue"], ["wednesday", "Wed"], ["thursday", "Thu"],
    ["friday", "Fri"], ["saturday", "Sat"], ["sunday", "Sun"],
];
const nodeSelect = document.querySelector("#node-select");
const endpointSelect = document.querySelector("#endpoint-select");
const dayPicker = document.querySelector("#day-picker");
const targetList = document.querySelector("#target-list");
const result = document.querySelector("#preferences-result");
const emptyState = document.querySelector("#preferences-empty-state");
const status = document.querySelector("#status");
const efficiencyValue = document.querySelector("#efficiency-value");
const efficiencyUnit = document.querySelector("#efficiency-unit");
const selectedDays = new Set();
let preferences;

for (const [day, label] of days) {
    const button = document.createElement("button");
    button.className = "day-toggle";
    button.dataset.day = day;
    button.textContent = label;
    button.type = "button";
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
        if (selectedDays.has(day)) selectedDays.delete(day);
        else selectedDays.add(day);
        button.setAttribute("aria-pressed", String(selectedDays.has(day)));
    });
    dayPicker.append(button);
}

nodeSelect.addEventListener("change", loadEndpoints);
endpointSelect.addEventListener("change", loadPreferences);
document.querySelector("#add-target").addEventListener("click", () => addTarget());
document.querySelector("#save-targets").addEventListener("click", saveTargets);
document.querySelector("#clear-targets").addEventListener("click", clearTargets);
const EFFICIENCY_UNIT_KEY = "chargingPreferencesEfficiencyUnit";
const KM_PER_MILE = 1.609344;
try {
    const savedUnit = localStorage.getItem(EFFICIENCY_UNIT_KEY);
    if ([...efficiencyUnit.options].some(option => option.value === savedUnit)) efficiencyUnit.value = savedUnit;
} catch {
    // The remembered unit is only a convenience
}
let currentEfficiencyUnit = efficiencyUnit.value;
efficiencyUnit.addEventListener("change", changeEfficiencyUnit);
addTarget();
loadNodes();

async function loadNodes() {
    try {
        const response = await fetch("/api/nodes");
        const { nodes, error } = await response.json();
        if (!response.ok) throw new Error(error ?? "Unable to list commissioned nodes.");
        nodeSelect.replaceChildren(...nodes.map(node => new Option(nodeDisplayName(node), node.nodeId)));
        nodeSelect.disabled = nodes.length === 0;
        const selected = localStorage.getItem("selectedMatterNodeId");
        if (nodes.some(node => node.nodeId === selected)) nodeSelect.value = selected;
        if (nodeSelect.value) await loadEndpoints();
    } catch (error) {
        showStatus(error.message, true);
    }
}

async function loadEndpoints() {
    localStorage.setItem("selectedMatterNodeId", nodeSelect.value);
    endpointSelect.disabled = true;
    endpointSelect.replaceChildren(new Option("Loading EVSE endpoints…", ""));
    try {
        const response = await fetch(`/api/evses?nodeId=${encodeURIComponent(nodeSelect.value)}`);
        const { evses, error } = await response.json();
        if (!response.ok) throw new Error(error ?? "Unable to discover EVSE endpoints.");
        endpointSelect.replaceChildren(...evses.map(evse => new Option(`EVSE endpoint ${evse.endpointId}`, evse.endpointId)));
        endpointSelect.disabled = evses.length === 0;
        const selected = localStorage.getItem("selectedChargingPreferencesEndpointId");
        if (evses.some(evse => String(evse.endpointId) === selected)) endpointSelect.value = selected;
        if (endpointSelect.value) await loadPreferences();
    } catch (error) {
        showStatus(error.message, true);
    }
}

async function loadPreferences() {
    if (!nodeSelect.value || !endpointSelect.value) return;
    localStorage.setItem("selectedChargingPreferencesEndpointId", endpointSelect.value);
    showStatus("Loading charging targets…");
    try {
        const response = await fetch(targetsUrl());
        const { preferences: nextPreferences, error } = await response.json();
        if (!response.ok) throw new Error(error ?? "Unable to retrieve charging targets.");
        preferences = nextPreferences;
        renderPreferences();
        showStatus("");
    } catch (error) {
        preferences = undefined;
        renderPreferences();
        showStatus(error.message, true);
    }
}

/**
 * Target rows follow the selected EVSE's SoC Reporting feature:
 *  - "soc": Target SoC is mandatory and AddedEnergy is an optional fallback for EVs that don't report SoC
 *  - "energy": AddedEnergy is the main target and TargetSoC may only be omitted or 100% (charge until full)
 */
function targetMode() {
    return preferences?.supportsSoC === true ? "soc" : "energy";
}

function addTarget(departureTime = "07:00") {
    if (targetList.children.length >= 10) return;
    const row = document.createElement("div");
    row.className = "target-row";
    row.dataset.mode = targetMode();
    if (row.dataset.mode === "soc") {
        row.innerHTML = `
          <label>Departure time <input class="target-time" type="time" required /></label>
          <label>Target SoC (%) <input class="target-soc" type="number" min="1" max="100" step="1" value="80" required /></label>
          <label><span class="range-label"></span> <input class="target-range" type="number" min="0.1" step="0.1" placeholder="Optional" /></label>
          <p class="muted target-hint">The fallback range is used if the plugged-in EV doesn't report its SoC. Without it, such an EV is charged until full.</p>`;
    } else {
        row.innerHTML = `
          <label>Departure time <input class="target-time" type="time" required /></label>
          <label><span class="range-label"></span> <input class="target-range" type="number" min="0.1" step="0.1" value="20" /></label>
          <label class="checkbox-label"><input class="target-full" type="checkbox" /> Also send Target SoC 100%</label>
          <p class="muted target-hint">This EVSE can't read the EV's SoC. Leave the range empty and tick 100% to charge until the EV is full.</p>`;
    }
    row.querySelector(".target-time").value = departureTime;

    const remove = document.createElement("button");
    remove.className = "secondary remove-target";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => row.remove());
    row.querySelector(".target-hint").before(remove);
    targetList.append(row);
    updateTargetValueLabel(row);
}

/** Rebuild the target rows (keeping departure times) when the selected EVSE has different capabilities */
function applyTargetCapabilities() {
    const rows = [...targetList.children];
    if (rows.length > 0 && rows.every(row => row.dataset.mode === targetMode())) return;
    const departureTimes = rows.map(row => row.querySelector(".target-time").value);
    targetList.replaceChildren();
    for (const departureTime of departureTimes.length ? departureTimes : ["07:00"]) addTarget(departureTime);
}

function updateRangeLabels() {
    for (const row of targetList.children) updateTargetValueLabel(row);
}

function updateTargetValueLabel(row) {
    const prefix = row.dataset.mode === "soc" ? "Fallback added range" : "Added range";
    row.querySelector(".range-label").textContent = `${prefix} (${rangeUnitLabel()})`;
}

function rangeUnitLabel() {
    return efficiencyUnit.value === "mi-per-kwh" ? "mi" : "km";
}

async function saveTargets() {
    try {
        const targets = collectTargets();
        const body = { days: [...selectedDays], targets };
        if (targets.some(target => target.addedEnergy !== undefined)) {
            body.approximateEvEfficiency = convertEfficiency();
        }
        showStatus("Setting charging targets…");
        const response = await fetch(targetsUrl(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Unable to set charging targets.");
        preferences = payload.preferences;
        renderPreferences();
        showStatus("Targets set. Read back from the EVSE.");
    } catch (error) {
        showStatus(error.message, true);
    }
}

async function clearTargets() {
    if (!nodeSelect.value || !endpointSelect.value || !confirm("Clear every charging target stored by this EVSE?")) return;
    try {
        showStatus("Clearing charging targets…");
        const response = await fetch(targetsUrl(), { method: "DELETE" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Unable to clear charging targets.");
        preferences = payload.preferences;
        renderPreferences();
        showStatus("All charging targets cleared. Read back from the EVSE.");
    } catch (error) {
        showStatus(error.message, true);
    }
}

function collectTargets() {
    if (!nodeSelect.value || !endpointSelect.value) throw new Error("Select a Matter node and EVSE endpoint.");
    if (!selectedDays.size) throw new Error("Select at least one day.");
    return [...targetList.children].map(row => {
        const [hours, minutes] = row.querySelector(".target-time").value.split(":").map(Number);
        if (!Number.isInteger(hours) || !Number.isInteger(minutes)) throw new Error("Each target needs a departure time.");
        const target = { departureMinutes: hours * 60 + minutes };

        const rangeText = row.querySelector(".target-range").value.trim();
        if (rangeText !== "") {
            const range = Number(rangeText);
            if (!Number.isFinite(range) || range <= 0) throw new Error("Added range must be a positive number.");
            const rangeKm = range * kmPerRangeUnit(efficiencyUnit.value);
            target.addedEnergy = Math.round((rangeKm / rangePerKwh()) * 1_000_000);
        }

        if (row.dataset.mode === "soc") {
            target.targetSoC = validSoC(Number(row.querySelector(".target-soc").value));
        } else if (row.querySelector(".target-full").checked) {
            target.targetSoC = 100;
        }

        if (target.targetSoC === undefined && target.addedEnergy === undefined) {
            throw new Error("Each target needs an added range, or Target SoC 100% to charge until full.");
        }
        return target;
    });
}

function validSoC(value) {
    if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error("Target SoC must be a whole percentage from 1 to 100.");
    return value;
}

function convertEfficiency() {
    const value = Number(efficiencyValue.value);
    if (!Number.isFinite(value) || value <= 0) throw new Error("Enter a positive vehicle efficiency for range targets.");
    return Math.round(rangePerKwh() * 1000);
}

/** Vehicle efficiency in km/kWh from the efficiency field */
function rangePerKwh() {
    return kmPerKwhFrom(Number(efficiencyValue.value), efficiencyUnit.value);
}

function kmPerKwhFrom(value, unit) {
    if (unit === "mi-per-kwh") return value * KM_PER_MILE;
    if (unit === "km-per-kwh") return value;
    return 100 / value; // kWh per 100 km
}

function efficiencyIn(kmPerKwh, unit) {
    if (unit === "mi-per-kwh") return kmPerKwh / KM_PER_MILE;
    if (unit === "km-per-kwh") return kmPerKwh;
    return 100 / kmPerKwh;
}

/** Range targets are entered in miles for mi/kWh and in km otherwise */
function kmPerRangeUnit(unit) {
    return unit === "mi-per-kwh" ? KM_PER_MILE : 1;
}

/** Convert the efficiency and any entered ranges so they keep their meaning in the new unit */
function changeEfficiencyUnit() {
    const previous = currentEfficiencyUnit;
    const next = efficiencyUnit.value;
    const efficiency = Number(efficiencyValue.value);
    if (Number.isFinite(efficiency) && efficiency > 0) {
        efficiencyValue.value = efficiencyIn(kmPerKwhFrom(efficiency, previous), next).toFixed(2);
    }
    const factor = kmPerRangeUnit(previous) / kmPerRangeUnit(next);
    for (const input of targetList.querySelectorAll(".target-range")) {
        if (input.value.trim() !== "") input.value = (Number(input.value) * factor).toFixed(1);
    }
    currentEfficiencyUnit = next;
    try {
        localStorage.setItem(EFFICIENCY_UNIT_KEY, next);
    } catch {
        // The remembered unit is only a convenience
    }
    updateRangeLabels();
}

function renderPreferences() {
    result.replaceChildren();
    emptyState.hidden = preferences !== undefined;
    if (preferences === undefined) return;
    if (preferences.approximateEvEfficiency !== null) {
        // Show the EVSE's value (stored as km/kWh x 1000) in the user's chosen unit
        efficiencyValue.value = efficiencyIn(preferences.approximateEvEfficiency / 1000, efficiencyUnit.value).toFixed(2);
    }
    applyTargetCapabilities();
    if (preferences.schedules.length === 0) {
        result.textContent = "No charging targets are stored on this EVSE.";
        return;
    }
    for (const schedule of preferences.schedules) {
        const card = document.createElement("div");
        card.className = "stored-schedule";
        const heading = document.createElement("strong");
        heading.textContent = schedule.days.map(day => day.slice(0, 3)).join(", ");
        const list = document.createElement("ul");
        for (const target of schedule.targets) {
            const item = document.createElement("li");
            item.textContent = `${formatMinutes(target.departureMinutes)} — ${formatTarget(target)}`;
            list.append(item);
        }
        card.append(heading, list);
        result.append(card);
    }
}

function formatTarget(target) {
    if (!preferences.supportsSoC) {
        // Without SoC reporting, AddedEnergy takes precedence and TargetSoC can only be 100%
        return target.addedEnergy !== null ? formatAddedEnergy(target.addedEnergy) : "Charge until full";
    }
    if (target.targetSoC === null) return formatAddedEnergy(target.addedEnergy);
    const fallback = target.addedEnergy !== null ? formatAddedEnergy(target.addedEnergy) : "charge until full";
    return `${target.targetSoC}% SoC (${fallback} if the EV doesn't report SoC)`;
}

function formatMinutes(value) {
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function formatAddedEnergy(value) {
    if (value === null) return "No target";
    const kwh = value / 1_000_000;
    if (preferences.approximateEvEfficiency === null) return `${kwh.toFixed(2)} kWh added`;
    const km = kwh * (preferences.approximateEvEfficiency / 1000);
    const range = km / kmPerRangeUnit(efficiencyUnit.value);
    return `${kwh.toFixed(2)} kWh added (≈ ${range.toFixed(1)} ${rangeUnitLabel()})`;
}

function targetsUrl() {
    return `/api/evses/${nodeSelect.value}/${endpointSelect.value}/charging-targets`;
}

function nodeDisplayName(node) {
    return node.nodeName
        ? `${node.nodeName} (${displayNodeId(node.nodeId)})`
        : [`Node ${displayNodeId(node.nodeId)}`, node.productName].filter(Boolean).join(" · ");
}

/** Node IDs are shown in hex, as in Matter tooling (the API still uses decimal) */
function displayNodeId(nodeId) {
    return `0x${BigInt(nodeId).toString(16).toUpperCase().padStart(4, "0")}`;
}

function showStatus(message, isError = false) {
    status.textContent = message;
    status.className = isError ? "error" : "";
}

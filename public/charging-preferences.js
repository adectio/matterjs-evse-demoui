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
const efficiencySettings = document.querySelector("#efficiency-settings");
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
efficiencyUnit.addEventListener("change", updateRangeLabels);
addTarget();
loadNodes();

async function loadNodes() {
    try {
        const response = await fetch("/api/nodes");
        const { nodes, error } = await response.json();
        if (!response.ok) throw new Error(error ?? "Unable to list commissioned nodes.");
        nodeSelect.replaceChildren(...nodes.map(node => new Option(`Node ${node.nodeId}`, node.nodeId)));
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

function addTarget() {
    if (targetList.children.length >= 10) return;
    const row = document.createElement("div");
    row.className = "target-row";
    row.innerHTML = `
      <label>Departure time <input class="target-time" type="time" value="07:00" required /></label>
      <label>Target type <select class="target-type"><option value="range">Added range</option><option value="soc">Target SoC</option></select></label>
      <label class="target-value-label">Added range <input class="target-value" type="number" min="0.1" step="0.1" value="20" required /></label>`;
    const remove = document.createElement("button");
    remove.className = "secondary remove-target";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
        row.remove();
        updateRangeSettingsVisibility();
    });
    row.append(remove);
    row.querySelector(".target-type").addEventListener("change", () => updateTargetType(row));
    targetList.append(row);
    applyTargetCapabilities(row);
    updateTargetValueLabel(row);
    updateRangeSettingsVisibility();
}

function updateTargetType(row) {
    const isRange = row.querySelector(".target-type").value === "range";
    const input = row.querySelector(".target-value");
    input.min = isRange ? "0.1" : "1";
    input.max = isRange ? "" : "100";
    input.step = isRange ? "0.1" : "1";
    input.value = isRange ? "20" : "80";
    updateTargetValueLabel(row);
    updateRangeSettingsVisibility();
}

function applyTargetCapabilities(row) {
    const type = row.querySelector(".target-type");
    const rangeOption = type.querySelector('option[value="range"]');
    rangeOption.disabled = preferences?.supportsSoC === true;
    if (preferences?.supportsSoC === true && type.value === "range") {
        type.value = "soc";
        updateTargetType(row);
    }
}

function updateRangeSettingsVisibility() {
    efficiencySettings.hidden = ![...targetList.querySelectorAll(".target-type")].some(select => select.value === "range");
}

function updateRangeLabels() {
    for (const row of targetList.children) updateTargetValueLabel(row);
}

function updateTargetValueLabel(row) {
    const label = row.querySelector(".target-value-label");
    const isRange = row.querySelector(".target-type").value === "range";
    label.firstChild.textContent = isRange ? `Added range (${rangeUnitLabel()}) ` : "Target SoC ";
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
        const value = Number(row.querySelector(".target-value").value);
        if (!Number.isFinite(value) || value <= 0) throw new Error("Each target needs a positive value.");
        if (row.querySelector(".target-type").value === "soc") {
            if (!Number.isInteger(value) || value > 100) throw new Error("Target SoC must be a whole percentage from 1 to 100.");
            return { departureMinutes: hours * 60 + minutes, targetSoC: value };
        }
        return { departureMinutes: hours * 60 + minutes, addedEnergy: Math.round((value / rangePerKwh()) * 1_000_000) };
    });
}

function convertEfficiency() {
    const value = Number(efficiencyValue.value);
    if (!Number.isFinite(value) || value <= 0) throw new Error("Enter a positive vehicle efficiency for range targets.");
    return Math.round(rangePerKwh() * 1000);
}

function rangePerKwh() {
    const value = Number(efficiencyValue.value);
    if (efficiencyUnit.value === "mi-per-kwh") return value * 1.609344;
    if (efficiencyUnit.value === "km-per-kwh") return value;
    return 100 / value;
}

function renderPreferences() {
    result.replaceChildren();
    emptyState.hidden = preferences !== undefined;
    if (preferences === undefined) return;
    if (preferences.approximateEvEfficiency !== null) {
        efficiencyValue.value = (preferences.approximateEvEfficiency / 1000).toFixed(2);
        efficiencyUnit.value = "km-per-kwh";
        updateRangeLabels();
    }
    for (const row of targetList.children) applyTargetCapabilities(row);
    if (preferences.schedules.length === 0) {
        result.textContent = preferences.supportsSoC
            ? "No charging targets are stored on this EVSE. This SoC-reporting EVSE requires SoC targets."
            : "No charging targets are stored on this EVSE.";
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
            item.textContent = `${formatMinutes(target.departureMinutes)} — ${target.targetSoC !== null ? `${target.targetSoC}% SoC` : formatAddedEnergy(target.addedEnergy)}`;
            list.append(item);
        }
        card.append(heading, list);
        result.append(card);
    }
}

function formatMinutes(value) {
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function formatAddedEnergy(value) {
    if (value === null) return "No target";
    const kwh = value / 1_000_000;
    if (preferences.approximateEvEfficiency === null) return `${kwh.toFixed(2)} kWh added`;
    const km = kwh * (preferences.approximateEvEfficiency / 1000);
    return `${kwh.toFixed(2)} kWh added (≈ ${km.toFixed(1)} km)`;
}

function targetsUrl() {
    return `/api/evses/${nodeSelect.value}/${endpointSelect.value}/charging-targets`;
}

function showStatus(message, isError = false) {
    status.textContent = message;
    status.className = isError ? "error" : "";
}

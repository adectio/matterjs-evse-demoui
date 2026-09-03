const evseList = document.querySelector("#evse-list");
const emptyState = document.querySelector("#empty-state");
const status = document.querySelector("#status");
const nodeSelect = document.querySelector("#node-select");
let updateTimer;
let chargingControlsActive = false;
let refreshPending = false;

nodeSelect.addEventListener("change", () => {
    localStorage.setItem("selectedMatterNodeId", nodeSelect.value);
    loadEvses();
});

async function loadNodes() {
    try {
        const response = await fetch("/api/nodes");
        const { nodes, error } = await response.json();
        if (!response.ok) throw new Error(error ?? "Unable to list commissioned nodes.");

        const previouslySelected = localStorage.getItem("selectedMatterNodeId");
        nodeSelect.replaceChildren(...nodes.map(node => new Option(`Node ${node.nodeId}`, node.nodeId)));
        nodeSelect.disabled = nodes.length === 0;

        if (nodes.some(node => node.nodeId === previouslySelected)) {
            nodeSelect.value = previouslySelected;
        }
        if (nodeSelect.value) {
            await loadEvses();
        } else {
            evseList.replaceChildren();
            emptyState.hidden = false;
            status.textContent = "";
        }
    } catch (error) {
        status.textContent = error.message;
        status.className = "error";
    }
}

async function loadEvses() {
    if (!nodeSelect.value) return;
    if (chargingControlsActive) {
        refreshPending = true;
        return;
    }

    status.textContent = "Refreshing EVSE state…";
    try {
        const response = await fetch(`/api/evses?nodeId=${encodeURIComponent(nodeSelect.value)}`);
        const { evses, error } = await response.json();
        if (!response.ok) throw new Error(error ?? "Unable to retrieve EVSE state.");
        evseList.replaceChildren(...evses.map(renderEvse));
        emptyState.hidden = evses.length > 0;
        status.textContent = evses.length ? `Live updates connected for ${evses.length} EVSE endpoint(s).` : "";
        status.className = "";
    } catch (error) {
        status.textContent = error.message;
        status.className = "error";
    }
}

const stream = new EventSource("/api/evses/events");
stream.addEventListener("evse-change", () => {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(loadEvses, 200);
});
stream.onerror = () => {
    status.textContent = "Live update connection lost; reconnecting…";
    status.className = "error";
};

evseList.addEventListener("focusin", event => {
    if (event.target.closest(".charging-controls")) {
        chargingControlsActive = true;
    }
});

evseList.addEventListener("focusout", event => {
    if (!event.target.closest(".charging-controls")) return;
    setTimeout(() => {
        if (evseList.contains(document.activeElement) && document.activeElement.closest(".charging-controls")) return;
        chargingControlsActive = false;
        if (refreshPending) {
            refreshPending = false;
            loadEvses();
        }
    });
});

function renderEvse(evse) {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `
      <div class="section-heading">
        <div><h2>EVSE endpoint ${evse.endpointId}</h2><p class="muted"><code>Node ${evse.nodeId}</code></p></div>
        <span class="badge ${evse.state === 3 ? "good" : ""}">${stateLabel(evse.state)}</span>
      </div>
      <h3>Main status</h3>
      <dl class="metrics">
        ${metric("EV plugged in", isPluggedIn(evse.state) ? "Yes" : evse.state === null ? "Unavailable" : "No", isPluggedIn(evse.state) ? "good" : "neutral")}
        ${metric("Charging", chargingLabel(evse.state), chargingStatus(evse.state))}
        ${metric("Supply", supplyLabel(evse.supplyState))}
        ${metric("Fault", faultLabel(evse.faultState))}
        ${metric("Session energy", energy(evse.sessionEnergyCharged))}
        ${metric("Session duration", duration(evse.sessionDuration))}
        ${metric("Effective charge limit", effectiveChargeLimit(evse))}
        ${metric("Circuit capacity", current(evse.circuitCapacity))}
      </dl>
      <h3>Power meter${evse.powerMeterEndpointId === null ? "" : ` · endpoint ${evse.powerMeterEndpointId}`}</h3>
      <dl class="metrics">
        ${metric("Active power", power(evse.activePower))}
        ${metric("Voltage", voltage(evse.voltage))}
        ${metric("Current", current(evse.activeCurrent))}
      </dl>
      <h3>Charging preferences</h3>
      <dl class="metrics">
        ${metric("Next charging time", time(evse.nextChargeStartTime))}
        ${metric("Target completion", time(evse.nextChargeTargetTime))}
        ${metric("Required energy", energy(evse.nextChargeRequiredEnergy))}
        ${metric("Target SoC", percent(evse.nextChargeTargetSoC))}
        ${metric("Charging enabled until", chargingEnabledUntil(evse))}
      </dl>`;

    if (isSupplyEnabled(evse.supplyState)) {
        const control = document.createElement("button");
        control.className = "charging-control";
        control.textContent = "Disable charging";
        control.addEventListener("click", () => disableCharging(evse, control));
        card.append(control);
    } else {
        card.append(createChargingControls(evse));
    }
    return card;
}

function createChargingControls(evse) {
    const form = document.createElement("form");
    form.className = "charging-controls";

    const minimumInput = currentInput("Minimum current (mA)", defaultMinimumChargeCurrent(evse), 6_000);
    const maximumInput = currentInput("Maximum current", defaultMaximumChargeCurrent(evse, Number(minimumInput.value)), Number(minimumInput.value));
    maximumInput.min = minimumInput.value;
    minimumInput.addEventListener("input", () => {
        maximumInput.min = minimumInput.value;
        if (Number(maximumInput.value) < Number(minimumInput.value)) {
            maximumInput.value = minimumInput.value;
        }
    });

    const control = document.createElement("button");
    control.type = "submit";
    control.textContent = "Enable charging";
    form.append(minimumInput.parentElement, maximumInput.parentElement, control);
    form.addEventListener("submit", event => {
        event.preventDefault();
        enableCharging(evse, control, Number(minimumInput.value), Number(maximumInput.value));
    });
    return form;
}

function currentInput(labelText, value, minimum) {
    const label = document.createElement("label");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = "number";
    input.min = minimum;
    input.step = 1_000;
    input.value = value;
    input.required = true;
    input.inputMode = "numeric";
    label.append(input);
    return input;
}

async function enableCharging(evse, control, minimumChargeCurrent, maximumChargeCurrent) {
    if (!Number.isInteger(minimumChargeCurrent) || minimumChargeCurrent < 6_000) {
        showChargingError("Minimum charge current must be at least 6 A.", control);
        return;
    }
    if (!Number.isInteger(maximumChargeCurrent) || maximumChargeCurrent < minimumChargeCurrent) {
        showChargingError("Maximum charge current must be greater than or equal to the minimum.", control);
        return;
    }
    await sendChargingCommand(evse, control, { minimumChargeCurrent, maximumChargeCurrent });
}

async function disableCharging(evse, control) {
    await sendChargingCommand(evse, control, { minimumChargeCurrent: 6_000, maximumChargeCurrent: 6_000 });
}

async function sendChargingCommand(evse, control, chargeCurrentLimits) {
    control.disabled = true;
    control.classList.add("is-busy");
    status.textContent = "Sending EVSE charging command…";
    try {
        const response = await fetch(`/api/evses/${evse.nodeId}/${evse.endpointId}/toggle-charging`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(chargeCurrentLimits),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Charging command failed.");
        status.textContent = `${result.status} Waiting for the EVSE state update…`;
        status.className = "";
        chargingControlsActive = false;
        refreshPending = false;
        loadEvses();
    } catch (error) {
        status.textContent = error.message;
        status.className = "error";
        control.disabled = false;
        control.classList.remove("is-busy");
    }
}

function showChargingError(message, control) {
    status.textContent = message;
    status.className = "error";
    control.disabled = false;
    control.classList.remove("is-busy");
}

function metric(name, value, status = "") {
    return `<div class="${status}"><dt>${name}</dt><dd>${value}</dd></div>`;
}

function stateLabel(value) {
    return ["Not plugged in", "Plugged in: no demand", "Plugged in: demand", "Charging", "Discharging", "Session ending", "Fault"][value] ?? "Unavailable";
}

function supplyLabel(value) {
    return ["Disabled", "Charging enabled", "Discharging enabled", "Disabled: error", "Disabled: diagnostics", "Charging/discharging enabled"][value] ?? "Unavailable";
}

function isSupplyEnabled(value) {
    return value === 1 || value === 2 || value === 5;
}

function faultLabel(value) {
    return value === 0 ? "No fault" : value === null ? "Unavailable" : `Fault code ${value}`;
}

function isPluggedIn(value) {
    return value !== null && value >= 1 && value <= 5;
}

function chargingLabel(value) {
    if (value === 3) return "Charging";
    if (value === 4) return "Discharging";
    return "Not charging";
}

function chargingStatus(value) {
    if (value === 3) return "good";
    if (value === 4) return "warning";
    return "neutral";
}

function current(value) {
    return value === null ? "Unavailable" : `${(value / 1000).toFixed(1)} A`;
}

function effectiveChargeLimit(evse) {
    if (evse.maximumChargeCurrent === null) return "Unavailable";
    if (evse.maximumChargeCurrent === 0) return "Disabled (0.0 A)";
    return current(evse.maximumChargeCurrent);
}

function defaultMinimumChargeCurrent(evse) {
    return Math.max(6_000, evse.minimumChargeCurrent ?? 0);
}

function defaultMaximumChargeCurrent(evse, minimumChargeCurrent) {
    const deviceCeiling = evse.circuitCapacity ?? evse.maximumChargeCurrent ?? 0;
    return Math.max(minimumChargeCurrent, deviceCeiling);
}

function energy(value) {
    return value === null ? "Unavailable" : `${(value / 1_000_000).toFixed(2)} kWh`;
}

function power(value) {
    return value === null ? "Unavailable" : `${(value / 1_000_000).toFixed(2)} kW`;
}

function voltage(value) {
    return value === null ? "Unavailable" : `${(value / 1000).toFixed(1)} V`;
}

function duration(value) {
    return value === null ? "Unavailable" : `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m ${value % 60}s`;
}

function percent(value) {
    return value === null ? "Unavailable" : `${value}%`;
}

function time(value) {
    if (value === null) return "Unavailable";
    if (value === 0) return "Not scheduled";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(Date.UTC(2000, 0, 1) + value * 1000),
    );
}

function chargingEnabledUntil(evse) {
    if (!isSupplyEnabled(evse.supplyState)) return "Disabled";
    if (evse.chargingEnabledUntil === null) return "Indefinitely";
    return time(evse.chargingEnabledUntil);
}

loadNodes();

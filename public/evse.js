const evseList = document.querySelector("#evse-list");
const emptyState = document.querySelector("#empty-state");
const status = document.querySelector("#status");
const nodeSelect = document.querySelector("#node-select");
let updateTimer;

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
        ${metric("EV plugged in", isPluggedIn(evse.state) ? "Yes" : evse.state === null ? "Unavailable" : "No")}
        ${metric("Charging", evse.state === 3 ? "Charging" : "Not charging")}
        ${metric("Supply", supplyLabel(evse.supplyState))}
        ${metric("Fault", faultLabel(evse.faultState))}
        ${metric("Session energy", energy(evse.sessionEnergyCharged))}
        ${metric("Session duration", duration(evse.sessionDuration))}
        ${metric("Current range", currentRange(evse))}
        ${metric("Circuit capacity", current(evse.circuitCapacity))}
      </dl>
      <h3>Charging preferences</h3>
      <dl class="metrics">
        ${metric("Next charging time", time(evse.nextChargeStartTime))}
        ${metric("Target completion", time(evse.nextChargeTargetTime))}
        ${metric("Required energy", energy(evse.nextChargeRequiredEnergy))}
        ${metric("Target SoC", percent(evse.nextChargeTargetSoC))}
        ${metric("Charging enabled until", time(evse.chargingEnabledUntil))}
      </dl>`;
    return card;
}

function metric(name, value) {
    return `<div><dt>${name}</dt><dd>${value}</dd></div>`;
}

function stateLabel(value) {
    return ["Not plugged in", "Plugged in: no demand", "Plugged in: demand", "Charging", "Discharging", "Session ending", "Fault"][value] ?? "Unavailable";
}

function supplyLabel(value) {
    return ["Disabled", "Charging enabled", "Discharging enabled", "Disabled: error", "Disabled: diagnostics", "Charging/discharging enabled"][value] ?? "Unavailable";
}

function faultLabel(value) {
    return value === 0 ? "No fault" : value === null ? "Unavailable" : `Fault code ${value}`;
}

function isPluggedIn(value) {
    return value !== null && value >= 1 && value <= 5;
}

function current(value) {
    return value === null ? "Unavailable" : `${(value / 1000).toFixed(1)} A`;
}

function currentRange(evse) {
    if (evse.minimumChargeCurrent === null || evse.maximumChargeCurrent === null) return "Unavailable";
    return `${current(evse.minimumChargeCurrent)} – ${current(evse.maximumChargeCurrent)}`;
}

function energy(value) {
    return value === null ? "Unavailable" : `${(value / 1_000_000).toFixed(2)} kWh`;
}

function duration(value) {
    return value === null ? "Unavailable" : `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`;
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

loadNodes();

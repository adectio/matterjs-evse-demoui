const evseList = document.querySelector("#evse-list");
const emptyState = document.querySelector("#empty-state");
const status = document.querySelector("#status");
const nodeSelect = document.querySelector("#node-select");
let updateTimer;
let chargingControlsActive = false;
let refreshPending = false;
// Chart.js instances keyed by chart id, kept across the frequent card re-renders so tooltips stay usable
const forecastCharts = new Map();
let priceForecastCache = { fetchedAt: 0, data: null };
let carbonForecastCache = { fetchedAt: 0, data: null };
const PRICE_FORECAST_MAX_AGE_MS = 5 * 60 * 1000;

const ForecastUpdateReason = Object.freeze({
    InternalOptimization: 0,
    LocalOptimization: 1,
    GridOptimization: 2,
});

const EnergyEvseState = Object.freeze({
    NotPluggedIn: 0,
    PluggedInNoDemand: 1,
    PluggedInDemand: 2,
    Charging: 3,
    Discharging: 4,
    SessionEnding: 5,
    Fault: 6,
});

const EnergyEvseSupplyState = Object.freeze({
    Disabled: 0,
    ChargingEnabled: 1,
    DischargingEnabled: 2,
    DisabledError: 3,
    DisabledDiagnostics: 4,
    Enabled: 5,
});

const EnergyEvseFaultState = Object.freeze({
    NoError: 0,
    MeterFailure: 1,
    OverVoltage: 2,
    UnderVoltage: 3,
    OverCurrent: 4,
    ContactWetFailure: 5,
    ContactDryFailure: 6,
    GroundFault: 7,
    PowerLoss: 8,
    PowerQuality: 9,
    PilotShortCircuit: 10,
    EmergencyStop: 11,
    EvDisconnected: 12,
    WrongPowerSupply: 13,
    LiveNeutralSwap: 14,
    OverTemperature: 15,
    Other: 255,
});

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
        nodeSelect.replaceChildren(...nodes.map(node => new Option(nodeLabel(node), node.nodeId)));
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
        const hasForecast = evses.some(evse => evse.forecast !== null);
        const [prices, carbon] = hasForecast ? await Promise.all([loadPriceForecast(), loadCarbonForecast()]) : [null, null];
        evseList.replaceChildren(...evses.map(renderEvse));
        placeForecastCharts(evses, prices, carbon);
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
    if (event.target.closest(".evse-controls")) {
        chargingControlsActive = true;
    }
});

evseList.addEventListener("focusout", event => {
    if (!event.target.closest(".evse-controls")) return;
    setTimeout(() => {
        if (evseList.contains(document.activeElement) && document.activeElement.closest(".evse-controls")) return;
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
    const faultActive = hasActiveFault(evse);
    card.innerHTML = `
      <div class="section-heading">
        <div><h2>EVSE endpoint ${evse.endpointId}</h2><p class="muted"><code>Node ${displayNodeId(evse.nodeId)}</code></p></div>
        <span class="badge ${evse.state === EnergyEvseState.Charging ? "good" : ""}">${stateLabel(evse.state)}</span>
      </div>
      <h3>Main status</h3>
      <dl class="metrics">
        ${metric("EV plugged in", pluggedInLabel(evse.state), pluggedInStatus(evse.state))}
        ${metric("Charging", chargingLabel(evse), chargingStatus(evse))}
        ${metric("Supply", supplyLabel(evse.supplyState))}
        ${metric("Fault", faultLabel(evse.faultState, faultActive), faultActive ? "warning" : "")}
        ${metric("Session energy", energy(evse.sessionEnergyCharged))}
        ${metric("Session duration", duration(evse.sessionDuration))}
        ${metric("Effective charge limit", effectiveChargeLimit(evse))}
        ${metric("User charge limit", current(evse.userMaximumChargeCurrent))}
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
      </dl>
      ${renderForecast(evse)}`;

    card.append(createUserChargeLimitControls(evse));
    if (faultActive) {
        const message = document.createElement("p");
        message.className = "muted";
        message.textContent = "Charging controls are unavailable while the EVSE reports a fault.";
        card.append(message);
    } else if (isSupplyEnabled(evse.supplyState)) {
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
    form.className = "charging-controls evse-controls";

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

function createUserChargeLimitControls(evse) {
    const container = document.createElement("section");
    container.className = "user-current-limit";

    const heading = document.createElement("h3");
    heading.textContent = "User charge limit";
    container.append(heading);

    if (evse.circuitCapacity === null || evse.circuitCapacity < 0) {
        const message = document.createElement("p");
        message.className = "muted";
        message.textContent = "A user charge limit can be set after the EVSE reports its circuit capacity.";
        container.append(message);
        return container;
    }

    const form = document.createElement("form");
    form.className = "user-current-limit-controls evse-controls";
    const label = document.createElement("label");
    label.htmlFor = `user-current-limit-${evse.nodeId}-${evse.endpointId}`;
    label.textContent = "Maximum current";
    const range = document.createElement("input");
    range.type = "range";
    range.id = label.htmlFor;
    range.min = "0";
    range.max = String(evse.circuitCapacity);
    range.step = "1000";
    range.value = String(clampChargeCurrent(evse.userMaximumChargeCurrent, evse.circuitCapacity));
    const value = document.createElement("output");
    value.textContent = current(Number(range.value));
    range.addEventListener("input", () => {
        value.textContent = current(Number(range.value));
    });

    const control = document.createElement("button");
    control.type = "submit";
    control.textContent = "Apply limit";
    form.append(label, range, value, control);
    form.addEventListener("submit", event => {
        event.preventDefault();
        setUserChargeLimit(evse, control, Number(range.value));
    });
    container.append(form);
    return container;
}

function clampChargeCurrent(value, maximum) {
    if (!Number.isSafeInteger(value)) return maximum;
    return Math.min(Math.max(value, 0), maximum);
}

async function setUserChargeLimit(evse, control, userMaximumChargeCurrent) {
    control.disabled = true;
    control.classList.add("is-busy");
    status.textContent = "Updating user charge limit…";
    try {
        const response = await fetch(`/api/evses/${evse.nodeId}/${evse.endpointId}/user-maximum-charge-current`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userMaximumChargeCurrent }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Unable to update the user charge limit.");
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

function forecastChartId(evse) {
    return `forecast-chart-${evse.nodeId}-${evse.endpointId}`;
}

function renderForecast(evse) {
    const forecast = evse.forecast;
    if (forecast === null) {
        return `
      <h3>Charging forecast</h3>
      <p class="muted">No Device Energy Management forecast. The EVSE publishes one when an EV is plugged in, charging is enabled and a charging target is set.</p>`;
    }

    const plannedEnergy = forecast.slots.reduce((total, slot) => total + (slot.nominalEnergy ?? 0), 0);
    const rows = forecast.slots
        .map((slot, index) => {
            const charging = (slot.nominalPower ?? 0) > 0;
            const rowClass = index === forecast.activeSlotNumber ? "active" : charging ? "" : "idle";
            return `<tr class="${rowClass}">
              <td>${index + 1}</td>
              <td>${clockTime(slot.startTime)}</td>
              <td>${shortDuration(slot.duration)}</td>
              <td>${charging ? power(slot.nominalPower) : "Off"}</td>
              <td>${charging ? energy(slot.nominalEnergy) : "—"}</td>
            </tr>`;
        })
        .join("");

    return `
      <h3>Charging forecast</h3>
      <dl class="metrics">
        ${metric("Forecast ID", forecast.forecastId)}
        ${metric("Starts", time(forecast.startTime))}
        ${metric("Ends", time(forecast.endTime))}
        ${metric("Must finish by", forecast.latestEndTime === null ? "Not set" : time(forecast.latestEndTime))}
        ${metric("Planned energy", energy(plannedEnergy))}
        ${metric("Planned by", forecastReasonLabel(forecast.forecastUpdateReason))}
      </dl>
      <div class="forecast-chart" data-chart-id="${forecastChartId(evse)}"></div>
      <table class="forecast-slots">
        <thead><tr><th>Slot</th><th>Start</th><th>Duration</th><th>Power</th><th>Energy</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
}

function forecastReasonLabel(value) {
    return {
        [ForecastUpdateReason.InternalOptimization]: "EVSE (internal optimisation)",
        [ForecastUpdateReason.LocalOptimization]: "Local energy manager",
        [ForecastUpdateReason.GridOptimization]: "Grid",
    }[value] ?? `Unknown (${value})`;
}

async function loadPriceForecast() {
    if (Date.now() - priceForecastCache.fetchedAt < PRICE_FORECAST_MAX_AGE_MS) return priceForecastCache.data;
    let data = null;
    try {
        const response = await fetch(`/api/commodity-price/forecast?hours=48&from=${chartHistoryFrom()}`);
        if (response.ok) data = await response.json();
    } catch {
        // The tariff overlay is optional
    }
    priceForecastCache = { fetchedAt: Date.now(), data };
    return data;
}

/**
 * Re-use each existing chart when its inputs haven't changed (EVSE session counters change every second),
 * otherwise draw a new one. Charts are redrawn at least once a minute so the "Now" marker moves.
 */
/** A forecast can have started a while ago (its first slot still running), so fetch some history too */
function chartHistoryFrom() {
    return Math.floor(Date.now() / 1000) - 6 * 3600;
}

async function loadCarbonForecast() {
    if (Date.now() - carbonForecastCache.fetchedAt < PRICE_FORECAST_MAX_AGE_MS) return carbonForecastCache.data;
    let data = null;
    try {
        const response = await fetch(`/api/grid-conditions/forecast?region=uk&hours=48&from=${chartHistoryFrom()}`);
        if (response.ok) data = await response.json();
    } catch {
        // The carbon overlay is optional
    }
    carbonForecastCache = { fetchedAt: Date.now(), data };
    return data;
}

function placeForecastCharts(evses, prices, carbon) {
    const placed = new Set();
    for (const evse of evses) {
        const id = forecastChartId(evse);
        const placeholder = evseList.querySelector(`[data-chart-id="${id}"]`);
        if (evse.forecast === null || placeholder === null || typeof Chart === "undefined") continue;

        const signature = JSON.stringify([
            evse.forecast,
            priceForecastCache.fetchedAt,
            carbonForecastCache.fetchedAt,
            Math.floor(Date.now() / 60_000),
        ]);
        const existing = forecastCharts.get(id);
        if (existing?.signature === signature) {
            placeholder.replaceWith(existing.container);
        } else {
            existing?.chart.destroy();
            const canvas = document.createElement("canvas");
            canvas.setAttribute("aria-label", "Forecast charging power and tariff");
            placeholder.append(canvas);
            forecastCharts.set(id, { chart: drawForecastChart(canvas, evse.forecast, prices, carbon), container: placeholder, signature });
        }
        placed.add(id);
    }

    for (const [id, entry] of forecastCharts) {
        if (placed.has(id)) continue;
        entry.chart.destroy();
        forecastCharts.delete(id);
    }
}

function drawForecastChart(canvas, forecast, prices, carbon) {
    const now = Date.now();
    // A margin either side keeps the "Now" and "Must finish by" lines inside the plot rather than on its edges
    const MARGIN_MS = 15 * 60 * 1000;
    const xMin = Math.min(now, forecast.startTime * 1000) - MARGIN_MS;
    const xMax = Math.max(forecast.endTime, forecast.latestEndTime ?? 0) * 1000 + MARGIN_MS;

    // Each slot holds its power until the next slot starts
    const powerPoints = forecast.slots.map(slot => ({ x: slot.startTime * 1000, y: (slot.nominalPower ?? 0) / 1_000_000 }));
    powerPoints.push({ x: forecast.endTime * 1000, y: 0 });
    const maxPower = Math.max(1, ...forecast.slots.map(slot => (slot.maxPower ?? slot.nominalPower ?? 0) / 1_000_000));

    const datasets = [
        {
            label: "Forecast power (kW)",
            data: powerPoints,
            pointStyle: "rect",
            // Chart.js "before": hold each value until the next point (a slot keeps its power until the next slot)
            stepped: "before",
            fill: "origin",
            borderColor: "#0073e6",
            backgroundColor: "rgba(0, 115, 230, 0.25)",
            pointRadius: 0,
            yAxisID: "power",
        },
    ];
    const markers = [{ x: now, label: "Now", color: "#60708a" }];
    if (forecast.latestEndTime !== null) {
        markers.push({ x: forecast.latestEndTime * 1000, label: "Must finish by", color: "#c83f54" });
    }

    const decimals = prices?.metadata?.decimals ?? 2;
    const pricePoints = (prices?.forecast ?? [])
        .filter(period => period.price !== null && period.periodEnd * 1000 > xMin && period.periodStart * 1000 < xMax)
        .sort((a, b) => a.periodStart - b.periodStart)
        .flatMap((period, index, periods) => {
            const point = { x: period.periodStart * 1000, y: period.price / 10 ** decimals };
            // Close off the final period
            return index === periods.length - 1 ? [point, { x: period.periodEnd * 1000, y: point.y }] : [point];
        });
    const estimatedPoints = (prices?.estimated ?? [])
        .filter(period => period.periodEnd * 1000 > xMin && period.periodStart * 1000 < xMax)
        .sort((a, b) => a.periodStart - b.periodStart)
        .flatMap((period, index, periods) => {
            const point = { x: period.periodStart * 1000, y: period.price / 10 ** decimals };
            return index === periods.length - 1 ? [point, { x: period.periodEnd * 1000, y: point.y }] : [point];
        });
    const tariffUnit = prices?.metadata?.currency === "GBP" || prices?.metadata?.currency === undefined ? "p" : prices.metadata.currency;
    if (pricePoints.length > 0) {
        datasets.push({
            label: `${prices.priceSource?.name ?? "Tariff"} (${tariffUnit}/kWh)`,
            data: pricePoints,
            stepped: "before",
            pointStyle: "line",
            borderColor: "#f57c00",
            borderWidth: 1.5,
            pointRadius: 0,
            yAxisID: "price",
        });
    }

    if (estimatedPoints.length > 0) {
        datasets.push({
            label: `Estimated tariff (${tariffUnit}/kWh)`,
            data: estimatedPoints,
            stepped: "before",
            pointStyle: "line",
            borderColor: "#f57c00",
            borderDash: [6, 4],
            borderWidth: 1.5,
            pointRadius: 0,
            yAxisID: "price",
        });
    }

    const carbonPoints = (carbon?.forecast ?? [])
        .filter(period => period.gridCarbonIntensity != null && (period.periodEnd ?? period.periodStart + 1800) * 1000 > xMin && period.periodStart * 1000 < xMax)
        .sort((a, b) => a.periodStart - b.periodStart)
        .flatMap((period, index, periods) => {
            const point = { x: period.periodStart * 1000, y: period.gridCarbonIntensity };
            const end = (period.periodEnd ?? period.periodStart + 1800) * 1000;
            return index === periods.length - 1 ? [point, { x: end, y: point.y }] : [point];
        });
    if (carbonPoints.length > 0) {
        datasets.push({
            label: "Grid carbon (gCO₂/kWh)",
            data: carbonPoints,
            stepped: "before",
            pointStyle: "line",
            borderColor: "#2e7d32",
            borderWidth: 1.5,
            pointRadius: 0,
            yAxisID: "carbon",
        });
    }

    alignStepSeries(datasets, xMin, xMax);

    return new Chart(canvas, {
            type: "line",
            data: { datasets },
            plugins: [markerLinesPlugin],
            options: {
                animation: false,
                maintainAspectRatio: false,
                parsing: false,
                interaction: { mode: "nearest", axis: "x", intersect: false },
                plugins: {
                    legend: { position: "top", labels: { usePointStyle: true } },
                    markerLines: { markers },
                    tooltip: {
                        // Every series has a point at the same times (see alignStepSeries), so all appear together
                        callbacks: { title: items => (items.length ? clockTime(items[0].parsed.x / 1000) : "") },
                    },
                },
                scales: {
                    x: {
                        type: "linear",
                        min: xMin,
                        max: xMax,
                        ticks: { callback: value => clockTime(value / 1000), maxRotation: 0 },
                    },
                    power: {
                        position: "left",
                        beginAtZero: true,
                        suggestedMax: maxPower,
                        title: { display: true, text: "kW" },
                    },
                    price: {
                        display: pricePoints.length > 0 || estimatedPoints.length > 0,
                        position: "right",
                        beginAtZero: true,
                        grid: { drawOnChartArea: false },
                        title: { display: true, text: "Tariff" },
                    },
                    carbon: {
                        display: carbonPoints.length > 0,
                        position: "right",
                        beginAtZero: true,
                        grid: { drawOnChartArea: false },
                        title: { display: true, text: "gCO₂/kWh" },
                    },
                },
            },
        });
}

/** Labelled vertical lines (e.g. "Now") drawn over the chart; they aren't data, so stay out of the legend and tooltip */
const markerLinesPlugin = {
    id: "markerLines",
    afterDatasetsDraw(chart, _args, options) {
        const { ctx, chartArea, scales } = chart;
        for (const marker of options.markers ?? []) {
            const x = scales.x.getPixelForValue(marker.x);
            if (x < chartArea.left || x > chartArea.right) continue;
            ctx.save();
            ctx.strokeStyle = marker.color;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(x, chartArea.top);
            ctx.lineTo(x, chartArea.bottom);
            ctx.stroke();
            // Label beside the line, flipped to the left near the right-hand edge
            const nearRight = x > chartArea.right - 100;
            ctx.setLineDash([]);
            ctx.fillStyle = marker.color;
            ctx.font = "12px sans-serif";
            ctx.textAlign = nearRight ? "right" : "left";
            ctx.fillText(marker.label, x + (nearRight ? -4 : 4), chartArea.top + 12);
            ctx.restore();
        }
    },
};

const HALF_HOUR_MS = 30 * 60 * 1000;

/**
 * Resample step series (each holding its value until its next point) onto one shared set of times: every half
 * hour plus every point where any series changes. The lines draw the same, but the tooltip's nearest-point lookup
 * then finds every series at the same time, rather than only the one that changes most often (e.g. carbon versus
 * a custom tariff with a few long periods).
 */
function alignStepSeries(datasets, xMin, xMax) {
    const times = new Set();
    for (let x = Math.floor(xMin / HALF_HOUR_MS) * HALF_HOUR_MS; x <= xMax; x += HALF_HOUR_MS) times.add(x);
    for (const dataset of datasets) for (const point of dataset.data) times.add(point.x);
    const grid = [...times].sort((a, b) => a - b);

    for (const dataset of datasets) {
        const points = dataset.data;
        if (points.length === 0) continue;
        const first = points[0].x;
        const last = points[points.length - 1].x;
        let index = 0;
        dataset.data = grid
            .filter(x => x >= first && x <= last)
            .map(x => {
                while (index + 1 < points.length && points[index + 1].x <= x) index++;
                return { x, y: points[index].y };
            });
    }
}

function clockTime(seconds) {
    return new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(seconds * 1000));
}

function shortDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** Node IDs are shown in hex, as in Matter tooling (the API still uses decimal) */
function displayNodeId(nodeId) {
    return `0x${BigInt(nodeId).toString(16).toUpperCase().padStart(4, "0")}`;
}

function nodeLabel(node) {
    if (node.nodeName) return `${node.nodeName} (${displayNodeId(node.nodeId)})`;
    return [`Node ${displayNodeId(node.nodeId)}`, node.productName].filter(Boolean).join(" · ");
}

function metric(name, value, status = "") {
    return `<div class="${status}"><dt>${name}</dt><dd>${value}</dd></div>`;
}

function stateLabel(value) {
    return {
        [EnergyEvseState.NotPluggedIn]: "Not plugged in",
        [EnergyEvseState.PluggedInNoDemand]: "Plugged in: no demand",
        [EnergyEvseState.PluggedInDemand]: "Plugged in: demand",
        [EnergyEvseState.Charging]: "Charging",
        [EnergyEvseState.Discharging]: "Discharging",
        [EnergyEvseState.SessionEnding]: "Session ending",
        [EnergyEvseState.Fault]: "Fault",
    }[value] ?? "Unavailable";
}

function supplyLabel(value) {
    return {
        [EnergyEvseSupplyState.Disabled]: "Disabled",
        [EnergyEvseSupplyState.ChargingEnabled]: "Charging enabled",
        [EnergyEvseSupplyState.DischargingEnabled]: "Discharging enabled",
        [EnergyEvseSupplyState.DisabledError]: "Disabled: error",
        [EnergyEvseSupplyState.DisabledDiagnostics]: "Disabled: diagnostics",
        [EnergyEvseSupplyState.Enabled]: "Charging/discharging enabled",
    }[value] ?? "Unavailable";
}

function isSupplyEnabled(value) {
    return value === EnergyEvseSupplyState.ChargingEnabled ||
        value === EnergyEvseSupplyState.DischargingEnabled ||
        value === EnergyEvseSupplyState.Enabled;
}

function faultLabel(value, hasActiveFault) {
    const faultLabels = {
        [EnergyEvseFaultState.NoError]: "No fault",
        [EnergyEvseFaultState.MeterFailure]: "Meter failure",
        [EnergyEvseFaultState.OverVoltage]: "Overvoltage",
        [EnergyEvseFaultState.UnderVoltage]: "Undervoltage",
        [EnergyEvseFaultState.OverCurrent]: "Overcurrent",
        [EnergyEvseFaultState.ContactWetFailure]: "Contactor wet failure",
        [EnergyEvseFaultState.ContactDryFailure]: "Contactor dry failure",
        [EnergyEvseFaultState.GroundFault]: "Ground fault",
        [EnergyEvseFaultState.PowerLoss]: "Power loss",
        [EnergyEvseFaultState.PowerQuality]: "Power quality fault",
        [EnergyEvseFaultState.PilotShortCircuit]: "Pilot short circuit",
        [EnergyEvseFaultState.EmergencyStop]: "Emergency stop",
        [EnergyEvseFaultState.EvDisconnected]: "EV disconnected",
        [EnergyEvseFaultState.WrongPowerSupply]: "Wrong power supply",
        [EnergyEvseFaultState.LiveNeutralSwap]: "Live/neutral swapped",
        [EnergyEvseFaultState.OverTemperature]: "Overtemperature",
        [EnergyEvseFaultState.Other]: "Other fault",
    };

    if (value === null) return "Unavailable";
    if (value === EnergyEvseFaultState.NoError && hasActiveFault) return "No fault reported (inconsistent)";
    return faultLabels[value] ?? `Unknown fault code ${value}`;
}

function isPluggedIn(value) {
    return value !== null && value >= EnergyEvseState.PluggedInNoDemand && value <= EnergyEvseState.SessionEnding;
}

function pluggedInLabel(state) {
    if (state === null) return "Unavailable";
    if (state === EnergyEvseState.Fault) return "Unknown (fault)";
    return isPluggedIn(state) ? "Yes" : "No";
}

function pluggedInStatus(state) {
    if (state === EnergyEvseState.Fault) return "warning";
    return isPluggedIn(state) ? "good" : "neutral";
}

function hasActiveFault(evse) {
    return evse.state === EnergyEvseState.Fault ||
        evse.supplyState === EnergyEvseSupplyState.DisabledError ||
        (evse.faultState !== null && evse.faultState !== EnergyEvseFaultState.NoError);
}

function chargingLabel(evse) {
    switch (evse.state) {
    case EnergyEvseState.Charging:
        return "Charging";
    case EnergyEvseState.Discharging:
        return "Discharging";
    case EnergyEvseState.Fault:
        return "Unknown (fault)";
    case null:
        return "Unavailable";
    default:
        return "Not charging";
    }
}

function chargingStatus(evse) {
    switch (evse.state) {
    case EnergyEvseState.Charging:
        return "good";
    case EnergyEvseState.Discharging:
    case EnergyEvseState.Fault:
        return "warning";
    default:
        return "neutral";
    }
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
    // matter.js already converts Matter epoch-s values to Unix seconds
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value * 1000));
}

function chargingEnabledUntil(evse) {
    if (!isSupplyEnabled(evse.supplyState)) return "Disabled";
    if (evse.chargingEnabledUntil === null) return "Indefinitely";
    return time(evse.chargingEnabledUntil);
}

loadNodes();

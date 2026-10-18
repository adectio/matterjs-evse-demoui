const status = document.querySelector("#status");
const deviceList = document.querySelector("#device-list");
const emptyState = document.querySelector("#empty-state");
const discoveryList = document.querySelector("#discovery-list");
const discoveryEmptyState = document.querySelector("#discovery-empty-state");
const discoveryStatus = document.querySelector("#discovery-status");
const discoverButton = document.querySelector("#discover");
const commissioningWindow = document.querySelector("#commissioning-window");
const windowQrCode = document.querySelector("#window-qr-code");
const windowManualCode = document.querySelector("#window-manual-code");
const windowQrImage = document.querySelector("#window-qr-image");
const commissionPriceServerButton = document.querySelector("#commission-price-server");
const priceServerStatus = document.querySelector("#price-server-status");

const ROLE_LABELS = { evse: "EVSE", "price-server": "Price server", unknown: "Other device" };

document.querySelector("#commission-form").addEventListener("submit", async event => {
    event.preventDefault();
    const pairingCode = document.querySelector("#pairing-code").value;
    const discriminator = document.querySelector("#discriminator").value;
    await runAction("Commissioning device…", "/api/commission", { pairingCode, discriminator }, 201);
    event.target.reset();
});

commissionPriceServerButton.addEventListener("click", async () => {
    commissionPriceServerButton.disabled = true;
    priceServerStatus.textContent = "Commissioning price server…";
    priceServerStatus.className = "";
    try {
        const response = await fetch("/api/commission-price-server", { method: "POST" });
        const result = await response.json();
        if (response.status !== 201) throw new Error(result.error ?? "Commissioning failed.");
        priceServerStatus.textContent = result.status;
        await Promise.all([loadNodes(), loadPriceServerPairing()]);
    } catch (error) {
        priceServerStatus.textContent = error.message;
        priceServerStatus.className = "error";
    } finally {
        commissionPriceServerButton.disabled = false;
    }
});

document.querySelector("#reset-price-server").addEventListener("click", async () => {
    if (!confirm("Factory reset the price server? Every controller it is commissioned to (including this one) will lose it, and EVSEs bound to it must be linked again.")) return;
    priceServerStatus.textContent = "Resetting price server…";
    priceServerStatus.className = "";
    try {
        const response = await fetch("/api/price-server-reset", { method: "POST" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Reset failed.");
        priceServerStatus.textContent = result.status;
        await loadPriceServerPairing();
    } catch (error) {
        priceServerStatus.textContent = error.message;
        priceServerStatus.className = "error";
    }
});

document.querySelector("#refresh").addEventListener("click", loadNodes);
discoverButton.addEventListener("click", discoverDevices);

document.querySelector("#clean-context").addEventListener("click", async () => {
    if (!confirm("Erase local Matter history? This will not decommission devices remotely.")) return;
    await runAction("Clearing local context…", "/api/clean-context");
});

async function loadNodes() {
    try {
        const response = await fetch("/api/nodes");
        const { nodes } = await response.json();
        deviceList.replaceChildren(...nodes.map(renderNode));
        emptyState.hidden = nodes.length > 0;
    } catch (error) {
        showStatus(error.message, true);
    }
}

async function discoverDevices() {
    discoverButton.disabled = true;
    discoverButton.classList.add("is-busy");
    discoverButton.textContent = "Scanning…";
    showDiscoveryStatus("Scanning the local network for 10 seconds…");
    try {
        const response = await fetch("/api/discover", { method: "POST" });
        const { devices, error } = await response.json();
        if (!response.ok) throw new Error(error ?? "Discovery failed.");
        discoveryList.replaceChildren(...devices.map(renderDiscoveredDevice));
        discoveryEmptyState.hidden = devices.length > 0;
        showDiscoveryStatus(
            devices.length ? `Found ${devices.length} commissionable device(s).` : "No commissionable devices found.",
        );
    } catch (error) {
        showDiscoveryStatus(error.message, true);
    } finally {
        discoverButton.disabled = false;
        discoverButton.classList.remove("is-busy");
        discoverButton.textContent = "Find devices";
    }
}

function renderDiscoveredDevice(device) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = device.deviceName ?? device.id;
    const details = document.createElement("small");
    details.textContent = `${ROLE_LABELS[device.role]} · Long discriminator: ${device.discriminator}`;
    const select = document.createElement("button");
    select.className = "secondary";
    select.textContent = "Use discriminator";
    select.addEventListener("click", () => {
        document.querySelector("#discriminator").value = device.discriminator;
        document.querySelector("#pairing-code").focus();
    });
    item.append(name, details, select);
    return item;
}

function renderNode(node) {
    const item = document.createElement("li");
    item.className = "node-row";
    const info = document.createElement("div");
    info.className = "node-info";
    const id = document.createElement("code");
    id.textContent = displayNodeId(node.nodeId);
    const details = document.createElement("small");
    details.textContent = [ROLE_LABELS[node.role], node.productName].filter(Boolean).join(" · ");
    details.title = details.textContent;
    info.append(id, details);

    // Every row fills the same button columns (an empty slot where a button doesn't apply) so they line up
    let link = document.createElement("span");
    if (node.consumesPrices) {
        link = document.createElement("button");
        link.className = "secondary";
        link.textContent = "Link to price server";
        link.addEventListener("click", async () => {
            await runAction("Linking device to price server…", `/api/nodes/${node.nodeId}/link-price-server`);
        });
    }

    const decommission = document.createElement("button");
    decommission.textContent = "Decommission";
    decommission.addEventListener("click", async () => {
        if (!confirm(`Decommission ${displayNodeId(node.nodeId)} from this Matter fabric?`)) return;
        await runAction("Decommissioning device…", `/api/nodes/${node.nodeId}/decommission`);
    });

    const openWindow = document.createElement("button");
    openWindow.className = "secondary";
    openWindow.textContent = "Open commissioning window";
    openWindow.addEventListener("click", async () => {
        await openCommissioningWindow(node.nodeId);
    });

    const forget = document.createElement("button");
    forget.className = "secondary";
    forget.textContent = "Force forget";
    forget.addEventListener("click", async () => {
        if (!confirm(`Forget ${displayNodeId(node.nodeId)} locally? The device will retain this Matter fabric.`)) return;
        await runAction("Forgetting device locally…", `/api/nodes/${node.nodeId}/force-forget`);
    });

    item.append(info, link, openWindow, decommission, forget);
    return item;
}

async function openCommissioningWindow(nodeId) {
    showStatus("Opening enhanced commissioning window…");
    try {
        const response = await fetch(`/api/nodes/${nodeId}/open-commissioning-window`, { method: "POST" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Unable to open the commissioning window.");
        if (!result.pairingCodes.qrSvg) {
            throw new Error("The server did not return a QR code. Restart the development server and try again.");
        }
        windowQrImage.innerHTML = result.pairingCodes.qrSvg;
        windowQrCode.textContent = result.pairingCodes.qrPairingCode;
        windowManualCode.textContent = result.pairingCodes.manualPairingCode;
        commissioningWindow.hidden = false;
        showStatus(result.status);
    } catch (error) {
        showStatus(error.message, true);
    }
}

async function runAction(pendingMessage, url, body, expectedStatus = 200) {
    showStatus(pendingMessage);
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: body ? JSON.stringify(body) : undefined,
        });
        const result = await response.json();
        if (response.status !== expectedStatus) throw new Error(result.error ?? "Request failed.");
        showStatus(result.status ?? "Done.");
        await Promise.all([loadNodes(), loadPriceServerPairing()]);
    } catch (error) {
        showStatus(error.message, true);
    }
}

/** Node IDs are shown in hex, as in Matter tooling (the API still uses decimal) */
function displayNodeId(nodeId) {
    return `0x${BigInt(nodeId).toString(16).toUpperCase().padStart(4, "0")}`;
}

function showStatus(message, isError = false) {
    status.textContent = message;
    status.className = isError ? "error" : "";
}

function showDiscoveryStatus(message, isError = false) {
    discoveryStatus.textContent = message;
    discoveryStatus.className = isError ? "error" : "";
}

async function loadPriceServerPairing() {
    try {
        const response = await fetch("/api/price-server-pairing");
        const { pairing, error } = await response.json();
        if (!response.ok) throw new Error(error ?? "Price server unavailable.");
        document.querySelector("#price-server-qr").innerHTML = pairing.qrSvg ?? "";
        document.querySelector("#price-server-manual-code").textContent = pairing.manualPairingCode ?? "—";
        document.querySelector("#price-server-pin").textContent = `${pairing.passcode} / ${pairing.discriminator}`;
        commissionPriceServerButton.disabled = pairing.commissioned;
        if (pairing.onThisController) {
            priceServerStatus.textContent = "The price server is commissioned on this controller.";
        } else if (pairing.commissioned) {
            priceServerStatus.textContent =
                "The price server is commissioned by another controller, so it isn't discoverable. Reset it, or open a commissioning window from that controller.";
        } else {
            priceServerStatus.textContent = "";
        }
    } catch (error) {
        commissionPriceServerButton.disabled = true;
        priceServerStatus.textContent = error.message;
        priceServerStatus.className = "error";
    }
}

loadNodes();
loadPriceServerPairing();

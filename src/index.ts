import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import QRCode from "qrcode";
import { MatterControllerService } from "./matter-controller.js";

const port = Number(process.env.PORT ?? 3000);
const publicDirectory = join(process.cwd(), "public");
const controller = new MatterControllerService();

assertNodeVersion();
await controller.start();

const server = createServer(async (request, response) => {
    try {
        await handleRequest(request, response);
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unexpected server error";
        console.error(error);
        sendJson(response, 500, { error: message });
    }
});

server.listen(port, "127.0.0.1", () => {
    console.log(`Matter EVSE demo is available at http://127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        server.close(() => {
            controller.close().finally(() => process.exit(0));
        });
    });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { status: "ready" });
        return;
    }

    if (request.method === "GET" && url.pathname === "/api/nodes") {
        sendJson(response, 200, { nodes: controller.listNodes() });
        return;
    }

    if (request.method === "GET" && url.pathname === "/api/evses") {
        sendJson(response, 200, { evses: await controller.getEvseStatuses(url.searchParams.get("nodeId") ?? undefined) });
        return;
    }

    if (request.method === "GET" && url.pathname === "/api/evses/events") {
        openEvseEventStream(request, response);
        return;
    }

    const evseAction = /^\/api\/evses\/(\d+)\/(\d+)\/toggle-charging$/.exec(url.pathname);
    if (request.method === "POST" && evseAction !== null) {
        const [, nodeId, endpointId] = evseAction;
        const body = await readJson(request);
        sendJson(response, 200, {
            status: await controller.toggleCharging(
                nodeId,
                endpointId,
                requiredChargeCurrent(body.minimumChargeCurrent, "minimumChargeCurrent"),
                requiredChargeCurrent(body.maximumChargeCurrent, "maximumChargeCurrent"),
            ),
        });
        return;
    }

    const chargingTargets = /^\/api\/evses\/(\d+)\/(\d+)\/charging-targets$/.exec(url.pathname);
    if (chargingTargets !== null) {
        const [, nodeId, endpointId] = chargingTargets;
        if (request.method === "GET") {
            sendJson(response, 200, { preferences: await controller.getChargingPreferences(nodeId, endpointId) });
            return;
        }
        if (request.method === "POST") {
            const body = await readJson(request);
            const preferences = await controller.setChargingTargets(
                nodeId,
                endpointId,
                requiredDays(body.days),
                requiredChargingTargets(body.targets),
                optionalPositiveNumber(body.approximateEvEfficiency, "approximateEvEfficiency"),
            );
            sendJson(response, 200, { preferences });
            return;
        }
        if (request.method === "DELETE") {
            sendJson(response, 200, { preferences: await controller.clearChargingTargets(nodeId, endpointId) });
            return;
        }
    }

    if (request.method === "POST" && url.pathname === "/api/discover") {
        const devices = await controller.discoverCommissionableDevices();
        sendJson(response, 200, { devices });
        return;
    }

    if (request.method === "POST" && url.pathname === "/api/commission") {
        const body = await readJson(request);
        const node = await controller.commission(
            requiredString(body.pairingCode, "pairingCode"),
            optionalString(body.discriminator),
        );
        sendJson(response, 201, { node });
        return;
    }

    if (request.method === "POST" && url.pathname === "/api/clean-context") {
        await controller.cleanLocalContext();
        sendJson(response, 200, { status: "Local Matter context cleared." });
        return;
    }

    const nodeAction = /^\/api\/nodes\/(\d+)\/(decommission|force-forget|open-commissioning-window)$/.exec(url.pathname);
    if (request.method === "POST" && nodeAction !== null) {
        const [, nodeId, action] = nodeAction;
        if (action === "decommission") {
            await controller.decommission(nodeId);
            sendJson(response, 200, {
                status: "Remote fabric removal completed. The device has been decommissioned.",
            });
        } else if (action === "open-commissioning-window") {
            const pairingCodes = await controller.openCommissioningWindow(nodeId);
            sendJson(response, 200, {
                status: "Enhanced commissioning window is open for 15 minutes.",
                pairingCodes: {
                    ...pairingCodes,
                    qrSvg: await QRCode.toString(pairingCodes.qrPairingCode, {
                        errorCorrectionLevel: "M",
                        margin: 1,
                        type: "svg",
                        width: 256,
                    }),
                },
            });
        } else {
            await controller.forceForget(nodeId);
            sendJson(response, 200, { status: "Device forgotten locally." });
        }
        return;
    }

    if (request.method === "GET") {
        await serveStaticFile(url.pathname, response);
        return;
    }

    sendJson(response, 404, { error: "Not found" });
}

async function serveStaticFile(pathname: string, response: ServerResponse) {
    const requestedPath = pathname === "/" ? "/index.html" : pathname;
    const filePath = normalize(join(publicDirectory, requestedPath));
    if (!filePath.startsWith(`${publicDirectory}/`)) {
        sendJson(response, 403, { error: "Forbidden" });
        return;
    }

    try {
        const content = await readFile(filePath);
        response.writeHead(200, { "content-type": contentType(filePath) });
        response.end(content);
    } catch {
        sendJson(response, 404, { error: "Not found" });
    }
}

function contentType(filePath: string) {
    return (
        {
            ".css": "text/css; charset=utf-8",
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
        }[extname(filePath)] ?? "application/octet-stream"
    );
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    } catch {
        throw new Error("Request body must be valid JSON.");
    }
}

function requiredString(value: unknown, name: string) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`"${name}" is required.`);
    }
    return value;
}

function optionalString(value: unknown) {
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error('"discriminator" must be a string.');
    return value;
}

function requiredDays(value: unknown) {
    if (!Array.isArray(value) || value.some(day => typeof day !== "string")) {
        throw new Error('"days" must be an array of day names.');
    }
    return value;
}

function requiredChargingTargets(value: unknown) {
    if (!Array.isArray(value)) throw new Error('"targets" must be an array.');
    return value.map((target, index) => {
        if (typeof target !== "object" || target === null) {
            throw new Error(`Target ${index + 1} must be an object.`);
        }
        const record = target as Record<string, unknown>;
        const departureMinutes = requiredInteger(record.departureMinutes, `targets[${index}].departureMinutes`, 0, 1439);
        const targetSoC = optionalInteger(record.targetSoC, `targets[${index}].targetSoC`, 0, 100);
        const addedEnergy = optionalPositiveNumber(record.addedEnergy, `targets[${index}].addedEnergy`);
        if ((targetSoC === undefined) === (addedEnergy === undefined)) {
            throw new Error(`Target ${index + 1} must specify exactly one of targetSoC or addedEnergy.`);
        }
        return { departureMinutes, targetSoC, addedEnergy };
    });
}

function requiredInteger(value: unknown, name: string, minimum: number, maximum: number) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(`"${name}" must be a whole number from ${minimum} to ${maximum}.`);
    }
    return value;
}

function optionalInteger(value: unknown, name: string, minimum: number, maximum: number) {
    if (value === undefined) return undefined;
    return requiredInteger(value, name, minimum, maximum);
}

function optionalPositiveNumber(value: unknown, name: string) {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error(`"${name}" must be a positive number.`);
    }
    return value;
}

function requiredChargeCurrent(value: unknown, name: string) {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new Error(`"${name}" must be a whole number of milliamps.`);
    }
    return value;
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
}

function openEvseEventStream(request: IncomingMessage, response: ServerResponse) {
    response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
    });
    response.write("event: ready\ndata: {}\n\n");
    const unsubscribe = controller.onEvseChanged(() => response.write("event: evse-change\ndata: {}\n\n"));
    request.on("close", unsubscribe);
}

function assertNodeVersion() {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 12)) {
        throw new Error("Node.js 22.12 or later is required by this Matter.js demo.");
    }
}

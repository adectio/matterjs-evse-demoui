import "dotenv/config";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import QRCode from "qrcode";
import { MatterControllerService } from "./matter-controller.js";
import { handleApiRequest } from "./api/handler.js";
import { initializeDatabase, closeDatabase } from "./database/schema.js";
import { initializeRedis, closeRedis } from "./database/cache.js";
import { initializeScheduler, stopScheduler } from "./fetchers/scheduler.js";
import { initializePriceServer, PRICE_SERVER_DISCRIMINATOR, PRICE_SERVER_PASSCODE } from "./price-server/index.js";

const port = Number(process.env.PORT ?? 3000);
const publicDirectory = join(process.cwd(), "public");
const controller = new MatterControllerService();
let priceServer: any = null;

assertNodeVersion();
await controller.start();

// Initialize data fetching infrastructure first (so price server has data)
try {
  console.log("Initializing database...");
  await initializeDatabase();
  console.log("Initializing Redis...");
  await initializeRedis();
  console.log("Starting data fetcher scheduler...");
  await initializeScheduler();
} catch (error) {
  console.warn("Failed to initialize data fetching:", error);
}

// Initialize price server after fetchers (so it has data available)
try {
  console.log("Initializing price server...");
  priceServer = await initializePriceServer();

  // Register price server with fetchers for updates
  if ((globalThis as any).__priceServer === undefined) {
    (globalThis as any).__priceServer = priceServer;
  }
} catch (error) {
  console.warn("Failed to initialize price server:", error);
}

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
    process.on(signal, async () => {
        server.close(async () => {
            if (priceServer) await priceServer.stop();
            await stopScheduler();
            await closeRedis();
            await closeDatabase();
            await controller.close();
            process.exit(0);
        });
    });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    // Try price server API first
    if (priceServer && url.pathname.startsWith("/api/price-server/")) {
        try {
            const body = request.method === "POST" ? await readJson(request) : undefined;
            const handler = priceServer.getAPIHandler();
            const result = await handler(url.pathname, request.method ?? "GET", body);
            if (result.handled) {
                return sendJson(response, result.statusCode || 200, result.response);
            }
        } catch (error) {
            console.error("Price server API error:", error);
            return sendJson(response, 500, { error: (error as Error).message });
        }
    }

    // Try existing API handler
    try {
        const handled = await handleApiRequest(url.pathname, request.method ?? "GET", url, response);
        if (handled) return;
    } catch (error) {
        console.error("API handler error:", error);
        sendJson(response, 500, { error: (error as Error).message });
        return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { status: "ready" });
        return;
    }

    if (request.method === "GET" && url.pathname === "/api/nodes") {
        sendJson(response, 200, { nodes: await controller.listNodes() });
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

    const userMaximumChargeCurrentAction = /^\/api\/evses\/(\d+)\/(\d+)\/user-maximum-charge-current$/.exec(url.pathname);
    if (request.method === "POST" && userMaximumChargeCurrentAction !== null) {
        const [, nodeId, endpointId] = userMaximumChargeCurrentAction;
        const body = await readJson(request);
        sendJson(response, 200, {
            status: await controller.setUserMaximumChargeCurrent(
                nodeId,
                endpointId,
                requiredNonNegativeChargeCurrent(body.userMaximumChargeCurrent, "userMaximumChargeCurrent"),
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
        sendJson(response, 201, { node, status: commissionedStatus(node) });
        return;
    }

    if (request.method === "GET" && url.pathname === "/api/price-server-pairing") {
        if (!priceServer) {
            sendJson(response, 503, { error: "The local price server is not running." });
            return;
        }
        const pairing = priceServer.getPairingInfo();
        sendJson(response, 200, {
            pairing: {
                ...pairing,
                qrSvg: pairing.qrPairingCode
                    ? await QRCode.toString(pairing.qrPairingCode, { errorCorrectionLevel: "M", margin: 1, type: "svg", width: 192 })
                    : undefined,
            },
        });
        return;
    }

    if (request.method === "POST" && url.pathname === "/api/commission-price-server") {
        if (!priceServer) {
            sendJson(response, 503, { error: "The local price server is not running." });
            return;
        }
        // Use the price server's own (distinct) passcode and discriminator so an EVSE can never be picked up instead
        const node = await controller.commission(
            String(PRICE_SERVER_PASSCODE),
            String(PRICE_SERVER_DISCRIMINATOR),
            "price-server",
        );
        sendJson(response, 201, { node, status: commissionedStatus(node) });
        return;
    }

    if (request.method === "POST" && url.pathname === "/api/clean-context") {
        await controller.cleanLocalContext();
        sendJson(response, 200, { status: "Local Matter context cleared." });
        return;
    }

    const nodeAction =
        /^\/api\/nodes\/(\d+)\/(decommission|force-forget|open-commissioning-window|link-price-server)$/.exec(url.pathname);
    if (request.method === "POST" && nodeAction !== null) {
        const [, nodeId, action] = nodeAction;
        if (action === "link-price-server") {
            sendJson(response, 200, { status: await controller.linkEvseToPriceServer(nodeId) });
        } else if (action === "decommission") {
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

function commissionedStatus(node: { nodeId: string; role: string; productName?: string; linkStatus?: string }) {
    const label = { evse: "EVSE", "price-server": "price server", unknown: "device" }[node.role] ?? "device";
    const name = node.productName ? ` (${node.productName})` : "";
    return [`Commissioned ${label} ${node.nodeId}${name}.`, node.linkStatus].filter(Boolean).join(" ");
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

function requiredNonNegativeChargeCurrent(value: unknown, name: string) {
    const current = requiredChargeCurrent(value, name);
    if (current < 0) {
        throw new Error(`"${name}" must not be negative.`);
    }
    return current;
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

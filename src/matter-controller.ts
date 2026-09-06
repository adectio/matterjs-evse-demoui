import { Environment, Seconds } from "@matter/main";
import { ElectricalPowerMeasurementClient } from "@matter/main/behaviors/electrical-power-measurement";
import { EnergyEvseClient } from "@matter/main/behaviors/energy-evse";
import { ElectricalPowerMeasurementCluster, EnergyEvseCluster, GeneralCommissioning } from "@matter/main/clusters";
import { isValidPasscode, ManualPairingCodeCodec, NodeId, QrPairingCodeCodec } from "@matter/main/types";
import { CommissioningController, NodeCommissioningOptions } from "@project-chip/matter.js";

export type CommissionedNode = {
    nodeId: string;
    commissionedAt?: string;
};

export type CommissionableDevice = {
    id: string;
    discriminator: number;
    deviceName?: string;
    deviceType?: number;
};

export type EvseStatus = {
    nodeId: string;
    endpointId: number;
    state: number | null;
    supplyState: number | null;
    faultState: number | null;
    chargingEnabledUntil: number | null;
    circuitCapacity: number | null;
    minimumChargeCurrent: number | null;
    maximumChargeCurrent: number | null;
    sessionId: number | null;
    sessionDuration: number | null;
    sessionEnergyCharged: number | null;
    nextChargeStartTime: number | null;
    nextChargeTargetTime: number | null;
    nextChargeRequiredEnergy: number | null;
    nextChargeTargetSoC: number | null;
    powerMeterEndpointId: number | null;
    activePower: number | null;
    voltage: number | null;
    activeCurrent: number | null;
};

export type ChargingTargetView = {
    departureMinutes: number;
    targetSoC: number | null;
    addedEnergy: number | null;
};

export type ChargingTargetScheduleView = {
    days: string[];
    targets: ChargingTargetView[];
};

export type ChargingPreferences = {
    supportsSoC: boolean;
    approximateEvEfficiency: number | null;
    schedules: ChargingTargetScheduleView[];
};

export type ChargingTargetInput = {
    departureMinutes: number;
    targetSoC?: number;
    addedEnergy?: number;
};

type PairingDetails = {
    passcode: number;
    identifierData: { longDiscriminator: number } | { shortDiscriminator: number };
};

export class MatterControllerService {
    #controller: CommissioningController | undefined;
    #evseChangeListeners = new Set<() => void>();
    #subscribedNodeIds = new Set<string>();

    async start() {
        if (this.#controller !== undefined) return;

        const controller = new CommissioningController({
            environment: {
                environment: Environment.default,
                id: "matter-evse-demo-controller",
            },
            adminFabricLabel: "Matter EVSE Demo",
            autoConnect: false,
        });

        await controller.start();
        this.#controller = controller;
    }

    listNodes(): CommissionedNode[] {
        return this.controller.getCommissionedNodes().map(nodeId => ({ nodeId: nodeId.toString() }));
    }

    async discoverCommissionableDevices(): Promise<CommissionableDevice[]> {
        const devices = await this.controller.discoverCommissionableDevices(
            {},
            { onIpNetwork: true },
            undefined,
            Seconds(10),
        );
        return devices.map(device => ({
            id: device.deviceIdentifier,
            discriminator: device.D,
            deviceName: device.DN,
            deviceType: device.DT,
        }));
    }

    async commission(pairingCode: string, discriminator?: string): Promise<CommissionedNode> {
        const pairing = parsePairingCode(pairingCode, discriminator);
        const options: NodeCommissioningOptions = {
            commissioning: {
                regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
                regulatoryCountryCode: "GB",
            },
            discovery: {
                identifierData: pairing.identifierData,
                discoveryCapabilities: { onIpNetwork: true },
                timeout: Seconds(30),
            },
            passcode: pairing.passcode,
        };

        const nodeId = await this.controller.commissionNode(options, { connectNodeAfterCommissioning: false });
        return { nodeId: nodeId.toString() };
    }

    async getEvseStatuses(selectedNodeId?: string): Promise<EvseStatus[]> {
        const nodeIds = this.controller.getCommissionedNodes();
        const selectedNode = selectedNodeId === undefined ? undefined : parseNodeId(selectedNodeId);
        if (selectedNode !== undefined && !nodeIds.includes(selectedNode)) {
            throw new Error("The selected Matter node is not commissioned in this controller.");
        }

        const statuses: EvseStatus[] = [];
        for (const nodeId of nodeIds) {
            if (selectedNode !== undefined && nodeId !== selectedNode) continue;
            const node = await this.controller.getNode(nodeId);
            this.subscribeToEvseChanges(node, nodeId.toString());
            if (!(await ensureConnected(node))) continue;

            const endpoints = [...node.node.endpoints];
            const powerMeterEndpoints = endpoints.filter(
                endpoint => endpoint.maybeStateOf(ElectricalPowerMeasurementClient) !== undefined,
            );
            for (const endpoint of endpoints) {
                const state = endpoint.maybeStateOf(EnergyEvseClient);
                if (state === undefined) continue;
                const powerMeterEndpoint =
                    powerMeterEndpoints.find(candidate => candidate === endpoint || isDescendantOf(candidate, endpoint)) ??
                    (powerMeterEndpoints.length === 1 ? powerMeterEndpoints[0] : undefined);
                const powerMeasurement = powerMeterEndpoint?.maybeStateOf(ElectricalPowerMeasurementClient);
                statuses.push({
                    nodeId: nodeId.toString(),
                    endpointId: endpoint.number,
                    state: numberOrNull(state.state),
                    supplyState: numberOrNull(state.supplyState),
                    faultState: numberOrNull(state.faultState),
                    chargingEnabledUntil: numberOrNull(state.chargingEnabledUntil),
                    circuitCapacity: numberOrNull(state.circuitCapacity),
                    minimumChargeCurrent: numberOrNull(state.minimumChargeCurrent),
                    maximumChargeCurrent: numberOrNull(state.maximumChargeCurrent),
                    sessionId: numberOrNull(state.sessionId),
                    sessionDuration: numberOrNull(state.sessionDuration),
                    sessionEnergyCharged: numberOrNull(state.sessionEnergyCharged),
                    nextChargeStartTime: numberOrNull(state.nextChargeStartTime),
                    nextChargeTargetTime: numberOrNull(state.nextChargeTargetTime),
                    nextChargeRequiredEnergy: numberOrNull(state.nextChargeRequiredEnergy),
                    nextChargeTargetSoC: numberOrNull(state.nextChargeTargetSoC),
                    powerMeterEndpointId: powerMeterEndpoint === undefined ? null : Number(powerMeterEndpoint.number),
                    activePower: numberOrNull(powerMeasurement?.activePower),
                    voltage: numberOrNull(powerMeasurement?.voltage),
                    activeCurrent: numberOrNull(powerMeasurement?.activeCurrent),
                });
            }
        }
        return statuses;
    }

    onEvseChanged(listener: () => void) {
        this.#evseChangeListeners.add(listener);
        return () => this.#evseChangeListeners.delete(listener);
    }

    async decommission(nodeId: string) {
        const node = await this.controller.getNode(parseNodeId(nodeId));
        if (!(await ensureConnected(node))) {
            throw new Error(
                "Could not connect to the device within 30 seconds. Remote decommission was not sent; use Force forget only if you accept that the device will retain this fabric.",
            );
        }
        await node.decommission();
    }

    async toggleCharging(nodeId: string, endpointId: string, minimumChargeCurrent: number, maximumChargeCurrent: number) {
        const node = await this.controller.getNode(parseNodeId(nodeId));
        if (!(await ensureConnected(node))) {
            throw new Error("Could not connect to the EVSE within 30 seconds. No charging command was sent.");
        }

        const parsedEndpointId = Number(endpointId);
        if (!Number.isSafeInteger(parsedEndpointId) || parsedEndpointId < 0) {
            throw new Error("Invalid EVSE endpoint ID.");
        }
        const endpoint = [...node.node.endpoints].find(candidate => candidate.number === parsedEndpointId);
        const state = endpoint?.maybeStateOf(EnergyEvseClient);
        if (endpoint === undefined || state === undefined) {
            throw new Error("The selected endpoint does not expose the Energy EVSE cluster.");
        }

        const chargingOrDischargingEnabled = [1, 2, 5].includes(Number(state.supplyState));
        if (chargingOrDischargingEnabled) {
            await endpoint.act("disable EVSE charging", agent => agent.get(EnergyEvseClient).disable());
            return "Charging and discharging disabled.";
        }

        if (minimumChargeCurrent < 6_000) {
            throw new Error("Minimum charge current must be at least 6 A.");
        }
        if (maximumChargeCurrent < minimumChargeCurrent) {
            throw new Error("Maximum charge current must be greater than or equal to the minimum.");
        }

        const circuitCapacity = numberOrNull(state.circuitCapacity);
        if (circuitCapacity !== null && maximumChargeCurrent > circuitCapacity) {
            throw new Error(`Maximum charge current cannot exceed the device circuit capacity of ${circuitCapacity / 1_000} A.`);
        }

        await endpoint.act("enable EVSE charging", agent =>
            agent.get(EnergyEvseClient).enableCharging({
                chargingEnabledUntil: null,
                minimumChargeCurrent,
                maximumChargeCurrent,
            }),
        );
        return `Charging enabled from ${minimumChargeCurrent / 1_000} A to ${maximumChargeCurrent / 1_000} A.`;
    }

    async getChargingPreferences(nodeId: string, endpointId: string): Promise<ChargingPreferences> {
        const { endpoint, state } = await this.getEvseEndpoint(nodeId, endpointId);
        if (!endpoint.maybeFeaturesOf(EnergyEvseClient)?.chargingPreferences) {
            throw new Error("This EVSE does not support charging preferences.");
        }
        const response = await endpoint.act("get EVSE charging targets", agent => agent.get(EnergyEvseClient).getTargets());
        return {
            supportsSoC: endpoint.maybeFeaturesOf(EnergyEvseClient)?.soCReporting === true,
            approximateEvEfficiency: numberOrNull(state.approximateEvEfficiency),
            schedules: response.chargingTargetSchedules.map(schedule => ({
                days: daysFromBitmap(schedule.dayOfWeekForSequence),
                targets: schedule.chargingTargets.map(target => ({
                    departureMinutes: target.targetTimeMinutesPastMidnight,
                    targetSoC: numberOrNull(target.targetSoC),
                    addedEnergy: numberOrNull(target.addedEnergy),
                })),
            })),
        };
    }

    async setChargingTargets(
        nodeId: string,
        endpointId: string,
        days: string[],
        targets: ChargingTargetInput[],
        approximateEvEfficiency?: number,
    ) {
        const { endpoint } = await this.getEvseEndpoint(nodeId, endpointId);
        if (!endpoint.maybeFeaturesOf(EnergyEvseClient)?.chargingPreferences) {
            throw new Error("This EVSE does not support charging preferences.");
        }
        if (days.length === 0) throw new Error("Select at least one day.");
        if (targets.length === 0 || targets.length > 10) throw new Error("Add between one and ten charging targets.");
        if (
            endpoint.maybeFeaturesOf(EnergyEvseClient)?.soCReporting === true &&
            targets.some(target => target.targetSoC === undefined)
        ) {
            throw new Error("This SoC-reporting EVSE requires a target SoC for every charging target.");
        }
        if (approximateEvEfficiency !== undefined) {
            await endpoint.setStateOf(EnergyEvseClient, { approximateEvEfficiency });
        }

        await endpoint.act("set EVSE charging targets", agent =>
            agent.get(EnergyEvseClient).setTargets({
                chargingTargetSchedules: [
                    {
                        dayOfWeekForSequence: bitmapFromDays(days),
                        chargingTargets: targets.map(target => ({
                            targetTimeMinutesPastMidnight: target.departureMinutes,
                            targetSoC: target.targetSoC,
                            addedEnergy: target.addedEnergy,
                        })),
                    },
                ],
            }),
        );
        return this.getChargingPreferences(nodeId, endpointId);
    }

    async clearChargingTargets(nodeId: string, endpointId: string) {
        const { endpoint } = await this.getEvseEndpoint(nodeId, endpointId);
        if (!endpoint.maybeFeaturesOf(EnergyEvseClient)?.chargingPreferences) {
            throw new Error("This EVSE does not support charging preferences.");
        }
        await endpoint.act("clear EVSE charging targets", agent => agent.get(EnergyEvseClient).clearTargets());
        return this.getChargingPreferences(nodeId, endpointId);
    }

    async openCommissioningWindow(nodeId: string) {
        const node = await this.controller.getNode(parseNodeId(nodeId));
        if (!(await ensureConnected(node))) {
            throw new Error("Could not connect to the device within 30 seconds. The commissioning window was not opened.");
        }
        return node.openEnhancedCommissioningWindow(900);
    }

    async forceForget(nodeId: string) {
        await this.controller.removeNode(parseNodeId(nodeId), false);
        this.#subscribedNodeIds.delete(nodeId);
    }

    async cleanLocalContext() {
        const controller = this.controller;
        await controller.close();
        await controller.resetStorage();
        this.#controller = undefined;
        await this.start();
    }

    async close() {
        await this.#controller?.close();
        this.#controller = undefined;
        this.#subscribedNodeIds.clear();
    }

    get controller() {
        if (this.#controller === undefined) {
            throw new Error("Matter controller has not been started");
        }
        return this.#controller;
    }

    private subscribeToEvseChanges(node: Awaited<ReturnType<CommissioningController["getNode"]>>, nodeId: string) {
        if (this.#subscribedNodeIds.has(nodeId)) return;
        node.events.attributeChanged.on(({ path }) => {
            if (path.clusterId === EnergyEvseCluster.id || path.clusterId === ElectricalPowerMeasurementCluster.id) {
                for (const listener of this.#evseChangeListeners) listener();
            }
        });
        this.#subscribedNodeIds.add(nodeId);
    }

    private async getEvseEndpoint(nodeId: string, endpointId: string) {
        const node = await this.controller.getNode(parseNodeId(nodeId));
        if (!(await ensureConnected(node))) {
            throw new Error("Could not connect to the EVSE within 30 seconds.");
        }
        const parsedEndpointId = Number(endpointId);
        if (!Number.isSafeInteger(parsedEndpointId) || parsedEndpointId < 0) {
            throw new Error("Invalid EVSE endpoint ID.");
        }
        const endpoint = [...node.node.endpoints].find(candidate => candidate.number === parsedEndpointId);
        const state = endpoint?.maybeStateOf(EnergyEvseClient);
        if (endpoint === undefined || state === undefined) {
            throw new Error("The selected endpoint does not expose the Energy EVSE cluster.");
        }
        return { endpoint, state };
    }
}

function parsePairingCode(input: string, suppliedDiscriminator?: string): PairingDetails {
    const pairingCode = input.trim().replace(/\s/g, "");
    if (pairingCode.length === 0) {
        throw new Error("Enter a Matter QR code, manual pairing code, or setup PIN.");
    }

    if (pairingCode.toUpperCase().startsWith("MT:")) {
        const decoded = QrPairingCodeCodec.decode(pairingCode)[0];
        if (decoded === undefined) {
            throw new Error("The Matter QR code did not contain a commissioning payload.");
        }
        return { identifierData: { longDiscriminator: decoded.discriminator }, passcode: decoded.passcode };
    }

    if (/^\d{1,8}$/.test(pairingCode)) {
        const passcode = Number(pairingCode);
        if (!isValidPasscode(passcode)) {
            throw new Error("Enter a valid Matter setup PIN.");
        }
        return {
            identifierData: { longDiscriminator: parseLongDiscriminator(suppliedDiscriminator) },
            passcode,
        };
    }

    const decoded = ManualPairingCodeCodec.decode(pairingCode);
    if (decoded.discriminator !== undefined) {
        return { identifierData: { longDiscriminator: decoded.discriminator }, passcode: decoded.passcode };
    }
    if (decoded.shortDiscriminator === undefined) {
        throw new Error("The manual pairing code did not contain a discriminator.");
    }
    return { identifierData: { shortDiscriminator: decoded.shortDiscriminator }, passcode: decoded.passcode };
}

function parseLongDiscriminator(value: string | undefined) {
    if (value === undefined || !/^\d+$/.test(value)) {
        throw new Error("A 0–4095 long discriminator is required when entering a setup PIN.");
    }
    const discriminator = Number(value);
    if (!Number.isSafeInteger(discriminator) || discriminator < 0 || discriminator > 4095) {
        throw new Error("The long discriminator must be a whole number from 0 to 4095.");
    }
    return discriminator;
}

function parseNodeId(nodeId: string) {
    if (!/^\d+$/.test(nodeId)) {
        throw new Error("Invalid Matter node ID.");
    }
    return NodeId(nodeId);
}

function numberOrNull(value: number | bigint | null | undefined) {
    return value === null || value === undefined ? null : Number(value);
}

function isDescendantOf(candidate: { owner?: unknown }, ancestor: object) {
    let current = candidate.owner;
    while (current !== undefined) {
        if (current === ancestor) return true;
        current = (current as { owner?: unknown }).owner;
    }
    return false;
}

const targetDays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

type TargetDay = (typeof targetDays)[number];
type TargetDayBitmap = { [key in TargetDay]?: boolean };

function bitmapFromDays(days: string[]): TargetDayBitmap {
    const bitmap: TargetDayBitmap = {};
    for (const day of days) {
        if (!targetDays.includes(day as TargetDay)) {
            throw new Error(`Invalid day "${day}".`);
        }
        bitmap[day as TargetDay] = true;
    }
    return bitmap;
}

function daysFromBitmap(bitmap: TargetDayBitmap) {
    return targetDays.filter(day => bitmap[day] === true);
}

async function ensureConnected(node: Awaited<ReturnType<CommissioningController["getNode"]>>) {
    if (node.isConnected) return true;

    node.connect({ autoSubscribe: true });
    const deadline = Date.now() + 30_000;
    while (!node.isConnected && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
    }

    return node.isConnected;
}

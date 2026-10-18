import { Environment, Seconds } from "@matter/main";
import { BasicInformationClient } from "@matter/main/behaviors/basic-information";
import { AccessControlClient } from "@matter/main/behaviors/access-control";
import { BindingClient } from "@matter/main/behaviors/binding";
import { CommodityPriceClient } from "@matter/main/behaviors/commodity-price";
import { DescriptorClient } from "@matter/main/behaviors/descriptor";
import { DeviceEnergyManagementClient } from "@matter/main/behaviors/device-energy-management";
import { ElectricalGridConditionsClient } from "@matter/main/behaviors/electrical-grid-conditions";
import { ElectricalPowerMeasurementClient } from "@matter/main/behaviors/electrical-power-measurement";
import { EnergyEvseClient } from "@matter/main/behaviors/energy-evse";
import { OperationalCredentialsClient } from "@matter/main/behaviors/operational-credentials";
import { TimeSynchronizationClient } from "@matter/main/behaviors/time-synchronization";
import {
    AccessControl,
    CommodityPrice,
    DeviceEnergyManagementCluster,
    ElectricalGridConditions,
    ElectricalPowerMeasurementCluster,
    EnergyEvseCluster,
    GeneralCommissioning,
    TimeSynchronization,
} from "@matter/main/clusters";
import {
    ClusterId,
    EndpointNumber,
    FabricIndex,
    isValidPasscode,
    ManualPairingCodeCodec,
    NodeId,
    QrPairingCodeCodec,
} from "@matter/main/types";
import { CommissioningController, NodeCommissioningOptions } from "@project-chip/matter.js";
import { randomInt } from "node:crypto";

export type NodeRole = "evse" | "price-server" | "unknown";

export type CommissionedNode = {
    nodeId: string;
    nodeName?: string;
    role: NodeRole;
    /** True when the node has CommodityPrice or ElectricalGridConditions client clusters (EVSE, appliance, ...) */
    consumesPrices: boolean;
    /** True when the node's Time Synchronization cluster has the TimeSyncClient feature, so it accepts a trusted time source */
    supportsTrustedTimeSource: boolean;
    productName?: string;
    commissionedAt?: string;
    linkStatus?: string;
};

export type CommissionableDevice = {
    id: string;
    discriminator: number;
    deviceName?: string;
    deviceType?: number;
    role: NodeRole;
};

/** New node IDs are drawn from this short range so they stay readable (shown as 0x0100-0xFFFF) */
const MIN_ASSIGNED_NODE_ID = 0x0100;
const MAX_ASSIGNED_NODE_ID = 0xffff;

/** Matter device type IDs used to label commissionable devices before commissioning */
const EVSE_DEVICE_TYPE = 0x050c;
const ELECTRICAL_ENERGY_TARIFF_DEVICE_TYPE = 0x0513;

/** Clusters on the price server that price consumers are bound to and granted View access on */
const PRICE_CLUSTER_IDS: ClusterId[] = [CommodityPrice.Cluster.id, ElectricalGridConditions.Cluster.id];

/** The price server hosts the trusted time source on its root endpoint */
const TIME_SOURCE_ENDPOINT = EndpointNumber(0);

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
    userMaximumChargeCurrent: number | null;
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
    forecast: ForecastView | null;
};

/** Device Energy Management Forecast, with times in Unix seconds and power/energy in mW/mWh */
export type ForecastView = {
    forecastId: number;
    startTime: number;
    endTime: number;
    earliestStartTime: number | null;
    latestEndTime: number | null;
    activeSlotNumber: number | null;
    forecastUpdateReason: number;
    slots: ForecastSlotView[];
};

export type ForecastSlotView = {
    startTime: number;
    duration: number;
    nominalPower: number | null;
    minPower: number | null;
    maxPower: number | null;
    nominalEnergy: number | null;
    isPausable: boolean | null;
    /** From the slot's DEM Costs, when the EVSE reports them */
    financialCost: { value: number; currency: number | null } | null;
    ghgEmissionsGrams: number | null;
};

/** DEM CostTypeEnum values */
const COST_TYPE_FINANCIAL = 0;
const COST_TYPE_GHG_EMISSIONS = 1;

export type CompanionNode = {
    nodeId: string;
    vendorName?: string;
    productName?: string;
    nodeName?: string;
    hasSubscription: boolean;
    endpoints: { endpointId: number; deviceTypes: number[] }[];
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
    /**
     * Latest DEM Forecast per "nodeId/endpointId", taken from attribute reports. matter.js 0.17 doesn't refresh its
     * cached views of list elements when a remote value replaces a list, so reading slots via the client state can
     * return stale entries (e.g. the first slot of an earlier forecast).
     */
    #forecasts = new Map<string, DemForecast | null>();

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

    async listNodes(): Promise<CommissionedNode[]> {
        const nodes: CommissionedNode[] = [];
        for (const nodeId of this.controller.getCommissionedNodes()) {
            const basicInformation = (await this.controller.getNode(nodeId)).basicInformation;
            const node = await this.controller.getNode(nodeId);
            nodes.push({
                nodeId: nodeId.toString(),
                nodeName: basicInformation?.nodeLabel || basicInformation?.productName || undefined,
                role: roleOf(node),
                consumesPrices: priceClientEndpointsOf(node).length > 0,
                supportsTrustedTimeSource: supportsTrustedTimeSource(node),
                productName: productNameOf(node),
            });
        }
        return nodes;
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
            role: roleOfDeviceType(device.DT),
        }));
    }

    /**
     * Commission a device and, depending on what it turns out to be, link it to the price server:
     * a price consumer is bound to the price server; a price server gets every known price consumer bound to it.
     */
    async commission(
        pairingCode: string,
        discriminator?: string,
        expectedRole?: NodeRole,
    ): Promise<CommissionedNode> {
        const nodeId = await this.commissionNode(parsePairingCode(pairingCode, discriminator));
        const node = await this.controller.getNode(nodeId);
        if (!(await ensureConnected(node))) {
            return {
                nodeId: nodeId.toString(),
                role: "unknown",
                consumesPrices: false,
                supportsTrustedTimeSource: false,
                linkStatus: "Commissioned, but could not connect to read its endpoints.",
            };
        }

        const role = roleOf(node);
        const consumesPrices = priceClientEndpointsOf(node).length > 0;
        const usesTimeSource = supportsTrustedTimeSource(node);
        const result: CommissionedNode = {
            nodeId: nodeId.toString(),
            role,
            consumesPrices,
            supportsTrustedTimeSource: usesTimeSource,
            productName: productNameOf(node),
        };
        if (expectedRole !== undefined && role !== expectedRole) {
            result.linkStatus = `Commissioned, but this node is a ${role} device, not a ${expectedRole}.`;
            return result;
        }

        // Commissioning has succeeded at this point, so linking failures are reported rather than thrown
        const statuses = [];
        if (role === "price-server") {
            statuses.push(await this.linkAllPriceConsumers(), await this.setAllTrustedTimeSources());
        } else {
            if (consumesPrices) {
                statuses.push(
                    await this.linkPriceConsumer(nodeId.toString()).catch(
                        error => `Linking to the price server failed: ${errorMessage(error)}`,
                    ),
                );
            }
            if (usesTimeSource) {
                statuses.push(await this.setTrustedTimeSource(nodeId.toString()).catch(errorMessage));
            }
        }
        if (statuses.length) result.linkStatus = statuses.join(" ");
        return result;
    }

    /** Link every commissioned price consumer to the price server, e.g. after the price server is commissioned */
    async linkAllPriceConsumers(): Promise<string> {
        const consumerNodeIds = (await this.listNodes()).filter(n => n.consumesPrices).map(n => n.nodeId);
        const statuses = [];
        for (const consumerNodeId of consumerNodeIds) {
            statuses.push(`${consumerNodeId}: ${await this.linkPriceConsumer(consumerNodeId).catch(errorMessage)}`);
        }
        return statuses.length ? statuses.join(" ") : "No price consumers commissioned yet to link.";
    }

    /** Point every commissioned node that supports it at the trusted time source, e.g. after the price server is commissioned */
    async setAllTrustedTimeSources(): Promise<string> {
        const nodeIds = (await this.listNodes()).filter(n => n.supportsTrustedTimeSource).map(n => n.nodeId);
        const statuses = [];
        for (const nodeId of nodeIds) {
            statuses.push(`${nodeId}: ${await this.setTrustedTimeSource(nodeId).catch(errorMessage)}`);
        }
        return statuses.length ? statuses.join(" ") : "No time sync clients commissioned yet.";
    }

    /**
     * Set the price server's Time Synchronization cluster as the node's trusted time source and grant the node View
     * access to it on the price server.
     */
    async setTrustedTimeSource(nodeId: string): Promise<string> {
        const priceServerNodeId = (await this.listNodes()).find(n => n.role === "price-server")?.nodeId;
        if (priceServerNodeId === undefined) {
            return "No price server commissioned yet; the trusted time source will be set when one is.";
        }

        const node = await this.controller.getNode(parseNodeId(nodeId));
        if (!(await ensureConnected(node))) {
            throw new Error("Could not connect to the device within 30 seconds; the trusted time source was not set.");
        }
        if (!supportsTrustedTimeSource(node)) {
            return "The device's Time Synchronization cluster does not support a trusted time source.";
        }

        const priceNode = await this.controller.getNode(parseNodeId(priceServerNodeId));
        if (!(await ensureConnected(priceNode))) {
            throw new Error("Could not connect to the price server within 30 seconds; the trusted time source was not set.");
        }
        if (priceNode.node.maybeStateOf(TimeSynchronizationClient) === undefined) {
            throw new Error("The price server does not expose Time Synchronization; restart it to pick up the time source.");
        }

        // Grant access first so the node can read UTCTime as soon as it has the trusted time source
        await grantView(priceNode, BigInt(nodeId), [
            { endpoint: TIME_SOURCE_ENDPOINT, cluster: TimeSynchronization.Cluster.id },
        ]);

        const priceNodeId = NodeId(BigInt(priceServerNodeId));
        const current = node.node.stateOf(TimeSynchronizationClient).trustedTimeSource;
        if (
            current?.nodeId === priceNodeId &&
            current.endpoint === TIME_SOURCE_ENDPOINT &&
            current.fabricIndex === currentFabricIndexOf(node)
        ) {
            return `Already using price server ${priceServerNodeId} as the trusted time source.`;
        }
        await node.node.act("set trusted time source", agent =>
            agent.get(TimeSynchronizationClient).setTrustedTimeSource({
                trustedTimeSource: { nodeId: priceNodeId, endpoint: TIME_SOURCE_ENDPOINT },
            }),
        );
        return `Trusted time source set to price server ${priceServerNodeId} endpoint ${TIME_SOURCE_ENDPOINT}.`;
    }

    /**
     * Point a price consumer's Binding cluster at the price server's CommodityPrice and ElectricalGridConditions
     * clusters and grant the consumer View access to them on the price server.
     */
    async linkPriceConsumer(consumerNodeId: string): Promise<string> {
        const priceServerNodeId = (await this.listNodes()).find(n => n.role === "price-server")?.nodeId;
        if (priceServerNodeId === undefined) {
            return "No price server commissioned yet; the device will be linked when one is.";
        }

        const consumerNode = await this.controller.getNode(parseNodeId(consumerNodeId));
        if (!(await ensureConnected(consumerNode))) {
            throw new Error("Could not connect to the device within 30 seconds; it was not linked to the price server.");
        }
        const priceClientEndpoints = priceClientEndpointsOf(consumerNode);
        if (priceClientEndpoints.length === 0) {
            return "The device has no CommodityPrice or ElectricalGridConditions client clusters; nothing to link.";
        }
        // The Binding cluster should live alongside the client clusters, but fall back to any endpoint with one
        const bindingEndpoints = [...consumerNode.node.endpoints].filter(e => e.maybeStateOf(BindingClient) !== undefined);
        const clientEndpoint = priceClientEndpoints.find(e => bindingEndpoints.includes(e.endpoint)) ?? priceClientEndpoints[0];
        const bindingEndpoint = bindingEndpoints.includes(clientEndpoint.endpoint)
            ? clientEndpoint.endpoint
            : bindingEndpoints[0];
        if (bindingEndpoint === undefined) {
            return "The device has no Binding cluster, so it was not linked to the price server.";
        }

        const priceNode = await this.controller.getNode(parseNodeId(priceServerNodeId));
        if (!(await ensureConnected(priceNode))) {
            throw new Error("Could not connect to the price server within 30 seconds; the device was not linked.");
        }
        const tariffEndpoint = [...priceNode.node.endpoints].find(
            e =>
                e.maybeStateOf(CommodityPriceClient) !== undefined &&
                e.maybeStateOf(ElectricalGridConditionsClient) !== undefined,
        );
        if (tariffEndpoint === undefined) {
            throw new Error("The price server does not expose CommodityPrice and ElectricalGridConditions.");
        }
        const tariffEndpointNumber = EndpointNumber(tariffEndpoint.number);

        // Grant access first so the consumer can subscribe as soon as it sees the binding
        await grantView(
            priceNode,
            BigInt(consumerNodeId),
            PRICE_CLUSTER_IDS.map(cluster => ({ endpoint: tariffEndpointNumber, cluster })),
        );

        const fabricIndex = currentFabricIndexOf(consumerNode);
        const existingBindings = bindingEndpoint.stateOf(BindingClient).binding;
        const priceNodeId = NodeId(BigInt(priceServerNodeId));
        const missingBindings = clientEndpoint.clusters
            .filter(
                cluster =>
                    !existingBindings.some(
                        b => b.node === priceNodeId && b.endpoint === tariffEndpointNumber && b.cluster === cluster,
                    ),
            )
            .map(cluster => ({ node: priceNodeId, endpoint: tariffEndpointNumber, cluster, fabricIndex }));
        if (missingBindings.length === 0) {
            return `Already bound to price server ${priceServerNodeId}.`;
        }
        await bindingEndpoint.setStateOf(BindingClient, { binding: [...existingBindings, ...missingBindings] });
        return `Bound endpoint ${bindingEndpoint.number} to price server ${priceServerNodeId} endpoint ${tariffEndpointNumber}.`;
    }

    /**
     * A random (but short) node ID. Sequential IDs get reused once a node is forgotten locally, and a forgotten
     * device that was never decommissioned still answers CASE for its old ID on this fabric - so the commissioner
     * would finish commissioning against the wrong device (failing with NoFailSafe).
     */
    private newNodeId() {
        const inUse = new Set(this.controller.getCommissionedNodes().map(nodeId => BigInt(nodeId)));
        for (;;) {
            const candidate = BigInt(randomInt(MIN_ASSIGNED_NODE_ID, MAX_ASSIGNED_NODE_ID + 1));
            if (!inUse.has(candidate)) return NodeId(candidate);
        }
    }

    private async commissionNode(pairing: PairingDetails) {
        const options: NodeCommissioningOptions = {
            commissioning: {
                regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
                regulatoryCountryCode: "GB",
                nodeId: this.newNodeId(),
            },
            discovery: {
                identifierData: pairing.identifierData,
                discoveryCapabilities: { onIpNetwork: true },
                timeout: Seconds(30),
            },
            passcode: pairing.passcode,
        };

        return this.controller.commissionNode(options, { connectNodeAfterCommissioning: false });
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
            if (roleOf(node) === "price-server") continue;
            this.subscribeToEvseChanges(node, nodeId.toString());
            if (!(await ensureConnected(node))) continue;

            const endpoints = [...node.node.endpoints];
            const powerMeterEndpoints = endpoints.filter(
                endpoint => endpoint.maybeStateOf(ElectricalPowerMeasurementClient) !== undefined,
            );
            const demEndpoints = endpoints.filter(
                endpoint => endpoint.maybeStateOf(DeviceEnergyManagementClient) !== undefined,
            );
            for (const endpoint of endpoints) {
                const state = endpoint.maybeStateOf(EnergyEvseClient);
                if (state === undefined) continue;
                const powerMeterEndpoint =
                    powerMeterEndpoints.find(candidate => candidate === endpoint || isDescendantOf(candidate, endpoint)) ??
                    (powerMeterEndpoints.length === 1 ? powerMeterEndpoints[0] : undefined);
                const powerMeasurement = powerMeterEndpoint?.maybeStateOf(ElectricalPowerMeasurementClient);
                const demEndpoint =
                    demEndpoints.find(candidate => candidate === endpoint || isDescendantOf(candidate, endpoint)) ??
                    (demEndpoints.length === 1 ? demEndpoints[0] : undefined);
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
                    userMaximumChargeCurrent: numberOrNull(state.userMaximumChargeCurrent),
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
                    forecast: forecastView(
                        demEndpoint === undefined
                            ? undefined
                            : this.#forecasts.has(`${nodeId}/${demEndpoint.number}`)
                              ? this.#forecasts.get(`${nodeId}/${demEndpoint.number}`)
                              : demEndpoint.maybeStateOf(DeviceEnergyManagementClient)?.forecast,
                    ),
                });
            }
        }
        return statuses;
    }

    async listCompanionNodes(): Promise<CompanionNode[]> {
        const nodes: CompanionNode[] = [];
        for (const nodeId of this.controller.getCommissionedNodes()) {
            const node = await this.controller.getNode(nodeId);
            const basicInformation = node.basicInformation;
            nodes.push({
                nodeId: nodeId.toString(),
                vendorName: basicInformation?.vendorName,
                productName: basicInformation?.productName,
                nodeName: basicInformation?.nodeLabel || undefined,
                hasSubscription: node.isConnected,
                endpoints: [...node.node.endpoints].flatMap(endpoint => {
                    const descriptor = endpoint.maybeStateOf(DescriptorClient);
                    if (descriptor === undefined) return [];
                    return [
                        {
                            endpointId: Number(endpoint.number),
                            deviceTypes: descriptor.deviceTypeList.map(entry => Number(entry.deviceType)),
                        },
                    ];
                }),
            });
        }
        return nodes;
    }

    async renameNode(nodeId: string, name: string) {
        if (name.length > 32) {
            throw new Error("The node name must be 32 characters or fewer.");
        }
        const node = await this.controller.getNode(parseNodeId(nodeId));
        if (!(await ensureConnected(node))) {
            throw new Error("Could not connect to the device within 30 seconds. The node was not renamed.");
        }
        await node.node.setStateOf(BasicInformationClient, { nodeLabel: name });
        return `Node renamed to "${name}".`;
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

    async setUserMaximumChargeCurrent(nodeId: string, endpointId: string, userMaximumChargeCurrent: number) {
        if (!Number.isSafeInteger(userMaximumChargeCurrent) || userMaximumChargeCurrent < 0) {
            throw new Error("User maximum charge current must be a non-negative whole number of milliamps.");
        }

        const { endpoint, state } = await this.getEvseEndpoint(nodeId, endpointId);
        const circuitCapacity = numberOrNull(state.circuitCapacity);
        if (circuitCapacity === null || circuitCapacity < 0) {
            throw new Error("The EVSE has not reported a usable circuit capacity.");
        }
        if (userMaximumChargeCurrent > circuitCapacity) {
            throw new Error(`User maximum charge current cannot exceed the circuit capacity of ${circuitCapacity / 1_000} A.`);
        }

        await endpoint.setStateOf(EnergyEvseClient, { userMaximumChargeCurrent });
        return `User charge limit set to ${userMaximumChargeCurrent / 1_000} A.`;
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
        const supportsSoC = endpoint.maybeFeaturesOf(EnergyEvseClient)?.soCReporting === true;
        if (supportsSoC && targets.some(target => target.targetSoC === undefined)) {
            throw new Error(
                "This EVSE supports SoC reporting, so every charging target needs a Target SoC (added energy is only used if the EV doesn't report its SoC).",
            );
        }
        if (!supportsSoC && targets.some(target => target.targetSoC !== undefined && target.targetSoC !== 100)) {
            throw new Error("This EVSE does not support SoC reporting, so Target SoC must be omitted or 100%.");
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
        for (const key of this.#forecasts.keys()) {
            if (key.startsWith(`${nodeId}/`)) this.#forecasts.delete(key);
        }
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
        this.#forecasts.clear();
    }

    get controller() {
        if (this.#controller === undefined) {
            throw new Error("Matter controller has not been started");
        }
        return this.#controller;
    }

    private subscribeToEvseChanges(node: Awaited<ReturnType<CommissioningController["getNode"]>>, nodeId: string) {
        if (this.#subscribedNodeIds.has(nodeId)) return;
        node.events.attributeChanged.on(({ path, value }) => {
            if (path.clusterId === DeviceEnergyManagementCluster.id && path.attributeName === "forecast") {
                this.#forecasts.set(`${nodeId}/${path.endpointId}`, value as DemForecast | null);
            }
            if (
                path.clusterId === EnergyEvseCluster.id ||
                path.clusterId === ElectricalPowerMeasurementCluster.id ||
                path.clusterId === DeviceEnergyManagementCluster.id
            ) {
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

function roleOf(node: PairedNode): NodeRole {
    const endpoints = [...node.node.endpoints];
    if (endpoints.some(e => e.maybeStateOf(CommodityPriceClient) !== undefined)) return "price-server";
    if (endpoints.some(e => e.maybeStateOf(EnergyEvseClient) !== undefined)) return "evse";
    return "unknown";
}

/** Endpoints declaring CommodityPrice and/or ElectricalGridConditions client clusters, with those clusters */
function priceClientEndpointsOf(node: PairedNode) {
    return [...node.node.endpoints]
        .map(endpoint => ({
            endpoint,
            clusters: PRICE_CLUSTER_IDS.filter(cluster =>
                endpoint.maybeStateOf(DescriptorClient)?.clientList.includes(cluster),
            ),
        }))
        .filter(({ clusters }) => clusters.length > 0);
}

/** Whether the node's root Time Synchronization cluster has TimeSyncClient; the price server is the source, not a client */
function supportsTrustedTimeSource(node: PairedNode) {
    return (
        roleOf(node) !== "price-server" &&
        node.node.maybeFeaturesOf(TimeSynchronizationClient)?.timeSyncClient === true
    );
}

function roleOfDeviceType(deviceType: number | undefined): NodeRole {
    if (deviceType === EVSE_DEVICE_TYPE) return "evse";
    if (deviceType === ELECTRICAL_ENERGY_TARIFF_DEVICE_TYPE) return "price-server";
    return "unknown";
}

function productNameOf(node: PairedNode) {
    try {
        return node.basicInformation?.productName;
    } catch {
        return undefined;
    }
}

function currentFabricIndexOf(node: PairedNode) {
    const fabricIndex = node.node.maybeStateOf(OperationalCredentialsClient)?.currentFabricIndex;
    if (fabricIndex === undefined) {
        throw new Error("Could not determine this controller's fabric index on the node.");
    }
    return FabricIndex(fabricIndex);
}

/**
 * Add the subject to a single shared View entry with exactly these targets (one entry per purpose, e.g. price clusters
 * or time source), keeping all other ACL entries (including our own Administer entry) untouched.
 */
async function grantView(
    serverNode: PairedNode,
    subjectNodeId: bigint,
    targets: { endpoint: EndpointNumber; cluster: ClusterId }[],
) {
    const fabricIndex = currentFabricIndexOf(serverNode);
    const acl = serverNode.node.stateOf(AccessControlClient).acl.map(entry => ({
        privilege: entry.privilege,
        authMode: entry.authMode,
        subjects: entry.subjects,
        targets: entry.targets,
        fabricIndex: entry.fabricIndex,
    }));
    const isMatchingViewEntry = (entry: (typeof acl)[number]) =>
        entry.privilege === AccessControl.AccessControlEntryPrivilege.View &&
        entry.authMode === AccessControl.AccessControlEntryAuthMode.Case &&
        entry.targets?.length === targets.length &&
        entry.targets.every(t => targets.some(target => t.endpoint === target.endpoint && t.cluster === target.cluster));

    const existing = acl.find(isMatchingViewEntry);
    if (existing?.subjects?.some(subject => BigInt(subject) === subjectNodeId)) return;

    if (existing !== undefined) {
        existing.subjects = [...(existing.subjects ?? []), NodeId(subjectNodeId)];
    } else {
        acl.push({
            privilege: AccessControl.AccessControlEntryPrivilege.View,
            authMode: AccessControl.AccessControlEntryAuthMode.Case,
            subjects: [NodeId(subjectNodeId)],
            targets: targets.map(({ cluster, endpoint }) => ({ cluster, endpoint, deviceType: null })),
            fabricIndex,
        });
    }
    await serverNode.node.setStateOf(AccessControlClient, { acl });
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
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

/** The fields of a DEM ForecastStruct (as read from the client state) used by the UI */
type DemForecast = {
    readonly forecastId: number;
    readonly startTime: number;
    readonly endTime: number;
    readonly earliestStartTime?: number | null;
    readonly latestEndTime?: number;
    readonly activeSlotNumber: number | null;
    readonly forecastUpdateReason: number;
    readonly slots: readonly {
        readonly defaultDuration: number;
        readonly nominalPower?: number | bigint;
        readonly minPower?: number | bigint;
        readonly maxPower?: number | bigint;
        readonly nominalEnergy?: number | bigint;
        readonly slotIsPausable?: boolean;
        readonly costs?: readonly {
            readonly costType: number;
            readonly value: number;
            readonly decimalPoints: number;
            readonly currency?: number;
        }[];
    }[];
};

function forecastView(forecast: DemForecast | null | undefined): ForecastView | null {
    if (forecast === null || forecast === undefined) return null;
    let slotStart = forecast.startTime;
    return {
        forecastId: forecast.forecastId,
        startTime: forecast.startTime,
        endTime: forecast.endTime,
        earliestStartTime: numberOrNull(forecast.earliestStartTime),
        latestEndTime: numberOrNull(forecast.latestEndTime),
        activeSlotNumber: numberOrNull(forecast.activeSlotNumber),
        forecastUpdateReason: forecast.forecastUpdateReason,
        // Slots are back to back from the forecast start
        slots: forecast.slots.map(slot => {
            const startTime = slotStart;
            slotStart += slot.defaultDuration;
            return {
                startTime,
                duration: slot.defaultDuration,
                nominalPower: numberOrNull(slot.nominalPower),
                minPower: numberOrNull(slot.minPower),
                maxPower: numberOrNull(slot.maxPower),
                nominalEnergy: numberOrNull(slot.nominalEnergy),
                isPausable: slot.slotIsPausable ?? null,
                ...slotCosts(slot.costs),
            };
        }),
    };
}

/** Cost values with their decimal points applied (e.g. 18400 with 4 decimal points is 1.84) */
function slotCosts(costs: DemForecast["slots"][number]["costs"]) {
    const financial = costs?.find(cost => cost.costType === COST_TYPE_FINANCIAL);
    const emissions = costs?.find(cost => cost.costType === COST_TYPE_GHG_EMISSIONS);
    return {
        financialCost: financial
            ? { value: financial.value / 10 ** financial.decimalPoints, currency: financial.currency ?? null }
            : null,
        ghgEmissionsGrams: emissions ? emissions.value / 10 ** emissions.decimalPoints : null,
    };
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

type PairedNode = Awaited<ReturnType<CommissioningController["getNode"]>>;

async function ensureConnected(node: PairedNode) {
    if (node.isConnected) return true;

    node.connect({ autoSubscribe: true });
    const deadline = Date.now() + 30_000;
    while (!node.isConnected && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
    }

    return node.isConnected;
}

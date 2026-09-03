# Matter.js EVSE demo

A local Matter.js commissioner and controller UI for demonstrating Matter EVSE
devices. The first working slice commissions devices available on the local IP
network, persists the controller fabric, lists commissioned nodes, remotely
decommissions a node, and can deliberately erase local controller history.

This is a development demonstrator, not a production Matter controller or
energy-management system. The intended protocol baseline is Matter 1.5; the
currently pinned Matter.js 0.17.9 release is mapped by Matter.js to Matter
1.5.1.

Matter.js published packages support Node.js 20+, but this repository requires
Node.js 22.12+ to match Matter.js's own development-toolchain baseline.

## Prerequisites

- Node.js **22.12 or later** (check with `node --version`).
- npm 10 or later is recommended.
- A Matter EVSE that is commissionable and reachable on the same local IP
  network as this computer.
- The device's Matter QR payload (`MT:...`) or manual pairing code.

Allow local multicast DNS (mDNS) and UDP traffic through the computer's
firewall. The initial implementation supports IP-network commissioning only:
the EVSE must already have network connectivity. Bluetooth onboarding, Thread
credentials, and Wi-Fi credential provisioning are intentionally not yet
implemented.

## Quick start

```sh
git clone <repository-url>
cd matterjs-evse-demoui
npm install
npm run dev
```

Open <http://127.0.0.1:3000>. Select **Find devices** to scan the local
network for commissionable Matter devices (10 seconds). Then paste the Matter
QR payload or manual pairing code and select **Commission device**.
Commissioning searches the local network for up to 30 seconds.

A setup PIN such as `20202021` is not itself a full pairing code: it does not
contain the long discriminator needed to find a device. Enter the PIN and the
EVSE's 0–4095 long discriminator, or use **Find devices** and select its
discriminator first. A QR payload contains both values.

The **Admin** page handles commissioning and fabric lifecycle. The **EVSE**
page discovers every reachable endpoint exposing the Energy EVSE cluster and
shows its main state, connection/charging status, session telemetry, and
device-reported next charging preferences. It subscribes to Energy EVSE
attribute changes and Electrical Power Measurement (EPM) updates
automatically. Its EPM meter shows active power, voltage, and current when
that cluster is present on the EVSE endpoint or its Descriptor-derived parts;
when one EPM endpoint exists elsewhere on the node, it is used as the meter.
The displayed meter heading identifies its endpoint. Fields unavailable on a
device are shown as unavailable rather than inferred. Select the commissioned
Matter node to control/view from the **Matter node** selector; the browser
remembers that selection.

The EVSE page provides an **Enable charging** / **Disable charging** control.
When enabling, enter the minimum and maximum charge current in milliamps. The form
defaults the maximum to the reported circuit capacity, rather than the current
maximum charge current, because a disabled EVSE reports the latter as zero.
The demo validates a 6 A minimum and does not allow a requested maximum above
the device's reported circuit capacity before sending the timed EVSE command.

The Matter fabric and commissioned-node records are managed by Matter.js in
its local storage. Do not delete its storage directly while the app is
running. Its exact location is platform-dependent; use **Clean local context**
only when you intentionally need to remove this application's local history.

## Device lifecycle

- **Decommission** contacts the selected device and sends Operational
  Credentials `RemoveFabric` for this controller's fabric before deleting the
  local record. It waits up to 30 seconds for a CASE connection first. Use it
  while the device is reachable; a connection or command error leaves the
  local record intact.
- **Force forget** removes only this application's local record when remote
  decommissioning is impossible. The device still retains the fabric.
- **Clean local context** erases all local Matter controller history. It also
  does not remove the fabric from any device, so remote-decommission reachable
  devices first.
- **Open commissioning window** opens a 15-minute enhanced commissioning
  window on a reachable commissioned device and displays a scannable QR code
  plus one-time plain-text QR/manual pairing codes for adding another Matter
  commissioner. Device support or
  authorization restrictions can cause this operation to fail.

## Validation

```sh
npm run check
```

## Development notes

The app uses a Node.js backend because Matter fabrics, commissioning
credentials, discovery, and multicast networking must not be held in browser
code. The browser UI is served locally on loopback and calls the backend's
small HTTP API.

Read [ai/README.md](ai/README.md) for Matter/EVSE constraints and
[ai/PLAN.md](ai/PLAN.md) for the staged roadmap toward EVSE telemetry,
charging preferences, tariffs, and DEM-based EMS controls.

The Adectio logo is stored locally at `public/assets/adectio-logo.png`, sourced
from the [Adectio website](https://adectio.com/).

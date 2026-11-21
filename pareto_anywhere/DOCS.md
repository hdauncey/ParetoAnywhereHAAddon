# Pareto Anywhere

Runs [reelyActive Pareto Anywhere](https://github.com/reelyactive/pareto-anywhere) inside Home Assistant to turn
the BLE and EnOcean packets reported by **Aruba Networks access points** (IoT transport, `barnowl-aruba`) into
real-time `raddec` / `dynamb` / `spatem` data, and adds an ingress web UI to manage the EnOcean device mapping.

## Install

**Local add-on:** copy the `pareto_anywhere` folder into the `addons` share of your Home Assistant OS host (Samba
`addons` share, or `/addons` over SSH), then *Settings → Add-ons → Add-on Store → ⋮ → Check for updates* and install
it from **Local add-ons**.

**From GitHub:** push this repository (it contains `repository.yaml`), then add its URL under
*Add-on Store → ⋮ → Repositories*.

The first build compiles the image on your host and needs internet access (npm registry).

## Ingress web UI

Open **Pareto Anywhere** from the sidebar. Tabs:

| Tab | What it does |
| --- | --- |
| EnOcean devices | Table editor for `enocean.json`: add / edit / remove device ID ↔ EEP rows, optional labels, import / export. |
| Discovered | EnOcean devices Pareto has actually seen, flagged *Mapped* / *Unmapped*, with a one-click *Add mapping*. |
| Raw JSON | Edit the file directly (validated and normalised before it is saved). |
| Backups | Every save keeps a copy of the previous file (newest 20); restore or download any of them. |
| Status & logs | Process state, live log, restart button, and the Aruba target URLs. |
| Pareto UI | Pareto Anywhere's own web apps, proxied through ingress (best effort, see below). |

### `enocean.json` format

```json
{
  "05174fc4/7": { "eepType": "A5-04-03" },
  "0591ee96/7": { "eepType": "D5-00-01" }
}
```

* Key: the 32-bit EnOcean ID in **lowercase** hex plus the `/7` ID-type suffix. The UI accepts `05174FC4`,
  `05:17:4f:c4`, `0x05174fc4` or `05174fc4/7` and normalises it.
* `eepType`: the EnOcean Equipment Profile in **UPPERCASE** hex, `RORG-FUNC-TYPE` (e.g. `A5-04-03`). It is printed on
  most device labels or in the device's datasheet.
* The file lives in the add-on's config folder (`/addon_configs/<id>_pareto_anywhere/enocean.json` on the host) so it
  survives updates. Labels and backups are kept separately by the add-on and never written into this file.
* Pareto Anywhere reads the file **once at startup**. Use **Save & restart Pareto** (a restart takes a few seconds)
  after editing.

Pareto can only decode EEPs it supports; see the
[supported EEP list](https://www.reelyactive.com/pareto/anywhere/devices/enocean-alliance/).

## Ports

| Port | Purpose |
| --- | --- |
| 3001/tcp | Pareto Anywhere HTTP(S) + WebSocket. Aruba APs connect to `/aruba/aos8` or `/aruba/aos10`. Also serves the `/devices`, `/context` APIs and Socket.IO for other consumers (Node-RED, custom apps). |
| 50001/udp | Optional raddec UDP input from external `barnowl-*` forwarders. |

The ingress UI itself is not exposed on any host port.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `tls` | `false` | Serve Pareto over HTTPS / `wss://`. **Required for AOS 10**, which only supports secure WebSockets. AOS 8 works with plain `ws://`. |
| `certfile` | `fullchain.pem` | Certificate file name in Home Assistant's `/ssl` folder. |
| `keyfile` | `privkey.pem` | Private key file name in `/ssl`. |

With TLS on, the APs must trust the certificate: upload the issuing CA certificate to the APs as the IoT Transport CA
certificate, and make sure the server URL host matches a name or IP in the certificate's SAN.

## Aruba configuration (summary)

Configure an IoT transport profile on the APs with a WebSocket endpoint pointing at this add-on:

* Endpoint type: `telemetry-websocket`
* Endpoint URL: `ws://<HA-HOST>:3001/aruba/aos8` (AOS 8) or `wss://<HA-HOST>:3001/aruba/aos10` (AOS 10)
* Endpoint token: any non-empty value
* Payload content: `all`; enable BLE data forwarding and, for EnOcean, the EnOcean / serial data service

EnOcean over Aruba requires an **EnOcean USB dongle on the AP** (Aruba's EnOcean serial-protocol transport).
The exact menu path for controller-managed (AOS 8 Mobility Master / Mobility Controller) deployments differs from the
Instant-AP and Central workflows reelyActive documents; follow your ArubaOS IoT transport guide and reelyActive's
[Aruba configuration tutorials](https://reelyactive.github.io/diy/aruba-instant-config) for the endpoint values above.

Pareto only processes real-time packet reports by default (*BLE Data*, EnOcean serial data), not periodic
telemetry reports.

## The "Pareto UI" tab

The Pareto web apps use absolute asset paths and a Socket.IO connection that are not designed to live under a path
prefix. The add-on rewrites the common cases, but some apps may not fully work inside ingress. They always work
directly at `http(s)://<HA-HOST>:3001/`.

## Home Assistant integration

Pareto exposes Socket.IO and REST (`/devices`, `/context`). To get EnOcean / BLE sensors into Home Assistant
entities, consume that stream with Node-RED (reelyActive publishes `@reelyactive/node-red-pareto-anywhere`) or a custom
integration and publish to MQTT discovery topics; this add-on provides the data source and the device mapping.

## Troubleshooting

* **Status shows *Starting…* forever:** check the log on the *Status & logs* tab; a port conflict on 3001 is the usual cause.
* **EnOcean packets arrive but are not decoded:** the device is missing from `enocean.json`, or has the wrong EEP.
  Look for it under *Discovered*.
* **TLS enabled but still `ws://`:** the certificate or key was not found in `/ssl`; the log says which path.
* **Upgrading Pareto Anywhere:** edit `PARETO_ANYWHERE_VERSION` in the Dockerfile and rebuild.

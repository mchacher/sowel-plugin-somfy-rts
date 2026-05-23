# sowel-plugin-somfy-rts

[Sowel](https://docs.sowel.org) integration plugin for the [`somfyrts2mqtt`](https://github.com/mchacher/somfyrts2mqtt) bridge — controls Somfy RTS shutters and awnings ("stores bannes") over MQTT.

The bridge is an ESP32 + CC1101 device that re-transmits paired remotes' RF codes. This plugin connects to the user's MQTT broker, auto-discovers every paired remote from the bridge's `tele/<root>/SENSOR` payload, and exposes each one as a Sowel `Device` with `shutter_position` data + `shutter_move` / `set_shutter_position` orders.

## Features

- **Auto-discovery**: every remote paired on the bridge appears in Sowel within seconds of the first `tele/<root>/SENSOR` payload.
- **Position tracking**: position updates (1 Hz during motion) propagate to the bound equipment.
- **Open / Close / Stop + go-to-position** orders dispatched as `cmnd/<root>/<name>/{Open,Close,Stop,Position}` publishes.
- **Multi-bridge**: comma-separated list of bridge root topics so a single Sowel install can drive several bridges.
- **Tasmota-style MQTT subset** — the bridge's contract is a tiny subset of Tasmota Shutter; same plugin scaffold as `sowel-plugin-tasmota`.
- **Equipment-type agnostic**: bind the device to a `shutter` equipment if the motor drives a roller shutter, or to an `awning` equipment (Sowel ≥ 1.12.0) if it drives a store banne. The per-remote `invert` flag is bridge-side; Sowel sees consistent `100 = down position` semantics across both wirings.

## Settings (Sowel UI)

| Key             | Required | Default            | Notes                                                                       |
| --------------- | -------- | ------------------ | --------------------------------------------------------------------------- |
| MQTT Broker URL | yes      | —                  | `mqtt://host:1883` or `mqtts://host:8883`                                   |
| MQTT Username   | no       | —                  |                                                                             |
| MQTT Password   | no       | —                  | Stored as a secret, redacted in logs                                        |
| MQTT Client ID  | no       | `sowel-somfy-rts`  | A random suffix is appended automatically to avoid broker collisions        |
| Bridge roots    | no       | `somfyrts2mqtt`    | Comma-separated list of bridge root topics. One per bridge if multi-bridge. |

## Topics consumed and produced

Subscribed:
- `tele/<root>/SENSOR` — aggregated 1 Hz state per remote
- `tele/<root>/LWT` — bridge availability (Online / Offline)
- `stat/<root>/<name>` — per-cmnd ack

Published:
- `cmnd/<root>/<name>/Open` (payload `""`)
- `cmnd/<root>/<name>/Close` (payload `""`)
- `cmnd/<root>/<name>/Stop` (payload `""`)
- `cmnd/<root>/<name>/Position` (payload `"0".."100"`)

The bridge's full MQTT contract is documented in [`docs/mqtt-api.md`](https://github.com/mchacher/somfyrts2mqtt/blob/main/docs/mqtt-api.md).

## Build & test

```bash
npm install
npm test         # vitest run
npm run build    # tsc → dist/
```

A tagged release `vX.Y.Z` triggers a GitHub Actions workflow that ships a pre-built tarball ready to be installed by Sowel's `PackageManager`.

## License

GPL-3.0 — same as the bridge firmware. See [LICENSE](LICENSE).

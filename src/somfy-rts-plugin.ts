/**
 * Somfy RTS engine — connects to a somfyrts2mqtt bridge over MQTT,
 * auto-discovers paired remotes from the SENSOR aggregated payload,
 * pushes shutter_position updates, and dispatches Sowel orders as
 * cmnd publishes.
 */

import { MqttConnector } from "./mqtt-connector.js";
import { buildCmndTopic, parseJson, parseSensorPayload, parseStatAck } from "./sensor-parser.js";

// ============================================================
// Local type definitions (no imports from Sowel source)
// ============================================================

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export interface EventBus {
  emit(event: unknown): void;
}

export interface DeviceManager {
  upsertFromDiscovery(integrationId: string, source: string, discovered: unknown): void;
  updateDeviceData(
    integrationId: string,
    sourceDeviceId: string,
    payload: Record<string, unknown>,
  ): void;
  updateDeviceStatus(integrationId: string, sourceDeviceId: string, status: string): void;
}

interface Device {
  id: string;
  integrationId: string;
  sourceDeviceId: string;
  name: string;
}

/**
 * Build a `DiscoveredDevice`-shaped object for a single Somfy RTS remote.
 * Each remote exposes:
 *   - data: shutter_position (number, 0..100)
 *   - orders: shutter_move (enum OPEN/CLOSE/STOP) + set_shutter_position (number)
 */
function discoveredRemote(remoteName: string): Record<string, unknown> {
  // Keys aligned with the Tasmota Shutter convention so Sowel's
  // `extractShutterGroupKey` / DeviceSelector treat us identically to a
  // real Tasmota device. The order `shutter_position` shares its key with
  // the data of the same name — Sowel stores them in separate tables, so
  // no clash. The category drives the alias resolution downstream.
  return {
    friendlyName: remoteName,
    manufacturer: "Somfy",
    model: "RTS (via somfyrts2mqtt)",
    data: [
      {
        key: "shutter_position",
        type: "number",
        category: "shutter_position",
        unit: "%",
      },
    ],
    orders: [
      {
        key: "shutter_state",
        type: "enum",
        category: "shutter_move",
        enumValues: ["OPEN", "CLOSE", "STOP"],
      },
      {
        key: "shutter_position",
        type: "number",
        category: "set_shutter_position",
        min: 0,
        max: 100,
        unit: "%",
      },
    ],
  };
}

export class SomfyRtsEngine {
  private readonly integrationId: string;
  private readonly mqtt: MqttConnector;
  private readonly deviceManager: DeviceManager;
  private readonly logger: Logger;
  private readonly roots: string[];
  /** Per-root → set of remote names already discovered (sourceDeviceId tracking). */
  private readonly discovered = new Map<string, Set<string>>();
  /** Per-sourceDeviceId → last known position to dedupe noisy SENSOR bursts. */
  private readonly lastPosition = new Map<string, number>();
  /** remoteName → bridge root, so executeOrder knows which cmnd topic to use.
   * First-discovered wins on multi-bridge name collisions (warned in logs). */
  private readonly remoteRoot = new Map<string, string>();

  constructor(
    integrationId: string,
    roots: string[],
    mqtt: MqttConnector,
    deviceManager: DeviceManager,
    logger: Logger,
  ) {
    this.integrationId = integrationId;
    this.mqtt = mqtt;
    this.deviceManager = deviceManager;
    this.logger = logger;
    this.roots = roots;
    for (const root of roots) this.discovered.set(root, new Set());
  }

  start(): void {
    for (const root of this.roots) {
      this.mqtt.subscribe(`tele/${root}/SENSOR`, (topic, payload) =>
        this.onSensor(root, topic, payload),
      );
      this.mqtt.subscribe(`tele/${root}/LWT`, (topic, payload) =>
        this.onLwt(root, topic, payload),
      );
      this.mqtt.subscribe(`stat/${root}/+`, (topic, payload) =>
        this.onStat(root, topic, payload),
      );
    }
    this.logger.info({ roots: this.roots }, "Somfy RTS subscriptions installed");

    // Belt-and-suspenders: even though the bridge publishes SENSOR retained
    // since firmware v0.2.0 (broker delivers it on subscribe), we also fire
    // an explicit cmnd/<root>/Status per root. Covers two real-world cases:
    //   1. Broker without persistence — retained messages lost on restart.
    //   2. Bridge firmware < 0.2.0 still in the wild — fallback that forces
    //      a fresh SENSOR publish even when no remote has moved yet.
    // No-op if the bridge ignores the topic (older firmware doesn't subscribe).
    for (const root of this.roots) {
      this.mqtt.publish(`cmnd/${root}/Status`, "");
    }
  }

  /**
   * Sowel calls executeOrder with the Device + orderKey + value. The Sowel
   * device's sourceDeviceId is just the remote name (which is also what the
   * bridge uses in MQTT topics). We look up the bridge root via the
   * remoteRoot map populated at discovery time.
   */
  executeOrder(device: Device, orderKey: string, value: unknown): void {
    const remoteName = device.sourceDeviceId;
    const root = this.remoteRoot.get(remoteName);
    if (!root) {
      this.logger.warn(
        { sourceDeviceId: remoteName, orderKey },
        "Somfy RTS: no bridge root known for this remote (was it discovered ?)",
      );
      return;
    }
    const cmd = buildCmndTopic(root, remoteName, orderKey, value);
    if (!cmd) {
      this.logger.warn(
        { orderKey, value, deviceId: device.id },
        "Somfy RTS: unknown order key or value",
      );
      return;
    }
    this.mqtt.publish(cmd.topic, cmd.payload);
    this.logger.debug({ topic: cmd.topic, payload: cmd.payload }, "Somfy RTS cmnd published");
  }

  // ── Handlers ──────────────────────────────────────────────

  private onSensor(root: string, _topic: string, payload: Buffer): void {
    try {
      const data = parseJson(payload);
      const updates = parseSensorPayload(data);
      if (updates.length === 0) {
        if (data !== null) {
          this.logger.warn({ root }, "Somfy RTS: empty or unparseable SENSOR payload");
        }
        return;
      }
      const seen = this.discovered.get(root) ?? new Set<string>();

      for (const u of updates) {
        // sourceDeviceId == remoteName. Multi-bridge collision: warn if a
        // remoteName already maps to a different root, but keep the first.
        const previousRoot = this.remoteRoot.get(u.name);
        if (previousRoot && previousRoot !== root) {
          this.logger.warn(
            { remote: u.name, knownRoot: previousRoot, conflictingRoot: root },
            "Somfy RTS: remote name collision across bridges — keeping the first-seen",
          );
        } else if (!previousRoot) {
          this.remoteRoot.set(u.name, root);
        }

        if (!seen.has(u.name)) {
          seen.add(u.name);
          const discovered = { ...discoveredRemote(u.name), ieeeAddress: u.name };
          this.deviceManager.upsertFromDiscovery(this.integrationId, this.integrationId, discovered);
          this.deviceManager.updateDeviceStatus(this.integrationId, u.name, "online");
          this.logger.info(
            { root, remote: u.name },
            "Somfy RTS remote discovered",
          );
        }

        const prev = this.lastPosition.get(u.name);
        if (prev === u.position) continue;
        this.lastPosition.set(u.name, u.position);
        this.deviceManager.updateDeviceData(this.integrationId, u.name, {
          shutter_position: u.position,
        });
      }
      this.discovered.set(root, seen);
    } catch (err) {
      this.logger.error({ err, root } as Record<string, unknown>, "Somfy RTS SENSOR handler error");
    }
  }

  private onLwt(root: string, _topic: string, payload: Buffer): void {
    try {
      const value = payload.toString("utf-8").trim();
      const status = value === "Online" ? "online" : "offline";
      const seen = this.discovered.get(root);
      if (!seen) return;
      for (const remoteName of seen) {
        this.deviceManager.updateDeviceStatus(this.integrationId, remoteName, status);
      }
      this.logger.info({ root, status }, "Somfy RTS bridge LWT");
    } catch (err) {
      this.logger.error({ err, root } as Record<string, unknown>, "Somfy RTS LWT handler error");
    }
  }

  private onStat(root: string, topic: string, payload: Buffer): void {
    try {
      // Topic shape: stat/<root>/<name>
      const parts = topic.split("/");
      if (parts.length !== 3) return;
      const remoteName = parts[2];
      const data = parseJson(payload);
      const { update, error } = parseStatAck(data, remoteName);
      if (error) {
        this.logger.warn(
          { root, remote: remoteName, error },
          "Somfy RTS stat ack reports an error",
        );
        return;
      }
      if (!update) return;
      const prev = this.lastPosition.get(remoteName);
      if (prev === update.position) return;
      this.lastPosition.set(remoteName, update.position);
      this.deviceManager.updateDeviceData(this.integrationId, remoteName, {
        shutter_position: update.position,
      });
    } catch (err) {
      this.logger.error(
        { err, topic } as Record<string, unknown>,
        "Somfy RTS stat handler error",
      );
    }
  }
}

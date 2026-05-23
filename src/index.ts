/**
 * Sowel Plugin: Somfy RTS
 *
 * Companion plugin for the somfyrts2mqtt bridge (ESP32 + CC1101).
 * Exposes every paired Somfy RTS remote as a Sowel `Device` with
 * shutter_position data + shutter_move / set_shutter_position orders.
 * Users bind those devices to either `shutter` or `awning` equipments
 * depending on the wiring of the underlying motor (per-remote `invert`
 * flag is handled bridge-side; Sowel sees consistent 0..100 semantics).
 */

import { MqttConnector } from "./mqtt-connector.js";
import { SomfyRtsEngine } from "./somfy-rts-plugin.js";
import type { DeviceManager, EventBus, Logger } from "./somfy-rts-plugin.js";

interface SettingsManager {
  get(key: string): string | undefined;
}

interface Device {
  id: string;
  integrationId: string;
  sourceDeviceId: string;
  name: string;
}

interface PluginDeps {
  logger: Logger;
  eventBus: EventBus;
  settingsManager: SettingsManager;
  deviceManager: DeviceManager;
  pluginDir: string;
}

type IntegrationStatus = "connected" | "disconnected" | "not_configured" | "error";

interface IntegrationSettingDef {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean";
  required: boolean;
  placeholder?: string;
  defaultValue?: string;
}

interface IntegrationPlugin {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly apiVersion?: number;
  getStatus(): IntegrationStatus;
  isConfigured(): boolean;
  getSettingsSchema(): IntegrationSettingDef[];
  start(options?: { pollOffset?: number }): Promise<void>;
  stop(): Promise<void>;
  executeOrder(
    device: Device,
    orderKeyOrDispatchConfig: string | Record<string, unknown>,
    value: unknown,
  ): Promise<void>;
  refresh?(): Promise<void>;
  getPollingInfo?(): { lastPollAt: string; intervalMs: number } | null;
}

const INTEGRATION_ID = "somfy-rts";
const SETTINGS_PREFIX = `integration.${INTEGRATION_ID}.`;

class SomfyRtsPlugin implements IntegrationPlugin {
  readonly id = INTEGRATION_ID;
  readonly name = "Somfy RTS Bridge";
  readonly description = "Somfy RTS shutters and awnings via a somfyrts2mqtt bridge";
  readonly icon = "Radio";
  readonly apiVersion = 2;

  private logger: Logger;
  private eventBus: EventBus;
  private settingsManager: SettingsManager;
  private deviceManager: DeviceManager;
  private mqtt: MqttConnector | null = null;
  private engine: SomfyRtsEngine | null = null;
  private status: IntegrationStatus = "disconnected";

  constructor(deps: PluginDeps) {
    this.logger = deps.logger;
    this.eventBus = deps.eventBus;
    this.settingsManager = deps.settingsManager;
    this.deviceManager = deps.deviceManager;
  }

  getStatus(): IntegrationStatus {
    if (!this.isConfigured()) return "not_configured";
    if (this.status === "connected" && this.mqtt && !this.mqtt.isConnected()) return "error";
    return this.status;
  }

  isConfigured(): boolean {
    return this.getSetting("mqtt_url") !== undefined;
  }

  getSettingsSchema(): IntegrationSettingDef[] {
    return [
      {
        key: "mqtt_url",
        label: "MQTT Broker URL",
        type: "text",
        required: true,
        placeholder: "mqtt://localhost:1883",
      },
      { key: "mqtt_username", label: "MQTT Username", type: "text", required: false },
      { key: "mqtt_password", label: "MQTT Password", type: "password", required: false },
      {
        key: "mqtt_client_id",
        label: "MQTT Client ID",
        type: "text",
        required: false,
        defaultValue: "sowel-somfy-rts",
      },
      {
        key: "bridge_roots",
        label: "Bridge root topics (comma separated)",
        type: "text",
        required: false,
        defaultValue: "somfyrts2mqtt",
      },
    ];
  }

  async start(): Promise<void> {
    if (!this.isConfigured()) {
      this.status = "not_configured";
      return;
    }

    const mqttUrl = this.getSetting("mqtt_url")!;
    const mqttUsername = this.getSetting("mqtt_username") || undefined;
    const mqttPassword = this.getSetting("mqtt_password") || undefined;
    const baseClientId = this.getSetting("mqtt_client_id") ?? "sowel-somfy-rts";
    const mqttClientId = `${baseClientId}-${Math.random().toString(36).slice(2, 8)}`;
    const rootsRaw = this.getSetting("bridge_roots") ?? "somfyrts2mqtt";
    const roots = Array.from(
      new Set(
        rootsRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),
    );
    if (roots.length === 0) {
      this.logger.warn({}, "Somfy RTS: no bridge root configured, falling back to somfyrts2mqtt");
      roots.push("somfyrts2mqtt");
    }

    try {
      this.mqtt = new MqttConnector(
        mqttUrl,
        { username: mqttUsername, password: mqttPassword, clientId: mqttClientId },
        this.eventBus,
        this.logger,
        INTEGRATION_ID,
      );
      await this.mqtt.connect();

      this.engine = new SomfyRtsEngine(
        INTEGRATION_ID,
        roots,
        this.mqtt,
        this.deviceManager,
        this.logger,
      );
      this.engine.start();

      this.status = this.mqtt.isConnected() ? "connected" : "disconnected";
      if (this.status === "connected") {
        this.eventBus.emit({ type: "system.integration.connected", integrationId: this.id });
      }
      this.logger.info({ roots }, "Somfy RTS plugin started");
    } catch (err) {
      this.status = "error";
      this.logger.error(
        { err } as Record<string, unknown>,
        "Failed to start Somfy RTS plugin",
      );
    }
  }

  async stop(): Promise<void> {
    if (this.mqtt) {
      await this.mqtt.disconnect();
      this.mqtt = null;
      this.engine = null;
      this.status = "disconnected";
      this.eventBus.emit({ type: "system.integration.disconnected", integrationId: this.id });
      this.logger.info({}, "Somfy RTS plugin stopped");
    }
  }

  async executeOrder(device: Device, orderKey: string, value: unknown): Promise<void> {
    if (!this.engine || !this.mqtt?.isConnected()) {
      throw new Error("Somfy RTS plugin not connected");
    }
    this.engine.executeOrder(device, orderKey, value);
  }

  private getSetting(key: string): string | undefined {
    return this.settingsManager.get(`${SETTINGS_PREFIX}${key}`);
  }
}

export function createPlugin(deps: PluginDeps): IntegrationPlugin {
  return new SomfyRtsPlugin(deps);
}

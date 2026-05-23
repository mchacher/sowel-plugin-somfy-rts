/**
 * Sensor / cmnd payload parsers for the somfyrts2mqtt bridge.
 *
 * MQTT contract (see https://github.com/mchacher/somfyrts2mqtt/blob/main/docs/mqtt-api.md):
 *
 *   tele/<root>/SENSOR   — { kitchen: { Position, Direction, Target }, bedroom: {...}, ... }
 *   tele/<root>/LWT      — "Online" | "Offline"
 *   stat/<root>/<name>   — { Position, Direction, Target } or { error: "..." }
 *
 *   cmnd/<root>/<name>/Open       payload ""
 *   cmnd/<root>/<name>/Close      payload ""
 *   cmnd/<root>/<name>/Stop       payload ""
 *   cmnd/<root>/<name>/Position   payload "0".."100"
 */

export interface RemoteUpdate {
  /** Remote name as configured in the bridge's admin UI (= top-level SENSOR key). */
  name: string;
  /** Current estimated position. 0 = up/retracted, 100 = down/deployed. */
  position: number;
  /** -1 closing, 0 idle, 1 opening. Tasmota convention. */
  direction: number;
  /** Destination of the current or last motion. 0..100. */
  target: number;
}

/**
 * Safe JSON parse. Returns null on error.
 */
export function parseJson(raw: string | Buffer): unknown {
  try {
    const str = typeof raw === "string" ? raw : raw.toString("utf-8");
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Parse a tele/<root>/SENSOR payload into a list of per-remote updates.
 *
 * Bridge payload (1 Hz during motion, also on every state change):
 *   {
 *     "kitchen": {"Position": 45, "Direction": 1, "Target": 100},
 *     "bedroom": {"Position": 0,  "Direction": 0, "Target": 0}
 *   }
 *
 * Remotes whose entry is malformed (missing or non-numeric Position) are
 * skipped silently — the caller logs the issue at warn level.
 */
export function parseSensorPayload(json: unknown): RemoteUpdate[] {
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];
  const obj = json as Record<string, unknown>;
  const result: RemoteUpdate[] = [];
  for (const [name, entry] of Object.entries(obj)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.Position !== "number") continue;
    result.push({
      name,
      position: clamp(e.Position, 0, 100),
      direction: typeof e.Direction === "number" ? e.Direction : 0,
      target: typeof e.Target === "number" ? clamp(e.Target, 0, 100) : clamp(e.Position, 0, 100),
    });
  }
  return result;
}

/**
 * Parse a stat/<root>/<name> per-cmnd ack into a single update or an error.
 *
 * Success shape: { Position, Direction, Target }
 * Error shape:   { error: "..." }
 */
export function parseStatAck(
  json: unknown,
  name: string,
): { update: RemoteUpdate | null; error: string | null } {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { update: null, error: null };
  }
  const obj = json as Record<string, unknown>;
  if (typeof obj.error === "string") {
    return { update: null, error: obj.error };
  }
  if (typeof obj.Position !== "number") {
    return { update: null, error: null };
  }
  return {
    update: {
      name,
      position: clamp(obj.Position, 0, 100),
      direction: typeof obj.Direction === "number" ? obj.Direction : 0,
      target:
        typeof obj.Target === "number" ? clamp(obj.Target, 0, 100) : clamp(obj.Position, 0, 100),
    },
    error: null,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/**
 * Translate a Sowel `executeOrder(device, orderKey, value)` into a
 * `(topic, payload)` pair to publish on the bridge.
 *
 * Returns null for unknown order keys; the caller logs a warn.
 *
 * Mapping:
 *   shutter_move OPEN   → cmnd/<root>/<name>/Open      ""
 *   shutter_move CLOSE  → cmnd/<root>/<name>/Close     ""
 *   shutter_move STOP   → cmnd/<root>/<name>/Stop      ""
 *   set_shutter_position N → cmnd/<root>/<name>/Position "<N>"
 *
 * Legacy alias `shutter_state` accepted on top of `shutter_move` so manually
 * rebound bindings keep working.
 */
export function buildCmndTopic(
  root: string,
  remoteName: string,
  orderKey: string,
  value: unknown,
): { topic: string; payload: string } | null {
  const base = `cmnd/${root}/${remoteName}`;

  if (orderKey === "shutter_move" || orderKey === "shutter_state") {
    const v = String(value).toUpperCase();
    if (v === "OPEN") return { topic: `${base}/Open`, payload: "" };
    if (v === "CLOSE") return { topic: `${base}/Close`, payload: "" };
    if (v === "STOP") return { topic: `${base}/Stop`, payload: "" };
    return null;
  }

  if (orderKey === "set_shutter_position" || orderKey === "shutter_position") {
    let n: number;
    if (typeof value === "number") n = value;
    else if (typeof value === "string") n = Number(value);
    else return null;
    if (!Number.isFinite(n)) return null;
    return { topic: `${base}/Position`, payload: String(Math.round(clamp(n, 0, 100))) };
  }

  return null;
}

import { describe, it, expect } from "vitest";
import {
  parseSensorPayload,
  parseStatAck,
  buildCmndTopic,
  parseJson,
} from "./sensor-parser.js";

describe("gate support (bridge iter 022)", () => {
  it("parses the Type hint for a gate remote", () => {
    const r = parseSensorPayload({
      driveway: { Position: 0, Direction: 0, Target: 0, Type: "gate" },
    });
    expect(r).toHaveLength(1);
    expect(r[0].type).toBe("gate");
  });
  it("leaves type undefined for a shutter (byte-identical legacy payload)", () => {
    const r = parseSensorPayload({ kitchen: { Position: 10, Direction: 0, Target: 10 } });
    expect(r[0].type).toBeUndefined();
  });
  it("maps a gate_trigger order to the bridge Toggle command", () => {
    expect(buildCmndTopic("somfyrts2mqtt", "driveway", "gate_trigger", "TOGGLE")).toEqual({
      topic: "cmnd/somfyrts2mqtt/driveway/Toggle",
      payload: "",
    });
  });
});

describe("parseSensorPayload", () => {
  it("parses a valid 2-remote payload", () => {
    const result = parseSensorPayload({
      kitchen: { Position: 45, Direction: 1, Target: 100 },
      bedroom: { Position: 0, Direction: 0, Target: 0 },
    });
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.name === "kitchen")).toEqual({
      name: "kitchen",
      position: 45,
      direction: 1,
      target: 100,
    });
    expect(result.find((r) => r.name === "bedroom")).toEqual({
      name: "bedroom",
      position: 0,
      direction: 0,
      target: 0,
    });
  });

  it("clamps out-of-range positions to 0..100", () => {
    const result = parseSensorPayload({ a: { Position: 150 }, b: { Position: -10 } });
    expect(result.find((r) => r.name === "a")?.position).toBe(100);
    expect(result.find((r) => r.name === "b")?.position).toBe(0);
  });

  it("defaults Target to Position when Target is missing or non-numeric", () => {
    const result = parseSensorPayload({ a: { Position: 42 } });
    expect(result[0]).toEqual({ name: "a", position: 42, direction: 0, target: 42 });
  });

  it("skips entries missing Position", () => {
    const result = parseSensorPayload({
      good: { Position: 10 },
      bad: { Direction: 1 },
      worse: "not an object",
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("good");
  });

  it("returns [] on null / array / scalar / undefined payloads", () => {
    expect(parseSensorPayload(null)).toEqual([]);
    expect(parseSensorPayload(undefined)).toEqual([]);
    expect(parseSensorPayload("foo")).toEqual([]);
    expect(parseSensorPayload(42)).toEqual([]);
    expect(parseSensorPayload([{ Position: 10 }])).toEqual([]);
  });

  it("returns [] on empty object", () => {
    expect(parseSensorPayload({})).toEqual([]);
  });
});

describe("parseStatAck", () => {
  it("returns an update on a success payload", () => {
    const { update, error } = parseStatAck(
      { Position: 80, Direction: -1, Target: 50 },
      "kitchen",
    );
    expect(error).toBeNull();
    expect(update).toEqual({ name: "kitchen", position: 80, direction: -1, target: 50 });
  });

  it("returns an error on { error: ... }", () => {
    const { update, error } = parseStatAck({ error: "not calibrated" }, "kitchen");
    expect(update).toBeNull();
    expect(error).toBe("not calibrated");
  });

  it("returns null/null on shape with no Position", () => {
    expect(parseStatAck({ OpenDuration: 18, CloseDuration: 20 }, "kitchen")).toEqual({
      update: null,
      error: null,
    });
  });

  it("returns null/null on null / scalar payload", () => {
    expect(parseStatAck(null, "kitchen")).toEqual({ update: null, error: null });
    expect(parseStatAck("foo", "kitchen")).toEqual({ update: null, error: null });
  });
});

describe("buildCmndTopic", () => {
  it("OPEN → /Open with empty payload", () => {
    expect(buildCmndTopic("somfyrts2mqtt", "kitchen", "shutter_move", "OPEN")).toEqual({
      topic: "cmnd/somfyrts2mqtt/kitchen/Open",
      payload: "",
    });
  });

  it("close (lowercase) → /Close with empty payload", () => {
    expect(buildCmndTopic("somfyrts2mqtt", "kitchen", "shutter_move", "close")).toEqual({
      topic: "cmnd/somfyrts2mqtt/kitchen/Close",
      payload: "",
    });
  });

  it("STOP → /Stop with empty payload", () => {
    expect(buildCmndTopic("somfyrts2mqtt", "kitchen", "shutter_move", "STOP")).toEqual({
      topic: "cmnd/somfyrts2mqtt/kitchen/Stop",
      payload: "",
    });
  });

  it("set_shutter_position 50 → /Position 50", () => {
    expect(buildCmndTopic("somfyrts2mqtt", "kitchen", "set_shutter_position", 50)).toEqual({
      topic: "cmnd/somfyrts2mqtt/kitchen/Position",
      payload: "50",
    });
  });

  it("set_shutter_position '75' (string) → /Position 75", () => {
    expect(buildCmndTopic("somfyrts2mqtt", "kitchen", "set_shutter_position", "75")).toEqual({
      topic: "cmnd/somfyrts2mqtt/kitchen/Position",
      payload: "75",
    });
  });

  it("clamps out-of-range positions to 0..100", () => {
    expect(buildCmndTopic("somfyrts2mqtt", "kitchen", "set_shutter_position", 150)?.payload).toBe(
      "100",
    );
    expect(buildCmndTopic("somfyrts2mqtt", "kitchen", "set_shutter_position", -10)?.payload).toBe(
      "0",
    );
  });

  it("legacy alias shutter_state still maps to /Open|Close|Stop", () => {
    expect(buildCmndTopic("somfyrts2mqtt", "kitchen", "shutter_state", "OPEN")?.topic).toBe(
      "cmnd/somfyrts2mqtt/kitchen/Open",
    );
  });

  it("legacy alias shutter_position still maps to /Position", () => {
    expect(buildCmndTopic("somfyrts2mqtt", "kitchen", "shutter_position", 30)).toEqual({
      topic: "cmnd/somfyrts2mqtt/kitchen/Position",
      payload: "30",
    });
  });

  it("returns null on unknown order key", () => {
    expect(buildCmndTopic("somfyrts2mqtt", "kitchen", "set_brightness", 50)).toBeNull();
  });

  it("returns null on unknown shutter_move value", () => {
    expect(buildCmndTopic("somfyrts2mqtt", "kitchen", "shutter_move", "WIGGLE")).toBeNull();
  });

  it("returns null on non-numeric set_shutter_position", () => {
    expect(buildCmndTopic("somfyrts2mqtt", "kitchen", "set_shutter_position", "abc")).toBeNull();
  });

  it("uses the configured root prefix verbatim (supports multi-bridge)", () => {
    expect(buildCmndTopic("somfy-etage", "chambre", "shutter_move", "OPEN")?.topic).toBe(
      "cmnd/somfy-etage/chambre/Open",
    );
  });
});

describe("parseJson", () => {
  it("parses valid JSON", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns null on invalid JSON", () => {
    expect(parseJson("not json")).toBeNull();
  });
});

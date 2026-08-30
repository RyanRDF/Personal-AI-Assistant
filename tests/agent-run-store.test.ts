import { describe, expect, it } from "vitest";
import { AgentRunStore } from "../src/agent/run-store.js";
import { temporaryDatabase } from "./helpers.js";

describe("AgentRunStore", () => {
  it("persists valid state transitions and append-only events", () => {
    const setup = temporaryDatabase();
    try {
      const store = new AgentRunStore(setup.database);
      store.create({
        id: "run-1",
        ownerChatId: "owner",
        inputKind: "text",
        model: "test-model",
        policyVersion: "1",
      });
      store.transition("run-1", "running");
      store.append("run-1", "capability.requested", { name: "search" });
      store.transition("run-1", "completed");

      expect(store.get("run-1")).toEqual(
        expect.objectContaining({ status: "completed", errorCode: null }),
      );
      expect(store.events("run-1").map(({ sequence, type }) => ({ sequence, type }))).toEqual([
        { sequence: 1, type: "run.queued" },
        { sequence: 2, type: "run.running" },
        { sequence: 3, type: "capability.requested" },
        { sequence: 4, type: "run.completed" },
      ]);
      expect(() => store.transition("run-1", "running")).toThrow("Transisi Agent Run");
    } finally {
      setup.cleanup();
    }
  });

  it("marks only interrupted queued/running work failed during recovery", () => {
    const setup = temporaryDatabase();
    try {
      const store = new AgentRunStore(setup.database);
      for (const id of ["running", "approval"] as const) {
        store.create({
          id,
          ownerChatId: "owner",
          inputKind: "text",
          model: "test-model",
          policyVersion: "1",
        });
        store.transition(id, "running");
      }
      store.transition("approval", "waiting_approval");

      expect(store.recoverInterrupted()).toEqual(["running"]);
      expect(store.get("running")).toEqual(
        expect.objectContaining({ status: "failed", errorCode: "process_restarted" }),
      );
      expect(store.get("approval")?.status).toBe("waiting_approval");
    } finally {
      setup.cleanup();
    }
  });
});

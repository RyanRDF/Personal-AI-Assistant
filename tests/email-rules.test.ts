import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmailRuleService } from "../src/services/email-rules.js";
import { temporaryDatabase } from "./helpers.js";

describe("email rules", () => {
  let setup: ReturnType<typeof temporaryDatabase>;

  beforeEach(() => {
    setup = temporaryDatabase();
  });

  afterEach(() => setup.cleanup());

  it("persists, pauses, and deduplicates evaluations", () => {
    const service = new EmailRuleService(setup.database);
    const rule = service.create("invoice proyek Alpha", "from:vendor@example.com");
    expect(rule.enabled).toBe(true);
    expect(service.setEnabled(rule.id, false)).toBe(true);
    expect(service.list(true)).toHaveLength(0);

    service.recordEvaluation(rule.id, "gmail-1", true, 0.9, "Cocok");
    service.recordEvaluation(rule.id, "gmail-1", true, 0.9, "Cocok");
    expect(service.wasEvaluated(rule.id, "gmail-1")).toBe(true);
  });
});

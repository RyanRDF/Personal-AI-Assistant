import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService, memoryRelevance } from "../src/services/memory.js";
import { temporaryDatabase } from "./helpers.js";

describe("personal memory", () => {
  let setup: ReturnType<typeof temporaryDatabase>;

  beforeEach(() => {
    setup = temporaryDatabase();
  });

  afterEach(() => setup.cleanup());

  it("deduplicates equal memories", () => {
    const service = new MemoryService(setup.database);
    const first = service.save("preference", "Saya suka jawaban singkat");
    const second = service.save("preference", "saya suka jawaban singkat");
    expect(second.id).toBe(first.id);
    expect(service.list()).toHaveLength(1);
  });

  it("ranks lexical Indonesian context", () => {
    const service = new MemoryService(setup.database);
    service.save("preference", "Saya suka jawaban singkat");
    service.save("fact", "Saya suka kopi tanpa gula");
    service.save("fact", "Saya tinggal di Jakarta");
    const relevant = service.relevant("kopi yang saya suka", 10);
    expect(relevant.some((item) => item.content.includes("kopi"))).toBe(true);
    expect(relevant.some((item) => item.content.includes("jawaban singkat"))).toBe(true);
    expect(relevant.some((item) => item.content.includes("Jakarta"))).toBe(false);
    expect(memoryRelevance("kopi gula", "kopi tanpa gula")).toBe(1);
  });

  it("updates a changed memory instead of keeping a contradiction", () => {
    const service = new MemoryService(setup.database);
    const memory = service.save("fact", "Saya tinggal di Jakarta");
    const updated = service.update(memory.id, "fact", "Saya tinggal di Bandung");
    expect(updated?.content).toBe("Saya tinggal di Bandung");
    expect(service.list()).toHaveLength(1);
  });
});

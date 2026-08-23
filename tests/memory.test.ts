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

  it("uses the limit independently for preferences and relevant facts", () => {
    const service = new MemoryService(setup.database);
    service.save("preference", "Gunakan jawaban singkat");
    service.save("fact", "Proyek Alpha menggunakan PostgreSQL");

    expect(service.relevant("database proyek Alpha", 1)).toEqual([
      expect.objectContaining({ kind: "preference", content: "Gunakan jawaban singkat" }),
      expect.objectContaining({ kind: "fact", content: "Proyek Alpha menggunakan PostgreSQL" }),
    ]);
  });

  it("keeps old preferences beyond the recent fact candidate window", () => {
    const service = new MemoryService(setup.database);
    service.save("preference", "Selalu gunakan bahasa Indonesia");
    for (let index = 0; index < 55; index += 1) {
      service.save("fact", `Fakta proyek Alpha nomor ${index}`);
    }

    const relevant = service.relevant("proyek Alpha", 4);
    expect(relevant[0]).toEqual(
      expect.objectContaining({ kind: "preference", content: "Selalu gunakan bahasa Indonesia" }),
    );
    expect(relevant).toHaveLength(5);
  });

  it("bounds each memory class and ranks facts independently", () => {
    const service = new MemoryService(setup.database);
    service.save("preference", "Preferensi pertama");
    service.save("preference", "Preferensi kedua");
    service.save("preference", "Preferensi ketiga");
    service.save("fact", "Proyek Alpha memakai SQLite");
    service.save("fact", "Proyek Alpha memakai SQLite dan TypeScript");
    service.save("fact", "Proyek Beta memakai Redis");

    const relevant = service.relevant("Proyek Alpha SQLite TypeScript", 4);
    expect(relevant.filter((item) => item.kind === "preference")).toHaveLength(3);
    expect(relevant.slice(3).map((item) => item.content)).toEqual([
      "Proyek Alpha memakai SQLite dan TypeScript",
      "Proyek Alpha memakai SQLite",
      "Proyek Beta memakai Redis",
    ]);
  });

  it("keeps more than five preferences at default capacity despite fact saturation", () => {
    const service = new MemoryService(setup.database);
    for (let index = 0; index < 6; index += 1) {
      service.save("preference", `Preferensi stabil nomor ${index}`);
    }
    for (let index = 0; index < 120; index += 1) {
      service.save("fact", `Fakta proyek Gamma nomor ${index}`);
    }

    const relevant = service.relevant("proyek Gamma", 20);
    const preferences = relevant.filter((item) => item.kind === "preference");
    const facts = relevant.filter((item) => item.kind !== "preference");

    expect(preferences).toHaveLength(6);
    expect(preferences.at(-1)?.content).toBe("Preferensi stabil nomor 0");
    expect(facts).toHaveLength(20);
    expect(relevant.length).toBeLessThanOrEqual(40);
  });

  it("enforces a hard limit for each memory class", () => {
    const service = new MemoryService(setup.database);
    for (let index = 0; index < 3; index += 1) {
      service.save("preference", `Preferensi bounded ${index}`);
      service.save("fact", `Fakta bounded proyek Delta ${index}`);
    }

    const relevant = service.relevant("proyek Delta", 2);
    expect(relevant.filter((item) => item.kind === "preference")).toHaveLength(2);
    expect(relevant.filter((item) => item.kind !== "preference")).toHaveLength(2);
    expect(relevant).toHaveLength(4);
  });

  it("updates a changed memory instead of keeping a contradiction", () => {
    const service = new MemoryService(setup.database);
    const memory = service.save("fact", "Saya tinggal di Jakarta");
    const updated = service.update(memory.id, "fact", "Saya tinggal di Bandung");
    expect(updated?.content).toBe("Saya tinggal di Bandung");
    expect(service.list()).toHaveLength(1);
  });
});

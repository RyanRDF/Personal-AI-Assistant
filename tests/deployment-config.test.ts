import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Railway deployment config", () => {
  it("uses the runtime types accepted by Railway", () => {
    const config = JSON.parse(
      fs.readFileSync(path.resolve("railway.json"), "utf8"),
    ) as {
      build: { builder: string };
      deploy: { drainingSeconds: unknown; healthcheckPath: string };
    };

    expect(config.build.builder).toBe("DOCKERFILE");
    expect(config.deploy.healthcheckPath).toBe("/health");
    expect(config.deploy.drainingSeconds).toBe(30);
    expect(typeof config.deploy.drainingSeconds).toBe("number");
  });
});

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

  it("leaves persistent storage mounting to Railway Volumes", () => {
    const dockerfile = fs.readFileSync(path.resolve("Dockerfile"), "utf8");

    expect(dockerfile).not.toMatch(/^\s*VOLUME\b/imu);
    expect(dockerfile).toContain("RUN mkdir -p /app/data");
  });

  it("exposes the dashboard health server outside the Docker container", () => {
    const dockerfile = fs.readFileSync(path.resolve("Dockerfile"), "utf8");

    expect(dockerfile).toContain("ENV DASHBOARD_HOST=0.0.0.0");
  });
});

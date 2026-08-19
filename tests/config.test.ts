import { describe, expect, it } from "vitest";
import { isGmailConfigured, loadConfig } from "../src/config.js";
import { testConfig } from "./helpers.js";

describe("configuration", () => {
  it("uses economical defaults", () => {
    const config = testConfig();
    expect(config.OPENAI_CHAT_MODEL).toBe("gpt-4o-mini");
    expect(config.OPENAI_CLASSIFIER_MODEL).toBe("gpt-4o-mini");
    expect(config.SEARCH_PROVIDER).toBe("searxng");
    expect(config.TIMEZONE).toBe("Asia/Jakarta");
    expect(isGmailConfigured(config)).toBe(false);
  });

  it("rejects missing owner and secrets", () => {
    expect(() => loadConfig({})).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("detects a complete Gmail configuration", () => {
    const config = testConfig({
      GMAIL_CLIENT_ID: "client-id",
      GMAIL_CLIENT_SECRET: "client-secret",
      GMAIL_REFRESH_TOKEN: "refresh-token",
    });
    expect(isGmailConfigured(config)).toBe(true);
  });
});

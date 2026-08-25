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
    expect(config.OPENAI_MAX_OUTPUT_TOKENS).toBe(2000);
    expect(config.ASSISTANT_TIMEOUT_SECONDS).toBe(90);
    expect(config.EMAIL_CLASSIFIER_TIMEOUT_SECONDS).toBe(30);
    expect(config.TELEGRAM_IMAGE_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(config.TRACE_ENABLED_DEFAULT).toBe(false);
    expect(config.VAULT_STORAGE_BACKEND).toBe("local");
    expect(config.ATTACHMENT_ANALYSIS_ENABLED).toBe(true);
    expect(isGmailConfigured(config)).toBe(false);
  });

  it("requires complete S3 credentials when bucket storage is enabled", () => {
    expect(() => testConfig({ VAULT_STORAGE_BACKEND: "s3" })).toThrow(/S3_BUCKET/);
    const config = testConfig({
      VAULT_STORAGE_BACKEND: "s3",
      S3_BUCKET: "bucket-test",
      S3_ENDPOINT: "https://storage.railway.app",
      S3_ACCESS_KEY_ID: "access",
      S3_SECRET_ACCESS_KEY: "secret",
    });
    expect(config.VAULT_STORAGE_BACKEND).toBe("s3");
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

import { describe, expect, it, vi } from "vitest";
import { GmailService, extractText } from "../src/services/gmail.js";
import { testConfig } from "./helpers.js";

function encoded(value: string): string {
  return Buffer.from(value).toString("base64url");
}

describe("Gmail MIME extraction", () => {
  it("recursively prefers the real plain-text body and excludes text attachments", () => {
    const body = extractText({
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "text/plain",
          filename: "notes.txt",
          body: { data: encoded("attachment content") },
        },
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/html", body: { data: encoded("<p>HTML body</p>") } },
            { mimeType: "text/plain", body: { data: encoded("Actual message body") } },
          ],
        },
      ],
    });

    expect(body).toBe("Actual message body");
  });

  it("falls back to nested HTML and ignores Content-Disposition attachments", () => {
    const body = extractText({
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "text/html",
          headers: [{ name: "Content-Disposition", value: "attachment; filename=offer.html" }],
          body: { data: encoded("<p>Attachment</p>") },
        },
        {
          mimeType: "multipart/related",
          parts: [
            { mimeType: "text/html", body: { data: encoded("<p>Hello &amp; welcome</p>") } },
          ],
        },
      ],
    });

    expect(body).toBe("Hello & welcome");
  });
});

describe("Gmail search pagination", () => {
  it("paginates message IDs and passes the caller signal to every request", async () => {
    const service = new GmailService(
      testConfig({
        GMAIL_CLIENT_ID: "client-id",
        GMAIL_CLIENT_SECRET: "client-secret",
        GMAIL_REFRESH_TOKEN: "refresh-token",
      }),
    );
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: { messages: [{ id: "m-1" }], nextPageToken: "page-2" },
      })
      .mockResolvedValueOnce({
        data: { messages: [{ id: "m-2" }, { id: "m-1" }] },
      });
    Object.defineProperty(service, "client", {
      value: { users: { messages: { list } } },
    });
    const controller = new AbortController();

    await expect(
      service.searchMessageIds("after:123", Number.POSITIVE_INFINITY, {
        signal: controller.signal,
      }),
    ).resolves.toEqual(["m-1", "m-2"]);

    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
    expect(list.mock.calls[1]?.[0]).toMatchObject({ pageToken: "page-2" });
    expect(list.mock.calls[1]?.[1]).toEqual({ signal: controller.signal });
  });
});

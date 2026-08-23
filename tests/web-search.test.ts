import { describe, expect, it, vi } from "vitest";
import {
  BraveSearchProvider,
  SearxngSearchProvider,
  formatSearchResults,
} from "../src/services/web-search.js";

describe("web search providers", () => {
  it("normalizes Brave results", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          web: {
            results: [
              { title: "Sumber", url: "https://example.com/news", description: "Ringkasan" },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const provider = new BraveSearchProvider("key", 5, fetcher as typeof fetch);
    await expect(provider.search("berita AI")).resolves.toEqual([
      { title: "Sumber", url: "https://example.com/news", snippet: "Ringkasan" },
    ]);
  });

  it("combines caller cancellation with the Brave timeout", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const provider = new BraveSearchProvider("key", 5, fetcher as typeof fetch);
    const pending = provider.search("berita AI", undefined, controller.signal);

    controller.abort(new DOMException("dibatalkan", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("normalizes SearXNG and preserves citation URLs", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          results: [{ title: "Dokumen", url: "https://example.org/doc", content: "Isi" }],
        }),
        { status: 200 },
      ),
    );
    const provider = new SearxngSearchProvider(
      "http://localhost:8080",
      5,
      fetcher as typeof fetch,
    );
    const results = await provider.search("dokumentasi");
    expect(formatSearchResults(results, provider.name)).toContain("https://example.org/doc");
  });

  it("passes caller cancellation to SearXNG requests", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(
      async (_input: URL | RequestInfo, _init?: RequestInit) =>
        new Response(JSON.stringify({ results: [] })),
    );
    const provider = new SearxngSearchProvider(
      "http://localhost:8080",
      5,
      fetcher as typeof fetch,
    );

    await provider.search("dokumentasi", 3, controller.signal);
    controller.abort();

    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});

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
});

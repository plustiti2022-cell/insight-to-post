import { test } from "node:test";
import assert from "node:assert/strict";
import { researchWithTavily } from "../src/server/services/research";
import { edges } from "../src/server/workflow/edges";
import { initialState } from "../src/server/workflow/state";
import { runAnalysisGraph, analysisDependencies } from "../src/server/workflow/run";
import { reportBasedSocial } from "../src/core/social";

const idea = "AI会减少初级岗位吗？";
const query = "AI entry level jobs employment research evidence";
const body = "Researchers observed changes in junior hiring and described the scope and limitations of their employment study. ".repeat(3);
const model = (data: unknown) => Response.json({ output_text: JSON.stringify(data), usage: { total_tokens: 10 } });
async function mocked(fetcher: typeof fetch, run: () => Promise<void>) {
  const savedFetch = globalThis.fetch;
  const savedQwen = process.env.QWEN_API_KEY, savedTavily = process.env.TAVILY_API_KEY;
  process.env.QWEN_API_KEY = process.env.TAVILY_API_KEY = "test-only";
  globalThis.fetch = fetcher;
  try { await run(); } finally {
    globalThis.fetch = savedFetch;
    if (savedQwen === undefined) delete process.env.QWEN_API_KEY; else process.env.QWEN_API_KEY = savedQwen;
    if (savedTavily === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = savedTavily;
  }
}

test("question becomes semantic search keywords; one useful article is enough and usage reaches diagnostics", async () => {
  let searches = 0;
  await mocked(async (url, init) => {
    const input = JSON.parse(String(init?.body));
    if (String(url).endsWith("/search")) {
      searches++;
      assert.equal(input.query, query);
      assert.equal(input.max_results, 15);
      assert.equal(input.search_depth, "advanced");
      assert.equal(input.include_raw_content, "markdown");
      return Response.json({ results: [{ url: "https://stanford.edu/jobs", raw_content: body }], usage: { credits: 2 } });
    }
    if (input.input.startsWith("你是检索规划")) {
      assert.equal(JSON.parse(input.input.split("\n输入：")[1]).idea, idea);
      return model({ query });
    }
    const review = JSON.parse(input.input.split("\n输入：")[1]);
    assert.ok(review.sources[0].passages.includes("junior hiring"));
    return model({ followUpQuery: null });
  }, async () => {
    const result = await runAnalysisGraph({ idea, socialTargetLength: 2000 }, {
      ...analysisDependencies,
      generateReport: async () => ({ draft: { title: idea, summary: [{ presentation: "lead", text: "部分初级岗位的招聘需求可能变化。", references: [{ sourceId: "S1", quote: body }] }], cards: [], limitations: [] }, modelCalls: 1, totalTokens: 5, warnings: [] }),
      generateSocialContent: async (report, sources) => ({ socialContent: reportBasedSocial(report, sources, 2000), modelCalls: 0, totalTokens: 0, durationMs: 0 }),
      signSocialSnapshot: () => "test-token",
    });
    assert.equal(searches, 1);
    assert.equal(result.diagnostics.modelCalls, 3);
    assert.equal(result.diagnostics.totalTokens, 25);
    assert.equal(result.diagnostics.tavilyCredits, 2);
    assert.deepEqual(result.searchSteps, [{ query, resultCount: 1, extractedCount: 1, sourceIds: ["S1"] }]);
  });
});

test("coverage gaps trigger a targeted second query even with many bodies; second round has no model loop", async () => {
  const followUpQuery = "AI entry level employer hiring survey";
  const searches: string[] = [];
  await mocked(async (url, init) => {
    const input = JSON.parse(String(init?.body));
    if (String(url).endsWith("/search")) {
      searches.push(input.query);
      return Response.json({ results: Array.from({ length: 6 }, (_, i) => ({ url: `https://example.org/${searches.length}-${i}`, raw_content: body })) });
    }
    return input.input.startsWith("你是检索规划") ? model({ query }) : model({ followUpQuery });
  }, async () => {
    const first = await researchWithTavily(idea);
    const before = structuredClone(first);
    assert.equal(edges.search({ ...initialState(idea), research: first }), "supplement");
    const second = await researchWithTavily(idea, undefined, first);
    assert.deepEqual(first, before, "follow-up cannot mutate prior research");
    assert.deepEqual(searches, [query, followUpQuery]);
    assert.equal(second.sources.length, 12);
    assert.equal(second.modelCalls, 2);
    assert.equal(second.followUpQuery, undefined);
    assert.deepEqual(second.searchSteps?.[1].sourceIds, ["S7", "S8", "S9", "S10", "S11", "S12"]);
  });
});

test("all missing bodies are extracted in batches and search summaries never reach evidence", async () => {
  const batches: string[][] = [];
  await mocked(async (url, init) => {
    const input = JSON.parse(String(init?.body));
    if (String(url).endsWith("/search")) return Response.json({ results: Array.from({ length: 25 }, (_, i) => ({ url: `https://example.org/${i}`, content: "SEARCH_SNIPPET_ONLY" })) });
    if (String(url).endsWith("/extract")) {
      batches.push(input.urls);
      return Response.json({ results: input.urls.slice(0, -1).map((url: string) => ({ url, raw_content: body })) });
    }
    if (input.input.startsWith("你是检索规划")) return model({ query });
    assert.ok(!input.input.includes("SEARCH_SNIPPET_ONLY"));
    return model({ followUpQuery: null });
  }, async () => {
    const result = await researchWithTavily(idea);
    assert.deepEqual(batches.map((batch) => batch.length), [20, 5]);
    assert.equal(result.extractorCalls, 2);
    assert.equal(result.sources.filter((source) => source.extractionStatus === "available").length, 23);
    assert.ok(result.sources.filter((source) => source.extractionStatus === "failed").every((source) => source.extractedContent === ""));
  });
});

test("invalid planning falls back to the question; invalid review preserves sources without invented follow-up", async () => {
  await mocked(async (url, init) => {
    if (String(url).endsWith("/search")) {
      assert.equal(JSON.parse(String(init?.body)).query, idea);
      return Response.json({ results: [{ url: "https://example.org/a", raw_content: body }] });
    }
    return model({ query: "" });
  }, async () => {
    const result = await researchWithTavily(idea);
    assert.equal(result.sources.length, 1);
    assert.equal(result.followUpQuery, undefined);
    assert.equal(result.warnings.length, 2);
    assert.equal(result.modelCalls, 2);
    assert.equal(result.totalTokens, 20);
  });
});

test("duplicate refinement ends research and a failed second search retains every first-round article", async () => {
  for (const followUpQuery of [query.toUpperCase(), "missing hiring evidence"]) {
    let searches = 0;
    await mocked(async (url, init) => {
      const input = JSON.parse(String(init?.body));
      if (String(url).endsWith("/search")) {
        if (++searches === 2) return new Response("private upstream error", { status: 503 });
        return Response.json({ results: [{ url: "https://example.org/a", raw_content: body }] });
      }
      return input.input.startsWith("你是检索规划") ? model({ query }) : model({ followUpQuery });
    }, async () => {
      const first = await researchWithTavily(idea);
      if (followUpQuery === query.toUpperCase()) assert.equal(first.followUpQuery, undefined);
      else {
        const second = await researchWithTavily(idea, undefined, first);
        assert.equal(second.sources[0].extractedContent, body.trim());
        assert.equal(second.searchCalls, 2);
        assert.equal(second.searchSteps?.[1].resultCount, 0);
        assert.ok(second.warnings.every((warning) => !warning.includes("private upstream")));
      }
    });
  }
});

test("a supplied public URL is extracted directly with no search or planning call", async () => {
  let calls = 0;
  await mocked(async (url, init) => {
    calls++;
    assert.ok(String(url).endsWith("/extract"));
    assert.deepEqual(JSON.parse(String(init?.body)).urls, ["https://example.org/research"]);
    return Response.json({ results: [{ url: "https://example.org/research", raw_content: body }] });
  }, async () => {
    const result = await researchWithTavily("解释这篇文章 https://example.org/research。");
    assert.equal(calls, 1);
    assert.equal(result.searchCalls, 0);
    assert.equal(result.modelCalls, 0);
    assert.equal(result.sources[0].extractionStatus, "available");
  });
});

test("cancellation during planning, extraction or coverage review always escapes research fallback", async () => {
  for (const stage of ["planning", "extract", "review"]) {
    const controller = new AbortController();
    await mocked(async (url, init) => {
      const input = JSON.parse(String(init?.body));
      const current = String(url).endsWith("/extract") ? "extract" : input.input?.startsWith("你是检索规划") ? "planning" : "review";
      if (!String(url).endsWith("/search") && current === stage) {
        controller.abort();
        throw new DOMException("cancelled", "AbortError");
      }
      if (String(url).endsWith("/search")) return Response.json({ results: [{ url: "https://example.org/a" }] });
      if (String(url).endsWith("/extract")) return Response.json({ results: [{ url: "https://example.org/a", raw_content: body }] });
      return model({ query });
    }, async () => {
      await assert.rejects(researchWithTavily(idea, controller.signal), (error: unknown) => error instanceof Error && (("code" in error && error.code === "CANCELLED") || error.name === "AbortError"));
    });
  }
});

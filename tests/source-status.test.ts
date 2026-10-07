import { test } from "node:test";
import assert from "node:assert/strict";
import { publicSources } from "../src/core/sources";
import type { Draft, Source } from "../src/core/contracts";
import { applyContent, mergeResults } from "../src/server/services/research";

const empty: Draft = { title: "test", cards: [], summary: [], limitations: [] };
const evidence =
  "In 2025, 42% of survey respondents reported using the service in at least one business function. "
    .repeat(2)
    .trim();
const source = (id: string): Source => ({
  id,
  url: `https://example.org/${id}`,
  title: null,
  sourceType: "未知",
  publishedAt: null,
  extractedContent: "",
  extractionStatus: "not_attempted",
  extractionReason: "未请求正文。",
});

test("public labels distinguish unattempted, failed, unusable and referenced articles", () => {
  const sources = ["S1", "S2", "S3", "S4"].map(source);
  applyContent(sources[1], "");
  applyContent(sources[2], "Access Denied https://errors.edgesuite.net/123");
  applyContent(sources[3], evidence);
  const report: Draft = {
    ...empty,
    summary: [
      {
        text: "test",
        references: [{ sourceId: "S4", quote: evidence }],
      },
    ],
  };
  assert.deepEqual(
    publicSources(sources, report).map((item) => item.status),
    ["not_attempted", "extraction_failed", "unusable", "referenced"],
  );
});

test("available evidence without a surviving claim is labelled extracted_unused", () => {
  const article = source("S1");
  applyContent(article, evidence);
  assert.equal(publicSources([article], empty)[0].status, "extracted_unused");
});

test("later failed extraction preserves earlier usable evidence", () => {
  const article = source("S1");
  applyContent(article, evidence);
  applyContent(article, "");
  applyContent(article, "Access Denied");
  assert.equal(article.extractedContent, evidence);
  assert.equal(article.extractionStatus, "available");
});

test("search summary cannot replace missing raw_content", () => {
  const research = {
    sources: [],
    searchCalls: 1,
    extractorCalls: 0,
    credits: 0,
    warnings: [],
  };
  mergeResults(research, [
    { url: "https://example.org/article", content: evidence },
  ]);
  assert.equal(publicSources(research.sources, empty)[0].hasEvidence, false);
  assert.equal(
    publicSources(research.sources, empty)[0].status,
    "extraction_failed",
  );
});

test("public source projection removes private article bodies and extraction fields", () => {
  const article = source("S1");
  applyContent(article, evidence);
  const projected = publicSources([article], empty)[0];
  assert.ok(!("extractedContent" in projected));
  assert.ok(!("extractionStatus" in projected));
  assert.ok(!("extractionReason" in projected));
  assert.equal(article.extractedContent, evidence);
});

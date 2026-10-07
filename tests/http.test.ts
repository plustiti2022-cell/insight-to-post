import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { jsonEndpoint } from "../src/server/http";
import { AnalysisError } from "../src/server/runtime";

const options = {
  maxChars: 100,
  busyMessage: "busy",
  invalidMessage: "invalid",
  tooLargeMessage: "too large",
  failureMessage: "failed",
};
const request = (text = '{"idea":"test"}') =>
  new Request("https://local.test/api", { method: "POST", body: text });
const schema = z.object({ idea: z.string().min(1) });

test("invalid JSON, invalid input and oversized body never reach the endpoint service", async () => {
  let calls = 0;
  const endpoint = jsonEndpoint(
    schema,
    async () => {
      calls++;
    },
    options,
  );
  assert.equal((await endpoint(request("not JSON"))).status, 400);
  assert.equal((await endpoint(request("{}"))).status, 400);
  assert.equal((await endpoint(request("x".repeat(101)))).status, 413);
  assert.equal(calls, 0);
});

test("concurrent requests are bounded and release capacity after a failure", async () => {
  const releases: Array<() => void> = [];
  const endpoint = jsonEndpoint(
    schema,
    async () => {
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      throw new AnalysisError("TIMEOUT", "timed out", 504);
    },
    options,
  );
  const first = endpoint(request()),
    second = endpoint(request());
  // 等待解析请求体，直到两个处理器均进入服务。
  while (releases.length < 2)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await endpoint(request())).status, 429);
  releases.shift()!();
  assert.equal((await first).status, 504);
  const third = endpoint(request());
  while (releases.length < 2)
    await new Promise<void>((resolve) => setImmediate(resolve));
  for (const release of releases) release();
  assert.equal((await second).status, 504);
  assert.equal((await third).status, 504);
});

test("unknown errors never expose upstream body and results are never cached", async () => {
  const endpoint = jsonEndpoint(
    schema,
    async () => {
      throw new Error("private-key-body");
    },
    options,
  );
  const response = await endpoint(request());
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: { code: "INTERNAL", message: "failed" },
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("native request cancellation returns CANCELLED and releases the endpoint", async () => {
  const controller = new AbortController();
  const endpoint = jsonEndpoint(
    schema,
    async (_input, signal) => {
      controller.abort();
      signal.throwIfAborted();
    },
    options,
  );
  const response = await endpoint(
    new Request("https://local.test/api", {
      method: "POST",
      body: '{"idea":"test"}',
      signal: controller.signal,
    }),
  );
  assert.equal(response.status, 499);
  assert.equal((await response.json()).error.code, "CANCELLED");
});

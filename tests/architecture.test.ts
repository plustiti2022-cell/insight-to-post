import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const files = readdirSync(root, { recursive: true, encoding: "utf8" })
  .filter((file) => /\.(ts|tsx)$/.test(file))
  .map((file) => file.replaceAll("\\", "/"));
const modules = new Map(
  files.map((file) => [file, readFileSync(path.join(root, file), "utf8")]),
);
const graph = new Map<string, string[]>();
for (const [file, source] of modules) {
  const imports = [
    ...source.matchAll(/^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm),
  ];
  const targets: string[] = [];
  for (const [, , specifier] of imports) {
    if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
    const base = specifier.startsWith("@/")
      ? specifier.slice(2)
      : path.posix.normalize(
          path.posix.join(path.posix.dirname(file), specifier),
        );
    const target = [base + ".ts", base + ".tsx"].find((candidate) =>
      modules.has(candidate),
    );
    assert.ok(target, `${file}: unresolved module ${specifier}`);
    targets.push(target);
    if (file.startsWith("core/"))
      assert.ok(
        target.startsWith("core/"),
        `${file}: core must stay independent of ${target}`,
      );
    if (file.startsWith("server/"))
      assert.ok(
        !/^(client|components|app)\//.test(target),
        `${file}: server cannot depend on UI ${target}`,
      );
    if (file.startsWith("server/providers/"))
      assert.ok(
        target === "server/runtime.ts" || target.startsWith("core/"),
        `${file}: providers cannot depend on business services ${target}`,
      );
    if (file.startsWith("server/services/"))
      assert.ok(
        !target.startsWith("server/workflow/"),
        `${file}: services cannot depend on workflow ${target}`,
      );
    if (
      file.startsWith("server/workflow/") &&
      file !== "server/workflow/run.ts"
    ) {
      assert.ok(
        !/^server\/(providers|services)\//.test(target),
        `${file}: workflow details must use capability contracts, not ${target}`,
      );
    }
    if (
      /^(client|components)\//.test(file) ||
      /^['"]use client['"]/.test(source)
    ) {
      assert.ok(
        !target.startsWith("server/"),
        `${file}: client cannot import server code ${target}`,
      );
    }
  }
  graph.set(file, targets);
}

test("module boundaries and pure business rules remain independent of runtime and UI", () => {
  for (const [file, source] of modules) {
    if (!file.startsWith("core/")) continue;
    assert.doesNotMatch(
      source,
      /\bprocess\.env\b|\bfetch\s*\(|from\s+['"](?:node:|react)/,
      `${file}: business rules cannot read environment or perform I/O`,
    );
  }
  assert.equal(
    existsSync(path.join(root, "lib/analyze.ts")),
    false,
    "old forwarding modules must not reappear",
  );
});

test("the source dependency graph has no cycles, including type dependencies", () => {
  const done = new Set<string>();
  function visit(file: string, ancestors: string[]) {
    assert.ok(
      !ancestors.includes(file),
      `Dependency cycle: ${[...ancestors, file].join(" -> ")}`,
    );
    if (done.has(file)) return;
    for (const target of graph.get(file) ?? [])
      visit(target, [...ancestors, file]);
    done.add(file);
  }
  for (const file of files) visit(file, []);
});

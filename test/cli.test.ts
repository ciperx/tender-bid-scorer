import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { buildDocument, parseArgs, run, serialise } from "../src/cli.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const cliPath = join(here, "..", "src", "cli.js");
const examplePath = join(here, "..", "..", "example", "bids.json");
const weightsPath = join(here, "..", "..", "example", "weights-price-heavy.json");

function cli(args: string[]): string {
  return execFileSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
}

test("the CLI is byte identical across runs", () => {
  const first = cli(["--input", examplePath, "--format", "json", "--explain"]);
  const second = cli(["--input", examplePath, "--format", "json", "--explain"]);
  assert.equal(first, second);
  assert.ok(first.length > 100);
});

test("the CLI is byte identical across runs for the table too", () => {
  const first = cli(["--input", examplePath, "--format", "table", "--explain"]);
  const second = cli(["--input", examplePath, "--format", "table", "--explain"]);
  assert.equal(first, second);
});

test("json output has the documented shape", () => {
  const output = cli(["--input", examplePath, "--format", "json"]);
  const doc = JSON.parse(output) as {
    weights: Record<string, number>;
    ranking: Array<Record<string, unknown>>;
  };
  assert.deepEqual(Object.keys(doc).sort(), ["ranking", "weights"]);
  assert.deepEqual(Object.keys(doc.weights).sort(), ["delivery", "experience", "price", "technical"]);
  assert.ok(doc.ranking.length > 0);
  for (const entry of doc.ranking) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["bid_id", "rank", "reason", "score", "test_evidence"],
    );
    assert.equal(typeof entry.bid_id, "string");
    assert.equal(typeof entry.rank, "number");
    assert.equal(typeof entry.score, "number");
    assert.equal(typeof entry.reason, "string");
  }
});

test("the table output names every bid and carries the reasons", () => {
  const output = cli(["--input", examplePath, "--format", "table"]);
  assert.match(output, /RANK\s+BID_ID\s+SCORE\s+PRICE_USDC/);
  assert.match(output, /Reasons/);
  assert.match(output, /bid-ada/);
  assert.match(output, /bid-finn/);
  assert.match(output, /Rank 1 of 6/);
});

test("the explain flag prints per factor contributions", () => {
  const output = cli(["--input", examplePath, "--format", "table", "--explain"]);
  assert.match(output, /Weights: price 30, technical 30, delivery 15, experience 25/);
  assert.match(output, /PRICE\s+TECHNICAL\s+DELIVERY\s+EXPERIENCE/);
  assert.match(output, /Notes/);
  assert.match(output, /price=under_ceiling/);

  const json = JSON.parse(cli(["--input", examplePath, "--format", "json", "--explain"])) as {
    ranking: Array<{ factors: Record<string, { points: number; max: number; note: string }> }>;
  };
  const factors = json.ranking[0].factors;
  assert.deepEqual(Object.keys(factors).sort(), ["delivery", "experience", "price", "technical"]);
});

test("the weights file overrides the embedded weights", () => {
  const doc = JSON.parse(
    cli(["--input", examplePath, "--weights", weightsPath, "--format", "json"]),
  ) as { weights: Record<string, number> };
  assert.deepEqual(doc.weights, { price: 40, technical: 40, delivery: 10, experience: 10 });
});

test("bad weights exit with code 2 and a clear message", () => {
  const dir = mkdtempSync(join(tmpdir(), "tbs-"));
  const bad = join(dir, "bad-weights.json");
  writeFileSync(bad, JSON.stringify({ price: -5 }), "utf8");
  const result = run(["--input", examplePath, "--weights", bad]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /invalid weights/);
});

test("missing input file exits with code 2", () => {
  const result = run(["--input", "/nonexistent/bids.json"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /ENOENT|no such file/i);
});

test("missing arguments exit with code 2 and print usage", () => {
  assert.equal(run([]).code, 2);
  assert.match(run([]).stderr, /--input is required/);
  assert.equal(run(["--format", "xml", "--input", examplePath]).code, 2);
  assert.equal(run(["--input"]).code, 2);
  assert.equal(run(["--wat"]).code, 2);
  assert.equal(run(["--help"]).code, 0);
});

test("--out writes the JSON document and keeps stdout clean", () => {
  const dir = mkdtempSync(join(tmpdir(), "tbs-"));
  const target = join(dir, "ranked.json");
  const result = run(["--input", examplePath, "--format", "json", "--out", target]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  const written = JSON.parse(readFileSync(target, "utf8")) as { ranking: unknown[] };
  assert.ok(Array.isArray(written.ranking));
});

test("parseArgs accepts every documented flag", () => {
  const options = parseArgs(["--input", "a.json", "--weights", "w.json", "--format", "table", "--explain"]);
  assert.deepEqual(options, { input: "a.json", weights: "w.json", format: "table", explain: true });
});

test("serialise keeps the key order stable", () => {
  const doc = buildDocument(
    JSON.parse(readFileSync(examplePath, "utf8")) as {
      bundle: Record<string, unknown>;
      bids: never[];
      records: Record<string, never>;
      weights: Record<string, number>;
    },
  );
  const text = serialise(doc, false);
  assert.match(text, /^\{\n  "weights": \{\n    "price":/);
  assert.equal(text, serialise(buildDocument(JSON.parse(readFileSync(examplePath, "utf8")) as never), false));
});

/**
 * Command line entry point.
 *
 * Usage:
 *   tender-bid-scorer --input example/bids.json [options]
 *
 * Options:
 *   --input <path>      JSON bundle of bids (required). May embed weights.
 *   --weights <path>    JSON weights file, overrides any embedded weights.
 *   --format <kind>     json, table or both. Default: both.
 *   --explain           Add per factor contributions to JSON and print the table.
 *   --out <path>        Write the JSON document to a file instead of stdout.
 *
 * Exit codes: 0 success, 2 bad usage or invalid input.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolveWeights, WeightsError } from "./config.js";
import { renderExplain, renderTable } from "./format.js";
import { rankBids } from "./rank.js";
import type { Bid, Bundle, RankedBid, Records, Weights } from "./types.js";

export interface CliOptions {
  input: string;
  weights?: string;
  format: "json" | "table" | "both";
  explain: boolean;
  out?: string;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const USAGE = `tender-bid-scorer

Rank tender bids on price against the ceiling, technical compliance, delivery
time and experience, with one written reason per bid.

Usage:
  tender-bid-scorer --input <file> [--weights <file>] [--format json|table|both]
                    [--explain] [--out <file>]

Exit codes: 0 success, 2 bad usage or invalid input.`;

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { input: "", format: "both", explain: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (name: string): string => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${name} requires a value`);
      }
      index += 1;
      return next;
    };
    switch (arg) {
      case "--input":
        options.input = readValue("--input");
        break;
      case "--weights":
        options.weights = readValue("--weights");
        break;
      case "--out":
        options.out = readValue("--out");
        break;
      case "--format": {
        const value = readValue("--format");
        if (value !== "json" && value !== "table" && value !== "both") {
          throw new Error("--format must be json, table or both");
        }
        options.format = value;
        break;
      }
      case "--explain":
        options.explain = true;
        break;
      case "--help":
      case "-h":
        throw new Error("__help__");
      default:
        throw new Error(`unknown argument "${arg}"`);
    }
  }
  if (options.input.length === 0) {
    throw new Error("--input is required");
  }
  return options;
}

interface InputDocument {
  bundle?: Bundle;
  bids?: Bid[];
  records?: Records;
  weights?: Partial<Weights> | null;
}

function readJson(path: string): unknown {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`cannot parse JSON in ${path}: ${(error as Error).message}`);
  }
}

export interface RankedDocument {
  weights: Weights;
  ranking: RankedBid[];
}

/** Build the output document. Kept separate from IO so tests can call it. */
export function buildDocument(doc: InputDocument, overrideWeights?: Partial<Weights> | null): RankedDocument {
  const bundle: Bundle = doc.bundle ?? {};
  const bids: Bid[] = Array.isArray(doc.bids) ? doc.bids : [];
  const records: Records = doc.records ?? {};
  const weights = resolveWeights(overrideWeights ?? doc.weights ?? null);
  const ranking = rankBids(bundle, bids, records, weights, { explain: true });
  return { weights, ranking };
}

export function serialise(document: RankedDocument, explain: boolean): string {
  const ranking = document.ranking.map((entry) => {
    if (explain) return entry;
    const { factors: _factors, ...rest } = entry;
    return rest;
  });
  return JSON.stringify({ weights: document.weights, ranking }, null, 2);
}

export function run(argv: string[]): CliResult {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    const message = (error as Error).message;
    if (message === "__help__") {
      return { code: 0, stdout: USAGE, stderr: "" };
    }
    return { code: 2, stdout: "", stderr: `${message}\n\n${USAGE}` };
  }

  let doc: InputDocument;
  let overrideWeights: Partial<Weights> | null = null;
  try {
    doc = readJson(options.input) as InputDocument;
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error(`${options.input} must contain a JSON object`);
    }
    if (options.weights !== undefined) {
      overrideWeights = readJson(options.weights) as Partial<Weights>;
    }
  } catch (error) {
    return { code: 2, stdout: "", stderr: `${(error as Error).message}\n` };
  }

  let document: RankedDocument;
  try {
    document = buildDocument(doc, overrideWeights);
  } catch (error) {
    if (error instanceof WeightsError) {
      return { code: 2, stdout: "", stderr: `invalid weights: ${error.message}\n` };
    }
    return { code: 2, stdout: "", stderr: `${(error as Error).message}\n` };
  }

  const json = serialise(document, options.explain);
  const table = renderTable(document.ranking, Array.isArray(doc.bids) ? doc.bids : []);
  const explainTable = options.explain ? renderExplain(document.ranking, document.weights) : "";

  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  if ((options.format === "json" || options.format === "both") && options.out === undefined) {
    stdoutParts.push(json);
  }
  if (options.format === "table" || options.format === "both") {
    const rendered = options.explain ? `${table}\n\n${explainTable}` : table;
    if (options.format === "both") {
      stderrParts.push(rendered);
    } else {
      stdoutParts.push(rendered);
    }
  }

  if (options.out !== undefined) {
    writeFileSync(options.out, `${json}\n`, "utf8");
    stderrParts.push(`wrote ${options.out}`);
  }

  return {
    code: 0,
    stdout: stdoutParts.length > 0 ? `${stdoutParts.join("\n")}\n` : "",
    stderr: stderrParts.length > 0 ? `${stderrParts.join("\n")}\n` : "",
  };
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return /cli\.(js|ts)$/.test(entry);
})();

if (invokedDirectly) {
  const result = run(process.argv.slice(2));
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

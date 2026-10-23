/**
 * Human readable output.
 *
 * The table is plain ASCII with fixed column widths derived only from the data,
 * so the same ranking always renders the same bytes. No colour, no clock, no
 * terminal width detection: those would make output depend on where it runs.
 */

import type { Bid, FactorName, RankedBid, Weights } from "./types.js";

const FACTORS: FactorName[] = ["price", "technical", "delivery", "experience"];

function cell(value: string | number, width: number): string {
  return String(value).padEnd(width, " ");
}

function numeric(value: number | null | undefined, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "-";
}

/** Wrap a sentence block at a fixed width on word boundaries. */
export function wrap(text: string, width = 100): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

export function renderTable(ranking: RankedBid[], bids: Bid[]): string {
  const byId = new Map<string, Bid>();
  for (const bid of bids) {
    if (!byId.has(bid.bid_id)) byId.set(bid.bid_id, bid);
  }

  const header = ["RANK", "BID_ID", "SCORE", "PRICE_USDC", "DAYS", "TESTS", "AGENT"];
  const rows = ranking.map((entry) => {
    const bid = byId.get(entry.bid_id);
    const tests = bid ? (entry.test_evidence ? "yes" : "no") : "-";
    return [
      String(entry.rank),
      entry.bid_id,
      entry.score.toFixed(2),
      numeric(bid?.price_usdc ?? null),
      numeric(bid?.delivery_days ?? null, 0),
      tests,
      (bid?.agent_id ?? "-") || "-",
    ];
  });

  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => row[index].length), 4),
  );

  const line = (values: string[]): string =>
    values.map((value, index) => cell(value, widths[index])).join("  ").trimEnd();

  const divider = widths.map((width) => "-".repeat(width)).join("  ");
  const out: string[] = [line(header), divider, ...rows.map(line)];
  if (ranking.some((entry) => !entry.test_evidence)) {
    out.push("");
    out.push(
      "Note: a bid with no test evidence is ranked below every bid that has it, so a score in this table can be higher than the score of a bid ranked above it.",
    );
  }
  out.push("");
  out.push("Reasons");
  out.push("-------");
  for (const entry of ranking) {
    const lines = wrap(`${entry.rank}. ${entry.bid_id}: ${entry.reason}`, 100);
    out.push(...lines);
    out.push("");
  }
  if (out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

export function renderExplain(ranking: RankedBid[], weights: Weights): string {
  const header = ["RANK", "BID_ID", ...FACTORS.map((name) => name.toUpperCase()), "TOTAL", "TESTS"];
  const rows = ranking.map((entry) => {
    const factors = entry.factors;
    return [
      String(entry.rank),
      entry.bid_id,
      ...FACTORS.map((name) => {
        const contribution = factors?.[name];
        if (!contribution) return "-";
        return `${contribution.points.toFixed(2)}/${contribution.max.toFixed(2)}`;
      }),
      entry.score.toFixed(2),
      entry.test_evidence ? "yes" : "no",
    ];
  });

  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => row[index].length), 4),
  );
  const line = (values: string[]): string =>
    values.map((value, index) => cell(value, widths[index])).join("  ").trimEnd();

  const out: string[] = [];
  out.push(
    `Weights: price ${weights.price}, technical ${weights.technical}, delivery ${weights.delivery}, experience ${weights.experience}`,
  );
  out.push(line(header));
  out.push(widths.map((width) => "-".repeat(width)).join("  "));
  out.push(...rows.map(line));
  out.push("");
  out.push("Notes");
  out.push("-----");
  for (const entry of ranking) {
    const factors = entry.factors;
    if (!factors) continue;
    const notes = FACTORS.map((name) => `${name}=${factors[name].note}`).join(" ");
    out.push(`${entry.rank}. ${entry.bid_id}: ${notes}`);
  }
  return out.join("\n");
}

/**
 * The scorer.
 *
 * rankBids(bundle, bids, records) is a pure function: the same arguments always
 * produce the same output, byte for byte, and the arguments are never mutated.
 * There is no clock, no randomness and no network access anywhere in this file.
 *
 * Formula (see README.md for the long version):
 *
 *   score = price + technical + delivery + experience
 *
 *   price      = W.price      * (1 - price / ceiling)          clamped to [0, W.price]
 *   technical  = W.technical  * (0.45 * tests + 0.35 * coverage + 0.20 * substance)
 *   delivery   = W.delivery   * (1 - days / window)            clamped to [0, W.delivery]
 *   experience = W.experience * (0.60 * record + 0.40 * tier / 5)
 *
 * where W are the normalised weights (they always sum to 100) and every
 * sub-score is clamped to [0, 1]. A missing input is never guessed: it scores
 * the documented neutral value and is named in the reason.
 */

import { resolveWeights } from "./config.js";
import type {
  AgentRecord,
  Bid,
  Bundle,
  FactorContribution,
  FactorName,
  RankedBid,
  Records,
  Weights,
} from "./types.js";

const TEST_RUNNERS = [
  "npm test",
  "npm run test",
  "node --test",
  "vitest",
  "jest",
  "mocha",
  "pytest",
  "go test",
  "cargo test",
  "forge test",
  "hardhat test",
];

const FILE_PATTERN = /[A-Za-z0-9_./-]+\.(ts|tsx|js|mjs|py|rs|go|sol|md|json)\b/;

export interface TestEvidence {
  present: boolean;
  count: number;
  /** How the evidence was found, used in the written reason. */
  source: "tests_field" | "tests_url" | "approach_count" | "approach_runner" | "none";
}

export interface RequirementCoverage {
  /** null when the bundle states no requirements, so coverage cannot be judged. */
  met: number | null;
  total: number | null;
}

export interface BidSignals {
  testEvidence: TestEvidence;
  coverage: RequirementCoverage;
  substance: number;
  priceRatio: number | null;
  days: number | null;
  window: number;
  record: AgentRecord;
  hasRecord: boolean;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  // Round half away from zero on a scaled integer to avoid 0.1 + 0.2 style drift.
  const scaled = value * 100;
  const rounded = scaled >= 0 ? Math.floor(scaled + 0.5) : -Math.floor(-scaled + 0.5);
  return rounded / 100;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normaliseLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Decide whether a bid carries test evidence, and how much.
 *
 * An explicit tests field or tests_url is the strongest signal. An approach
 * document that names a test count or a known runner also counts, because the
 * acceptance rule is about evidence of tests, not about a single field name.
 */
export function detectTestEvidence(bid: Bid): TestEvidence {
  const explicit = bid.tests;
  if (isFiniteNumber(explicit) && explicit > 0) {
    return { present: true, count: Math.floor(explicit), source: "tests_field" };
  }
  const testsText = nonEmpty(explicit as unknown);
  if (testsText.length > 0) {
    const digits = /\d+/.exec(testsText);
    const count = digits ? Number.parseInt(digits[0], 10) : 0;
    if (count > 0 || /test/i.test(testsText)) {
      return { present: true, count, source: "tests_field" };
    }
  }
  if (nonEmpty(bid.tests_url).length > 0) {
    return { present: true, count: 0, source: "tests_url" };
  }
  const approach = nonEmpty(bid.approach_md);
  if (approach.length > 0) {
    const counted = /(\d+)\s+(?:unit\s+|integration\s+|regression\s+)?tests?\b/i.exec(approach);
    if (counted) {
      const count = Number.parseInt(counted[1], 10);
      if (count > 0) {
        return { present: true, count, source: "approach_count" };
      }
    }
    const lower = approach.toLowerCase();
    if (TEST_RUNNERS.some((runner) => lower.includes(runner))) {
      return { present: true, count: 0, source: "approach_runner" };
    }
  }
  return { present: false, count: 0, source: "none" };
}

/**
 * Count how many of the bundle requirements the bid claims to meet.
 *
 * compliance may be a map (requirement to met/not met) or a list of met
 * requirement labels. Anything unreadable counts as not met, which is the
 * conservative choice for a buyer.
 */
export function scoreCoverage(bundle: Bundle, bid: Bid): RequirementCoverage {
  const requirements = Array.isArray(bundle.requirements)
    ? bundle.requirements.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  if (requirements.length === 0) {
    return { met: null, total: null };
  }

  const compliance = bid.compliance;
  const metLabels = new Set<string>();
  if (Array.isArray(compliance)) {
    for (const item of compliance) {
      if (typeof item === "string") metLabels.add(normaliseLabel(item));
    }
  } else if (compliance !== null && typeof compliance === "object") {
    for (const [key, value] of Object.entries(compliance)) {
      const truthy =
        value === true ||
        value === 1 ||
        (typeof value === "string" && /^(true|yes|met|done|ok|pass|passed)$/i.test(value.trim()));
      if (truthy) metLabels.add(normaliseLabel(key));
    }
  }

  let met = 0;
  for (const requirement of requirements) {
    if (metLabels.has(normaliseLabel(requirement))) met += 1;
  }
  return { met, total: requirements.length };
}

/**
 * How substantive the written approach is, in [0, 1].
 *
 * Four cheap, explainable signals: some length, a named file, ordered steps and
 * an explicit mapping to the acceptance criteria.
 */
export function scoreSubstance(approachRaw: unknown): number {
  const approach = nonEmpty(approachRaw);
  if (approach.length === 0) return 0;
  const words = approach.split(/\s+/).filter((word) => word.length > 0).length;
  const lengthScore = clamp01(words / 80);
  const fileScore = FILE_PATTERN.test(approach) ? 1 : 0;
  const stepScore = /(^|\n)\s*(\d+[.)]|[-*])\s+\S/.test(approach) || /\bstep\s+\d/i.test(approach) ? 1 : 0;
  const acceptanceScore = /\b(acceptance|test plan|definition of done|out of scope|scope)\b/i.test(approach) ? 1 : 0;
  return clamp01(0.4 * lengthScore + 0.25 * fileScore + 0.2 * stepScore + 0.15 * acceptanceScore);
}

function deliveryWindow(bundle: Bundle): number {
  const raw = bundle.delivery_window_days;
  if (isFiniteNumber(raw) && raw > 0) return raw;
  return 30;
}

/** Gather every signal once, so scoring and reasoning read the same numbers. */
export function collectSignals(bundle: Bundle, bid: Bid, records: Records): BidSignals {
  const ceiling = bundle.ceiling_usdc;
  let priceRatio: number | null = null;
  if (isFiniteNumber(bid.price_usdc) && bid.price_usdc >= 0) {
    if (isFiniteNumber(ceiling) && ceiling > 0) {
      priceRatio = bid.price_usdc / ceiling;
    }
  }

  const days = isFiniteNumber(bid.delivery_days) && bid.delivery_days >= 0 ? bid.delivery_days : null;
  const agentId = nonEmpty(bid.agent_id);
  const record = agentId.length > 0 ? records[agentId] : undefined;

  return {
    testEvidence: detectTestEvidence(bid),
    coverage: scoreCoverage(bundle, bid),
    substance: scoreSubstance(bid.approach_md),
    priceRatio,
    days,
    window: deliveryWindow(bundle),
    record: record ?? {},
    hasRecord: record !== undefined && record !== null && typeof record === "object",
  };
}

export interface FactorScores {
  points: Record<FactorName, number>;
  notes: Record<FactorName, string>;
  total: number;
}

/** Turn the signals into points per factor. */
export function scoreFactors(weights: Weights, signals: BidSignals, bid: Bid): FactorScores {
  const notes: Record<FactorName, string> = {
    price: "",
    technical: "",
    delivery: "",
    experience: "",
  };
  const points: Record<FactorName, number> = {
    price: 0,
    technical: 0,
    delivery: 0,
    experience: 0,
  };

  // Price: linear discount against the ceiling. Above the ceiling earns nothing.
  if (signals.priceRatio === null) {
    points.price = 0;
    notes.price = isFiniteNumber(bid.price_usdc) ? "no_ceiling" : "no_price";
  } else if (signals.priceRatio > 1) {
    points.price = 0;
    notes.price = "over_ceiling";
  } else {
    points.price = weights.price * clamp01(1 - signals.priceRatio);
    notes.price = "under_ceiling";
  }

  // Technical: tests first, then stated requirement coverage, then approach substance.
  const testComponent = signals.testEvidence.present ? 1 : 0;
  const coverageComponent =
    signals.coverage.met === null || signals.coverage.total === null || signals.coverage.total === 0
      ? 0.5
      : signals.coverage.met / signals.coverage.total;
  const technicalFraction = clamp01(0.45 * testComponent + 0.35 * coverageComponent + 0.2 * signals.substance);
  points.technical = weights.technical * technicalFraction;
  notes.technical = signals.testEvidence.present
    ? signals.coverage.met === null
      ? "tests_present"
      : "tests_and_coverage"
    : signals.coverage.met === null
      ? "no_tests"
      : "no_tests_with_coverage";

  // Delivery: faster than the window is better. No stated time earns half.
  if (signals.days === null) {
    points.delivery = weights.delivery * 0.5;
    notes.delivery = "no_delivery_time";
  } else {
    points.delivery = weights.delivery * clamp01(1 - signals.days / signals.window);
    notes.delivery = signals.days === 0 ? "same_day" : "stated_days";
  }

  // Experience: acceptance rate scaled by volume, then the Cerberus tier.
  const record = signals.record;
  const delivered = isFiniteNumber(record.delivered) && record.delivered > 0 ? record.delivered : 0;
  const accepted = isFiniteNumber(record.accepted) && record.accepted > 0 ? record.accepted : 0;
  const rejected = isFiniteNumber(record.rejected) && record.rejected > 0 ? record.rejected : 0;
  const disputes = isFiniteNumber(record.disputes) && record.disputes > 0 ? record.disputes : 0;
  const tier = isFiniteNumber(record.cerberus_tier) ? clamp01(record.cerberus_tier / 5) * 5 : 0;

  let recordComponent: number;
  if (delivered === 0) {
    recordComponent = signals.hasRecord ? 0.3 : 0.25;
    notes.experience = signals.hasRecord ? "no_deliveries" : "no_record";
  } else {
    const acceptance = clamp01(accepted / delivered);
    const volume = clamp01(delivered / 10);
    const penalty = clamp01(0.1 * (rejected + disputes));
    recordComponent = clamp01(acceptance * (0.5 + 0.5 * volume) - penalty);
    notes.experience = rejected + disputes > 0 ? "record_with_penalty" : "record_clean";
  }
  const experienceFraction = clamp01(0.6 * recordComponent + 0.4 * (tier / 5));
  points.experience = weights.experience * experienceFraction;

  const total =
    round2(points.price) + round2(points.technical) + round2(points.delivery) + round2(points.experience);

  return { points, notes, total: round2(total) };
}

function describePrice(bid: Bid, bundle: Bundle, signals: BidSignals, points: number, max: number): string {
  if (signals.priceRatio === null) {
    if (isFiniteNumber(bid.price_usdc)) {
      return `Price scores ${round2(points)} of ${round2(max)} because the bundle states no usable ceiling.`;
    }
    return `Price scores 0 of ${round2(max)} because no price was given for this bid.`;
  }
  const price = round2(bid.price_usdc as number);
  const ceiling = round2(bundle.ceiling_usdc as number);
  if (signals.priceRatio > 1) {
    return `Price scores 0 of ${round2(max)} because ${price} USDC is above the ${ceiling} USDC ceiling.`;
  }
  const discount = round1((1 - signals.priceRatio) * 100);
  return `Price scores ${round2(points)} of ${round2(max)} at ${price} USDC, which is ${discount} percent below the ${ceiling} USDC ceiling.`;
}

function describeTechnical(signals: BidSignals, points: number, max: number): string {
  const parts: string[] = [];
  const evidence = signals.testEvidence;
  if (evidence.present) {
    if (evidence.count > 0) {
      parts.push(`${evidence.count} tests on file`);
    } else if (evidence.source === "tests_url") {
      parts.push("a public test suite link");
    } else {
      parts.push("a named test runner in the approach");
    }
  } else {
    parts.push("no test evidence");
  }
  if (signals.coverage.met !== null && signals.coverage.total !== null) {
    parts.push(`${signals.coverage.met} of ${signals.coverage.total} stated requirements met`);
  } else {
    parts.push("no requirement checklist in the bundle");
  }
  parts.push(`approach substance ${round2(signals.substance * 100)} percent`);
  return `Technical compliance scores ${round2(points)} of ${round2(max)} on ${parts.join(", ")}.`;
}

function describeDelivery(signals: BidSignals, points: number, max: number): string {
  if (signals.days === null) {
    return `Delivery scores ${round2(points)} of ${round2(max)} because no delivery time was given, so it earns half credit.`;
  }
  return `Delivery scores ${round2(points)} of ${round2(max)} at ${round2(signals.days)} days against a ${round2(signals.window)} day window.`;
}

function describeExperience(bid: Bid, signals: BidSignals, points: number, max: number): string {
  const agent = nonEmpty(bid.agent_id);
  const record = signals.record;
  const tier = isFiniteNumber(record.cerberus_tier) ? round2(record.cerberus_tier) : 0;
  if (!signals.hasRecord || agent.length === 0) {
    return `Experience scores ${round2(points)} of ${round2(max)} because no record is on file for this agent, and it is scored as an unknown with Cerberus tier ${tier}.`;
  }
  const delivered = isFiniteNumber(record.delivered) ? record.delivered : 0;
  const accepted = isFiniteNumber(record.accepted) ? record.accepted : 0;
  const rejected = isFiniteNumber(record.rejected) ? record.rejected : 0;
  const disputes = isFiniteNumber(record.disputes) ? record.disputes : 0;
  const penalties: string[] = [];
  if (rejected > 0) penalties.push(`${rejected} rejected`);
  if (disputes > 0) penalties.push(`${disputes} disputes`);
  const tail = penalties.length > 0 ? `, with ${penalties.join(" and ")}` : "";
  if (delivered === 0) {
    return `Experience scores ${round2(points)} of ${round2(max)} from no deliveries on record at Cerberus tier ${tier}${tail}.`;
  }
  return `Experience scores ${round2(points)} of ${round2(max)} from ${accepted} of ${delivered} delivered bids accepted at Cerberus tier ${tier}${tail}.`;
}

/**
 * Build the written reason. Every reason is at least ten words and names the
 * factors that moved the bid up or held it down.
 */
export function buildReason(
  bid: Bid,
  bundle: Bundle,
  signals: BidSignals,
  scores: FactorScores,
  weights: Weights,
  rank: number,
  total: number,
): string {
  const sentences: string[] = [];
  sentences.push(`Rank ${rank} of ${total} with a composite score of ${scores.total} out of 100.`);
  sentences.push(describePrice(bid, bundle, signals, scores.points.price, weights.price));
  sentences.push(describeTechnical(signals, scores.points.technical, weights.technical));
  sentences.push(describeDelivery(signals, scores.points.delivery, weights.delivery));
  sentences.push(describeExperience(bid, signals, scores.points.experience, weights.experience));

  if (!signals.testEvidence.present) {
    sentences.push("It carries no test evidence, so it ranks below every bid that does.");
  } else if (signals.priceRatio !== null && signals.priceRatio > 1) {
    sentences.push("Its price is above the ceiling, so the price factor contributes nothing.");
  }

  sentences.push(
    "The score is the weighted sum of price, technical compliance, delivery time and experience, normalised to 100 points.",
  );
  return sentences.join(" ");
}

/**
 * Rank bids.
 *
 * Ordering is: bids with test evidence first (a hard gate), then composite
 * score, then lower price, then bid_id. The gate is what makes the acceptance
 * rule hold: a cheaper bid with no tests can never outrank a tested one on
 * price alone, because price is only consulted after the gate and the score.
 */
export function rankBids(
  bundle: Bundle,
  bids: Bid[],
  records: Records,
  weightsInput?: Partial<Weights> | null,
  options: { explain?: boolean } = {},
): RankedBid[] {
  const weights = resolveWeights(weightsInput);
  const safeBundle: Bundle = bundle ?? {};
  const safeBids: Bid[] = Array.isArray(bids) ? bids : [];
  const safeRecords: Records = records ?? {};
  const explain = options.explain === true;

  interface Draft {
    entry: RankedBid;
    bid: Bid;
    signals: BidSignals;
    scores: FactorScores;
  }

  const drafts: Draft[] = [];
  const priced = new Map<RankedBid, number | null>();

  for (const bid of safeBids) {
    const signals = collectSignals(safeBundle, bid, safeRecords);
    const scores = scoreFactors(weights, signals, bid);
    const price = isFiniteNumber(bid.price_usdc) && bid.price_usdc >= 0 ? bid.price_usdc : null;
    const entry: RankedBid = {
      bid_id: bid.bid_id,
      rank: 0,
      score: scores.total,
      reason: "",
      test_evidence: signals.testEvidence.present,
    };
    if (explain) {
      const factors = {} as Record<FactorName, FactorContribution>;
      for (const name of ["price", "technical", "delivery", "experience"] as FactorName[]) {
        factors[name] = {
          points: round2(scores.points[name]),
          max: round2(weights[name]),
          note: scores.notes[name],
        };
      }
      entry.factors = factors;
    }
    priced.set(entry, price);
    drafts.push({ entry, bid, signals, scores });
  }

  drafts.sort((a, b) => {
    const aTested = a.entry.test_evidence === true ? 1 : 0;
    const bTested = b.entry.test_evidence === true ? 1 : 0;
    if (aTested !== bTested) return bTested - aTested;
    if (a.entry.score !== b.entry.score) return b.entry.score - a.entry.score;
    const aPrice = priced.get(a.entry) ?? null;
    const bPrice = priced.get(b.entry) ?? null;
    if (aPrice !== bPrice) {
      if (aPrice === null) return 1;
      if (bPrice === null) return -1;
      return aPrice - bPrice;
    }
    if (a.entry.bid_id === b.entry.bid_id) return 0;
    return a.entry.bid_id < b.entry.bid_id ? -1 : 1;
  });

  const ranked: RankedBid[] = [];
  for (let index = 0; index < drafts.length; index += 1) {
    const { entry, bid, signals, scores } = drafts[index];
    const out: RankedBid = {
      bid_id: entry.bid_id,
      rank: index + 1,
      score: entry.score,
      reason: buildReason(bid, safeBundle, signals, scores, weights, index + 1, drafts.length),
      test_evidence: entry.test_evidence,
    };
    if (explain) out.factors = entry.factors;
    ranked.push(out);
  }
  return ranked;
}

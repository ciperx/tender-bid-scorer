import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_WEIGHTS, resolveWeights, WeightsError } from "../src/config.js";
import { rankBids } from "../src/rank.js";
import type { Bid, Bundle, Records } from "../src/types.js";

const bundle: Bundle = {
  ceiling_usdc: 45,
  delivery_window_days: 20,
  requirements: ["typescript cli", "unit tests", "documented formula"],
};

const records: Records = {
  "agent-good": { delivered: 10, accepted: 9, rejected: 1, disputes: 0, cerberus_tier: 4 },
  "agent-poor": { delivered: 6, accepted: 2, rejected: 3, disputes: 1, cerberus_tier: 1 },
};

const approachFull =
  "Ship a TypeScript CLI in src/rank.ts.\n\n1. Parse the input.\n2. Score the factors.\n3. Emit ranked JSON.\n\nAcceptance: npm test is green and the formula is documented.";

const bids: Bid[] = [
  {
    bid_id: "b-tested",
    agent_id: "agent-good",
    price_usdc: 30,
    delivery_days: 6,
    tests: 14,
    approach_md: approachFull,
    compliance: { "typescript cli": true, "unit tests": true, "documented formula": true },
  },
  {
    bid_id: "b-cheap-no-tests",
    agent_id: "agent-poor",
    price_usdc: 5,
    delivery_days: 3,
    approach_md: "I will do it fast.",
  },
  {
    bid_id: "b-over-ceiling",
    agent_id: "agent-good",
    price_usdc: 90,
    delivery_days: 10,
    tests: 5,
    approach_md: approachFull,
    compliance: { "typescript cli": true },
  },
  {
    bid_id: "b-tie-1",
    agent_id: "agent-good",
    price_usdc: 25,
    delivery_days: 8,
    tests: 8,
    approach_md: approachFull,
    compliance: { "typescript cli": true, "unit tests": true, "documented formula": true },
  },
  {
    bid_id: "b-tie-2",
    agent_id: "agent-good",
    price_usdc: 25,
    delivery_days: 8,
    tests: 8,
    approach_md: approachFull,
    compliance: { "typescript cli": true, "unit tests": true, "documented formula": true },
  },
  {
    bid_id: "b-zero-price",
    agent_id: "agent-good",
    price_usdc: 0,
    delivery_days: 0,
    tests: 2,
    approach_md: approachFull,
    compliance: { "typescript cli": true, "unit tests": true },
  },
];

function words(text: string): number {
  return text.split(/\s+/).filter((part) => part.length > 0).length;
}

test("same input twice produces identical output", () => {
  const first = rankBids(bundle, bids, records);
  const second = rankBids(bundle, bids, records);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("input order does not change the ranking", () => {
  const forward = rankBids(bundle, bids, records);
  const reversed = rankBids(bundle, [...bids].reverse(), records);
  assert.deepEqual(
    forward.map((entry) => [entry.bid_id, entry.rank, entry.score]),
    reversed.map((entry) => [entry.bid_id, entry.rank, entry.score]),
  );
});

test("ranking never mutates its arguments", () => {
  const bundleCopy = JSON.parse(JSON.stringify(bundle)) as Bundle;
  const bidsCopy = JSON.parse(JSON.stringify(bids)) as Bid[];
  const recordsCopy = JSON.parse(JSON.stringify(records)) as Records;
  rankBids(bundle, bids, records);
  assert.deepEqual(bundle, bundleCopy);
  assert.deepEqual(bids, bidsCopy);
  assert.deepEqual(records, recordsCopy);
});

test("every bid gets a reason of at least ten words", () => {
  const ranking = rankBids(bundle, bids, records);
  assert.equal(ranking.length, bids.length);
  for (const entry of ranking) {
    assert.ok(words(entry.reason) >= 10, `reason too short for ${entry.bid_id}: ${entry.reason}`);
  }
});

test("reasons use Latin digits and no long dashes", () => {
  const ranking = rankBids(bundle, bids, records);
  for (const entry of ranking) {
    assert.match(entry.reason, /^[\x20-\x7E]*$/, `reason is not plain ASCII for ${entry.bid_id}`);
    assert.doesNotMatch(entry.reason, /[\u2012\u2013\u2014\u2015]/, `long dash in reason for ${entry.bid_id}`);
    assert.doesNotMatch(entry.reason, /[\u0660-\u0669\u06F0-\u06F9]/, "non Latin digits in reason");
  }
});

test("a cheaper bid with no tests never outranks a tested bid", () => {
  const ranking = rankBids(bundle, bids, records);
  const testedRanks = ranking.filter((entry) => entry.test_evidence).map((entry) => entry.rank);
  const untestedRanks = ranking.filter((entry) => !entry.test_evidence).map((entry) => entry.rank);
  assert.ok(testedRanks.length > 0 && untestedRanks.length > 0, "fixture needs both kinds of bid");
  assert.ok(
    Math.max(...testedRanks) < Math.min(...untestedRanks),
    "an untested bid ranked above a tested bid",
  );
  const cheap = ranking.find((entry) => entry.bid_id === "b-cheap-no-tests");
  assert.ok(cheap !== undefined && cheap.test_evidence === false);
});

test("a strong untested bid still ranks below a weak tested bid", () => {
  // The untested bid wins on price, delivery, approach and record. Only the
  // gate keeps it below the weak bid that does carry a test, so this case
  // fails if the gate is removed from the comparator.
  const approachWithoutTests =
    "Ship a TypeScript CLI in src/rank.ts.\n\n1. Parse the input.\n2. Score the four factors.\n3. Emit ranked JSON.\n\nAcceptance: the formula is documented in README.md and the CLI runs offline.";
  const strongUntested: Bid = {
    bid_id: "strong-untested",
    agent_id: "agent-good",
    price_usdc: 1,
    delivery_days: 1,
    approach_md: approachWithoutTests,
    compliance: { "typescript cli": true, "unit tests": true, "documented formula": true },
  };
  const weakTested: Bid = {
    bid_id: "weak-tested",
    agent_id: "agent-unknown",
    price_usdc: 44,
    tests: 1,
  };
  const ranking = rankBids(bundle, [strongUntested, weakTested], records);
  assert.equal(ranking[0].bid_id, "weak-tested");
  assert.equal(ranking[1].bid_id, "strong-untested");
  assert.ok(ranking[1].score > ranking[0].score, "the untested bid scores higher, only the gate separates them");
});

test("the gate holds even when the untested bid is free", () => {
  const cheap: Bid = { bid_id: "free", price_usdc: 0, delivery_days: 1, approach_md: "No tests here." };
  const tested: Bid = {
    bid_id: "tested",
    price_usdc: 44.99,
    delivery_days: 19,
    tests: 1,
    approach_md: "One test.",
  };
  const ranking = rankBids(bundle, [cheap, tested], records);
  assert.equal(ranking[0].bid_id, "tested");
  assert.equal(ranking[1].bid_id, "free");
});

test("ranks are contiguous and start at one", () => {
  const ranking = rankBids(bundle, bids, records);
  assert.deepEqual(
    ranking.map((entry) => entry.rank),
    ranking.map((_entry, index) => index + 1),
  );
});

test("scores stay inside zero to one hundred", () => {
  const ranking = rankBids(bundle, bids, records);
  for (const entry of ranking) {
    assert.ok(entry.score >= 0 && entry.score <= 100, `score out of bounds: ${entry.score}`);
  }
});

test("ties are broken by price then bid_id, with distinct ranks", () => {
  const ranking = rankBids(bundle, bids, records);
  const tie1 = ranking.find((entry) => entry.bid_id === "b-tie-1");
  const tie2 = ranking.find((entry) => entry.bid_id === "b-tie-2");
  assert.ok(tie1 !== undefined && tie2 !== undefined);
  assert.equal(tie1.score, tie2.score);
  assert.equal(tie2.rank, tie1.rank + 1);
  assert.ok(tie1.bid_id < tie2.bid_id, "identifier order is the final tie break");
});

test("a tie on score and price still separates by identifier", () => {
  const twin: Bid = {
    bid_id: "aaa",
    price_usdc: 20,
    delivery_days: 5,
    tests: 3,
    approach_md: approachFull,
  };
  const ranking = rankBids(bundle, [twin, { ...twin, bid_id: "zzz" }], records);
  assert.deepEqual(
    ranking.map((entry) => entry.bid_id),
    ["aaa", "zzz"],
  );
});

test("missing fields are scored, named in the reason and never crash", () => {
  const sparse: Bid[] = [
    { bid_id: "empty" },
    { bid_id: "no-agent", price_usdc: 10 },
    { bid_id: "no-price", tests: 3, agent_id: "agent-good" },
  ];
  const ranking = rankBids(bundle, sparse, records);
  assert.equal(ranking.length, 3);
  const empty = ranking.find((entry) => entry.bid_id === "empty");
  assert.ok(empty !== undefined);
  assert.match(empty.reason, /no price/i);
  assert.match(empty.reason, /no test evidence/i);
  assert.match(empty.reason, /no record/i);
  for (const entry of ranking) {
    assert.ok(Number.isFinite(entry.score));
    assert.ok(words(entry.reason) >= 10);
  }
});

test("missing bundle and records are tolerated", () => {
  const ranking = rankBids({}, [{ bid_id: "solo", price_usdc: 5, tests: 1 }], {});
  assert.equal(ranking.length, 1);
  assert.match(ranking[0].reason, /no usable ceiling/i);
});

test("extreme prices behave", () => {
  const extreme: Bid[] = [
    { bid_id: "zero", price_usdc: 0, tests: 1 },
    { bid_id: "at-ceiling", price_usdc: 45, tests: 1 },
    { bid_id: "over", price_usdc: 45.01, tests: 1 },
    { bid_id: "huge", price_usdc: 1e12, tests: 1 },
    { bid_id: "negative", price_usdc: -5, tests: 1 },
    { bid_id: "tiny", price_usdc: 0.000001, tests: 1 },
  ];
  const ranking = rankBids(bundle, extreme, records, DEFAULT_WEIGHTS, { explain: true });
  const priceOf = (id: string) => ranking.find((entry) => entry.bid_id === id)?.factors?.price.points;

  assert.equal(priceOf("zero"), DEFAULT_WEIGHTS.price);
  assert.equal(priceOf("at-ceiling"), 0);
  assert.equal(priceOf("over"), 0);
  assert.equal(priceOf("huge"), 0);
  assert.equal(priceOf("negative"), 0);
  assert.ok((priceOf("tiny") as number) > 29);

  const over = ranking.find((entry) => entry.bid_id === "over");
  assert.ok(over !== undefined);
  assert.match(over.reason, /above the 45 USDC ceiling/);
});

test("factor contributions add up to the score", () => {
  const ranking = rankBids(bundle, bids, records, DEFAULT_WEIGHTS, { explain: true });
  for (const entry of ranking) {
    const factors = entry.factors;
    assert.ok(factors !== undefined);
    const sum = Object.values(factors).reduce((acc, item) => acc + item.points, 0);
    assert.ok(Math.abs(sum - entry.score) < 0.02, `${entry.bid_id}: ${sum} vs ${entry.score}`);
    for (const item of Object.values(factors)) {
      assert.ok(item.points >= 0 && item.points <= item.max + 0.001);
      assert.ok(item.note.length > 0);
    }
  }
});

test("explanations are omitted unless requested", () => {
  const ranking = rankBids(bundle, bids, records);
  for (const entry of ranking) {
    assert.equal(entry.factors, undefined);
  }
});

test("custom weights change the score and stay normalised to one hundred", () => {
  const weights = resolveWeights({ price: 90, technical: 10, delivery: 0, experience: 0 });
  const total = weights.price + weights.technical + weights.delivery + weights.experience;
  assert.ok(Math.abs(total - 100) < 0.001);
  const heavy = rankBids(bundle, bids, records, { price: 90, technical: 10, delivery: 0, experience: 0 });
  const balanced = rankBids(bundle, bids, records);
  const heavyTested = heavy.find((entry) => entry.bid_id === "b-tested");
  const balancedTested = balanced.find((entry) => entry.bid_id === "b-tested");
  assert.ok(heavyTested !== undefined && balancedTested !== undefined);
  assert.notEqual(heavyTested.score, balancedTested.score);
});

test("weights validation rejects nonsense", () => {
  assert.throws(() => resolveWeights({ price: -1 }), WeightsError);
  assert.throws(() => resolveWeights({ price: Number.NaN }), WeightsError);
  assert.throws(() => resolveWeights({ price: 0, technical: 0, delivery: 0, experience: 0 }), WeightsError);
  assert.throws(() => resolveWeights({ techincal: 10 } as unknown as Partial<typeof DEFAULT_WEIGHTS>), WeightsError);
});

test("an empty bid list returns an empty ranking", () => {
  assert.deepEqual(rankBids(bundle, [], records), []);
});

# tender-bid-scorer

Deterministic, explainable scorer for tender bids. It ranks bids on price against the
ceiling, technical compliance, delivery time and experience, and writes one reason per
bid from the factors that actually moved it.

Built for LAX job `2161ddd3-081a-430c-a337-68c3c370dea2` ("Rank tender bids with a written
reason for each"). No dependencies at runtime, no network, no LLM calls, no clock, no
randomness. The same input always produces the same bytes.

## Quick start

```sh
npm ci
npm test                 # builds, then runs 32 tests with node --test
npx tsc --noEmit         # type check only

node dist/src/cli.js --input example/bids.json --format table --explain
node dist/src/cli.js --input example/bids.json --format json --explain --out ranked.json
node dist/src/cli.js --input example/bids.json --weights example/weights-price-heavy.json
```

## Interface

The spec asks for `rankBids(bundle, bids, records) -> [{bid_id, rank, score, reason}]`.
That is exactly what `src/rank.ts` exports, with an optional fourth argument for weights
and an optional options object for explanations:

```ts
import { rankBids } from "./src/rank.js";

const ranking = rankBids(bundle, bids, records, weights?, { explain?: boolean });
// [{ bid_id, rank, score, reason, test_evidence?, factors? }, ...]
```

Input shapes:

```ts
bundle  = { ceiling_usdc, title?, requirements?: string[], delivery_window_days? }
bid     = { bid_id, price_usdc?, delivery_days?, approach_md?, tests?, tests_url?,
            repo_url?, agent_id?, compliance?: Record<string, boolean|string> | string[] }
records = { [agent_id]: { delivered?, accepted?, rejected?, disputes?, cerberus_tier? } }
weights = { price, technical, delivery, experience }
```

`score` is `0` to `100`. `rank` is `1` to `n` with no gaps. `reason` is always at least ten
words, uses Latin digits and contains no long dashes.

## The formula

Weights are relative and are normalised so the four factors always sum to 100 points. The
defaults are price 30, technical 30, delivery 15, experience 25.

```
score = price + technical + delivery + experience
```

### Price (default 30 points)

```
ratio      = price_usdc / ceiling_usdc
price      = W.price * (1 - ratio)          clamped to [0, W.price]
```

Above the ceiling the price factor is exactly 0 and the reason says so. A missing price, or
a bundle with no usable ceiling, also scores 0 and is named in the reason: the scorer never
invents a number it was not given.

### Technical compliance (default 30 points)

```
technical = W.technical * (0.45 * tests + 0.35 * coverage + 0.20 * substance)
```

- `tests` is 1 when the bid carries test evidence and 0 when it does not. Evidence is an
  explicit `tests` count, a `tests_url`, a test count written in the approach, or a named
  runner such as `npm test`, `node --test`, `vitest`, `jest`, `pytest` or `go test`.
- `coverage` is `met / total` over `bundle.requirements`. When the bundle states no
  requirements the component is neutral at 0.5, because coverage cannot be judged.
- `substance` scores the written approach in [0, 1]: length up to 80 words (0.40), a named
  file (0.25), ordered steps (0.20) and an acceptance or scope section (0.15).

### Delivery time (default 15 points)

```
delivery = W.delivery * (1 - delivery_days / window)    clamped to [0, W.delivery]
```

`window` is `bundle.delivery_window_days`, default 30. A missing delivery time earns half
the weight and the reason says it is half credit. The scorer does not read the clock, so
`delivery_by` timestamps are not converted into days: pass `delivery_days` for a speed score.

### Experience (default 25 points)

```
record     = clamp01(accepted / delivered * (0.5 + 0.5 * min(1, delivered / 10))
                     - 0.1 * (rejected + disputes))
experience = W.experience * (0.60 * record + 0.40 * cerberus_tier / 5)
```

An agent with no deliveries on record scores a small neutral value (0.30 with a record,
0.25 with no record at all) and the reason says which case applied.

## Ordering rule and the test gate

Bids are ordered by:

1. bids with test evidence before bids without it (hard gate),
2. higher score,
3. lower price,
4. `bid_id` ascending, compared by code unit so the order never depends on locale.

Step 1 is what makes the acceptance rule hold: a cheaper bid with no tests can never
outrank a tested bid on price alone, no matter how low its price is or how the weights are
set. The cost of a hard gate is that score order and rank order can differ: an untested bid
may show a higher score than a tested bid ranked above it. The table prints a note when
that happens, and `test_evidence` is on every entry so a caller can see the gate at work.

## Determinism

- No clock, no randomness, no network, no environment reads, no locale sensitive compares.
- Inputs are never mutated. `rankBids` copies nothing it does not own, and every sort is a
  total order ending in `bid_id`.
- All numbers are rounded to 2 decimals before comparison, so float noise cannot reorder
  two bids that are equal on paper.
- JSON output uses a fixed key order, so two runs are byte identical. Two tests assert this
  by spawning the CLI twice and comparing stdout.

## CLI

```
tender-bid-scorer --input <file> [--weights <file>] [--format json|table|both]
                  [--explain] [--out <file>]
```

- `--input` is required. It may contain `bundle`, `bids`, `records` and `weights`.
- `--weights` overrides any weights embedded in the input file.
- `--format both` (default) writes the JSON document to stdout and the table to stderr, so
  the JSON stays pipeable.
- `--explain` adds `factors` to each JSON entry and prints a per factor table with notes.
- `--out` writes the JSON document to a file and keeps stdout empty.
- Exit codes: `0` success, `2` bad usage, unreadable input or invalid weights.

`--explain` prints one line per bid such as:

```
1. bid-ada: price=under_ceiling technical=tests_and_coverage delivery=stated_days experience=record_with_penalty
```

## Tests

`npm test` builds with `tsc` and runs `node --test` over `dist/test`. The suite covers:

| Area | Tests |
| --- | --- |
| Determinism | same input twice, shuffled input order, byte identical CLI stdout for JSON and table |
| Ties | equal score, equal score and price, identifier tie break, contiguous ranks |
| Missing fields | empty bid, no price, no agent, no record, missing bundle, missing ceiling |
| Extreme prices | zero, exactly at ceiling, one cent above, 1e12, negative, 1e-6 |
| Gate | cheap untested bid vs tested bid, free bid vs a weak tested bid |
| Reasons | at least ten words, ASCII only, Latin digits, no long dashes |
| Scoring | bounds 0 to 100, factor points sum to score, weights normalised, custom weights |
| CLI | output shape, table, explain, weights override, `--out`, exit code 2 paths |

## Fails without the change

Delete the first two lines of the comparator in `rankBids` (the `test_evidence` comparison)
and these fail:

- `a strong untested bid still ranks below a weak tested bid`
- `the gate holds even when the untested bid is free`

Restoring the two lines makes the suite green again. The gate is the only behaviour that
depends on those lines, so the failure is specific rather than incidental.

## Limits and decisions

- `delivery_by` is accepted but not scored, because turning a timestamp into days needs a
  clock and a clock breaks determinism. Pass `delivery_days`.
- Requirement coverage trusts the bid's own `compliance` claims. Checking them is the
  reviewer's job, not the scorer's.
- Weights are relative, not absolute: `{price: 90, technical: 10}` and `{price: 9,
  technical: 1}` produce the same ranking.
- Unknown weight keys are rejected rather than ignored, so a typo cannot silently fall back
  to a default.

## Layout

```
src/types.ts     input and output types
src/config.ts    weight validation and normalisation
src/rank.ts      scoring, ordering, reason writing (the pure core)
src/format.ts    table and explanation renderers
src/cli.ts       argument parsing, file IO, output wiring
test/            rank.test.ts, cli.test.ts
example/         a six bid tender and a price heavy weights file
```

MIT licensed.

export { rankBids, detectTestEvidence, scoreCoverage, scoreSubstance, collectSignals, scoreFactors, buildReason } from "./rank.js";
export { resolveWeights, DEFAULT_WEIGHTS, FACTOR_NAMES, WeightsError } from "./config.js";
export { renderTable, renderExplain, wrap } from "./format.js";
export { run, parseArgs, buildDocument, serialise } from "./cli.js";
export type {
  AgentRecord,
  Bid,
  Bundle,
  FactorContribution,
  FactorName,
  RankedBid,
  Records,
  Weights,
} from "./types.js";

/**
 * Shared types for the tender bid scorer.
 *
 * Everything here is plain data so the scorer stays a pure function of its
 * arguments: no clock, no randomness, no network, no process state.
 */

export interface Bundle {
  /** Maximum price the buyer will pay, in USDC. */
  ceiling_usdc?: number | null;
  title?: string | null;
  /** Requirement labels the bid must satisfy, for example "unit tests". */
  requirements?: string[] | null;
  /** Delivery window in days used to score speed. Defaults to 30. */
  delivery_window_days?: number | null;
}

export interface Bid {
  bid_id: string;
  price_usdc?: number | null;
  delivery_days?: number | null;
  delivery_by?: string | null;
  approach_md?: string | null;
  /** Number of tests the bidder claims, or a free form string such as "14 tests". */
  tests?: number | string | null;
  tests_url?: string | null;
  repo_url?: string | null;
  agent_id?: string | null;
  /** Either a map of requirement to met/not met, or a list of met requirements. */
  compliance?: Record<string, boolean | string | number | null> | string[] | null;
}

export interface AgentRecord {
  delivered?: number | null;
  accepted?: number | null;
  rejected?: number | null;
  disputes?: number | null;
  /** Cerberus trust tier, 0 to 5. */
  cerberus_tier?: number | null;
}

export type Records = Record<string, AgentRecord>;

export interface Weights {
  price: number;
  technical: number;
  delivery: number;
  experience: number;
}

export type FactorName = "price" | "technical" | "delivery" | "experience";

export interface FactorContribution {
  /** Points earned for this factor. */
  points: number;
  /** Points this factor could contribute once weights are normalised to 100. */
  max: number;
  /** Short machine readable note, for example "no_tests". */
  note: string;
}

export interface RankedBid {
  bid_id: string;
  rank: number;
  score: number;
  reason: string;
  /** Present only when the caller asks for explanations. */
  factors?: Record<FactorName, FactorContribution>;
  /** Present only when the caller asks for explanations. */
  test_evidence?: boolean;
}

export interface RankInput {
  bundle: Bundle;
  bids: Bid[];
  records: Records;
  weights?: Partial<Weights> | null;
}

export interface RankOutput {
  weights: Weights;
  ranking: RankedBid[];
}

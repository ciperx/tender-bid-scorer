/**
 * Weight handling.
 *
 * Weights are relative. They are normalised so the four factors always add up
 * to 100 points, which keeps scores comparable when a caller supplies its own
 * weighting. Validation is strict on purpose: a silently ignored weight would
 * make a ranking look trustworthy while scoring the wrong thing.
 */

import type { FactorName, Weights } from "./types.js";

export const DEFAULT_WEIGHTS: Weights = {
  price: 30,
  technical: 30,
  delivery: 15,
  experience: 25,
};

export const FACTOR_NAMES: FactorName[] = ["price", "technical", "delivery", "experience"];

export class WeightsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeightsError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a partial weights object and normalise it to a sum of 100.
 *
 * Unknown keys are rejected so a typo such as "techincal" fails loudly instead
 * of quietly falling back to the default for that factor.
 */
export function resolveWeights(input?: Partial<Weights> | null): Weights {
  if (input === undefined || input === null) {
    return { ...DEFAULT_WEIGHTS };
  }
  if (!isPlainObject(input)) {
    throw new WeightsError("weights must be an object with price, technical, delivery and experience");
  }

  for (const key of Object.keys(input)) {
    if (!(FACTOR_NAMES as string[]).includes(key)) {
      throw new WeightsError(`unknown weight "${key}"; allowed keys are ${FACTOR_NAMES.join(", ")}`);
    }
  }

  const merged: Record<FactorName, number> = { ...DEFAULT_WEIGHTS };
  for (const name of FACTOR_NAMES) {
    const raw = (input as Record<string, unknown>)[name];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      throw new WeightsError(`weight "${name}" must be a finite number greater than or equal to 0`);
    }
    merged[name] = raw;
  }

  const sum = FACTOR_NAMES.reduce((acc, name) => acc + merged[name], 0);
  if (sum <= 0) {
    throw new WeightsError("weights must not all be zero");
  }

  const normalised = {} as Weights;
  for (const name of FACTOR_NAMES) {
    // Round to 4 decimals so the printed weights stay short while still
    // summing to 100 within floating point tolerance.
    normalised[name] = Math.round((merged[name] / sum) * 100 * 10000) / 10000;
  }
  return normalised;
}

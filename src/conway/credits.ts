/**
 * Conway Credits Management
 *
 * Monitors the automaton's compute credit balance and triggers
 * survival mode transitions.
 */

import type {
  ConwayClient,
  FinancialState,
  SurvivalTier,
} from "../types.js";
import type { Address } from "viem";
import { SURVIVAL_THRESHOLDS } from "../types.js";
import { getUsdcBalance } from "./x402.js";

/**
 * Check the current financial state of the automaton.
 */
export async function checkFinancialState(
  conway: ConwayClient,
  usdcBalance: number,
): Promise<FinancialState> {
  const creditsCents = await conway.getCreditsBalance();

  return {
    creditsCents,
    usdcBalance,
    lastChecked: new Date().toISOString(),
  };
}

/**
 * Determine the survival tier based on current credits.
 * Thresholds are checked in descending order: high > normal > low_compute > critical > dead.
 *
 * Zero credits = "critical" (broke but alive — can still accept funding, send distress).
 * Only negative balance (API-confirmed debt) = "dead".
 */
export function getSurvivalTier(creditsCents: number): SurvivalTier {
  if (creditsCents > SURVIVAL_THRESHOLDS.high) return "high";
  if (creditsCents > SURVIVAL_THRESHOLDS.normal) return "normal";
  if (creditsCents > SURVIVAL_THRESHOLDS.low_compute) return "low_compute";
  if (creditsCents >= 0) return "critical";
  return "dead";
}

/**
 * Check financial state in testnet mode.
 * Credits are derived from testnet token balance (no Conway API call).
 */
export async function checkFinancialStateTestnet(
  walletAddress: Address,
  network: string = "eip155:97",
): Promise<FinancialState> {
  const tokenBalance = await getUsdcBalance(walletAddress, network);
  // Convert token balance to creditsCents (1 token = $1 = 100 cents)
  const creditsCents = Math.floor(tokenBalance * 100);

  return {
    creditsCents,
    usdcBalance: tokenBalance,
    lastChecked: new Date().toISOString(),
  };
}

/**
 * Format a credit amount for display.
 */
export function formatCredits(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

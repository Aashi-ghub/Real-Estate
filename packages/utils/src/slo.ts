export interface SloWindowInput {
  target: number;
  goodEvents: number;
  totalEvents: number;
  previousBurnRate?: number;
}

export function calculateSloCompliance(input: SloWindowInput): {
  compliance: number;
  errorBudgetRemaining: number;
  burnRate: number;
  degradation: "none" | "minor" | "major" | "critical";
} {
  const total = Math.max(1, input.totalEvents);
  const compliance = input.goodEvents / total;
  const allowedBad = Math.max(0.000001, 1 - input.target);
  const actualBad = 1 - compliance;
  const burnRate = actualBad / allowedBad;
  const errorBudgetRemaining = Math.max(0, 1 - burnRate);
  const degradation = burnRate >= 8 ? "critical" : burnRate >= 4 ? "major" : burnRate >= 2 ? "minor" : "none";

  return {
    compliance,
    errorBudgetRemaining,
    burnRate,
    degradation
  };
}

export function shouldAlertForSlo(input: SloWindowInput): boolean {
  const current = calculateSloCompliance(input);
  return current.burnRate >= 2 && current.burnRate >= (input.previousBurnRate ?? 0);
}

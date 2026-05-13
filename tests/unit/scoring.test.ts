import { describe, expect, it } from "vitest";

import { computeLeadScore } from "@real-estate/utils";

describe("lead scoring", () => {
  it("returns an explainable hot score for urgent complete leads", () => {
    const result = computeLeadScore({
      attributes: {
        budget: { min: 8_000_000, max: 10_000_000 },
        timeline: { raw: "next 2 months", days: 60, unit: "month" },
        financing_needed: false
      },
      responseLatencyMs: 10 * 60 * 1000,
      engagementCount: 5,
      qualificationCompleteness: 100
    });

    expect(result.priority).toBe("HOT");
    expect(result.total).toBeGreaterThanOrEqual(75);
    expect(result.breakdown).toMatchObject({
      formula: "weighted_deterministic_v1"
    });
  });

  it("honors tenant scoring thresholds", () => {
    const result = computeLeadScore({
      attributes: {},
      responseLatencyMs: null,
      engagementCount: 1,
      qualificationCompleteness: 20,
      config: {
        warmThreshold: 10,
        hotThreshold: 95
      }
    });

    expect(result.priority).toBe("WARM");
  });
});

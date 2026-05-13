import { describe, expect, it } from "vitest";

import { extractLeadQualification } from "@real-estate/utils";

describe("lead qualification extraction", () => {
  it("extracts multiple structured fields with confidence metadata", () => {
    const result = extractLeadQualification("Need 3 bhk in Mohali under 1cr next 2 months for investment with home loan");

    expect(result.fields.map((field) => field.key)).toEqual([
      "budget",
      "location",
      "timeline",
      "property_type",
      "purpose",
      "financing_needed"
    ]);
    expect(result.parsedAnswers.budget).toMatchObject({ max: 10_000_000 });
    expect(result.parsedAnswers.location).toBe("mohali");
    expect(result.parsedAnswers.timeline).toMatchObject({ days: 60 });
    expect(result.parsedAnswers.property_type).toBe("3_bhk");
    expect(result.parsedAnswers.purpose).toBe("investment");
    expect(result.parsedAnswers.financing_needed).toBe(true);
    expect(result.completenessPercentage).toBe(100);
    expect(result.fields.every((field) => field.source === "rule" && field.confidence > 0)).toBe(true);
  });

  it("supports partial extraction without fabricating missing fields", () => {
    const result = extractLeadQualification("50 lakh near Zirakpur");

    expect(result.parsedAnswers.budget).toMatchObject({ min: 5_000_000, max: 5_000_000 });
    expect(result.parsedAnswers.location).toBe("zirakpur");
    expect(result.fields.map((field) => field.key)).toEqual(["budget", "location"]);
    expect(result.completenessPercentage).toBe(33);
  });
});

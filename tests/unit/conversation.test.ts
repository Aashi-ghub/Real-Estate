import { describe, expect, it } from "vitest";

import { advanceState, parseBudget, parseTimeline } from "@real-estate/utils";

describe("conversation engine", () => {
  it("sends the intro prompt from INIT", () => {
    const result = advanceState({
      id: "conversation-1",
      leadId: "lead-1",
      state: "INIT",
      context: {},
      lastMessageAt: null
    });

    expect(result.nextState).toBe("ASK_BUDGET");
    expect(result.outboundMessage).toContain("budget");
    expect(result.attributesToUpsert).toHaveLength(0);
  });

  it("advances across multiple states when the user sends all answers at once", () => {
    const result = advanceState(
      {
        id: "conversation-1",
        leadId: "lead-1",
        state: "ASK_BUDGET",
        context: {},
        lastMessageAt: new Date()
      },
      "My budget is 80 lakh to 1 crore in Whitefield within 2 months for investment"
    );

    expect(result.nextState).toBe("QUALIFIED");
    expect(result.attributesToUpsert.map((item) => item.key)).toEqual([
      "budget",
      "location",
      "timeline",
      "purpose"
    ]);
    expect(result.outboundMessage).toContain("Our team");
  });
});

describe("parsers", () => {
  it("parses Indian budget ranges", () => {
    expect(parseBudget("Budget 75 lakh to 1.1 crore")).toMatchObject({
      min: 7_500_000,
      max: 11_000_000
    });
  });

  it("parses timelines into days", () => {
    expect(parseTimeline("Looking to buy in 3 months")).toMatchObject({
      days: 90,
      unit: "month"
    });
  });
});

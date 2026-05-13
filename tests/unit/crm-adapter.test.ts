import { afterEach, describe, expect, it, vi } from "vitest";

import { pushToCRM } from "@real-estate/utils";

const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("CRM adapters", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps generic webhook fields and sends an idempotency key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "crm-1" })
    } as Response);

    await pushToCRM({
      client: {
        id: "client-1",
        name: "Acme",
        timezone: "Asia/Kolkata",
        status: "active",
        whatsappProvider: "twilio",
        whatsappConfig: { fromNumber: "whatsapp:+1" },
        crmType: "custom",
        crmConfig: {
          endpoint: "https://crm.example.test/leads",
          method: "POST",
          authType: "none",
          fieldMap: {
            "lead.id": "lead_id",
            "attributes.location": "city"
          },
          externalIdPath: "id"
        }
      },
      lead: {
        id: "lead-1",
        name: "Rohan",
        phone: "+919811112222",
        email: null,
        source: "website",
        status: "qualified",
        score: 80,
        createdAt: new Date("2026-05-01T00:00:00.000Z")
      },
      attributes: {
        location: "mohali"
      },
      dedupeKey: "crm-dedupe-1",
      encryptionKey
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://crm.example.test/leads",
      expect.objectContaining({
        headers: expect.objectContaining({ "Idempotency-Key": "crm-dedupe-1" }),
        body: JSON.stringify({ lead_id: "lead-1", city: "mohali" })
      })
    );
  });

  it("wraps HubSpot payloads in properties", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "hubspot-1" })
    } as Response);

    const result = await pushToCRM({
      client: {
        id: "client-1",
        name: "Acme",
        timezone: "Asia/Kolkata",
        status: "active",
        whatsappProvider: "twilio",
        whatsappConfig: { fromNumber: "whatsapp:+1" },
        crmType: "hubspot",
        crmConfig: {
          fieldMap: {
            "lead.phone": "phone"
          }
        }
      },
      lead: {
        id: "lead-1",
        name: "Rohan",
        phone: "+919811112222",
        email: null,
        source: "website",
        status: "qualified",
        score: 80,
        createdAt: new Date("2026-05-01T00:00:00.000Z")
      },
      attributes: {},
      dedupeKey: "crm-dedupe-2",
      encryptionKey
    });

    expect(result.externalId).toBe("hubspot-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.hubapi.com/crm/v3/objects/contacts",
      expect.objectContaining({
        body: JSON.stringify({ properties: { phone: "+919811112222" } })
      })
    );
  });
});

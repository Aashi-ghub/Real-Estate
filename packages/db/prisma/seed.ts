import { getBaseConfig } from "@real-estate/config";
import { hashApiKey } from "@real-estate/utils";

import { PrismaClient } from "../src/generated";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const config = getBaseConfig();
  const clientId = "11111111-1111-1111-1111-111111111111";
  const apiKeyId = "22222222-2222-2222-2222-222222222222";
  const localApiKey = "local-dev-api-key-123456";

  await prisma.client.upsert({
    where: { id: clientId },
    create: {
      id: clientId,
      name: "Acme Realty",
      status: "active",
      timezone: "Asia/Kolkata",
      whatsappProvider: "twilio",
      whatsappConfig: {
        fromNumber: config.TWILIO_WHATSAPP_FROM
      },
      crmType: "custom",
      crmConfig: {
        endpoint: "http://host.docker.internal:8081/crm/leads",
        method: "POST",
        authType: "none",
        fieldMap: {
          "lead.id": "lead_id",
          "lead.name": "full_name",
          "lead.phone": "phone",
          "lead.email": "email",
          "lead.source": "source",
          "lead.score": "score",
          "attributes.budget": "budget",
          "attributes.location": "location",
          "attributes.timeline": "timeline",
          "attributes.purpose": "purpose"
        }
      }
    },
    update: {
      status: "active",
      timezone: "Asia/Kolkata",
      whatsappProvider: "twilio",
      whatsappConfig: {
        fromNumber: config.TWILIO_WHATSAPP_FROM
      }
    }
  });

  await prisma.apiKey.upsert({
    where: { id: apiKeyId },
    create: {
      id: apiKeyId,
      clientId,
      name: "Local Development",
      hashedKey: hashApiKey(localApiKey, config.APP_ENCRYPTION_KEY),
      status: "active"
    },
    update: {
      hashedKey: hashApiKey(localApiKey, config.APP_ENCRYPTION_KEY),
      status: "active"
    }
  });

  console.log(JSON.stringify({ clientId, apiKey: localApiKey }, null, 2));
}

main()
  .catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
    await prisma.$disconnect();
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

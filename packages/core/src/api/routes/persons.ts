import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { createLogger } from "../../logger.js";
import { STRANGER_PERSON_ID } from "../../constants.js";
import { ensureProfileMemoryInitialized, getMemoryTemplateDir } from "../../profile-memory.js";
import type { ApiDeps } from "../deps.js";

const log = createLogger("api:persons");

interface CreatePersonBody {
  displayName?: string;
  bondLevel?: "inner-circle" | "acquaintance" | "other";
  relation?: string;
  channel?: string;
  channelUserId?: string;
}

interface LinkBody {
  channel?: string;
  channelUserId?: string;
  existingPersonId?: string;
  displayName?: string;
}

interface MarkStrangerBody {
  channel?: string;
  channelUserId?: string;
  displayName?: string;
}

export function personsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/persons", async (c) => {
    const rows = await deps.personMappingRepo.findAllWithMappings();
    return c.json(rows);
  });

  app.get("/persons/unknown", async (c) => {
    const rows = await deps.db.all(sql`
      SELECT
        s.channel,
        s.channel_user_id AS channelUserId,
        s.display_name AS displayName,
        s.text AS lastMessage,
        MAX(s.created_at) AS lastMessageAt
      FROM sentinel_log s
      LEFT JOIN channel_mappings cm
        ON s.channel = cm.channel AND s.channel_user_id = cm.channel_user_id
      WHERE cm.id IS NULL
      GROUP BY s.channel, s.channel_user_id
      ORDER BY MAX(s.created_at) DESC
    `);
    return c.json(rows);
  });

  app.post("/persons/create", async (c) => {
    const body = await c.req.json<CreatePersonBody>().catch(() => ({}) as CreatePersonBody);
    const { displayName, bondLevel, relation, channel, channelUserId } = body;
    if (!displayName || !bondLevel || !channel || !channelUserId) {
      return c.json(
        { error: "displayName, bondLevel, channel, and channelUserId are required" },
        400,
      );
    }

    const personId = await deps.personMappingRepo.generatePersonId(displayName);
    const profilePath = `memory/relationship/${personId}.md`;

    // One transaction: a person whose mapping write failed would be unreachable
    // and unrepairable through this API.
    await deps.personMappingRepo.createWithChannelMapping(
      personId,
      { displayName, bondLevel, profilePath, approved: true },
      { channel, channelUserId, displayName },
    );

    try {
      const memoryDir = ensureProfileMemoryInitialized();
      const profileDir = join(memoryDir, "relationship");
      mkdirSync(profileDir, { recursive: true });

      const profileTemplatePath = join(profileDir, "TEMPLATE.md");
      const fallbackTemplatePath = join(getMemoryTemplateDir(), "relationship", "TEMPLATE.md");

      let template: string;
      try {
        template = readFileSync(profileTemplatePath, "utf-8");
      } catch {
        try {
          template = readFileSync(fallbackTemplatePath, "utf-8");
        } catch {
          template = `# {Person Name}\n\n## Overview\n\n| Field | Value |\n|---|---|\n| **Name** | {Full Name} |\n| **Bond Level** | {Bond Level} |\n| **Relation** | {Relation} |\n`;
        }
      }

      const profileContent = template
        .replace(/\{Person Name\}/g, displayName)
        .replace(/\{Full Name\}/g, displayName)
        .replace(/\{Bond Level\}/g, bondLevel)
        .replace(/\{How they know the guardian\}/g, relation || "Unknown")
        .replace(/\{Date or approximate period\}/g, new Date().toISOString().split("T")[0])
        .replace(/\{Telegram user ID\}/g, channel === "telegram" ? channelUserId : "")
        .replace(/\{WhatsApp phone\/ID\}/g, channel === "whatsapp" ? channelUserId : "");

      writeFileSync(join(profileDir, `${personId}.md`), profileContent);
    } catch (err) {
      log.error("failed to write profile file", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return c.json({ success: true, personId });
  });

  app.post("/persons/link", async (c) => {
    const body = await c.req.json<LinkBody>().catch(() => ({}) as LinkBody);
    const { channel, channelUserId, existingPersonId, displayName } = body;
    if (!channel || !channelUserId || !existingPersonId) {
      return c.json({ error: "channel, channelUserId, and existingPersonId are required" }, 400);
    }
    await deps.personMappingRepo.addChannelMapping(
      existingPersonId,
      channel,
      channelUserId,
      displayName,
    );
    return c.json({ success: true });
  });

  app.post("/persons/mark-stranger", async (c) => {
    const body = await c.req.json<MarkStrangerBody>().catch(() => ({}) as MarkStrangerBody);
    const { channel, channelUserId, displayName } = body;
    if (!channel || !channelUserId) {
      return c.json({ error: "channel and channelUserId are required" }, 400);
    }
    await deps.personMappingRepo.addChannelMapping(
      STRANGER_PERSON_ID,
      channel,
      channelUserId,
      displayName,
    );
    return c.json({ success: true });
  });

  return app;
}

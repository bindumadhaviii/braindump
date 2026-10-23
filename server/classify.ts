import fs from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { CATEGORIES, CATEGORY_IDS } from "../shared/categories.ts";
import { existingTopics, getStoredName, storedPath, type Message } from "./db.ts";
import { classifyWithRules, type NewItem } from "../shared/rules.ts";
import { client } from "./claude.ts";


const ItemsSchema = z.object({
  items: z.array(
    z.object({
      category: z.enum(CATEGORY_IDS),
      topic: z.string().nullable(),
      title: z.string(),
      body: z.string(),
      source: z.string(),
    }),
  ),
});

const SYSTEM = `You are the organizer inside a braindump app. The user dumps whatever is on their mind into a chat with no one on the other side: notes, to-dos, links, screenshots, photos, voice memos, files. Your job is to turn one message into tidy items for their auto-organized notebook. You never reply to the user.

Categories:
${CATEGORIES.map((c) => `- ${c.id}: ${c.hint}. Keywords: ${c.keywords.join(", ")}`).join("\n")}

How to split a message into items:
- One message can hold several intents. "buy oat milk, call mom, also this site is great https://..." is two todo items and one link item.
- Every attachment and every link gets exactly one item whose source points at it ("attachment:0", "link:1"). If the user's text is a caption for that attachment or link, put the caption in that item's body instead of making a separate text item.
- Remaining text becomes items with source "text". Each separate to-do is its own todo item. Keep a coherent thought together as one note or idea; don't fragment prose.
- A voice memo's transcript counts as the user's words: split it the same way, with source pointing at the audio attachment for the first item and "text" for any extra items.

Fields:
- title: a short label (max ~12 words) in the user's language. For a todo, the action itself ("Call Mom"). For a link, what the page is.
- body: the user's own words for this item, lightly cleaned (trim filler like "remind me to" / "don't forget to" for todos). Never invent content the user didn't say. Empty string if there's nothing beyond the title.
- topic: a 1-3 word theme used to group related items within a category, e.g. "UI design", "Travel", "Work", "AI tools". Reuse an existing topic when one fits. null for todos with no clear theme.

Write titles and topics in the same language the user writes in.`;

function sourceIndex(source: string, prefix: string, max: number): number | null {
  const m = new RegExp(`^${prefix}:(\\d+)$`).exec(source.trim());
  if (!m) return null;
  const i = Number(m[1]);
  return i < max ? i : null;
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const TEXTY = /^(text\/|application\/(json|xml|x-yaml|javascript))/;

async function classifyWithClaude(msg: Message): Promise<NewItem[]> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];

  msg.attachments.forEach((a, i) => {
    let label = `[attachment:${i}] ${a.kind} "${a.filename}" (${a.mime})`;
    if (a.transcript) label += `\n${a.kind === "audio" ? "Voice memo transcript" : "Text read from the image"}: ${a.transcript}`;
    content.push({ type: "text", text: label });
    const file = storedPath(getStoredName(a.id));
    if (IMAGE_TYPES.has(a.mime) && a.size < 5_000_000) {
      content.push({ type: "image", source: { type: "base64", media_type: a.mime as "image/png", data: fs.readFileSync(file, "base64") } });
    } else if (a.mime === "application/pdf" && a.size < 20_000_000) {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: fs.readFileSync(file, "base64") } });
    } else if (TEXTY.test(a.mime) && a.size < 200_000) {
      content.push({ type: "text", text: `Contents of ${a.filename}:\n${fs.readFileSync(file, "utf8")}` });
    }
  });
  msg.links.forEach((l, i) => {
    content.push({ type: "text", text: `[link:${i}] ${l.url}\nPage title: ${l.title ?? "?"}\nPage description: ${l.description ?? "?"}` });
  });
  content.push({ type: "text", text: `Topics already in use, by category: ${JSON.stringify(existingTopics())}` });
  content.push({ type: "text", text: `Message text:\n${msg.text || "(no text)"}` });

  const response = await client!.beta.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: "low", format: betaZodOutputFormat(ItemsSchema) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) {
    throw new Error(`Classifier returned no items (stop_reason: ${response.stop_reason})`);
  }

  return response.parsed_output.items.map((it) => {
    const ai = sourceIndex(it.source, "attachment", msg.attachments.length);
    const li = sourceIndex(it.source, "link", msg.links.length);
    return {
      category: it.category,
      topic: it.topic?.trim() || null,
      title: it.title.trim(),
      body: it.body.trim(),
      attachment_id: ai === null ? null : msg.attachments[ai].id,
      link_id: li === null ? null : msg.links[li].id,
    };
  });
}

/** Every attachment and link must land somewhere in the doc, even if the model skipped one. */
function ensureCoverage(msg: Message, items: NewItem[]): NewItem[] {
  const fallback = classifyWithRules(msg);
  const missing = fallback.filter(
    (f) =>
      (f.attachment_id && !items.some((i) => i.attachment_id === f.attachment_id)) ||
      (f.link_id && !items.some((i) => i.link_id === f.link_id)),
  );
  return [...items, ...missing];
}

export async function classify(msg: Message): Promise<NewItem[]> {
  if (!client) return classifyWithRules(msg);
  try {
    return ensureCoverage(msg, await classifyWithClaude(msg));
  } catch (err) {
    console.error("[classify] falling back to rules:", err instanceof Error ? err.message : err);
    return classifyWithRules(msg);
  }
}

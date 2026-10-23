// Rule-based categorizer: used when there's no API key or the Claude call fails, and by the static demo build
// (which runs in the browser), so it must stay free of server-only imports.
import type { Item, Message } from "../server/db.ts";
import { CATEGORIES, type CategoryId } from "./categories.ts";

export type NewItem = Omit<Item, "id" | "done">;

// One regex per category from its keywords; whole words, plurals allowed ("meetings"), "call up" matches "call  up".
const KEYWORD_RE = Object.fromEntries(
  CATEGORIES.map((c) => [
    c.id,
    new RegExp(String.raw`\b(?:${c.keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, String.raw`\s+`)).join("|")})(?:s|es)?\b`, "gi"),
  ]),
) as Record<CategoryId, RegExp>;
/** How many of a category's keywords appear in the text. */
const keywordHits = (id: CategoryId, text: string) => text.match(KEYWORD_RE[id])?.length ?? 0;

const URL_RE = /https?:\/\/[^\s<>"'，。！？、）)\]]+/gi;

export function extractUrls(text: string): string[] {
  return [...new Set(text.match(URL_RE) ?? [])];
}

const TODO_RE =
  /^\s*(?:[-*•]\s*\[\s?\]|\[\s?\]|(?:to-?do|remember to|remind me|don'?t forget|need to|have to|must|buy|get|call|text|email|book|schedule|pay|pick up|finish|submit|reply|tomorrow|tonight|next week)\b)/i;
// Also projects in the works: "We are building…", "Thinking of making…", "brainstorming".
const IDEA_RE =
  /\b(idea|what if|maybe we|could build|how about|wouldn'?t it be|brainstorm\w*|(?:we|i)(?:'re| are|'m| am) (?:building|creating|developing)|thinking (?:of|about) (?:building|making|creating|starting|launching))\b/i;
// Openers that always start a new idea instead of continuing the previous one.
const NEW_IDEA_RE = /^\s*(?:idea:|what if|how about)/i;
const INSPO_RE = /\b(inspo|inspiration|design|palette|colou?rs?|ui|ux|layout|fonts?|typography|moodboard|reference|style)\b/i;

// Plans count as to-dos too: things with a time on them, intentions, and appointments.
const DAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const TIME_RE = new RegExp(
  String.raw`\b(?:at\s+\d{1,2}(?::\d{2})?(?:\s*(?:am|pm|a\.m\.|p\.m\.))?|\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)|tonight|this (?:morning|afternoon|evening)|later (?:today|tonight|this (?:morning|afternoon|evening)|in the (?:morning|afternoon|evening))|tomorrow|on (?:${DAYS})|this (?:${DAYS})|next (?:${DAYS}))\b`,
  "i",
);
const INTENT_RE =
  /\b(?:i\s+(?:have|need|got|gotta|must|should|want|plan|am planning|'m planning|am going|'m going|will|'d like)\s+to|i'?ll|i\s+(?:was wondering|wonder|am wondering|'m wondering) if i (?:could|should|can|might)|maybe i (?:could|should|can|will|'ll)|i (?:have|'ve got|got) (?:an? )?(?:meeting|appointment|call|interview|class|session|flight|date|dinner|lunch|coffee)|(?:meeting|appointment|call|interview) with)\b/i;
// Looking back rather than ahead: "Meetings were tiring", "I cooked dinner at 7".
const PAST_RE = /\b(?:was|were|went|had|did|felt|got back|yesterday|ago|last (?:night|week))\b/i;

/** Is this clause something the user means to do? */
const isTask = (c: string) =>
  TODO_RE.test(stripBullet(c)) || INTENT_RE.test(c) || (TIME_RE.test(c) && !PAST_RE.test(c.replace(INTENT_RE, "")));

const TODO_HEADER_RE = /\b(to-?do|to do|tasks|to buy|shopping list|checklist)\b/i;
const stripBullet = (l: string) => l.replace(/^\s*(?:[-*•]|\d+[.)])?\s*(?:\[\s?\]\s*)?(?:to-?do:\s*)?/i, "");
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const stripPrefix = (l: string) => capitalize(l.replace(/^(?:idea|note|thought):\s*/i, ""));
// Opening filler that isn't part of the task: "Hey, today I have a meeting…" → "Meeting…"
const FILLER = /^(?:(?:hey|hi|hello|ok|okay|so|um|well|alright|oh)\b[,!.]?\s*|(?:today|tonight|tomorrow|later(?: in the (?:morning|afternoon|evening)| today| tonight)?|this (?:morning|afternoon|evening))\b,?\s+(?=i\b|i'))+/i;
const INTENT_LEAD =
  /^(?:i\s+(?:have|need|got|gotta|must|should|want|plan|am planning|'m planning|am going|'m going|will|'d like)\s+to|i'?ll|i\s+(?:was wondering|wonder|am wondering|'m wondering) if i (?:could|should|can|might)|maybe i (?:could|should|can|will|'ll)|i (?:have|'ve got|got)(?: an?)?(?= (?:meeting|appointment|call|interview|class|session|flight|date|dinner|lunch|coffee)\b)|remember to|don'?t forget to|remind me to|need to)\s*/i;
// "Hey, I was wondering if I could read Atomic Habits later tonight." → "Read Atomic Habits later tonight"
const todoTitle = (l: string) =>
  capitalize(stripBullet(l).replace(FILLER, "").replace(INTENT_LEAD, "").replace(/[.;,!]+$/, "").trim());
const short = (s: string, n = 48) => (s.length > n ? s.slice(0, n) + "…" : s);

// ---------- Splitting one message into one clause per intent ----------

const CONNECTOR = /^(?:and also|oh and|and|also|plus|then|btw)\s+/i;
const hasUrl = (s: string) => /https?:\/\//i.test(s);
/** Does this piece of text start something new (a task, an idea, a link) rather than continue the last one? */
const startsIntent = (s: string) =>
  TODO_RE.test(stripBullet(s)) || INTENT_RE.test(s) || NEW_IDEA_RE.test(s) || hasUrl(s);
// "Hey," / "So," on its own carries nothing.
const isFiller = (s: string) => /^(?:hey|hi|hello|ok|okay|so|um|well|alright|oh)[!.,]*$/i.test(s.trim());

/**
 * "buy oat milk, call mom, also this site is great https://…" → ["buy oat milk", "call mom", "this site is great https://…"].
 * Splits on lines and sentences, and at commas / "and" / "also" / "then" only when the next part starts a new
 * intent, so "call mom and dad" stays whole.
 */
function clauses(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    for (const sentence of line.split(/(?<=[.!?;])\s+/)) {
      const parts = sentence.split(/(,\s*|\s+and\s+|\s+also\s+|\s+then\s+)/i);
      let current = parts[0];
      for (let i = 1; i < parts.length; i += 2) {
        const piece = parts[i + 1] ?? "";
        if (startsIntent(piece.replace(CONNECTOR, ""))) {
          out.push(current);
          current = piece;
        } else current += parts[i] + piece;
      }
      out.push(current);
    }
  }
  return out.map((c) => c.replace(CONNECTOR, "").replace(/[,;]\s*$/, "").trim()).filter((c) => c && !isFiller(c));
}

type Clause = { kind: "todo" | "idea" | "note" | "link"; text: string; urls: string[] };

/**
 * Last resort for a clause none of the patterns above caught: whichever of to-do / idea / note keywords it mentions
 * most, with ties going to note. Past tense rules out a to-do ("Meetings were tiring" is not a task).
 */
function byKeywords(c: string): "todo" | "idea" | "note" {
  const todo = PAST_RE.test(c) ? 0 : keywordHits("todo", c);
  const idea = keywordHits("idea", c);
  const note = keywordHits("note", c);
  if (todo > note && todo >= idea) return "todo";
  if (idea > note) return "idea";
  return "note";
}

function parse(text: string): Clause[] {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  // A "To do tomorrow:" / "Shopping list:" header → every line under it is a to-do.
  if (lines.length > 1 && /:$/.test(lines[0]) && TODO_HEADER_RE.test(lines[0])) {
    return lines.slice(1).map((l) => ({ kind: "todo", text: l, urls: [] }));
  }
  const parsed = clauses(text).map((c): Clause => {
    const urls = extractUrls(c);
    if (urls.length) return { kind: "link", text: urls.reduce((acc, u) => acc.replace(u, ""), c).replace(/\s+/g, " ").trim(), urls };
    if (/^\s*(?:idea:|what if)/i.test(c)) return { kind: "idea", text: c, urls: [] };
    if (isTask(c)) return { kind: "todo", text: c, urls: [] };
    if (IDEA_RE.test(c)) return { kind: "idea", text: c, urls: [] };
    return { kind: byKeywords(c), text: c, urls: [] };
  });
  // Neighbouring note clauses are one thought, and sentences after an idea keep elaborating it unless they open a
  // new one ("Idea: …", "What if …").
  return parsed.reduce<Clause[]>((acc, c) => {
    const last = acc[acc.length - 1];
    const continues =
      (c.kind === "note" && (last?.kind === "note" || last?.kind === "idea")) ||
      (c.kind === "idea" && last?.kind === "idea" && !NEW_IDEA_RE.test(c.text));
    if (continues) last.text += " " + c.text;
    else acc.push({ ...c });
    return acc;
  }, []);
}

const base = { topic: null, attachment_id: null, link_id: null };

function itemFor(c: Clause): NewItem {
  if (c.kind === "todo") return { ...base, category: "todo", title: short(todoTitle(c.text), 80), body: "" };
  const text = stripPrefix(c.text);
  return { ...base, category: c.kind === "idea" ? "idea" : "note", title: short(text), body: text };
}

export function classifyWithRules(msg: Message): NewItem[] {
  const items: NewItem[] = [];
  const parsed = parse(msg.text);
  const notes = parsed.filter((c) => c.kind === "note");
  const linkCaption = new Map(parsed.filter((c) => c.kind === "link").flatMap((c) => c.urls.map((u) => [u, c.text] as const)));

  // Plain notes describe the media they came with, so they become its caption instead of separate items:
  // the attachments if there are any, otherwise links that have no caption of their own.
  const captionlessLinks = msg.links.filter((l) => !linkCaption.get(l.url));
  const notesAsCaption = notes.length > 0 && (msg.attachments.length > 0 || captionlessLinks.length > 0);
  const caption = notesAsCaption ? notes.map((n) => n.text).join(" ") : "";

  for (const a of msg.attachments) {
    const ref = { ...base, attachment_id: a.id };
    if (a.kind === "image") {
      // Text read from the photo (a saved screenshot, a whiteboard) is sorted like the user's own words. With a
      // caption, the photo itself is still filed by the caption's keywords and the text is sorted alongside it.
      const read = a.transcript ? parse(a.transcript).filter((c) => c.kind !== "link").map(itemFor) : [];
      if (caption || read.length === 0) {
        const inspo = !caption || INSPO_RE.test(caption) || keywordHits("inspiration", caption) > keywordHits("moment", caption);
        const cat = inspo ? "inspiration" : "moment";
        items.push({ ...ref, category: cat, title: short(caption || a.filename), body: caption });
      } else read[0].attachment_id = a.id;
      items.push(...read);
    } else if (a.kind === "video") items.push({ ...ref, category: "moment", title: short(caption || a.filename), body: caption });
    else if (a.kind === "audio") {
      // A voice memo is the user's own words: split it like typed text, with the recording on the first item.
      const spoken = parse(a.transcript ?? "").filter((c) => c.kind !== "link").map(itemFor);
      if (spoken.length === 0) spoken.push({ ...base, category: "note", title: "Voice memo", body: "" });
      spoken[0].attachment_id = a.id;
      items.push(...spoken);
    } else items.push({ ...ref, category: "file", title: a.filename, body: caption });
  }
  for (const l of msg.links) {
    const isImage = l.image === l.url;
    const body = linkCaption.get(l.url) || (msg.attachments.length === 0 ? caption : "");
    items.push({ ...base, link_id: l.id, category: isImage ? "inspiration" : "link", title: l.title ?? l.site_name ?? l.url, body });
  }
  for (const c of parsed) {
    if (c.kind === "todo" || c.kind === "idea" || (c.kind === "note" && !notesAsCaption)) items.push(itemFor(c));
  }
  return items;
}

// Photo recall: "I remember taking a screenshot of a leg day workout, can you find it?" → the matching photos.
// Matches the words in the message against the text read from each photo. Free of server-only imports, like rules.ts.
import type { Photo } from "../server/db.ts";

/** Is this message asking to find something in the photo library rather than dumping a thought? */
const RECALL_RE =
  /\b(?:can you (?:please )?(?:look|find|search|dig|pull|check)|could you (?:please )?(?:look|find|search|dig|pull|check)|look (?:into|for|up|through)\b|find (?:me |it|that|the|my)|search (?:for|my|through)|pull (?:it |that )?up|do i have (?:a|an|any|the|that)\b|where(?:'s| is) (?:that|the|my) (?:photo|picture|pic|screenshot|image)|i (?:remember|think i|know i) (?:taking|took|saving|saved|screenshotting|screenshotted|snapping|snapped|had) )/i;

export const isRecallQuery = (text: string) => RECALL_RE.test(text);

// Words that say how to search, not what to search for.
const STOP = new Set(
  (
    "a an the and or but so if of from for on in at to by with about into onto over this that these those it its it's " +
    "i i'm i've i'd me my mine we our you your he she they them is are was were be been being am do does did don't dont " +
    "have has had having can could would should will just really quite very some any random thing stuff something " +
    "hey hi hello please thanks ok okay um like also then there here what which who when where why how not no yes " +
    "look looking find finding search searching pull dig check tell show remember remembered recall think thought know " +
    "taking took take taken saving saved save snapped snapping screenshot screenshots screenshotted photo photos picture " +
    "pictures pic pics image images gallery camera roll name one once went go going been based sure kind sort get got " +
    "want wanted need later explore again maybe someone somewhere everywhere anywhere posted up as"
  ).split(" "),
);

// Related words, so "exercise" also finds a screenshot that only says "squats". A small hand-made start: the
// WordNet-based keyword lists can replace these groups.
const RELATED: string[][] = [
  ["exercise", "workout", "gym", "fitness", "training", "reps", "sets", "squat", "lunge", "deadlift", "burpee", "bodyweight", "plank"],
  ["job", "career", "resume", "interview", "hiring", "apply", "linkedin", "indeed", "recruiter"],
  ["birthday", "reward", "coupon", "discount", "deal", "freebie", "offer", "loyalty"],
  ["netflix", "series", "show", "watch", "tv", "movie"],
  ["english", "vocabulary", "accent", "speaking", "language", "conversation"],
  ["thriller", "mystery", "bestselling", "novel", "author"],
  ["fryer", "appliance", "kitchen", "seller", "sale", "obo"],
  ["leg", "squat", "lunge", "glute", "quad", "hamstring", "calf"],
  ["rep", "set"],
  ["travel", "trip", "flight", "hotel", "itinerary", "booking", "vacation", "visit"],
  ["flight", "boarding", "gate", "airline", "departure"],
  ["hackathon", "hack", "demo", "pitch", "team", "project", "devpost"],
  ["food", "restaurant", "menu", "cafe", "dish", "dinner", "lunch", "brunch"],
  ["coffee", "cafe", "latte", "espresso"],
  ["run", "running", "jog", "pace", "mile", "km", "strava"],
  ["recipe", "ingredient", "cook", "bake", "oven"],
  ["receipt", "total", "order", "paid", "invoice"],
  ["todo", "task", "checklist", "deadline"],
  ["book", "read", "reading", "author", "novel"],
  ["event", "ticket", "concert", "show", "rsvp"],
];

/** Lower-case, drop possessives, hyphens and plural endings, so "Squats" matches "squat" and "To-do" matches "todo". */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/[’']s$/, "").replace(/[’'-]/g, "");
  if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w;
}

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];

const relatedTo = new Map<string, Set<string>>();
for (const group of RELATED.map((g) => g.map(stem))) {
  for (const w of group) {
    const set = relatedTo.get(w) ?? new Set<string>();
    group.forEach((x) => x !== w && set.add(x));
    relatedTo.set(w, set);
  }
}

/** "…and make a to-do with the time": the user wants the found photo turned into a to-do, not just shown. */
const TODO_ASK_RE = /\b(?:make|create|add|put|turn|save|set|write)\b[^.?!]{0,40}\b(?:to-?dos?|to do|task|reminder)\b|\bremind me\b/i;
export const wantsTodo = (text: string) => TODO_ASK_RE.test(text);
/** "…and add it to my notes": the user wants the found photo saved into the log. */
const NOTE_ASK_RE = /\b(?:add|put|save|keep|store|make)\b[^.?!]{0,30}\bnotes?\b/i;
export const wantsNote = (text: string) => NOTE_ASK_RE.test(text);
// Words that describe the request, not the photo, so they don't take part in the search.
const ASK_WORDS = new Set(
  "todo list task reminder remind make create add put turn write store stored keep save note same timing time date alongside after as effort".split(" "),
);

/** The words worth searching for, in the order the user said them. */
export function recallTerms(text: string): string[] {
  const asks = wantsTodo(text) || wantsNote(text);
  const out: string[] = [];
  for (const w of words(text)) {
    const s = stem(w);
    if (s.length < 2 || STOP.has(w) || STOP.has(s) || out.includes(s) || (asks && ASK_WORDS.has(s))) continue;
    out.push(s);
  }
  return out;
}

// ---------- Turning a found photo into a to-do ----------

const DATE_RE =
  /\b(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?,?\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:\s*[-–]\s*\d{1,2})?\b/i;
const WEEKDAY_RE = /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/i;
const CLOCK_RE = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i; // needs AM/PM, so the status bar's "9:41" isn't taken
const GENERIC = new Set("my the a ticket tickets screenshot photo schedule booking confirmation event events recipe recipes notes post".split(" "));

/** "SATURDAY, NOV 14" → "Saturday, Nov 14"; mixed case is kept as written. Also undoes OCR's usual "AI" → "Al". */
const tidy = (s: string) =>
  (s === s.toUpperCase() ? s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : s).replace(/\bAl\b(?=\s+[A-Z])/g, "AI");

/**
 * What the photo is: a capitalised name the user said that's in the photo, else a stretch of the photo's words they
 * used ("golden gate music festival"), else the photo's own title line ("HackSF 2026").
 */
export function photoName(photo: Photo, asked: string, terms: string[]): string {
  const flat = photo.text.replace(/\s+/g, " ");
  const said = (asked.match(/\b[A-Z][\w'&]*(?:\s+(?:of|the|and|&|[A-Z][\w'&]*))*\s+[A-Z][\w'&]*/g) ?? [])
    .filter((n) => flat.toLowerCase().includes(n.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  if (said) return tidy(said);

  // Longest stretch of the photo's own words that the user also said ("golden gate music festival").
  const ws = flat.split(" ");
  let best: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    const run: string[] = [];
    for (let j = i; j < ws.length && (terms.includes(stem(ws[j].replace(/[^\p{L}\p{N}'-]/gu, ""))) || /^(?:of|the|and|&)$/i.test(ws[j])); j++) run.push(ws[j]);
    while (run.length && GENERIC.has(run[0].toLowerCase())) run.shift();
    while (run.length && (GENERIC.has(run[run.length - 1].toLowerCase()) || /^(?:of|the|and|&)$/i.test(run[run.length - 1]))) run.pop();
    if (run.length > best.length) best = run;
  }
  if (best.length >= 2) return tidy(best.join(" "));

  // One matching word ("meetup") makes a poor name; the photo's title line is better. Skip the status bar, date and
  // time lines, labels like "Events" or "My tickets", and OCR specks like "SRR INR La," (no real word in them).
  const title = photo.text
    .split("\n")
    .find(
      (l) =>
        /\p{Lu}?\p{Ll}{3,}/u.test(l) &&
        !/^\d{1,2}:\d{2}\b/.test(l) &&
        !DATE_RE.test(l) &&
        !CLOCK_RE.test(l) &&
        l.split(/\s+/).some((w) => !GENERIC.has(w.toLowerCase())),
    );
  return tidy(title ?? (best.join(" ") || photo.path));
}

/** What the user asked to be reminded to do: "remind me to message the seller" → "message the seller". */
function askedAction(asked: string): string | null {
  const m = asked.match(/\bremind me to ([^.?!,]+)/i) ?? asked.match(/\b(?:to-?do|task|reminder) to ([^.?!,]+)/i);
  const action = m?.[1].trim().replace(/\s+(?:about|for|with) (?:it|this|that)$/i, "");
  return action && !/^(?:go|attend|be there|go there)$/i.test(action) ? action : null;
}

/**
 * A to-do from the photo: "Go to Golden Gate Music Festival — Saturday, Nov 14, 7:30 PM", or the user's own action
 * ("Message the seller — Air Fryer"). Other times and prices from the photo go in the body.
 */
export function todoFromPhoto(photo: Photo, asked: string, terms: string[]): { title: string; body: string } {
  const name = photoName(photo, asked, terms);
  const action = askedAction(asked);
  const lines = photo.text.split("\n");
  const dateLine = lines.find((l) => DATE_RE.test(l)) ?? lines.find((l) => WEEKDAY_RE.test(l));
  const date = dateLine ? tidy((dateLine.match(DATE_RE) ?? dateLine.match(WEEKDAY_RE))![0]) : null;
  // Prefer a time on the same line as the date ("Saturday, Nov 14 7:30 PM"), else the first time in the photo.
  const timeLine = (dateLine && CLOCK_RE.test(dateLine) ? dateLine : lines.find((l) => CLOCK_RE.test(l))) ?? null;
  const time = timeLine ? timeLine.match(CLOCK_RE)![0].toUpperCase() : null;
  const when = [date, time].filter(Boolean).join(", ");
  const extra = lines.filter((l) => l !== timeLine && (CLOCK_RE.test(l) || /\$\d/.test(l))).slice(0, 3); // "Gates open 6:00 PM", "$45 OBO"
  const title = action
    ? `${action.charAt(0).toUpperCase()}${action.slice(1)} — ${name}${when ? ` (${when})` : ""}`
    : when
      ? `Go to ${name} — ${when}`
      : name;
  return {
    title,
    body: [...extra, `From your screenshot ${photo.path}`].join(" · "),
  };
}

export type Match = { photo: Photo; score: number };

/**
 * Ranks photos by how well their text matches the terms. Rare words count more than common ones (so "hackathon"
 * outweighs "day"), a related word counts half, and two terms side by side ("leg day") get a bonus.
 */
export function searchPhotos(photos: Photo[], terms: string[], limit = 6): Match[] {
  if (!terms.length || !photos.length) return [];
  const docs = photos.map((p) => {
    const ws = words(`${p.text} ${p.path.replace(/[\\/_.-]+/g, " ")}`).map(stem);
    // OCR often glues stylised words together ("Reverselunge30x"); long tokens are also searched inside.
    const glued = ws.filter((w) => w.length >= 9);
    return { photo: p, set: new Set(ws), glued, joined: ` ${ws.join(" ")} ` };
  });
  /** 1 for the word itself, 0.5 for a word of 5+ letters found inside a glued token, else 0. */
  const has = (d: (typeof docs)[number], w: string) => (d.set.has(w) ? 1 : w.length >= 5 && d.glued.some((g) => g.includes(w)) ? 0.5 : 0);
  const idf = (w: string) => Math.log(1 + docs.length / (1 + docs.filter((d) => has(d, w)).length));
  // A related word backs up a photo that already matches another term, or stands in for a term no photo contains.
  // On its own it's noise: if one photo says "hackathon", another that only says "pitch" isn't a match.
  const exact = new Set(terms.filter((t) => docs.some((d) => has(d, t))));

  const matches: Match[] = [];
  for (const d of docs) {
    let score = 0;
    const matchesATerm = terms.some((t) => has(d, t));
    for (const t of terms) {
      if (has(d, t)) score += has(d, t) * idf(t);
      else if (matchesATerm || !exact.has(t)) {
        const rel = [...(relatedTo.get(t) ?? [])].find((r) => has(d, r));
        if (rel) score += 0.5 * has(d, rel) * idf(rel);
      }
    }
    for (let i = 1; i < terms.length; i++) if (d.joined.includes(` ${terms[i - 1]} ${terms[i]} `)) score += 1;
    if (score > 0) matches.push({ photo: d.photo, score });
  }
  matches.sort((a, b) => b.score - a.score || (b.photo.taken_at ?? 0) - (a.photo.taken_at ?? 0));
  // Drop weak hits (e.g. only "day" matched) when there are much better ones.
  const best = matches[0]?.score ?? 0;
  return matches.filter((m) => m.score >= best * 0.5).slice(0, limit);
}

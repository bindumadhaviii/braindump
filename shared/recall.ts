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
    "want wanted need later explore again maybe"
  ).split(" "),
);

// Related words, so "exercise" also finds a screenshot that only says "squats". A small hand-made start: the
// WordNet-based keyword lists can replace these groups.
const RELATED: string[][] = [
  ["exercise", "workout", "gym", "fitness", "training", "reps", "sets", "squat", "lunge", "deadlift"],
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
  ["event", "ticket", "concert", "show", "rsvp"],
];

/** Lower-case, drop possessives and plural endings, so "Squats" matches "squat". */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/[’']s$/, "").replace(/[’']/g, "");
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

/** The words worth searching for, in the order the user said them. */
export function recallTerms(text: string): string[] {
  const out: string[] = [];
  for (const w of words(text)) {
    const s = stem(w);
    if (s.length < 2 || STOP.has(w) || STOP.has(s) || out.includes(s)) continue;
    out.push(s);
  }
  return out;
}

export type Match = { photo: Photo; score: number };

/**
 * Ranks photos by how well their text matches the terms. Rare words count more than common ones (so "hackathon"
 * outweighs "day"), a related word counts half when no photo has the word itself, and two terms side by side
 * ("leg day") get a bonus.
 */
export function searchPhotos(photos: Photo[], terms: string[], limit = 6): Match[] {
  if (!terms.length || !photos.length) return [];
  const docs = photos.map((p) => {
    const ws = words(`${p.text} ${p.path.replace(/[\\/_.-]+/g, " ")}`).map(stem);
    return { photo: p, set: new Set(ws), joined: ` ${ws.join(" ")} ` };
  });
  const idf = (w: string) => Math.log(1 + docs.length / (1 + docs.filter((d) => d.set.has(w)).length));
  // Related words only stand in for a term no photo contains: if one says "hackathon", "pitch" is just noise.
  const exact = new Set(terms.filter((t) => docs.some((d) => d.set.has(t))));

  const matches: Match[] = [];
  for (const d of docs) {
    let score = 0;
    for (const t of terms) {
      if (d.set.has(t)) score += idf(t);
      else if (!exact.has(t)) {
        const rel = [...(relatedTo.get(t) ?? [])].find((r) => d.set.has(r));
        if (rel) score += 0.5 * idf(rel);
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

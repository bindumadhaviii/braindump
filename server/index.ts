import "./env.ts";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import * as db from "./db.ts";
import { classify } from "./classify.ts";
import { aiEnabled } from "./claude.ts";
import { generateTemplate } from "./templates.ts";
import { importSeedIfEmpty } from "./seed.ts";
import { fetchPreview } from "./links.ts";
import { extractUrls } from "../shared/rules.ts";
import { isRecallQuery, photoName, recallTerms, searchPhotos, todoFromPhoto, wantsNote, wantsTodo } from "../shared/recall.ts";
import { CATEGORY_IDS } from "../shared/categories.ts";

importSeedIfEmpty(); // a fresh clone starts with the sample data in seed/

const PORT = Number(process.env.PORT ?? 5173);
const isProd = process.env.NODE_ENV === "production";
const app = express();
app.use(express.json());

// ---------- Live updates (Server-Sent Events) ----------
const clients = new Set<express.Response>();
function broadcast(event: object) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(payload);
}
const pushMessage = (id: string) => {
  const message = db.getMessage(id);
  if (message) broadcast({ type: "message", message });
};

app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

/** Copies a photo from the library into the log as a new message, with the text read from it. */
function photoMessage(photo: db.Photo): db.Message {
  const storedName = db.newId() + ".jpg";
  fs.copyFileSync(path.join(db.THUMB_DIR, path.basename(photo.url)), db.storedPath(storedName));
  return db.insertMessage("", [
    {
      kind: "image",
      filename: path.basename(photo.path),
      mime: "image/jpeg",
      size: fs.statSync(db.storedPath(storedName)).size,
      storedName,
      transcript: photo.text.trim() || null,
    },
  ]);
}

// ---------- Organizing pipeline ----------
async function organize(id: string) {
  try {
    const msg = db.getMessage(id);
    if (!msg) return;
    // A question can be typed or spoken: a voice memo alone counts by its transcript.
    const voiceOnly = msg.attachments.length > 0 && msg.attachments.every((a) => a.kind === "audio");
    const asked = [msg.text, ...(voiceOnly ? msg.attachments.map((a) => a.transcript ?? "") : [])].join(" ").trim();
    if (isRecallQuery(asked) && (msg.attachments.length === 0 || voiceOnly)) {
      // "Can you find that screenshot…": answer from the photo library instead of filing it as a note.
      const terms = recallTerms(asked);
      const photos = db.listPhotos();
      const found = searchPhotos(photos, terms);
      db.saveRecall(id, terms, found.map((m) => m.photo.id), photos.length);
      // "…and make a to-do with the day and time": file the best match as a to-do on this message.
      const todo = wantsTodo(asked) && found.length ? todoFromPhoto(found[0].photo, asked, terms) : null;
      db.replaceItems(id, todo ? [{ category: "todo", topic: null, title: todo.title, body: todo.body, attachment_id: null, link_id: null }] : []);
      // "…and add it to my notes": save the best match into the log as one note (not re-sorted, so its times don't
      // turn into extra to-dos next to the one above).
      if (wantsNote(asked) && found.length) {
        const best = found[0].photo;
        const saved = photoMessage(best);
        const title = photoName(best, asked, terms);
        const body = best.text.split("\n").filter((l) => /\p{Ll}{3,}/u.test(l)).join("\n"); // drop OCR specks like "SRR INR La,"
        db.replaceItems(saved.id, [{ category: "note", topic: null, title, body, attachment_id: saved.attachments[0].id, link_id: null }]);
        db.setStatus(saved.id, "done");
        pushMessage(saved.id);
      }
    } else {
      db.replaceLinks(id, await Promise.all(extractUrls(msg.text).map(fetchPreview)));
      pushMessage(id); // show link previews as soon as they're ready
      db.replaceItems(id, await classify(db.getMessage(id)!));
    }
    db.setStatus(id, "done");
  } catch (err) {
    console.error(`[organize] ${id}:`, err);
    db.setStatus(id, "error");
  }
  pushMessage(id);
}

// ---------- API ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: db.UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, db.newId() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

const kindOf = (mime: string) =>
  mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "file";

app.get("/api/status", (_req, res) => res.json({ ai: aiEnabled }));

app.get("/api/messages", (_req, res) => res.json(db.listMessages()));

app.post("/api/messages", upload.array("files"), (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  const transcripts: (string | null)[] = JSON.parse(req.body.transcripts ?? "[]");
  const text = String(req.body.text ?? "").replace(/\r\n/g, "\n").trim();
  if (!text && files.length === 0) return res.status(400).json({ error: "Empty message" });

  const message = db.insertMessage(
    text,
    files.map((f, i) => ({
      kind: kindOf(f.mimetype),
      // multer decodes multipart filenames as latin1; restore UTF-8 (e.g. Chinese names).
      filename: Buffer.from(f.originalname, "latin1").toString("utf8"),
      mime: f.mimetype,
      size: f.size,
      storedName: f.filename,
      transcript: transcripts[i]?.trim() || null,
    })),
  );
  res.status(201).json(message);
  broadcast({ type: "message", message });
  organize(message.id);
});

app.post("/api/messages/:id/reorganize", (req, res) => {
  if (!db.getMessage(req.params.id)) return res.sendStatus(404);
  db.setStatus(req.params.id, "pending");
  pushMessage(req.params.id);
  organize(req.params.id);
  res.sendStatus(202);
});

app.delete("/api/messages/:id", (req, res) => {
  for (const f of db.deleteMessage(req.params.id)) fs.rm(db.storedPath(f), { force: true }, () => {});
  broadcast({ type: "deleted", id: req.params.id });
  res.sendStatus(204);
});

app.patch("/api/items/:id", (req, res) => {
  const { done, category } = req.body ?? {};
  if (category !== undefined && !CATEGORY_IDS.includes(category)) return res.status(400).json({ error: "Unknown category" });
  const messageId = db.updateItem(req.params.id, { done: done === undefined ? undefined : Boolean(done), category });
  if (!messageId) return res.sendStatus(404);
  pushMessage(messageId);
  res.sendStatus(204);
});

app.get("/api/templates", (_req, res) => res.json(db.listTemplates()));

app.post("/api/templates", async (req, res) => {
  const prompt = String(req.body?.prompt ?? "").trim();
  if (!prompt) return res.status(400).json({ error: "Describe the page you want." });
  res.status(201).json(db.insertTemplate(prompt, await generateTemplate(prompt)));
});

app.put("/api/templates/:id", async (req, res) => {
  const prompt = String(req.body?.prompt ?? "").trim();
  if (!prompt) return res.status(400).json({ error: "Describe the page you want." });
  const template = db.updateTemplate(req.params.id, prompt, await generateTemplate(prompt));
  if (!template) return res.sendStatus(404);
  res.json(template);
});

app.delete("/api/templates/:id", (req, res) => {
  db.deleteTemplate(req.params.id);
  res.sendStatus(204);
});

// ---------- Photo library ----------
// The browser reads each photo (text, date, place) and sends only that plus a thumbnail; originals stay on disk.
const thumbUpload = multer({
  storage: multer.diskStorage({ destination: db.THUMB_DIR, filename: (_req, _file, cb) => cb(null, db.newId() + ".jpg") }),
  limits: { fileSize: 5 * 1024 * 1024 },
});
const removeThumb = (name: string) => fs.rm(path.join(db.THUMB_DIR, name), { force: true }, () => {});

app.get("/api/photos", (_req, res) => res.json({ folders: db.photoFolders() }));

app.get("/api/photos/known", (req, res) => res.json(db.knownPhotoKeys(String(req.query.folder ?? ""))));

app.post("/api/photos", thumbUpload.single("thumb"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Missing thumbnail" });
  const meta = JSON.parse(req.body.meta ?? "{}");
  if (!meta.folder || !meta.path) {
    removeThumb(req.file.filename);
    return res.status(400).json({ error: "Missing folder or path" });
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const replaced = db.upsertPhoto({
    folder: String(meta.folder),
    path: String(meta.path),
    size: Number(meta.size) || 0,
    modified_at: Number(meta.modified_at) || 0,
    taken_at: num(meta.taken_at),
    lat: num(meta.lat),
    lon: num(meta.lon),
    text: String(meta.text ?? "").slice(0, 20_000),
    thumb_name: req.file.filename,
  });
  if (replaced) removeThumb(replaced);
  res.sendStatus(201);
});

app.delete("/api/photos", (req, res) => {
  for (const t of db.deletePhotoFolder(String(req.query.folder ?? ""))) removeThumb(t);
  res.sendStatus(204);
});

/** "Save to my notes": posts a found photo into the log, with the text read from it, so it gets sorted. */
app.post("/api/photos/:id/save", (req, res) => {
  const photo = db.getPhoto(req.params.id);
  if (!photo) return res.sendStatus(404);
  const message = photoMessage(photo);
  res.status(201).json(message);
  broadcast({ type: "message", message });
  organize(message.id);
});

app.use("/thumbs", express.static(db.THUMB_DIR, { maxAge: "7d" }));
app.use("/uploads", express.static(db.UPLOAD_DIR, { maxAge: "7d" }));

// ---------- Frontend ----------
if (isProd) {
  app.use(express.static("dist"));
  app.get(/^\/(?!api|uploads).*/, (_req, res) => res.sendFile(path.resolve("dist/index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
}

app.listen(PORT, () => {
  console.log(`BrainDump running at http://localhost:${PORT}  (AI organizer: ${aiEnabled ? "Claude" : "rules only — set ANTHROPIC_API_KEY to enable"})`);
  // Resume anything that was mid-organize when the server last stopped.
  for (const id of db.pendingMessageIds()) organize(id);
});

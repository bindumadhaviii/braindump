// Stand-in for src/api.ts in the static demo build (vite.demo.config.ts): no server, data baked in at build time.
// Visitors can send messages (sorted by the rule-based categorizer), tick to-dos and move items between
// categories; everything stays in their browser and resets when the page reloads.
import type { Attachment, Message } from "../../server/db.ts";
import type { Pending, ServerEvent } from "../api.ts";
import { classifyWithRules, extractUrls } from "../../shared/rules.ts";
import { templateFromKeywords, type Template } from "../../shared/templates.ts";

export type { Message, Item, Attachment, Link, Photo, Recall, Pending, PhotoMeta, ServerEvent, Template, TemplateSpec } from "../api.ts";

declare const __SNAPSHOT__: Message[];
const messages: Message[] = structuredClone(__SNAPSHOT__);
const listeners = new Set<(e: ServerEvent) => void>();
declare const __TEMPLATES__: Template[];
const templates: Template[] = structuredClone(__TEMPLATES__); // new ones live only in the visitor's browser until reload

const notInDemo = () => Promise.reject(new Error("Not available in the demo"));
const emit = (message: Message) => {
  for (const l of listeners) l({ type: "message", message: structuredClone(message) });
};
const kindOf = (mime: string): Attachment["kind"] =>
  mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "file";

export const api = {
  demo: true,
  subscribe: (onEvent: (e: ServerEvent) => void, onOpen: () => void) => {
    listeners.add(onEvent);
    onOpen();
    return () => void listeners.delete(onEvent);
  },
  status: async () => ({ ai: false }),
  list: async () => structuredClone(messages),
  send: async (text: string, files: Pending[]) => {
    const message: Message = {
      id: crypto.randomUUID(),
      created_at: Date.now(),
      text: text.trim(),
      status: "done",
      attachments: files.map(({ file, transcript }) => ({
        id: crypto.randomUUID(),
        kind: kindOf(file.type),
        filename: file.name,
        mime: file.type || "application/octet-stream",
        size: file.size,
        url: URL.createObjectURL(file),
        transcript: transcript?.trim() || null,
      })),
      // No server to fetch previews, so links show just their site name.
      links: extractUrls(text).map((url) => ({
        id: crypto.randomUUID(),
        url,
        title: null,
        description: null,
        image: null,
        site_name: new URL(url).hostname.replace(/^www\./, ""),
      })),
      items: [],
    };
    message.items = classifyWithRules(message).map((i) => ({ ...i, id: crypto.randomUUID(), done: false }));
    messages.push(message);
    emit(message);
    return structuredClone(message);
  },
  templates: {
    list: async () => structuredClone(templates),
    create: async (prompt: string) => {
      const t: Template = { id: crypto.randomUUID(), created_at: Date.now(), prompt, spec: templateFromKeywords(prompt) };
      templates.push(t);
      return structuredClone(t);
    },
    update: async (id: string, prompt: string) => {
      const t = templates.find((x) => x.id === id)!;
      Object.assign(t, { prompt, spec: templateFromKeywords(prompt) });
      return structuredClone(t);
    },
    remove: async (id: string) => {
      templates.splice(templates.findIndex((x) => x.id === id), 1);
    },
  },
  remove: notInDemo,
  reorganize: notInDemo,
  // The photo library reads folders on the visitor's own computer through the server; not part of the demo.
  photos: {
    folders: async () => ({ folders: [] }),
    known: async () => [],
    add: notInDemo,
    removeFolder: notInDemo,
    save: notInDemo,
  },
  patchItem: async (id: string, patch: { done?: boolean; category?: string }) => {
    const message = messages.find((m) => m.items.some((i) => i.id === id));
    const item = message?.items.find((i) => i.id === id);
    if (!message || !item) return;
    Object.assign(item, patch);
    emit(message);
  },
};

import type { Message } from "../server/db.ts";

export type { Message, Item, Attachment, Link, Photo, Recall } from "../server/db.ts";
export type { Template, TemplateSpec } from "../shared/templates.ts";
import type { Template } from "../shared/templates.ts";
export type Pending = { file: File; transcript?: string; preview?: string };
/** What the browser read from one photo in a granted folder. */
export type PhotoMeta = {
  folder: string;
  path: string;
  size: number;
  modified_at: number;
  taken_at: number | null;
  lat: number | null;
  lon: number | null;
  text: string;
};
export type ServerEvent = { type: "message"; message: Message } | { type: "deleted"; id: string };

async function ok(res: Response) {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res;
}

export const api = {
  /** The static demo build (src/demo/api.ts) swaps this module out and sets this to true. */
  demo: false,
  /** Live updates. onOpen fires on every (re)connect so the caller can reload anything it missed. */
  subscribe: (onEvent: (e: ServerEvent) => void, onOpen: () => void) => {
    const es = new EventSource("/api/events");
    es.onopen = onOpen;
    es.onmessage = (ev) => onEvent(JSON.parse(ev.data));
    return () => es.close();
  },
  status: (): Promise<{ ai: boolean }> => fetch("/api/status").then((r) => r.json()),
  list: (): Promise<Message[]> => fetch("/api/messages").then((r) => r.json()),
  send: async (text: string, files: Pending[]): Promise<Message> => {
    const form = new FormData();
    form.append("text", text);
    for (const p of files) form.append("files", p.file);
    form.append("transcripts", JSON.stringify(files.map((p) => p.transcript ?? null)));
    return (await ok(await fetch("/api/messages", { method: "POST", body: form }))).json();
  },
  remove: (id: string) => fetch(`/api/messages/${id}`, { method: "DELETE" }).then(ok),
  reorganize: (id: string) => fetch(`/api/messages/${id}/reorganize`, { method: "POST" }).then(ok),
  templates: {
    list: (): Promise<Template[]> => fetch("/api/templates").then((r) => r.json()),
    create: async (prompt: string): Promise<Template> =>
      (await ok(await fetch("/api/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }) }))).json(),
    update: async (id: string, prompt: string): Promise<Template> =>
      (await ok(await fetch(`/api/templates/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }) }))).json(),
    remove: (id: string) => fetch(`/api/templates/${id}`, { method: "DELETE" }).then(ok),
  },
  patchItem: (id: string, patch: { done?: boolean; category?: string }) =>
    fetch(`/api/items/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then(ok),
  photos: {
    folders: (): Promise<{ folders: { folder: string; count: number }[] }> => fetch("/api/photos").then((r) => r.json()),
    known: (folder: string): Promise<string[]> => fetch(`/api/photos/known?folder=${encodeURIComponent(folder)}`).then((r) => r.json()),
    add: async (meta: PhotoMeta, thumb: Blob) => {
      const form = new FormData();
      form.append("meta", JSON.stringify(meta));
      form.append("thumb", thumb, "thumb.jpg");
      await ok(await fetch("/api/photos", { method: "POST", body: form }));
    },
    removeFolder: (folder: string) => fetch(`/api/photos?folder=${encodeURIComponent(folder)}`, { method: "DELETE" }).then(ok),
    save: (id: string) => fetch(`/api/photos/${id}/save`, { method: "POST" }).then(ok),
  },
};

// Photo library, browser side: folder access and reading each photo (text in it, date, place, a thumbnail).
// Only what's read is sent to the server; the photos themselves stay where they are.
import exifr from "exifr";
import { createWorker, type Worker } from "tesseract.js";
import { api, type PhotoMeta } from "./api.ts";

/** Full: the folder and every folder inside it. Limited: only the photos directly in the chosen folder. */
export type Access = "full" | "limited";
export type Folder = { name: string; access: Access; handle?: FileSystemDirectoryHandle };
export type PhotoFile = { path: string; file: File };

// Chrome and Edge on desktop. Elsewhere a folder can still be read once through <input webkitdirectory>.
export const canPickFolders = typeof (window as any).showDirectoryPicker === "function";

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp)$/i; // most browsers can't decode HEIC

// ---------- Granted folders: IndexedDB keeps the handles so a later visit can rescan without picking again ----------

function folderStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("braindump-photos", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("folders", { keyPath: "name" });
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = run(open.result.transaction("folders", mode).objectStore("folders"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

export const savedFolders = (): Promise<Folder[]> => folderStore<Folder[]>("readonly", (s) => s.getAll()).catch(() => []);
const rememberFolder = (f: Folder) => folderStore("readwrite", (s) => s.put(f)).catch(() => {});
export const forgetFolder = (name: string) => folderStore("readwrite", (s) => s.delete(name)).catch(() => {});

/** Opens the system folder picker. Null if the user cancelled. */
export async function pickFolder(access: Access): Promise<Folder | null> {
  try {
    const handle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({ id: "braindump-photos", mode: "read", startIn: "pictures" });
    const folder: Folder = { name: handle.name, access, handle };
    await rememberFolder(folder);
    return folder;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return null;
    throw err;
  }
}

/** The browser asks again for access on a later visit; `ask` must only be true inside a click handler. */
export async function hasPermission(folder: Folder, ask: boolean): Promise<boolean> {
  const handle = folder.handle as any;
  if (!handle) return false;
  if ((await handle.queryPermission({ mode: "read" })) === "granted") return true;
  return ask && (await handle.requestPermission({ mode: "read" })) === "granted";
}

export async function listPhotoFiles(folder: Folder): Promise<PhotoFile[]> {
  const out: PhotoFile[] = [];
  async function walk(dir: any, prefix: string) {
    for await (const entry of dir.values()) {
      if (entry.kind === "file" && IMAGE_EXT.test(entry.name)) out.push({ path: prefix + entry.name, file: await entry.getFile() });
      else if (entry.kind === "directory" && folder.access === "full" && !entry.name.startsWith(".")) await walk(entry, `${prefix}${entry.name}/`);
    }
  }
  await walk(folder.handle, "");
  return out;
}

/** Files from <input webkitdirectory>, for browsers without the folder picker. These can't be rescanned later. */
export function filesFromInput(files: File[], access: Access): { folder: Folder; files: PhotoFile[] } {
  const rel = (f: File) => ((f as any).webkitRelativePath as string) || f.name;
  const name = rel(files[0]).split("/")[0] || "Photos";
  const photos = files
    .map((file) => ({ path: rel(file).split("/").slice(1).join("/") || file.name, file }))
    .filter((p) => IMAGE_EXT.test(p.path) && (access === "full" || !p.path.includes("/")));
  return { folder: { name, access }, files: photos };
}

// ---------- Reading photos ----------

let worker: Promise<Worker> | null = null;
// Downloads the English text-recognition model (about 10 MB) the first time; the browser caches it.
const ocrWorker = () => (worker ??= createWorker("eng"));

/** Keeps real words from OCR output and drops the specks it "reads" in photos without text. */
export function cleanText(raw: string): string {
  const realWord = (w: string) => {
    const letters = w.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
    return letters >= 2 && letters / w.length >= 0.6;
  };
  return raw
    .split("\n")
    .map((line) => line.split(/\s+/).filter(realWord))
    .filter((ws) => ws.length >= 2 || ws.some((w) => w.length >= 4))
    .map((ws) => ws.join(" "))
    .join("\n");
}

function scaled(bitmap: ImageBitmap, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function readPhoto(folder: string, { path, file }: PhotoFile): Promise<{ meta: PhotoMeta; thumb: Blob }> {
  const bitmap = await createImageBitmap(file);
  const thumb = await new Promise<Blob>((resolve, reject) =>
    scaled(bitmap, 800).toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make a thumbnail"))), "image/jpeg", 0.82),
  );
  const { data } = await (await ocrWorker()).recognize(scaled(bitmap, 2400));
  bitmap.close();
  const exif = await exifr.parse(file, { gps: true, exif: true, tiff: true, xmp: false, icc: false, iptc: false }).catch(() => null);
  const taken: unknown = exif?.DateTimeOriginal ?? exif?.CreateDate;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    meta: {
      folder,
      path,
      size: file.size,
      modified_at: file.lastModified,
      taken_at: taken instanceof Date && !isNaN(taken.getTime()) ? taken.getTime() : null,
      lat: num(exif?.latitude),
      lon: num(exif?.longitude),
      text: cleanText(data.text ?? ""),
    },
    thumb,
  };
}

/** Reads every photo that's new or changed since the last scan and sends it to the library. Returns how many. */
export async function indexPhotos(folder: Folder, files: PhotoFile[], onProgress: (done: number, total: number) => void): Promise<number> {
  const known = new Set(await api.photos.known(folder.name));
  const todo = files.filter((p) => !known.has(`${p.path}|${p.file.size}|${p.file.lastModified}`));
  onProgress(0, todo.length);
  let done = 0;
  for (const p of todo) {
    try {
      const { meta, thumb } = await readPhoto(folder.name, p);
      await api.photos.add(meta, thumb);
    } catch (err) {
      console.warn(`[photos] skipped ${p.path}:`, err); // e.g. a file the browser can't decode
    }
    onProgress(++done, todo.length);
  }
  return todo.length;
}

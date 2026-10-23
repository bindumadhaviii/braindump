import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import {
  canPickFolders,
  filesFromInput,
  forgetFolder,
  hasPermission,
  indexPhotos,
  listPhotoFiles,
  pickFolder,
  savedFolders,
  type Access,
  type Folder,
  type PhotoFile,
} from "../photos.ts";

type LibraryFolder = { name: string; count: number; access: Access | null; local: Folder | null };
export type Scan = { folder: string; done: number; total: number } | null;

/** Granted folders, how many photos each has in the library, and the scan in progress. */
export function usePhotoLibrary() {
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [scan, setScan] = useState<Scan>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    const [{ folders: counts }, local] = await Promise.all([api.photos.folders(), savedFolders()]);
    const names = [...new Set([...local.map((f) => f.name), ...counts.map((c) => c.folder)])].sort();
    setFolders(
      names.map((name) => {
        const l = local.find((f) => f.name === name) ?? null;
        return { name, count: counts.find((c) => c.folder === name)?.count ?? 0, access: l?.access ?? null, local: l };
      }),
    );
  }, []);

  const run = useCallback(
    async (folder: Folder, files: () => Promise<PhotoFile[]>) => {
      if (busy.current) return;
      busy.current = true;
      setError(null);
      setScan({ folder: folder.name, done: 0, total: 0 });
      try {
        await indexPhotos(folder, await files(), (done, total) => setScan({ folder: folder.name, done, total }));
      } catch (err) {
        console.error(err);
        setError(`Couldn't read the photos in “${folder.name}”.`);
      } finally {
        busy.current = false;
        setScan(null);
        refresh();
      }
    },
    [refresh],
  );

  // Pick up new photos in folders the browser still has access to, without asking.
  useEffect(() => {
    if (api.demo) return;
    refresh().then(async () => {
      for (const f of await savedFolders()) if (await hasPermission(f, false)) await run(f, () => listPhotoFiles(f));
    });
  }, [refresh, run]);

  return {
    folders,
    scan,
    error,
    async add(access: Access) {
      try {
        const folder = await pickFolder(access);
        if (folder) await run(folder, () => listPhotoFiles(folder));
      } catch (err) {
        console.error(err);
        setError("Couldn't open that folder.");
      }
    },
    async addFromInput(files: File[], access: Access) {
      if (!files.length) return;
      const { folder, files: photos } = filesFromInput(files, access);
      await run(folder, async () => photos);
    },
    async rescan(f: LibraryFolder) {
      if (!f.local) return;
      if (await hasPermission(f.local, true)) await run(f.local, () => listPhotoFiles(f.local!));
      else setError(`BrainDump no longer has access to “${f.name}”. Choose it again to give access.`);
    },
    async remove(f: LibraryFolder) {
      await forgetFolder(f.name);
      await api.photos.removeFolder(f.name);
      refresh();
    },
  };
}

export type PhotoLibrary = ReturnType<typeof usePhotoLibrary>;

const ACCESS = {
  full: { label: "Full access", hint: "Choose your Pictures folder. BrainDump reads it and every folder inside it." },
  limited: { label: "Limited access", hint: "Choose only the folders you want, like Screenshots. Folders inside them are left out." },
} as const;

export function PhotoAccessDialog({ library, onClose }: { library: PhotoLibrary; onClose: () => void }) {
  const { folders, scan, error } = library;
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputAccess, setInputAccess] = useState<Access>("limited");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const choose = (access: Access) => {
    if (canPickFolders) return library.add(access);
    setInputAccess(access);
    inputRef.current?.click();
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="photo-dialog-title">
        <h2 id="photo-dialog-title">Photo access</h2>
        <p className="dialog-lede">
          Let BrainDump look through your photos, so later you can ask “find the screenshot of that leg day workout” and get it back. The text,
          date and place in each photo are read on this computer; your photos stay in their folders.
        </p>

        <div className="access-options">
          {(["full", "limited"] as const).map((a) => (
            <div key={a} className="access-option">
              <div>
                <strong>{ACCESS[a].label}</strong>
                <p>{ACCESS[a].hint}</p>
              </div>
              <button type="button" className="btn" onClick={() => choose(a)} disabled={!!scan}>
                Choose folder…
              </button>
            </div>
          ))}
        </div>
        <input
          ref={inputRef}
          type="file"
          hidden
          multiple
          {...{ webkitdirectory: "" }}
          onChange={(e) => {
            library.addFromInput([...(e.target.files ?? [])], inputAccess);
            e.target.value = "";
          }}
        />
        {!canPickFolders && (
          <p className="dialog-mode">This browser can read a folder only once. Open BrainDump in Chrome or Edge to keep folders up to date.</p>
        )}

        {scan && (
          <div className="scan">
            <div className="scan-label">
              {scan.total === 0 ? `Looking in “${scan.folder}”…` : `Reading photos in “${scan.folder}”: ${scan.done} of ${scan.total}`}
            </div>
            <div className="scan-bar">
              <span style={{ width: scan.total ? `${(scan.done / scan.total) * 100}%` : "0%" }} />
            </div>
            <p className="dialog-mode">The first scan downloads a 10 MB text-reading model. You can close this window; reading continues.</p>
          </div>
        )}

        {folders.length > 0 && (
          <ul className="access-folders">
            {folders.map((f) => (
              <li key={f.name}>
                <span className="access-folder-name">📁 {f.name}</span>
                <span className="access-folder-meta">
                  {f.access ? ACCESS[f.access].label : "Read once"} · {f.count} {f.count === 1 ? "photo" : "photos"}
                </span>
                {f.local?.handle && (
                  <button type="button" className="link-btn" onClick={() => library.rescan(f)} disabled={!!scan}>
                    Rescan
                  </button>
                )}
                <button type="button" className="link-btn danger" onClick={() => library.remove(f)} disabled={!!scan}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="dialog-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

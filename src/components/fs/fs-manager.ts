export type MountStatus =
  | { state: "idle"; message: string }
  | { state: "working"; message: string }
  | { state: "done"; message: string }
  | { state: "error"; message: string };

type StoredHandle = FileSystemHandle;

type IdRecord = {
  id: string;
  handles?: StoredHandle[];
  manifest?: Record<string, TarEntryMeta>;
};

type PermissionState = "granted" | "denied" | "prompt";
type FileSystemPermissionMode = "read" | "readwrite";
type QueryableFileSystemHandle = FileSystemHandle & {
  queryPermission?: (options: { mode: FileSystemPermissionMode }) => Promise<PermissionState>;
  requestPermission?: (options: { mode: FileSystemPermissionMode }) => Promise<PermissionState>;
};

const DB_NAME = "stare-fs";
const STORE = "handles";
const KEY = "mounts";
const TAR_KEY = "tar-manifest";

type TarEntryMeta = {
  size: number;
  mtime: number;
};

const openDb = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const withStore = async <T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>,
): Promise<T> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    fn(store)
      .then((result) => {
        tx.oncomplete = () => resolve(result);
      })
      .catch((err) => {
        tx.abort();
        reject(err);
      });
  });
};

export const saveHandles = async (handles: StoredHandle[]) => {
  await withStore("readwrite", (store) => {
    return new Promise<void>((resolve, reject) => {
      const record: IdRecord = { id: KEY, handles };
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });
};

export const loadHandles = async (): Promise<StoredHandle[]> => {
  return withStore("readonly", (store) => {
    return new Promise<StoredHandle[]>((resolve, reject) => {
      const req = store.get(KEY);
      req.onsuccess = () => {
        const result = req.result as IdRecord | undefined;
        resolve(result?.handles ?? []);
      };
      req.onerror = () => reject(req.error);
    });
  });
};

const loadTarManifest = async (): Promise<Record<string, TarEntryMeta>> => {
  return withStore("readonly", (store) => {
    return new Promise<Record<string, TarEntryMeta>>((resolve, reject) => {
      const req = store.get(TAR_KEY);
      req.onsuccess = () => {
        const result = req.result as IdRecord | undefined;
        resolve(result?.manifest ?? {});
      };
      req.onerror = () => reject(req.error);
    });
  });
};

const saveTarManifest = async (manifest: Record<string, TarEntryMeta>) => {
  await withStore("readwrite", (store) => {
    return new Promise<void>((resolve, reject) => {
      const record: IdRecord = { id: TAR_KEY, manifest };
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });
};

export const isFsAccessSupported = () =>
  typeof window !== "undefined" && "showDirectoryPicker" in window;

const requestPermission = async (
  handle: QueryableFileSystemHandle,
  mode: FileSystemPermissionMode,
) => {
  if (!handle.queryPermission) return "granted";
  const query = await handle.queryPermission({ mode });
  if (query === "granted") return query;
  if (!handle.requestPermission) return query;
  return handle.requestPermission({ mode });
};

const ensurePermission = async (handle: FileSystemHandle) => {
  const mode: FileSystemPermissionMode = "read";
  const result = await requestPermission(handle as QueryableFileSystemHandle, mode);
  if (result !== "granted") {
    throw new Error("Permission denied");
  }
};

export const getOpfsRoot = async () => {
  const storage = await navigator.storage.getDirectory();
  return storage.getDirectoryHandle("stare-mounts", { create: true });
};

const sanitizeName = (name: string) =>
  name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64) || "mount";

const copyFile = async (
  fileHandle: FileSystemFileHandle,
  destDir: FileSystemDirectoryHandle,
) => {
  const file = await fileHandle.getFile();
  const destHandle = await destDir.getFileHandle(sanitizeName(file.name), {
    create: true,
  });
  const writable = await destHandle.createWritable();
  await writable.write(await file.arrayBuffer());
  await writable.close();
};

const getDirectoryValues = (dir: FileSystemDirectoryHandle) =>
  (dir as FileSystemDirectoryHandle & {
    values: () => AsyncIterable<FileSystemHandle>;
  }).values();

const copyDirectory = async (
  dirHandle: FileSystemDirectoryHandle,
  destDir: FileSystemDirectoryHandle,
) => {
  for await (const handle of getDirectoryValues(dirHandle)) {
    const name = handle.name ?? "";
    const safeName = sanitizeName(name);
    if (handle.kind === "file") {
      const fileHandle = handle as FileSystemFileHandle;
      const targetFile = await destDir.getFileHandle(safeName, { create: true });
      const file = await fileHandle.getFile();
      const writable = await targetFile.createWritable();
      await writable.write(await file.arrayBuffer());
      await writable.close();
    } else {
      const childDir = await destDir.getDirectoryHandle(safeName, {
        create: true,
      });
      await copyDirectory(handle as FileSystemDirectoryHandle, childDir);
    }
  }
};

export const mountHandlesToOpfs = async (
  handles: FileSystemHandle[],
  onStatus: (status: MountStatus) => void,
) => {
  if (!handles.length) return;
  const root = await getOpfsRoot();

  for (const handle of handles) {
    onStatus({
      state: "working",
      message: `Mounting ${handle.name || "selection"}...`,
    });

    await ensurePermission(handle);
    const mountDir = await root.getDirectoryHandle(
      sanitizeName(handle.name || "mount"),
      { create: true },
    );

    if (handle.kind === "file") {
      await copyFile(handle as FileSystemFileHandle, mountDir);
    } else {
      await copyDirectory(handle as FileSystemDirectoryHandle, mountDir);
    }
  }

  onStatus({ state: "done", message: "Mounted to OPFS." });
};

export const handlesFromDragEvent = async (event: DragEvent) => {
  const items = Array.from(event.dataTransfer?.items ?? []);
  const handles: FileSystemHandle[] = [];
  for (const item of items) {
    if ("getAsFileSystemHandle" in item) {
      const handle = await (item as any).getAsFileSystemHandle();
      if (handle) handles.push(handle);
    }
  }
  if (handles.length) return handles;

  const files = Array.from(event.dataTransfer?.files ?? []);
  return files.map((file) => ({
    kind: "file",
    name: file.name,
    getFile: async () => file,
  })) as unknown as FileSystemHandle[];
};

export const listOpfsMounts = async (): Promise<string[]> => {
  const root = await getOpfsRoot();
  const names: string[] = [];
  for await (const handle of getDirectoryValues(root)) {
    const name = handle.name ?? "";
    if (handle.kind === "directory") {
      names.push(name);
    }
  }
  return names.sort((a, b) => a.localeCompare(b));
};

type TarEntry = {
  path: string;
  size: number;
  mtime: number;
  type: "file" | "dir";
  dataOffset: number;
};

const readString = (buf: Uint8Array, start: number, length: number) => {
  const slice = buf.subarray(start, start + length);
  let end = 0;
  while (end < slice.length && slice[end] !== 0) end += 1;
  return new TextDecoder().decode(slice.subarray(0, end));
};

const readOctal = (buf: Uint8Array, start: number, length: number) => {
  const str = readString(buf, start, length).trim();
  if (!str) return 0;
  return parseInt(str, 8);
};

const parseTar = (buffer: ArrayBuffer): TarEntry[] => {
  const entries: TarEntry[] = [];
  const u8 = new Uint8Array(buffer);
  let offset = 0;
  while (offset + 512 <= u8.length) {
    const header = u8.subarray(offset, offset + 512);
    const isEmpty = header.every((b) => b === 0);
    if (isEmpty) break;

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = readOctal(header, 124, 12);
    const mtime = readOctal(header, 136, 12);
    const typeflag = header[156];
    const type = typeflag === 53 ? "dir" : "file"; // '5' == dir
    const dataOffset = offset + 512;
    entries.push({ path: fullName, size, mtime, type, dataOffset });

    const blocks = Math.ceil(size / 512);
    offset = dataOffset + blocks * 512;
  }
  return entries;
};

const ensureDir = async (
  root: FileSystemDirectoryHandle,
  parts: string[],
) => {
  let dir = root;
  for (const part of parts) {
    if (!part) continue;
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
};

export const applyGuestTarToOpfs = async (
  buffer: ArrayBuffer,
  options: { incremental?: boolean } = {},
) => {
  const entries = parseTar(buffer);
  const root = await getOpfsRoot();
  const manifest = await loadTarManifest();
  const prefix = "mnt/host/";
  let written = 0;
  let skipped = 0;
  let files = 0;
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const relPath = entry.path.slice(prefix.length);
    if (!relPath) continue;

    if (entry.type === "dir") {
      await ensureDir(root, relPath.split("/"));
      continue;
    }

    files += 1;
    seen.add(relPath);
    const metaKey = relPath;
    const prev = manifest[metaKey];
    if (
      options.incremental &&
      prev &&
      prev.size === entry.size &&
      prev.mtime === entry.mtime
    ) {
      skipped += 1;
      continue;
    }

    const parts = relPath.split("/");
    const fileName = parts.pop() as string;
    const dir = await ensureDir(root, parts);
    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    const data = new Uint8Array(buffer, entry.dataOffset, entry.size);
    await writable.write(data);
    await writable.close();

    manifest[metaKey] = { size: entry.size, mtime: entry.mtime };
    written += 1;
  }

  const pruneMissing = async (dir: FileSystemDirectoryHandle, base = "") => {
    for await (const handle of getDirectoryValues(dir)) {
      const name = handle.name ?? "";
      const rel = base ? `${base}/${name}` : name;
      if (handle.kind === "directory") {
        const child = handle as FileSystemDirectoryHandle;
        await pruneMissing(child, rel);
        const childIterator = getDirectoryValues(child)[Symbol.asyncIterator]();
        const nextEntry = await childIterator.next();
        const hasEntries = !nextEntry.done;
        if (!hasEntries) {
          await dir.removeEntry(name);
        }
      } else if (!seen.has(rel)) {
        await dir.removeEntry(name);
        delete manifest[rel];
      }
    }
  };

  if (seen.size > 0) {
    await pruneMissing(root);
  }

  await saveTarManifest(manifest);
  return { written, skipped, files };
};

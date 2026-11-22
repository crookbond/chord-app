/**
 * The files Chord's viewer (`mobile/app/file-viewer.tsx`) may show.
 *
 * The viewer is a route, so it can be opened by a link from outside
 * (`chord://file-viewer?...`, `https://chordapp.ai/file-viewer?...`). It must
 * never take the file from the link: a crafted address would frame any site,
 * read any local file, or have the viewer delete files on close. So a caller
 * that has just downloaded or fetched a file registers it here and pushes
 * only the opaque id; the viewer looks the id up. An id it does not know
 * (a reload, a link) shows nothing.
 *
 * The registry lives in memory, so it is gone on reload by design.
 */

export interface ViewerFile {
  /** A `blob:` URL on web, a file in the app's cache on a phone. */
  uri: string;
  name: string;
  mime: string;
  /** The viewer created nothing else for this file: true when the viewer
   *  may delete (phone) or revoke (web) it when it closes. */
  owned: boolean;
}

export interface ViewerFileRegistry {
  register(file: ViewerFile): string;
  get(id: string | undefined | null): ViewerFile | null;
  /** Forget the file; returns it so the caller can delete or revoke it. */
  release(id: string | undefined | null): ViewerFile | null;
  size(): number;
}

/** Ids look like `vf<counter>-<random>`; anything else is rejected outright. */
const ID_SHAPE = /^vf\d+-[a-z0-9]+$/;

export function createViewerFileRegistry(opts: { random?: () => string; max?: number } = {}): ViewerFileRegistry {
  const random = opts.random ?? (() => Math.random().toString(36).slice(2, 12));
  const max = opts.max ?? 20;
  const files = new Map<string, ViewerFile>();
  let counter = 0;
  return {
    register(file) {
      counter += 1;
      const id = `vf${counter}-${random().toLowerCase().replace(/[^a-z0-9]/g, '') || 'x'}`;
      files.set(id, { ...file });
      // Never grows without bound if views are opened and never closed.
      while (files.size > max) {
        const oldest = files.keys().next().value as string;
        files.delete(oldest);
      }
      return id;
    },
    get(id) {
      if (!id || !ID_SHAPE.test(id)) return null;
      return files.get(id) ?? null;
    },
    release(id) {
      if (!id || !ID_SHAPE.test(id)) return null;
      const file = files.get(id) ?? null;
      files.delete(id);
      return file;
    },
    size: () => files.size,
  };
}

/** Folders under the cache the viewer never deletes from, whatever it is
 *  told: the sealed mail store (ADR 0302) lives there. */
const PROTECTED_CACHE_DIRS = ['email-store/'];

/**
 * May the viewer delete `uri` when it closes? Only a plain file directly in
 * the app's cache folder, with no `..` (raw or encoded) and not inside a
 * protected folder. A registered file is the only kind ever asked about;
 * this is the second check, so a mistake in a caller cannot wipe the store.
 */
export function isDeletableViewerFile(uri: string, cacheDir: string | null | undefined): boolean {
  if (!uri || !cacheDir) return false;
  if (!uri.startsWith(cacheDir)) return false;
  const rest = uri.slice(cacheDir.length);
  if (!rest) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return false;
  }
  for (const part of [rest, decoded]) {
    if (part.includes('\\') || part.includes('\0')) return false;
    if (part.split('/').some((seg) => seg === '..' || seg === '.')) return false;
    if (part.startsWith('/')) return false;
    if (PROTECTED_CACHE_DIRS.some((d) => part.startsWith(d) || part === d.slice(0, -1))) return false;
  }
  // Directly in the cache folder: a sub-folder is somebody else's.
  return !decoded.includes('/');
}

// Export and import of notes as a zip, shared by Settings and All notes: the
// read order and the write order exist once. It returns results and rejects
// with errors; logging and messages are the page's.

import { zipSync, type Zippable } from 'fflate';
import { Inflate } from 'pako/lib/inflate.js';
import {
  DEFAULT_TITLE, MAX_IMAGE_BYTES, MAX_IMPORT_BYTES, MAX_NOTE_BYTES, bytesDataUrl, dataUrlBytes, exportLinks,
  fileNames, idFromStorageKey, imageExt, imageKey, importedNote, mdNote, noteFile, noteIdFromUrl, notesFromStorage,
  parseNoteFile, planImport, referencedImages, storageKey, storedImageIds, titleVars, zipEntries, zipFits, zipPath,
  type ExportResult, type ImageValue, type ImportedNote, type ImportResult, type Note, type Settings, type ZipEntry,
} from './lib/notes.ts';

// exportZip builds a zip of the notes with these ids, or of all notes for
// null, and the images they reference. Any failed read rejects: a partial
// backup must not look complete.
export async function exportZip(ids: string[] | null): Promise<ExportResult> {
  const keys = await browser.storage.local.getKeys().catch((err: unknown) => {
    throw new Error('list keys', { cause: err });
  });
  const wanted = ids === null ? null : new Set(ids);
  const noteKeys = keys.filter((key) => {
    const id = idFromStorageKey(key);
    return id !== null && (wanted === null || wanted.has(id));
  });
  const stored: Record<string, unknown> = await browser.storage.local.get([...noteKeys, 'settings']).catch((err: unknown) => {
    throw new Error('read notes', { cause: err });
  });
  const notes: Record<string, Note> = notesFromStorage(stored);
  const defaultTitle = (stored.settings as Settings | undefined)?.defaultTitle || DEFAULT_TITLE;

  const storedImages = storedImageIds(keys);
  const referenced = referencedImages(Object.values(notes));
  const files: Record<string, Uint8Array> = {};
  const exts: Record<string, string> = {};
  const broken: string[] = [];
  // one image value at a time, so only one data URL is in memory besides the
  // decoded images; the zip and its Blob copy those again, so the peak is
  // about three times the image bytes
  for (const id of [...referenced].filter((id) => storedImages.has(id)).sort()) {
    const got: Record<string, ImageValue | undefined> = await browser.storage.local.get([imageKey(id)]).catch((err: unknown) => {
      throw new Error(`read image ${id}`, { cause: err });
    });
    const value = got[imageKey(id)];
    // removed since the key list: left out like any missing image
    if (value === undefined) continue;
    const decoded = typeof value.dataUrl === 'string' ? dataUrlBytes(value.dataUrl) : null;
    const ext = decoded === null ? null : imageExt(decoded.mime);
    if (decoded === null || ext === null) {
      broken.push(id);
      continue;
    }
    exts[id] = ext;
    files[`images/${id}.${ext}`] = decoded.bytes;
  }

  const utf8 = new TextEncoder();
  const names = fileNames(notes, defaultTitle);
  for (const [id, note] of Object.entries(notes)) {
    files[names[id]] = utf8.encode(noteFile(id, note, exportLinks(note.content, exts)));
  }
  const paths = Object.keys(files).sort();
  if (!zipFits(paths.map((path) => ({ name: path, size: files[path].length })))) {
    throw new Error('over the zip limit of 4 GB or 65,535 files');
  }
  const zippable: Zippable = {};
  for (const path of paths) zippable[path] = files[path];
  // level 0, as images are already compressed; a fixed entry time from local
  // fields, as fflate reads it with local getters, so the same notes give the
  // same bytes
  const zip = zipSync(zippable, { level: 0, mtime: new Date(1980, 0, 1) });

  const name = `tabnotes-${titleVars(new Date(), null).date}.zip`;
  return { blob: new Blob([zip], { type: 'application/zip' }), name, notes: Object.keys(notes).length, broken };
}

// saveBlob downloads blob as name through <a download>, which needs no
// downloads permission. The URL is revoked a minute later, as Firefox can fail
// a download whose URL is revoked in the same task.
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// importFiles imports tabnotes zips and markdown files. It never overwrites a
// stored note and skips notes whose content is already stored. Entries are
// sized from the central directory first and inflated one at a time, so a
// corrupt entry costs only itself and memory and time stay within declared
// sizes.
// Images land before the notes, which go in one set, so open pages see one
// change. A failed read rejects, also the one between the images and the
// notes, whose images the sweep collects; a failed write stops the import and
// the result says what got in.
export async function importFiles(files: File[]): Promise<ImportResult> {
  const now = Date.now();
  const newId = () => crypto.randomUUID();
  const rejected: Record<string, number> = {};
  const reject = (reason: string, n = 1) => {
    rejected[reason] = (rejected[reason] ?? 0) + n;
  };
  const incoming: ImportedNote[] = [];
  // admitted image entries by id, inflated only once a note references them
  const images = new Map<string, { entry: ZipEntry; mime: string }>();
  const decoder = new TextDecoder();

  const addNote = (name: string, bytes: Uint8Array) => {
    const parsed = parseNoteFile(bytes);
    if (parsed === null) {
      reject('bad note file');
      return;
    }
    if (parsed !== 'plain') {
      incoming.push({ id: parsed.id, note: importedNote(parsed.note, now) });
      return;
    }
    const note = mdNote(name, decoder.decode(bytes), now);
    if (note === null) {
      reject('empty file');
      return;
    }
    incoming.push({ id: newId(), note });
  };
  // inflate returns the bytes of entry, or null unless they come out at
  // exactly its declared size. Deflate output stops once it passes that
  // size: inflating into a buffer of it would decode the whole stream and
  // drop the rest, which costs CPU in proportion to the real output and
  // imports it truncated.
  const inflate = ({ compression, data, originalSize }: ZipEntry): Uint8Array | null => {
    if (data === null) return null;
    if (compression === 0) return data.length === originalSize ? data : null;
    if (compression !== 8) return null;
    // zlib's deflateBound for any settings, plus slack: past it the stream
    // holds input that produces nothing, such as empty stored blocks, which
    // would cost time no declared size accounts for
    if (data.length > originalSize + Math.ceil(originalSize / 8) + Math.ceil(originalSize / 64) + 64) return null;
    const out = new Uint8Array(originalSize);
    let length = 0;
    let ended = false;
    // pako hands over each output chunk as soon as it is full, within one
    // push of the whole input, so the throw stops it at most one chunk past
    // the declared size. fflate's Inflate checks only after a whole push and
    // copies its 32 KB window on each, so pushes small enough to bound the
    // overrun made incompressible entries 30 to 100 times slower.
    const stream = new Inflate({ raw: true, chunkSize: Math.min(0x10000, originalSize + 1) });
    stream.onData = (chunk: Uint8Array) => {
      if (length + chunk.length > out.length) throw new Error('longer than declared');
      out.set(chunk, length);
      length += chunk.length;
    };
    stream.onEnd = (status) => {
      ended = status === 0;
    };
    try {
      // no Z_FINISH: under it zlib reports a full output buffer as
      // Z_BUF_ERROR, and pako then returns once the input is used up, with
      // output still pending
      stream.push(data, false);
    } catch {
      return null;
    }
    return data.length > 0 && ended && length === out.length ? out : null;
  };

  for (const file of files) {
    const isNote = /\.md$/i.test(file.name);
    if (!isNote && !/\.zip$/i.test(file.name)) {
      reject('unsupported file');
      continue;
    }
    if (file.size > (isNote ? MAX_NOTE_BYTES : MAX_IMPORT_BYTES)) {
      reject('too large');
      continue;
    }
    const bytes = new Uint8Array(await file.arrayBuffer().catch((err: unknown) => {
      throw new Error(`read file ${file.name}`, { cause: err });
    }));
    if (isNote) {
      addNote(file.name, bytes);
      continue;
    }

    const entries = zipEntries(bytes);
    if (typeof entries === 'string') {
      reject(entries);
      continue;
    }
    const notes: ZipEntry[] = [];
    let total = 0;
    let over = false;
    for (const entry of entries) {
      if (over) {
        reject('over the import limit');
        continue;
      }
      const path = zipPath(entry.name);
      if (path.kind === 'skip') continue;
      // no check for repeated names: a note is identified by its front
      // matter id and an image by its file name, and a tool writing names in
      // a code page can give two notes one name
      if (path.kind === 'unsupported') {
        reject('unsupported file');
        continue;
      }
      const max = path.kind === 'note' ? MAX_NOTE_BYTES : MAX_IMAGE_BYTES;
      if (entry.size > max || entry.originalSize > max) {
        reject('too large');
        continue;
      }
      if (total + entry.originalSize > MAX_IMPORT_BYTES) {
        over = true;
        reject('over the import limit');
        continue;
      }
      total += entry.originalSize;
      if (path.kind === 'note') notes.push({ ...entry, name: path.name });
      else if (images.has(path.id)) reject('duplicate image');
      else images.set(path.id, { entry, mime: path.mime });
    }
    // path order, so the first of several notes with one id is predictable;
    // the sort is stable, so entries of one name keep the directory order
    notes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of notes) {
      const text = inflate(entry);
      if (text === null) reject('bad note file');
      else addNote(entry.name, text);
    }
  }

  const keys = await browser.storage.local.getKeys().catch((err: unknown) => {
    throw new Error('list keys', { cause: err });
  });
  const stored = notesFromStorage(await browser.storage.local.get(keys.filter((key) => idFromStorageKey(key) !== null))
    .catch((err: unknown) => {
      throw new Error('read notes', { cause: err });
    }));
  const tabs = await browser.tabs.query({}).catch((err: unknown) => {
    throw new Error('list tabs', { cause: err });
  });
  const noteBase = browser.runtime.getURL('note/note.html');
  const contents = new Set(Object.values(stored).map((note) => note.content));
  const taken = new Set([
    ...Object.keys(stored),
    ...tabs.map((tab) => noteIdFromUrl(tab.url, noteBase)).filter((id) => id !== null),
  ]);
  const plan = planImport(incoming, { contents, taken }, newId);
  if (plan.duplicates > 0) reject('duplicate id', plan.duplicates);
  const result: ImportResult = { imported: 0, images: 0, identical: plan.identical.length, copies: 0, rejected };

  // images of notes skipped as identical count too, so a backup restores an
  // image lost locally
  const kept = [...Object.values(plan.write), ...plan.identical];
  const wanted = referencedImages(kept);
  const storedImages = storedImageIds(keys);
  for (const [id, image] of images) {
    if (!wanted.has(id)) {
      reject('unreferenced image');
      continue;
    }
    // a stored image keeps its local bytes
    if (storedImages.has(id)) continue;
    const bytes = inflate(image.entry);
    if (bytes === null) {
      reject('bad image');
      continue;
    }
    try {
      await browser.storage.local.set({ [imageKey(id)]: { dataUrl: bytesDataUrl(image.mime, bytes) } satisfies ImageValue });
    } catch (err) {
      return { ...result, stopped: err };
    }
    result.images++;
  }

  if (Object.keys(plan.write).length === 0) return result;
  // a note stored since the first read, by a tab or an import from another
  // page, is not overwritten either, and its content counts as present
  const latest = await browser.storage.local.getKeys().catch((err: unknown) => {
    throw new Error('list keys before writing notes', { cause: err });
  });
  const known = new Set(keys);
  const added = notesFromStorage(await browser.storage.local.get(latest.filter((key) => idFromStorageKey(key) !== null && !known.has(key)))
    .catch((err: unknown) => {
      throw new Error('read notes before writing notes', { cause: err });
    }));
  const replan = planImport(
    Object.entries(plan.write).map(([id, note]) => ({ id, note })),
    { contents: new Set(Object.values(added).map((note) => note.content)), taken: new Set([...taken, ...Object.keys(added)]) },
    newId,
  );
  result.identical += replan.identical.length;
  const write = Object.keys(replan.write);
  if (write.length === 0) return result;
  try {
    await browser.storage.local.set(Object.fromEntries(write.map((id) => [storageKey(id), replan.write[id]])));
  } catch (err) {
    return { ...result, stopped: err };
  }
  // a copy has an id from newId, in either plan; an incoming id is no copy
  const ids = new Set(incoming.map(({ id }) => id));
  return { ...result, imported: write.length, copies: write.filter((id) => !ids.has(id)).length };
}

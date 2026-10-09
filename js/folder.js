/* Optional Markdown folder backup using the File System Access API. */
(function (root) {
  'use strict';

  const DB_NAME = 'logbook.folder';
  const DB_STORE = 'handles';
  const DB_KEY = 'directory';
  let directory = null;
  let indexCache = null;
  const fileCache = new Map();

  function supported() {
    return !!(root.showDirectoryPicker && root.indexedDB);
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      const request = root.indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = function () { request.result.createObjectStore(DB_STORE); };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('Could not open folder settings.')); };
    });
  }

  async function saveHandle(handle) {
    const db = await openDb();
    try {
      await new Promise(function (resolve, reject) {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(handle, DB_KEY);
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error || new Error('Could not remember the folder.')); };
        tx.onabort = function () { reject(tx.error || new Error('Could not remember the folder.')); };
      });
    } finally {
      db.close();
    }
  }

  async function restore() {
    const db = await openDb();
    try {
      directory = await new Promise(function (resolve, reject) {
        const request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(DB_KEY);
        request.onsuccess = function () { resolve(request.result || null); };
        request.onerror = function () { reject(request.error || new Error('Could not read the saved folder.')); };
      });
      indexCache = null;
      fileCache.clear();
      return !!directory;
    } finally {
      db.close();
    }
  }

  async function ensurePermission(handle) {
    const permission = await handle.queryPermission({ mode: 'readwrite' });
    if (permission === 'granted') return true;
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
  }

  async function choose() {
    if (!supported()) throw new Error('Folder sync needs a recent version of Chrome or Edge.');
    const handle = await root.showDirectoryPicker({ mode: 'readwrite' });
    if (!(await ensurePermission(handle))) throw new Error('Folder access was not granted.');
    directory = handle;
    indexCache = null;
    fileCache.clear();
    await saveHandle(handle);
    return handle;
  }

  async function readText(dir, name) {
    const handle = await dir.getFileHandle(name);
    return handle.getFile().then(function (file) { return file.text(); });
  }

  async function writeText(dir, name, text) {
    const handle = await dir.getFileHandle(name, { create: true });
    const writer = await handle.createWritable();
    try {
      await writer.write(text);
      await writer.close();
    } catch (err) {
      try { await writer.abort(); } catch (abortError) { /* preserve the original write error */ }
      throw err;
    }
  }

  function fileName(id) { return encodeURIComponent(id) + '.md'; }

  function versionedFileName(note, revision) {
    const slug = note.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'note';
    const id = encodeURIComponent(note.id).slice(-16);
    return slug + '-' + id + '-' + revision + '.md';
  }

  function validFileName(name) {
    return typeof name === 'string' && /^[A-Za-z0-9_%.-]+\.md$/.test(name) && name.indexOf('..') === -1;
  }

  function noteFile(note) {
    const metadata = Object.assign({}, note, { body: undefined });
    return 'LOGBOOK-NOTE-1\n' + JSON.stringify(metadata) + '\n---\n' + (note.body || '');
  }

  function parseNoteFile(text) {
    const lines = text.split('\n');
    if (lines[0] !== 'LOGBOOK-NOTE-1' || lines[2] !== '---') {
      throw new Error('A Markdown file in the folder has invalid Logbook metadata.');
    }
    const note = JSON.parse(lines[1]);
    note.body = note.locked ? '' : lines.slice(3).join('\n');
    return note;
  }

  async function readIndex(dir) {
    try {
      const data = JSON.parse(await readText(dir, '.logbook.json'));
      if (!data || (data.format !== 1 && data.format !== 2) ||
          !Array.isArray(data.notes) || !Array.isArray(data.trash)) return null;
      return data;
    } catch (err) {
      if (err && err.name === 'NotFoundError') return null;
      if (err instanceof SyntaxError) throw new Error('The selected folder has a damaged .logbook.json index.');
      throw err;
    }
  }

  async function readBackup(onlyIfGranted) {
    if (!directory) throw new Error('Choose a folder first.');
    if (onlyIfGranted) {
      if (await directory.queryPermission({ mode: 'readwrite' }) !== 'granted') return null;
    } else if (!(await ensurePermission(directory))) {
      throw new Error('Folder access was not granted.');
    }
    const index = await readIndex(directory);
    if (!index) return null;
    const notesDir = await directory.getDirectoryHandle('Notes');
    const trashDir = await directory.getDirectoryHandle('Trash');
    const notes = {};
    const trash = [];
    for (const id of index.notes) {
      const path = index.files && index.files[id] || fileName(id);
      if (!validFileName(path)) throw new Error('The folder index contains an invalid note filename.');
      notes[id] = parseNoteFile(await readText(notesDir, path));
    }
    for (const id of index.trash) {
      const path = index.trashFiles && index.trashFiles[id] || fileName(id);
      if (!validFileName(path)) throw new Error('The folder index contains an invalid Trash filename.');
      const item = parseNoteFile(await readText(trashDir, path));
      trash.push({ note: item, deletedAt: item.deletedAt });
    }
    const metadata = index.metadata || {};
    return {
      app: 'logbook',
      version: 1,
      notes: notes,
      trash: trash,
      vault: metadata.vault || null,
      lastOpen: metadata.lastOpen || null,
      hideSealedTitles: metadata.hideSealedTitles === true,
      savedAt: Number(metadata.savedAt) || 0
    };
  }

  async function cleanDirectory(dir, referenced) {
    const current = new Set(referenced);
    for await (const entry of dir.entries()) {
      const name = entry[0];
      if (!name.endsWith('.md') || current.has(name)) continue;
      await dir.removeEntry(name);
    }
  }

  async function cachedText(dir, prefix, path) {
    const key = prefix + path;
    if (fileCache.has(key)) {
      try {
        await dir.getFileHandle(path);
        return fileCache.get(key);
      } catch (err) {
        if (!err || err.name !== 'NotFoundError') throw err;
        fileCache.delete(key);
      }
    }
    try {
      const text = await readText(dir, path);
      fileCache.set(key, text);
      return text;
    } catch (err) {
      if (!err || err.name !== 'NotFoundError') throw err;
      return null;
    }
  }

  function pruneCache(prefix, referenced) {
    const current = new Set(referenced.map(function (path) { return prefix + path; }));
    for (const key of fileCache.keys()) {
      if (key.indexOf(prefix) === 0 && !current.has(key)) fileCache.delete(key);
    }
  }

  async function sync(notes, trash, metadata) {
    if (!directory) return false;
    if (!(await ensurePermission(directory))) throw new Error('Folder access was not granted.');
    const notesDir = await directory.getDirectoryHandle('Notes', { create: true });
    const trashDir = await directory.getDirectoryHandle('Trash', { create: true });
    const prior = indexCache || await readIndex(directory);
    const noteIds = notes.map(function (note) { return note.id; });
    const trashIds = trash.map(function (entry) { return entry.note.id; });
    const revision = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const files = {};
    const trashFiles = {};

    for (const note of notes) {
      const text = noteFile(note);
      const oldPath = prior && prior.files && prior.files[note.id] || (prior && prior.format === 1 ? fileName(note.id) : null);
      const oldText = oldPath && validFileName(oldPath) ? await cachedText(notesDir, 'Notes/', oldPath) : null;
      files[note.id] = oldText === text ? oldPath : versionedFileName(note, revision);
      if (oldText !== text) await writeText(notesDir, files[note.id], text);
      fileCache.set('Notes/' + files[note.id], text);
    }
    for (const entry of trash) {
      const text = noteFile(Object.assign({}, entry.note, { deletedAt: entry.deletedAt }));
      const id = entry.note.id;
      const oldPath = prior && prior.trashFiles && prior.trashFiles[id] || (prior && prior.format === 1 ? fileName(id) : null);
      const oldText = oldPath && validFileName(oldPath) ? await cachedText(trashDir, 'Trash/', oldPath) : null;
      trashFiles[id] = oldText === text ? oldPath : versionedFileName(entry.note, revision);
      if (oldText !== text) await writeText(trashDir, trashFiles[id], text);
      fileCache.set('Trash/' + trashFiles[id], text);
    }

    const next = {
      format: 2,
      notes: noteIds,
      trash: trashIds,
      files: files,
      trashFiles: trashFiles,
      metadata: metadata
    };
    await writeText(directory, '.logbook.json', JSON.stringify(next, null, 2));
    indexCache = next;
    await cleanDirectory(notesDir, Object.values(files));
    await cleanDirectory(trashDir, Object.values(trashFiles));
    pruneCache('Notes/', Object.values(files));
    pruneCache('Trash/', Object.values(trashFiles));
    return true;
  }

  root.JournalFolder = {
    supported: supported,
    choose: choose,
    restore: restore,
    hasDirectory: function () { return !!directory; },
    readBackup: readBackup,
    readBackupIfGranted: function () { return readBackup(true); },
    sync: sync
  };
})(typeof window !== 'undefined' ? window : globalThis);

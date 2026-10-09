/* Note storage. Everything lives in this browser's localStorage under one key.
   Sealed notes are stored as ciphertext only: `body` is empty and `cipher`
   holds the encrypted text. */
(function (root) {
  'use strict';

  const KEY = 'logbook.v1';

  const state = { notes: {}, trash: [], vault: null, lastOpen: null, hideSealedTitles: false, savedAt: 0 };
  let persistent = true;
  let recovered = false;
  let lastExport = 0;
  const EXPORT_KEY = 'logbook.lastExport';
  const TRASH_DAYS = 30;

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* Titles can't contain characters that would break [[wiki links]]. */
  function cleanTitle(title) {
    return String(title == null ? '' : title)
      .replace(/[\[\]|\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  }

  function sanitizeNote(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
    const title = cleanTitle(raw.title);
    if (!id || !title) return null;

    const locked = raw.locked === true;
    let cipher = null;
    if (locked) {
      if (!raw.cipher || typeof raw.cipher.iv !== 'string' || typeof raw.cipher.data !== 'string') return null;
      cipher = { iv: raw.cipher.iv, data: raw.cipher.data };
    }

    const created = Number(raw.created) || Date.now();
    return {
      id: id,
      title: title,
      body: locked ? '' : (typeof raw.body === 'string' ? raw.body : ''),
      locked: locked,
      cipher: cipher,
      created: created,
      updated: Number(raw.updated) || created,
      pinned: raw.pinned === true
    };
  }

  function sanitizeVault(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.salt !== 'string' || !(Number(raw.iterations) > 0)) return null;
    if (!raw.check || typeof raw.check.iv !== 'string' || typeof raw.check.data !== 'string') return null;
    return {
      v: 1,
      kdf: 'PBKDF2-SHA256',
      iterations: Number(raw.iterations),
      salt: raw.salt,
      check: { iv: raw.check.iv, data: raw.check.data },
      hint: typeof raw.hint === 'string' ? raw.hint.slice(0, 80) : ''
    };
  }

  function sanitizeAll(raw) {
    if (!raw || typeof raw !== 'object' || !raw.notes || typeof raw.notes !== 'object') return null;
    const notes = {};
    const trash = [];
    const titles = new Set();
    Object.keys(raw.notes).forEach(function (k) {
      const note = sanitizeNote(raw.notes[k]);
      if (!note) return;
      // titles must be unique because [[links]] resolve by title
      if (titles.has(note.title.toLowerCase())) note.title = note.title + ' (' + note.id.slice(-4) + ')';
      titles.add(note.title.toLowerCase());
      notes[note.id] = note;
    });
    if (Array.isArray(raw.trash)) {
      raw.trash.forEach(function (entry) {
        if (!entry || typeof entry !== 'object') return;
        const note = sanitizeNote(entry.note);
        const deletedAt = Number(entry.deletedAt);
        if (note && !notes[note.id] && Number.isFinite(deletedAt) && deletedAt > 0 && deletedAt <= Date.now()) {
          trash.push({ note: note, deletedAt: deletedAt });
        }
      });
    }
    return {
      notes: notes,
      trash: trash,
      vault: sanitizeVault(raw.vault),
      lastOpen: typeof raw.lastOpen === 'string' && notes[raw.lastOpen] ? raw.lastOpen : null,
      hideSealedTitles: raw.hideSealedTitles === true,
      savedAt: Number(raw.savedAt) || 0
    };
  }

  function load() {
    let raw = null;
    try {
      raw = root.localStorage.getItem(KEY);
      lastExport = Number(root.localStorage.getItem(EXPORT_KEY)) || 0;
    } catch (err) {
      persistent = false;
      return;
    }
    if (!raw) return;
    try {
      const clean = sanitizeAll(JSON.parse(raw));
      if (!clean) throw new Error('Unexpected data shape');
      state.notes = clean.notes;
      state.trash = clean.trash;
      state.vault = clean.vault;
      state.lastOpen = clean.lastOpen;
      state.hideSealedTitles = clean.hideSealedTitles;
      state.savedAt = clean.savedAt;
    } catch (err) {
      // keep a copy of what we couldn't read instead of overwriting it silently
      recovered = true;
      try { root.localStorage.setItem(KEY + '.damaged', raw); } catch (err2) { /* nothing more to do */ }
    }
  }

  function save() {
    state.savedAt = Date.now();
    try {
      root.localStorage.setItem(KEY, JSON.stringify(state));
      persistent = true;
      return true;
    } catch (err) {
      persistent = false;
      return false;
    }
  }

  function all() { return Object.keys(state.notes).map(function (id) { return state.notes[id]; }); }
  function get(id) { return state.notes[id] || null; }

  function setPinnedAndSave(id, pinned) {
    const note = state.notes[id];
    if (!note) return false;
    const previousNotes = state.notes;
    state.notes = Object.assign({}, state.notes);
    state.notes[id] = Object.assign({}, note, { pinned: pinned === true });
    if (save()) return true;
    state.notes = previousNotes;
    return false;
  }

  function findByTitle(title) {
    const key = cleanTitle(title).toLowerCase();
    return all().find(function (n) { return n.title.toLowerCase() === key; }) || null;
  }

  function uniqueTitle(base, excludeId) {
    const clean = cleanTitle(base) || 'Untitled';
    const taken = new Set(
      all().filter(function (n) { return n.id !== excludeId; })
        .map(function (n) { return n.title.toLowerCase(); })
    );
    if (!taken.has(clean.toLowerCase())) return clean;
    let n = 2;
    while (taken.has((clean + ' ' + n).toLowerCase())) n++;
    return clean + ' ' + n;
  }

  function add(fields) {
    const now = Date.now();
    const note = {
      id: uid(),
      title: uniqueTitle(fields.title),
      body: fields.body || '',
      locked: false,
      cipher: null,
      created: now,
      updated: now,
      pinned: false
    };
    state.notes[note.id] = note;
    return note;
  }

  function remove(id) {
    const note = state.notes[id];
    if (!note) return null;
    state.trash.unshift({ note: note, deletedAt: Date.now() });
    delete state.notes[id];
    if (state.lastOpen === id) state.lastOpen = null;
    return note;
  }

  function restore(id) {
    const index = state.trash.findIndex(function (entry) { return entry.note.id === id; });
    if (index < 0) return null;
    const entry = state.trash.splice(index, 1)[0];
    entry.note.title = uniqueTitle(entry.note.title);
    state.notes[entry.note.id] = entry.note;
    return entry.note;
  }

  function purgeTrash() {
    const expiry = Date.now() - TRASH_DAYS * 24 * 60 * 60 * 1000;
    const before = state.trash.length;
    state.trash = state.trash.filter(function (entry) { return entry.deletedAt > expiry; });
    return before - state.trash.length;
  }

  function deleteFromTrash(id) {
    const before = state.trash.length;
    state.trash = state.trash.filter(function (entry) { return entry.note.id !== id; });
    return before !== state.trash.length;
  }

  function moveToTrashAndSave(id) {
    const previousNotes = state.notes;
    const previousTrash = state.trash;
    const previousLastOpen = state.lastOpen;
    state.notes = Object.assign({}, state.notes);
    state.trash = state.trash.slice();
    const note = remove(id);
    if (!note) return null;
    if (save()) return note;
    state.notes = previousNotes;
    state.trash = previousTrash;
    state.lastOpen = previousLastOpen;
    return null;
  }

  function restoreFromTrashAndSave(id) {
    const previousNotes = state.notes;
    const previousTrash = state.trash;
    const previousLastOpen = state.lastOpen;
    state.notes = Object.assign({}, state.notes);
    state.trash = state.trash.map(function (entry) {
      return { note: Object.assign({}, entry.note), deletedAt: entry.deletedAt };
    });
    const note = restore(id);
    if (!note) return null;
    state.lastOpen = note.id;
    if (save()) return note;
    state.notes = previousNotes;
    state.trash = previousTrash;
    state.lastOpen = previousLastOpen;
    return null;
  }

  function deleteFromTrashAndSave(id) {
    const previousTrash = state.trash;
    if (!deleteFromTrash(id)) return false;
    if (save()) return true;
    state.trash = previousTrash;
    return false;
  }

  function exportJSON() {
    return JSON.stringify({
      app: 'logbook',
      version: 1,
      exported: new Date().toISOString(),
      notes: state.notes,
      trash: state.trash,
      vault: state.vault,
      lastOpen: state.lastOpen,
      hideSealedTitles: state.hideSealedTitles,
      savedAt: state.savedAt
    }, null, 2);
  }

  function parseBackup(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return { ok: false, error: "That file isn't a valid backup (it couldn't be read as JSON)." };
    }
    const clean = sanitizeAll(data);
    if (!clean) return { ok: false, error: 'That file has no notes in it.' };
    const expiry = Date.now() - TRASH_DAYS * 24 * 60 * 60 * 1000;
    clean.trash = clean.trash.filter(function (entry) { return entry.deletedAt > expiry; });
    const count = Object.keys(clean.notes).length + clean.trash.length;
    if (count === 0) return { ok: false, error: 'That file has no notes in it.' };
    return { ok: true, count: count, data: clean };
  }

  function replaceAll(clean) {
    const previous = {
      notes: state.notes,
      trash: state.trash,
      vault: state.vault,
      lastOpen: state.lastOpen,
      hideSealedTitles: state.hideSealedTitles,
      savedAt: state.savedAt
    };
    state.notes = clean.notes;
    state.trash = clean.trash || [];
    state.vault = clean.vault;
    state.lastOpen = clean.lastOpen;
    state.hideSealedTitles = clean.hideSealedTitles === true;
    state.savedAt = clean.savedAt || 0;
    if (save()) return true;
    state.notes = previous.notes;
    state.trash = previous.trash;
    state.vault = previous.vault;
    state.lastOpen = previous.lastOpen;
    state.hideSealedTitles = previous.hideSealedTitles;
    state.savedAt = previous.savedAt;
    return false;
  }

  function replaceAllFromFolder(clean) {
    state.notes = clean.notes;
    state.trash = clean.trash || [];
    state.vault = clean.vault;
    state.lastOpen = clean.lastOpen;
    state.hideSealedTitles = clean.hideSealedTitles === true;
    state.savedAt = clean.savedAt || 0;
  }

  function replaceEncryptedNotes(notes, vault) {
    const previousNotes = state.notes;
    const previousVault = state.vault;
    state.notes = notes;
    state.vault = vault;
    if (save()) return true;
    state.notes = previousNotes;
    state.vault = previousVault;
    return false;
  }

  function replaceEncryptedNotesFromFolder(notes, vault) {
    state.notes = notes;
    state.vault = vault;
  }

  const api = {
    load: load,
    save: save,
    all: all,
    get: get,
    setPinnedAndSave: setPinnedAndSave,
    add: add,
    remove: remove,
    moveToTrashAndSave: moveToTrashAndSave,
    restore: restore,
    restoreFromTrashAndSave: restoreFromTrashAndSave,
    purgeTrash: purgeTrash,
    deleteFromTrash: deleteFromTrash,
    deleteFromTrashAndSave: deleteFromTrashAndSave,
    trash: function () { return state.trash.slice().sort(function (a, b) { return b.deletedAt - a.deletedAt; }); },
    trashDays: TRASH_DAYS,
    findByTitle: findByTitle,
    uniqueTitle: uniqueTitle,
    cleanTitle: cleanTitle,
    getVault: function () { return state.vault; },
    setVault: function (vault) { state.vault = vault; },
    replaceEncryptedNotes: replaceEncryptedNotes,
    replaceEncryptedNotesFromFolder: replaceEncryptedNotesFromFolder,
    hideSealedTitles: function () { return state.hideSealedTitles; },
    setHideSealedTitles: function (value) {
      const previous = state.hideSealedTitles;
      state.hideSealedTitles = value === true;
      if (save()) return true;
      state.hideSealedTitles = previous;
      return false;
    },
    getSavedAt: function () { return state.savedAt; },
    replaceAllFromFolder: replaceAllFromFolder,
    getLastExport: function () { return lastExport; },
    markExported: function () {
      lastExport = Date.now();
      try {
        root.localStorage.setItem(EXPORT_KEY, String(lastExport));
        return true;
      } catch (err) {
        return false;
      }
    },
    getLastOpen: function () { return state.lastOpen; },
    setLastOpen: function (id) { state.lastOpen = id; },
    status: function () { return { persistent: persistent, recovered: recovered }; },
    exportJSON: exportJSON,
    parseBackup: parseBackup,
    replaceAll: replaceAll
  };

  root.JournalStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

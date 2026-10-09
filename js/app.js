/* Logbook app: wires the store, markdown renderer, vault and graph to the page. */
(function () {
  'use strict';

  const Store = window.JournalStore;
  const Md = window.JournalMarkdown;
  const Vault = window.JournalCrypto;
  const Graph = window.JournalGraph;
  const Folder = window.JournalFolder;
  const $ = function (id) { return document.getElementById(id); };
  const AUTO_LOCK_MS = 5 * 60 * 1000;
  const EXPORT_REMINDER_MS = 14 * 24 * 60 * 60 * 1000;

  const S = {
    currentId: null,
    mode: 'edit',
    key: null,                       // CryptoKey while the vault is open
    cache: Object.create(null),      // id -> plain text of sealed notes (memory only)
    failed: new Set(),               // sealed notes that wouldn't decrypt
    query: '',
    tag: null,
    index: null,
    pending: new Set(),              // note ids waiting to be saved
    dirty: false,
    saveTimer: 0,
    saveToken: 0,
    indexTimer: 0,
    flashTimer: 0,
    saveChain: Promise.resolve(),
    lastActive: Date.now(),
    graph: null,
    folderChain: Promise.resolve(),
    bannerKind: '',
    exportReminderDismissed: false,
    linkMatches: [],
    linkIndex: 0,
    commandItems: [],
    commandIndex: 0,
    recentNotes: [],
    calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  };

  /* ---------- small helpers ---------- */

  function pad(n) { return String(n).padStart(2, '0'); }

  function todayTitle() {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, sameYear
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function current() { return S.currentId ? Store.get(S.currentId) : null; }

  function visibleTitle(note) {
    return Store.hideSealedTitles() && !S.key && note.locked ? 'Sealed note' : note.title;
  }

  /* Text of a note, or null when it is sealed (or couldn't be decrypted). */
  function bodyOf(n) {
    if (!n.locked) return n.body;
    if (!S.key || S.failed.has(n.id)) return null;
    return S.cache[n.id] !== undefined ? S.cache[n.id] : '';
  }

  function mostRecentId() {
    const list = Store.all().sort(function (a, b) { return b.updated - a.updated; });
    return list.length ? list[0].id : null;
  }

  function setFlash(message) {
    const el = $('flash');
    el.textContent = message;
    clearTimeout(S.flashTimer);
    S.flashTimer = setTimeout(function () { el.textContent = ''; }, 7000);
  }

  function showBanner(message, kind) {
    const el = $('banner');
    $('banner-text').textContent = message;
    S.bannerKind = kind || '';
    $('banner-export').hidden = !message;
    $('banner-dismiss').hidden = kind !== 'reminder';
    el.hidden = !message;
  }

  function loadRecentNotes() {
    try {
      const raw = localStorage.getItem('logbook.recentNotes');
      return raw ? JSON.parse(raw) : [];
    } catch (err) {
      return [];
    }
  }

  function saveRecentNotes(list) {
    try {
      localStorage.setItem('logbook.recentNotes', JSON.stringify(list.slice(0, 10)));
    } catch (err) {
      /* Recent notes are a convenience feature, not a recovery mechanism. */
    }
  }

  function rememberRecentNote(id) {
    if (!id) return;
    const seen = new Set();
    const next = [id];
    (S.recentNotes || []).forEach(function (item) {
      if (item !== id && !seen.has(item)) {
        seen.add(item);
        next.push(item);
      }
      seen.add(item);
    });
    S.recentNotes = next.slice(0, 10);
    saveRecentNotes(S.recentNotes);
  }

  function renderRecentNotes() {
    const box = $('recent-list');
    if (!box) return;
    const ids = S.recentNotes.filter(function (id) { return !!Store.get(id); }).slice(0, 6);
    box.textContent = '';
    if (!ids.length) {
      box.hidden = true;
      return;
    }
    ids.forEach(function (id) {
      const note = Store.get(id);
      if (!note) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'recent-link';
      btn.dataset.id = note.id;
      btn.textContent = visibleTitle(note);
      btn.title = 'Open ' + visibleTitle(note);
      box.appendChild(btn);
    });
    box.hidden = false;
  }

  function toggleFocusMode(force) {
    const active = typeof force === 'boolean' ? force : !$('app').classList.contains('focus-mode');
    $('app').classList.toggle('focus-mode', active);
    const btn = $('btn-focus');
    if (btn) btn.textContent = active ? 'Exit focus' : 'Focus';
    btn && btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (active) setFlash('Focus mode on. Sidebar and graph are hidden.');
  }

  async function syncFolder() {
    if (!Folder.hasDirectory()) return;
    const operation = S.folderChain.catch(function () {}).then(function () {
      return Folder.sync(Store.all(), Store.trash(), {
        vault: Store.getVault(),
        lastOpen: Store.getLastOpen(),
        hideSealedTitles: Store.hideSealedTitles(),
        savedAt: Store.getSavedAt()
      });
    });
    S.folderChain = operation;
    await operation;
  }

  function refreshExportReminder() {
    if (S.exportReminderDismissed || S.bannerKind === 'error') return;
    const last = Store.getLastExport();
    if (Date.now() - last >= EXPORT_REMINDER_MS) {
      showBanner('It has been over two weeks since your last backup. Export a copy to protect your notes.', 'reminder');
    } else if (S.bannerKind === 'reminder') {
      showBanner('');
    }
  }

  function clock() {
    return new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  /* ---------- index of links and tags (only for notes we can read) ---------- */

  function buildIndex() {
    const notes = Store.all();
    const byTitle = new Map();
    const links = new Map();
    const tags = new Map();
    notes.forEach(function (n) {
      byTitle.set(n.title.toLowerCase(), n);
      const body = bodyOf(n);
      if (body !== null) {
        links.set(n.id, Md.extractLinks(body));
        tags.set(n.id, Md.extractTags(body));
      }
    });
    S.index = { notes: notes, byTitle: byTitle, links: links, tags: tags };
  }

  function refreshIndex() {
    buildIndex();
    renderSidebar();
    renderTags();
    renderRecentNotes();
    renderRail();
  }

  function scheduleIndex() {
    clearTimeout(S.indexTimer);
    S.indexTimer = setTimeout(refreshIndex, 250);
  }

  /* ---------- rendering ---------- */

  function renderAll() {
    buildIndex();
    renderVault();
    renderSidebar();
    renderTags();
    renderRecentNotes();
    renderEditor();
    renderRail();
    renderOutline();
  }

  function renderVault() {
    const btn = $('btn-vault');
    const label = $('vault-label');
    const dot = $('vault-dot');
    $('btn-vault-password').hidden = !S.key || !Store.getVault();
    $('btn-hide-titles').textContent = 'Title privacy: ' + (Store.hideSealedTitles() ? 'On' : 'Off');
    $('btn-hide-titles').setAttribute('aria-label', 'Hide sealed note titles');
    $('btn-hide-titles').setAttribute('aria-pressed', Store.hideSealedTitles() ? 'true' : 'false');
    $('btn-folder').hidden = !Folder.supported();
    $('btn-restore-folder').hidden = !Folder.supported();
    $('btn-folder').textContent = Folder.hasDirectory() ? 'Sync folder' : 'Connect folder';
    if (!Vault.available()) {
      label.textContent = 'Vault unavailable';
      dot.className = 'vault-dot off';
      btn.disabled = true;
      btn.title = 'Locking notes needs a secure page (https, localhost, or a file opened directly).';
      return;
    }
    btn.disabled = false;
    if (!Store.getVault()) {
      label.textContent = 'Set up vault';
      dot.className = 'vault-dot off';
      btn.title = 'Create the password that seals your private notes';
    } else if (S.key) {
      label.textContent = 'Lock vault';
      dot.className = 'vault-dot open';
      btn.title = 'Lock the vault now';
    } else {
      label.textContent = 'Unlock vault';
      dot.className = 'vault-dot locked';
      btn.title = 'Enter your vault password';
    }
  }

  function renderSidebar() {
    const q = S.query.trim().toLowerCase();
    let list = S.index.notes.slice().sort(function (a, b) {
      return Number(b.pinned === true) - Number(a.pinned === true) || b.updated - a.updated;
    });

    if (S.tag) {
      list = list.filter(function (n) { return (S.index.tags.get(n.id) || []).indexOf(S.tag) !== -1; });
    }
    if (q) {
      list = list.filter(function (n) {
        return visibleTitle(n).toLowerCase().indexOf(q) !== -1 ||
          (bodyOf(n) || '').toLowerCase().indexOf(q) !== -1;
      });
    }

    const nav = $('note-list');
    nav.textContent = '';

    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'list-empty';
      p.textContent = (q || S.tag) ? 'No notes match.' : 'No notes yet. Choose New note to start.';
      nav.appendChild(p);
      return;
    }

    list.forEach(function (n) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'note-item';
      item.dataset.id = n.id;
      if (n.id === S.currentId) item.setAttribute('aria-current', 'true');

      const title = document.createElement('span');
      title.className = 'note-title';
      title.textContent = visibleTitle(n);
      item.appendChild(title);

      if (n.pinned) {
        const pin = document.createElement('span');
        pin.className = 'note-pin';
        pin.textContent = 'Pinned';
        item.appendChild(pin);
        item.setAttribute('aria-label', visibleTitle(n) + ', pinned');
      }

      if (n.locked) {
        const seal = document.createElement('span');
        seal.className = 'seal';
        seal.setAttribute('role', 'img');
        seal.setAttribute('aria-label', 'Sealed note');
        item.appendChild(seal);
      }

      const date = document.createElement('span');
      date.className = 'note-date';
      date.textContent = fmtDate(n.updated);
      item.appendChild(date);

      nav.appendChild(item);
    });
  }

  function renderTags() {
    const counts = new Map();
    S.index.tags.forEach(function (arr) {
      arr.forEach(function (t) { counts.set(t, (counts.get(t) || 0) + 1); });
    });
    if (S.tag && !counts.has(S.tag)) S.tag = null;

    const box = $('tag-list');
    box.textContent = '';
    const entries = Array.from(counts.entries())
      .sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); })
      .slice(0, 14);
    box.hidden = entries.length === 0;

    entries.forEach(function (entry) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.tag = entry[0];
      chip.title = entry[1] + (entry[1] === 1 ? ' note' : ' notes');
      chip.setAttribute('aria-pressed', S.tag === entry[0] ? 'true' : 'false');
      chip.textContent = '#' + entry[0];
      box.appendChild(chip);
    });
  }

  function updateWordCount(body) {
    const words = body && body.trim() ? body.trim().split(/\s+/).length : 0;
    $('word-count').textContent = words + (words === 1 ? ' word' : ' words');
  }

  function renderPreview(body) {
    const pv = $('preview');
    if (body.trim()) {
      pv.innerHTML = Md.render(body, {
        resolve: function (title) { return S.index.byTitle.has(title.toLowerCase()); }
      });
    } else {
      pv.innerHTML = '<p class="muted">Nothing here yet. Choose Edit to start writing.</p>';
    }
    $('stage').scrollTop = 0;
  }

  function renderEditor() {
    const n = current();
    const ed = $('editor');
    const pv = $('preview');
    const title = $('title');
    const modeBtn = $('btn-mode');
    const lockBtn = $('btn-lock-note');
    const pinBtn = $('btn-pin');
    const delBtn = $('btn-delete');
    const badge = $('note-seal');

    $('link-suggestions').hidden = true;
    ed.hidden = true;
    pv.hidden = true;
    $('sealed').hidden = true;
    $('empty').hidden = true;

    if (!n) {
      $('empty').hidden = false;
      title.value = '';
      title.disabled = true;
      ed.value = '';
      pv.textContent = '';
      modeBtn.hidden = true;
      lockBtn.hidden = true;
      pinBtn.hidden = true;
      delBtn.hidden = true;
      badge.hidden = true;
      $('word-count').textContent = '';
      return;
    }

    const hideCurrentTitle = Store.hideSealedTitles() && !S.key && n.locked;
    title.value = hideCurrentTitle ? 'Sealed note' : n.title;
    title.disabled = hideCurrentTitle;
    delBtn.hidden = false;
    pinBtn.hidden = false;
    pinBtn.textContent = n.pinned ? 'Unpin note' : 'Pin note';
    pinBtn.setAttribute('aria-pressed', n.pinned ? 'true' : 'false');
    badge.hidden = !n.locked;

    const body = bodyOf(n);
    if (body === null) {
      // sealed: make sure no plain text is left in the page
      ed.value = '';
      pv.textContent = '';
      modeBtn.hidden = true;
      lockBtn.hidden = true;
      const failed = S.failed.has(n.id);
      $('sealed').hidden = false;
      $('sealed-title').textContent = failed ? "This note can't be opened" : 'This note is sealed';
      $('sealed-text').textContent = failed
        ? "It couldn't be decrypted with this vault's password. Notes imported from another vault keep that vault's password."
        : 'Unlock the vault to read and edit it.';
      $('btn-sealed-unlock').hidden = failed;
      $('word-count').textContent = '';
      return;
    }

    modeBtn.hidden = false;
    lockBtn.hidden = false;
    modeBtn.textContent = S.mode === 'edit' ? 'Preview' : 'Edit';
    lockBtn.textContent = n.locked ? 'Remove lock' : 'Lock note';
    ed.value = body;
    if (S.mode === 'edit') {
      ed.hidden = false;
    } else {
      pv.hidden = false;
      renderPreview(body);
    }
    updateWordCount(body);
  }

  function linkButton(label, attr, value, extraClass, suffix) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'link-btn' + (extraClass ? ' ' + extraClass : '');
    btn.dataset[attr] = value;
    btn.textContent = label;
    li.appendChild(btn);
    if (suffix) {
      const small = document.createElement('span');
      small.className = 'muted';
      small.textContent = ' ' + suffix;
      li.appendChild(small);
    }
    return li;
  }

  function noneItem(text) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = text;
    return li;
  }

  function renderRail() {
    const n = current();
    const back = $('backlinks');
    const out = $('outlinks');
    back.textContent = '';
    out.textContent = '';
    $('rail-note').hidden = !(!S.key && S.index.notes.some(function (m) { return m.locked; }));
    if (!n) return;

    const key = n.title.toLowerCase();
    const backs = S.index.notes.filter(function (m) {
      return m.id !== n.id && (S.index.links.get(m.id) || []).some(function (t) { return t.toLowerCase() === key; });
    });
    if (backs.length) {
      backs.forEach(function (m) { back.appendChild(linkButton(visibleTitle(m), 'open', m.id)); });
    } else {
      back.appendChild(noneItem('No notes link here yet.'));
    }

    const links = (S.index.links.get(n.id) || []).filter(function (t) { return t.toLowerCase() !== key; });
    if (links.length) {
      links.forEach(function (t) {
        const target = S.index.byTitle.get(t.toLowerCase());
        if (target) out.appendChild(linkButton(visibleTitle(target), 'open', target.id));
        else out.appendChild(linkButton(t, 'create', t, 'missing', 'not created yet'));
      });
    } else {
      out.appendChild(noneItem(n.locked && !S.key ? 'Unlock the vault to see links.' : 'No links in this note.'));
    }
  }

  function renderOutline() {
    const list = $('outline-list');
    if (!list) return;
    list.textContent = '';
    const n = current();
    if (!n) return;
    const body = bodyOf(n);
    if (!body) {
      list.appendChild(noneItem('Outline is hidden while the note is sealed.'));
      return;
    }
    const seen = new Map();
    const headings = [];
    body.split(/\r?\n/).forEach(function (line, index) {
      const match = line.match(/^(#{1,6})\s+(.*)$/);
      if (!match) return;
      const raw = match[2].trim();
      if (!raw) return;
      const text = raw.replace(/\s+#+\s*$/, '');
      const count = seen.get(text) || 0;
      seen.set(text, count + 1);
      headings.push({ text: count ? text + ' (' + (count + 1) + ')' : text, level: match[1].length, line: index });
    });
    if (!headings.length) {
      list.appendChild(noneItem('No headings yet.'));
      return;
    }
    headings.forEach(function (heading) {
      const item = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link-btn outline-btn';
      btn.style.marginLeft = ((heading.level - 1) * 0.55) + 'rem';
      btn.dataset.line = String(heading.line);
      btn.textContent = heading.text;
      btn.title = 'Jump to heading';
      item.appendChild(btn);
      list.appendChild(item);
    });
  }

  function buildCommandItems() {
    const items = [];
    const notes = Store.all().slice().sort(function (a, b) {
      return Number(b.pinned === true) - Number(a.pinned === true) || b.updated - a.updated;
    });
    notes.forEach(function (n) {
      items.push({
        kind: 'note',
        label: visibleTitle(n),
        detail: n.locked ? 'Sealed note' : 'Open note',
        value: n.id,
        key: 'O'
      });
    });
    items.push({ kind: 'action', label: 'New note', detail: 'Create a blank note', value: 'new', key: 'N' });
    items.push({ kind: 'action', label: 'Today', detail: 'Open today\'s note', value: 'today', key: 'D' });
    items.push({ kind: 'action', label: 'Calendar', detail: 'Open the daily note calendar', value: 'calendar', key: 'C' });
    items.push({ kind: 'action', label: 'Toggle focus mode', detail: 'Hide the rail and sidebar', value: 'focus', key: 'F' });
    return items;
  }

  function openCommandPalette() {
    const dlg = $('command-dialog');
    const input = $('command-input');
    const list = $('command-list');
    S.commandItems = buildCommandItems();
    S.commandIndex = 0;
    input.value = '';
    list.textContent = '';
    const renderCommandList = function (query) {
      const q = (query || '').trim().toLowerCase();
      const matches = S.commandItems.filter(function (item) {
        if (!q) return true;
        return (item.label + ' ' + item.detail).toLowerCase().indexOf(q) !== -1;
      }).slice(0, 12);
      list.textContent = '';
      if (!matches.length) {
        const li = document.createElement('li');
        li.className = 'none';
        li.textContent = 'No matches.';
        list.appendChild(li);
        return;
      }
      matches.forEach(function (item, idx) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        const label = document.createElement('span');
        const key = document.createElement('span');
        btn.type = 'button';
        btn.dataset.value = item.value;
        btn.dataset.kind = item.kind;
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', idx === S.commandIndex ? 'true' : 'false');
        label.textContent = item.label;
        key.textContent = item.key;
        key.className = 'command-key';
        btn.appendChild(label);
        btn.appendChild(key);
        btn.addEventListener('click', function () {
          selectCommand(item);
        });
        li.appendChild(btn);
        list.appendChild(li);
      });
    };
    const moveCommandSelection = function (dir) {
      const items = Array.from(list.querySelectorAll('button[role="option"]'));
      if (!items.length) return;
      S.commandIndex = (S.commandIndex + dir + items.length) % items.length;
      items.forEach(function (btn, idx) {
        btn.setAttribute('aria-selected', idx === S.commandIndex ? 'true' : 'false');
      });
    };
    const selectCommand = function (item) {
      dlg.close();
      if (item.kind === 'note') {
        openNote(item.value);
      } else if (item.value === 'new') {
        const n = createNote(Store.uniqueTitle('Untitled'), '');
        S.mode = 'edit';
        openNote(n.id, { focus: 'title' });
      } else if (item.value === 'today') {
        openDailyNote(new Date());
      } else if (item.value === 'calendar') {
        S.calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        renderCalendar();
        $('calendar-dialog').showModal();
      } else if (item.value === 'focus') {
        toggleFocusMode();
      }
    };
    input.addEventListener('input', function (e) {
      S.commandIndex = 0;
      renderCommandList(e.target.value);
    });
    input.addEventListener('keydown', function (e) {
      const items = Array.from(list.querySelectorAll('button[role="option"]'));
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveCommandSelection(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveCommandSelection(-1);
      } else if (e.key === 'Enter' && items.length) {
        e.preventDefault();
        const chosen = items[S.commandIndex];
        if (chosen) {
          const found = S.commandItems.find(function (item) {
            return item.value === chosen.dataset.value && item.kind === chosen.dataset.kind;
          });
          if (found) selectCommand(found);
        }
      } else if (e.key === 'Escape') {
        dlg.close();
      }
    });
    dlg.addEventListener('close', function () {
      input.value = '';
      list.textContent = '';
    }, { once: true });
    renderCommandList('');
    dlg.showModal();
    requestAnimationFrame(function () { input.focus(); });
  }

  /* ---------- saving ---------- */

  function setSaveState(text) { $('save-state').textContent = text; }

  async function persistPending() {
    const ids = Array.from(S.pending);
    S.pending.clear();
    for (const id of ids) {
      const n = Store.get(id);
      if (!n || !n.locked) continue;
      if (!S.key || S.cache[id] === undefined) continue;
      n.cipher = await Vault.encryptText(S.key, S.cache[id], id);
      n.body = '';
    }
    const ok = Store.save();
    if (ok) {
      S.dirty = S.pending.size > 0;
      setSaveState('Saved ' + clock());
      if (Folder.hasDirectory()) {
        try {
          await syncFolder();
          setSaveState('Saved ' + clock() + ' · folder synced');
        } catch (err) {
          console.error(err);
          setFlash("Saved in this browser, but couldn't update the folder copy. Check folder access and try Sync folder.");
        }
      }
      refreshExportReminder();
    } else if (Folder.hasDirectory()) {
      try {
        await syncFolder();
        S.dirty = S.pending.size > 0;
        setSaveState('Saved to folder ' + clock());
        showBanner("Browser storage is full or unavailable. Changes are saved to the connected folder; use Restore folder if browser data is cleared.", 'error');
      } catch (err) {
        console.error(err);
        ids.forEach(function (id) { S.pending.add(id); });
        S.dirty = true;
        setSaveState('Not saved');
        showBanner("Browser storage and the folder copy both failed. Export a backup before closing the tab.", 'error');
      }
    } else {
      ids.forEach(function (id) { S.pending.add(id); });
      S.dirty = true;
      setSaveState('Not saved');
      showBanner("This browser isn't letting the logbook save. Use Export to keep a copy of your notes before closing the tab.", 'error');
    }
  }

  function flush() {
    clearTimeout(S.saveTimer);
    const token = ++S.saveToken;
    S.saveChain = S.saveChain.then(async function () {
      if (token !== S.saveToken) return;
      await persistPending();
    }).catch(function (err) {
      console.error(err);
      setSaveState('Not saved');
      setFlash("Couldn't save the last change. Use Export to keep a copy.");
      showBanner("Couldn't save the latest changes. Export a backup before closing the tab.", 'error');
    });
    return S.saveChain;
  }

  function markDirty(id) {
    S.pending.add(id);
    S.dirty = true;
    setSaveState('Saving…');
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(flush, 350);
  }

  /* ---------- notes ---------- */

  function createNote(title, body) {
    const n = Store.add({ title: title || 'Untitled', body: body || '' });
    markDirty(n.id);
    return n;
  }

  function openNote(id, opts) {
    opts = opts || {};
    flush();
    S.currentId = id;
    Store.setLastOpen(id);
    rememberRecentNote(id);
    $('app').classList.remove('show-side');
    Store.save();
    renderAll();
    if (opts.focus === 'title') {
      $('title').focus();
      $('title').select();
    } else if (opts.focus === 'editor' && !$('editor').hidden) {
      const ed = $('editor');
      ed.focus();
      ed.setSelectionRange(ed.value.length, ed.value.length);
    }
  }

  function followTitle(title) {
    const existing = Store.findByTitle(title);
    if (existing) {
      openNote(existing.id);
      return;
    }
    const made = createNote(title, '');
    S.mode = 'edit';
    openNote(made.id, { focus: 'editor' });
  }

  async function renameCurrent(raw) {
    const n = current();
    if (!n) return;
    const clean = Store.cleanTitle(raw);
    if (!clean) {
      $('title').value = n.title;
      return;
    }
    const next = Store.uniqueTitle(clean, n.id);
    if (next === n.title) {
      $('title').value = n.title;
      return;
    }
    const old = n.title;
    n.title = next;
    n.updated = Date.now();

    // keep [[links]] pointing at the renamed note
    Store.all().forEach(function (m) {
      if (!m.locked) {
        const updated = Md.renameLinks(m.body, old, next);
        if (updated !== m.body) {
          m.body = updated;
          S.pending.add(m.id);
        }
      } else if (S.key && S.cache[m.id] !== undefined) {
        const updated = Md.renameLinks(S.cache[m.id], old, next);
        if (updated !== S.cache[m.id]) {
          S.cache[m.id] = updated;
          S.pending.add(m.id);
        }
      }
    });

    S.pending.add(n.id);
    await flush();
    renderAll();
    if (next !== clean) setFlash('Another note already uses that title, so this one is called "' + next + '".');
  }

  async function deleteCurrent() {
    const n = current();
    if (!n) return;
    const ok = await confirmDialog(
      'Move "' + visibleTitle(n) + '" to Trash?',
      'The note will be kept in Trash for 30 days and can be restored.',
      'Move to Trash'
    );
    if (!ok) return;
    await flush();
    if (!Store.moveToTrashAndSave(n.id)) {
      setFlash("Couldn't save the move to Trash. The note is still in place.");
      return;
    }

    delete S.cache[n.id];
    S.failed.delete(n.id);
    S.pending.delete(n.id);
    S.currentId = mostRecentId();
    Store.setLastOpen(S.currentId);
    Store.save();
    try { await syncFolder(); } catch (err) {
      console.error(err);
      setFlash("Moved to Trash locally, but couldn't update the folder copy.");
    }
    renderAll();
    renderTrash();
    setFlash('Moved "' + visibleTitle(n) + '" to Trash.');
  }

  async function toggleCurrentPin() {
    const n = current();
    if (!n) return;
    const pinned = !n.pinned;
    if (!Store.setPinnedAndSave(n.id, pinned)) {
      setFlash("Couldn't save the pin change. The note's pin state is unchanged.");
      return;
    }
    renderAll();
    try {
      await syncFolder();
    } catch (err) {
      console.error(err);
      setFlash((pinned ? 'Pinned' : 'Unpinned') + ' locally, but the folder copy could not be updated.');
      return;
    }
    setFlash(pinned ? 'Note pinned.' : 'Note unpinned.');
  }

  function renderTrash() {
    const list = $('trash-list');
    list.textContent = '';
    const entries = Store.trash();
    if (!entries.length) {
      const empty = document.createElement('li');
      empty.className = 'none';
      empty.textContent = 'Trash is empty.';
      list.appendChild(empty);
      return;
    }
    entries.forEach(function (entry) {
      const li = document.createElement('li');
      const title = document.createElement('span');
      title.textContent = visibleTitle(entry.note);
      const daysLeft = Math.max(1, Store.trashDays - Math.floor((Date.now() - entry.deletedAt) / (24 * 60 * 60 * 1000)));
      title.title = daysLeft + (daysLeft === 1 ? ' day until permanent deletion' : ' days until permanent deletion');
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.dataset.restore = entry.note.id;
      restore.textContent = 'Restore';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.permanent = entry.note.id;
      remove.textContent = 'Delete forever';
      li.append(title, restore, remove);
      list.appendChild(li);
    });
  }

  async function restoreTrashNote(id) {
    const note = Store.restoreFromTrashAndSave(id);
    if (!note) return;
    if (note.locked && S.key) {
      try {
        S.cache[note.id] = await Vault.decryptText(S.key, note.cipher, note.id);
        S.failed.delete(note.id);
      } catch (err) {
        S.failed.add(note.id);
      }
    }
    try { await syncFolder(); } catch (err) {
      console.error(err);
      setFlash("Restored locally, but couldn't update the folder copy.");
    }
    S.currentId = note.id;
    renderAll();
    renderTrash();
    setFlash('Restored "' + visibleTitle(note) + '".');
  }

  async function permanentlyDeleteTrashNote(id) {
    const entry = Store.trash().find(function (item) { return item.note.id === id; });
    if (!entry) return;
    const ok = await confirmDialog(
      'Delete "' + visibleTitle(entry.note) + '" forever?',
      'This permanently removes the note and cannot be undone.',
      'Delete forever'
    );
    if (!ok) return;
    if (!Store.deleteFromTrashAndSave(id)) {
      setFlash("Couldn't save the permanent deletion in this browser.");
      return;
    }
    delete S.cache[id];
    S.failed.delete(id);
    try { await syncFolder(); } catch (err) {
      console.error(err);
      setFlash("Deleted locally, but couldn't update the folder copy.");
    }
    renderTrash();
  }

  /* ---------- dialogs ---------- */

  function confirmDialog(title, text, okLabel) {
    return new Promise(function (resolve) {
      const dlg = $('confirm-dialog');
      let result = false;
      $('confirm-title').textContent = title;
      $('confirm-text').textContent = text;
      $('confirm-ok').textContent = okLabel;
      $('confirm-ok').onclick = function () { result = true; dlg.close(); };
      $('confirm-cancel').onclick = function () { dlg.close(); };
      dlg.onclose = function () { resolve(result); };
      dlg.showModal();
      $('confirm-cancel').focus();
    });
  }

  /* ---------- vault ---------- */

  async function decryptAll() {
    S.cache = Object.create(null);
    S.failed = new Set();
    const sealed = Store.all().filter(function (n) { return n.locked; });
    for (const n of sealed) {
      try {
        S.cache[n.id] = await Vault.decryptText(S.key, n.cipher, n.id);
      } catch (err) {
        S.failed.add(n.id);
      }
    }
    if (S.failed.size) {
      setFlash(S.failed.size + (S.failed.size === 1 ? ' sealed note' : ' sealed notes') +
        " couldn't be decrypted with this password.");
    }
  }

  /* Opens the set-up or unlock dialog. Resolves true once the vault is open. */
  function requestVault() {
    return new Promise(function (resolve) {
      const dlg = $('vault-dialog');
      const existing = Store.getVault();
      const setup = !existing;
      const submit = $('vault-submit');
      const hintBtn = $('vault-hint-btn');
      const hintText = $('vault-hint-text');
      let opened = false;

      $('vault-title').textContent = setup ? 'Set up your vault' : 'Unlock your vault';
      $('vault-intro').textContent = setup
        ? "One password seals every note you lock. It stays in this browser, and it can't be recovered if you forget it."
        : 'Enter your vault password to open sealed notes.';
      $('vault-confirm-row').hidden = !setup;
      $('vault-hint-row').hidden = !setup;
      $('vault-pass').autocomplete = setup ? 'new-password' : 'current-password';
      $('vault-pass').value = '';
      $('vault-pass2').value = '';
      $('vault-hint').value = '';
      $('vault-error').textContent = '';
      hintText.textContent = existing && existing.hint ? existing.hint : '';
      hintText.hidden = true;
      hintBtn.hidden = setup || !(existing && existing.hint);
      submit.textContent = setup ? 'Create vault' : 'Unlock vault';
      submit.disabled = false;

      hintBtn.onclick = function () {
        hintText.hidden = false;
        hintBtn.hidden = true;
      };
      $('vault-cancel').onclick = function () { dlg.close(); };
      dlg.onclose = function () {
        $('vault-pass').value = '';
        $('vault-pass2').value = '';
        resolve(opened);
      };

      $('vault-form').onsubmit = async function (e) {
        e.preventDefault();
        const pass = $('vault-pass').value;
        const err = $('vault-error');
        err.textContent = '';

        if (setup) {
          if (pass.length < 8) {
            err.textContent = 'Use at least 8 characters. A short phrase works well.';
            return;
          }
          if (pass !== $('vault-pass2').value) {
            err.textContent = "The two passwords don't match.";
            return;
          }
        } else if (!pass) {
          err.textContent = 'Enter your vault password.';
          return;
        }

        const label = submit.textContent;
        submit.disabled = true;
        submit.textContent = setup ? 'Creating' : 'Unlocking';
        try {
          if (setup) {
            const made = await Vault.createVault(pass, $('vault-hint').value.trim());
            Store.setVault(made.vault);
            S.key = made.key;
            S.cache = Object.create(null);
            S.failed = new Set();
            Store.save();
          } else {
            const key = await Vault.openVault(existing, pass);
            if (!key) {
              err.textContent = "That password doesn't open this vault.";
              submit.disabled = false;
              submit.textContent = label;
              $('vault-pass').select();
              return;
            }
            S.key = key;
            await decryptAll();
          }
          opened = true;
          S.lastActive = Date.now();
          dlg.close();
        } catch (ex) {
          console.error(ex);
          err.textContent = 'Something went wrong. Try again.';
          submit.disabled = false;
          submit.textContent = label;
        }
      };

      dlg.showModal();
      $('vault-pass').focus();
    }).then(function (opened) {
      if (opened) renderAll();
      return opened;
    });
  }

  async function lockVault(message) {
    if (!S.key) return;
    await flush();
    S.key = null;
    S.cache = Object.create(null);
    S.failed = new Set();
    if ($('graph-dialog').open) $('graph-dialog').close();
    renderAll();
    setFlash(message || 'Vault locked.');
  }

  function changeVaultPassword() {
    if (!S.key) return;
    const dlg = $('password-dialog');
    $('new-vault-pass').value = '';
    $('new-vault-pass2').value = '';
    $('new-vault-hint').value = Store.getVault().hint || '';
    $('password-error').textContent = '';
    $('password-submit').disabled = false;
    $('password-cancel').onclick = function () { dlg.close(); };
    dlg.showModal();
    $('new-vault-pass').focus();
  }

  async function submitVaultPasswordChange(event) {
    event.preventDefault();
    const error = $('password-error');
    const password = $('new-vault-pass').value;
    error.textContent = '';
    if (!S.key) {
      error.textContent = 'Unlock the vault before changing its password.';
      return;
    }
    if (password.length < 8) {
      error.textContent = 'Use at least 8 characters. A short phrase works well.';
      return;
    }
    if (password !== $('new-vault-pass2').value) {
      error.textContent = "The two passwords don't match.";
      return;
    }
    if (S.failed.size) {
      error.textContent = 'Unlock or restore every sealed note before changing the password.';
      return;
    }

    const submit = $('password-submit');
    submit.disabled = true;
    submit.textContent = 'Re-encrypting notes…';
    try {
      await flush();
      if (!Store.status().persistent && !Folder.hasDirectory()) {
        error.textContent = "Couldn't save pending notes. The password hasn't been changed.";
        return;
      }
      const made = await Vault.createVault(password, $('new-vault-hint').value.trim());
      const updated = {};
      const previousNotes = {};
      const oldVault = Store.getVault();
      for (const note of Store.all()) {
        previousNotes[note.id] = note;
        const copy = Object.assign({}, note, { cipher: note.cipher && Object.assign({}, note.cipher) });
        if (copy.locked) {
          if (S.cache[copy.id] === undefined) throw new Error('A sealed note is not available in memory.');
          copy.cipher = await Vault.encryptText(made.key, S.cache[copy.id], copy.id);
          copy.body = '';
        }
        updated[copy.id] = copy;
      }
      let folderOnly = false;
      if (!Store.replaceEncryptedNotes(updated, made.vault)) {
        if (!Folder.hasDirectory()) {
          error.textContent = "Couldn't save the password change. No notes were changed.";
          return;
        }
        Store.replaceEncryptedNotesFromFolder(updated, made.vault);
        try {
          await syncFolder();
          folderOnly = true;
        } catch (folderError) {
          console.error(folderError);
          Store.replaceEncryptedNotesFromFolder(previousNotes, oldVault);
          error.textContent = "Couldn't commit the password change to the folder. No notes were changed.";
          return;
        }
      }
      S.key = made.key;
      S.failed = new Set();
      dlg.close();
      renderAll();
      if (folderOnly) {
        showBanner('Browser storage is full. The new password and sealed notes were committed together to the connected folder.', 'error');
        setFlash('Vault password changed in the folder copy. Keep that folder safe.');
      } else {
        try {
          await syncFolder();
        } catch (folderError) {
          console.error(folderError);
          setFlash("Password changed in this browser, but couldn't update the folder copy.");
        }
        setFlash('Vault password changed. Save the new password somewhere safe.');
      }
    } catch (err) {
      console.error(err);
      error.textContent = 'Password change failed. The existing password and notes are unchanged.';
    } finally {
      submit.disabled = false;
      submit.textContent = 'Change password';
    }
  }

  async function toggleNoteLock() {
    const n = current();
    if (!n) return;

    if (n.locked) {
      if (!S.key || S.failed.has(n.id)) return;
      n.body = S.cache[n.id] || '';
      n.locked = false;
      n.cipher = null;
      delete S.cache[n.id];
      n.updated = Date.now();
      markDirty(n.id);
      await flush();
      renderAll();
      setFlash('Lock removed. This note is now stored as plain text.');
      return;
    }

    if (!S.key) {
      const opened = await requestVault();
      if (!opened) return;
    }

    // encrypt first, then switch the note over in one step so a save can
    // never catch it half-sealed
    const text = n.body;
    const cipher = await Vault.encryptText(S.key, text, n.id);
    S.cache[n.id] = n.body;
    n.cipher = cipher;
    n.body = '';
    n.locked = true;
    n.updated = Date.now();
    markDirty(n.id);
    await flush();
    renderAll();
    $('note-seal').classList.remove('stamp');
    void $('note-seal').offsetWidth;
    $('note-seal').classList.add('stamp');
    setFlash('Note locked.');
  }

  /* ---------- backup ---------- */

  async function exportBackup() {
    await flush();
    const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'logbook-backup-' + todayTitle() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    const reminderSaved = Store.markExported();
    S.exportReminderDismissed = false;
    refreshExportReminder();
    setFlash(reminderSaved
      ? 'Backup downloaded. Sealed notes stay encrypted inside it.'
      : "Backup downloaded, but the last-export date couldn't be saved and the reminder may appear again.");
  }

  async function importBackup(file) {
    if (!file) return;
    let text;
    try {
      text = await file.text();
    } catch (err) {
      setFlash("Couldn't read that file.");
      return;
    }
    const parsed = Store.parseBackup(text);
    if (!parsed.ok) {
      setFlash(parsed.error);
      return;
    }
    const ok = await confirmDialog(
      'Replace your notes with this backup?',
      'The backup has ' + parsed.count + (parsed.count === 1 ? ' note' : ' notes') +
        '. Everything currently in this browser will be replaced, so export first if you want to keep it.',
      'Replace notes'
    );
    if (!ok) return;

    await flush();
    if (!Store.replaceAll(parsed.data)) {
      setFlash("Couldn't save the imported backup in this browser.");
      return;
    }
    S.key = null;
    S.cache = Object.create(null);
    S.failed = new Set();
    S.pending.clear();
    S.tag = null;
    S.query = '';
    $('search').value = '';
    try { await syncFolder(); } catch (err) {
      console.error(err);
      setFlash("Backup imported locally, but couldn't update the folder copy.");
    }
    S.currentId = parsed.data.lastOpen || mostRecentId();
    renderAll();
    setFlash('Backup imported. Sealed notes open with the vault password from that backup.');
  }

  async function importFolderData(data, confirmed) {
    if (!data) {
      setFlash('No Logbook Markdown backup was found in that folder.');
      return false;
    }
    const parsed = Store.parseBackup(JSON.stringify(data));
    if (!parsed.ok) {
      setFlash(parsed.error);
      return false;
    }
    if (!confirmed) {
      const ok = await confirmDialog(
        'Restore ' + parsed.count + (parsed.count === 1 ? ' note' : ' notes') + ' from this folder?',
        'This replaces notes and Trash currently in the browser. Export a backup first if you want to keep them.',
        'Restore folder'
      );
      if (!ok) return false;
    }

    await flush();
    if (!Store.replaceAll(parsed.data)) {
      Store.replaceAllFromFolder(parsed.data);
      setFlash('Restored from the folder, but browser storage is full. The connected folder will store future changes.');
    }
    S.key = null;
    S.cache = Object.create(null);
    S.failed = new Set();
    S.pending.clear();
    S.tag = null;
    S.query = '';
    $('search').value = '';
    S.currentId = parsed.data.lastOpen || mostRecentId();
    renderAll();
    renderTrash();
    if (Store.status().persistent) {
      setFlash('Folder backup restored. Sealed notes still require their vault password.');
    }
    return true;
  }

  async function connectFolder() {
    try {
      if (Folder.hasDirectory()) {
        await syncFolder();
        setSaveState('Folder synced ' + clock());
        setFlash('Markdown folder backup is up to date.');
        return;
      }
      await Folder.choose();
      const existing = await Folder.readBackup();
      if (existing) {
        const restore = await confirmDialog(
          'Use the existing folder backup?',
          'Restore replaces notes and Trash in this browser with the folder copy. Cancel keeps browser notes; syncing them into the folder requires a separate confirmation.',
          'Restore folder'
        );
        if (restore) {
          const imported = await importFolderData(existing, true);
          if (!imported) return;
        } else {
          const overwrite = await confirmDialog(
            'Replace the folder backup with browser notes?',
            'This updates the Markdown files in the selected folder to match this browser.',
            'Sync browser notes'
          );
          if (!overwrite) return;
        }
      }
      await syncFolder();
      renderVault();
      setSaveState('Saved ' + clock() + ' · folder synced');
      setFlash('Markdown folder backup is connected.');
    } catch (err) {
      console.error(err);
      setFlash(err.message || "Couldn't access that folder.");
    }
  }

  async function restoreFolder() {
    try {
      await Folder.choose();
      const data = await Folder.readBackup();
      await importFolderData(data);
      renderVault();
    } catch (err) {
      console.error(err);
      setFlash(err.message || "Couldn't read that folder.");
    }
  }

  function dailyDate(note) {
    const match = note.title.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 ||
        date.getDate() !== Number(match[3])) return null;
    return date;
  }

  function openDailyNote(date) {
    const title = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
    const note = Store.findByTitle(title) || createNote(title, '## Today\n\n## Next\n\n');
    S.mode = 'edit';
    $('calendar-dialog').close();
    openNote(note.id, { focus: 'editor' });
  }

  function renderCalendar() {
    const first = new Date(S.calendarMonth.getFullYear(), S.calendarMonth.getMonth(), 1);
    $('calendar-title').textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const entries = new Map();
    Store.all().forEach(function (note) {
      const date = dailyDate(note);
      if (date) entries.set(note.title, note);
    });
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    const today = todayTitle();
    const grid = $('calendar-grid');
    grid.textContent = '';
    for (let index = 0; index < 42; index++) {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const key = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'calendar-day';
      button.textContent = String(date.getDate());
      button.dataset.date = key;
      button.setAttribute('role', 'gridcell');
      if (date.getMonth() !== first.getMonth()) button.classList.add('outside-month');
      if (key === today) button.classList.add('today');
      if (entries.has(key)) {
        button.classList.add('has-note');
        button.title = 'Open daily note ' + key;
        button.setAttribute('aria-label', key + ', daily note exists');
      } else {
        button.title = 'Create daily note ' + key;
        button.setAttribute('aria-label', key + ', no daily note');
      }
      grid.appendChild(button);
    }

    const matches = Store.all().filter(function (note) {
      const date = dailyDate(note);
      return date && date.getMonth() === new Date().getMonth() &&
        date.getDate() === new Date().getDate() && date.getFullYear() < new Date().getFullYear();
    }).sort(function (a, b) { return b.title.localeCompare(a.title); });
    const onThisDay = $('on-this-day');
    onThisDay.textContent = '';
    if (!matches.length) {
      const empty = document.createElement('li');
      empty.className = 'none';
      empty.textContent = 'No entries from this date in previous years.';
      onThisDay.appendChild(empty);
    } else {
      matches.forEach(function (note) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'link-btn';
        button.dataset.open = note.id;
        button.textContent = note.title + ' — ' + visibleTitle(note);
        li.appendChild(button);
        onThisDay.appendChild(li);
      });
    }
  }

  function showLinkSuggestions() {
    const ed = $('editor');
    const popup = $('link-suggestions');
    const before = ed.value.slice(0, ed.selectionStart);
    const match = before.match(/\[\[([^\]\n]*)$/);
    if (!match || ed.hidden || !current() || bodyOf(current()) === null) {
      popup.hidden = true;
      S.linkMatches = [];
      return;
    }
    const query = match[1].trim().toLowerCase();
    S.linkMatches = Store.all().filter(function (note) {
      if (Store.hideSealedTitles() && !S.key && note.locked) return false;
      return visibleTitle(note).toLowerCase().includes(query);
    }).sort(function (a, b) {
      return b.updated - a.updated || a.title.localeCompare(b.title);
    }).slice(0, 8);
    S.linkIndex = 0;
    popup.textContent = '';
    S.linkMatches.forEach(function (note, index) {
      const option = document.createElement('button');
      option.type = 'button';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', index === S.linkIndex ? 'true' : 'false');
      option.textContent = visibleTitle(note);
      option.addEventListener('pointerdown', function (event) { event.preventDefault(); });
      option.addEventListener('click', function () { insertLinkSuggestion(note.title); });
      popup.appendChild(option);
    });
    popup.hidden = S.linkMatches.length === 0;
  }

  function insertLinkSuggestion(title) {
    const ed = $('editor');
    const before = ed.value.slice(0, ed.selectionStart);
    const match = before.match(/\[\[([^\]\n]*)$/);
    if (!match) return;
    const start = ed.selectionStart - match[0].length;
    const insertion = '[[' + title + ']]';
    ed.value = ed.value.slice(0, start) + insertion + ed.value.slice(ed.selectionStart);
    ed.setSelectionRange(start + insertion.length, start + insertion.length);
    ed.focus();
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    $('link-suggestions').hidden = true;
  }

  function moveLinkSelection(direction) {
    if (!S.linkMatches.length) return;
    S.linkIndex = (S.linkIndex + direction + S.linkMatches.length) % S.linkMatches.length;
    Array.from($('link-suggestions').children).forEach(function (option, index) {
      option.setAttribute('aria-selected', index === S.linkIndex ? 'true' : 'false');
    });
  }

  /* ---------- graph ---------- */

  function graphColors() {
    const css = getComputedStyle(document.documentElement);
    const get = function (name) { return css.getPropertyValue(name).trim(); };
    return {
      node: get('--accent'),
      line: get('--line'),
      ink: get('--ink'),
      muted: get('--muted'),
      seal: get('--seal'),
      font: get('--sans')
    };
  }

  function openGraph() {
    const dlg = $('graph-dialog');
    const idx = S.index;
    const nodes = idx.notes.map(function (n) { return { id: n.id, label: visibleTitle(n), locked: n.locked }; });
    const edges = [];
    const seen = new Set();
    idx.notes.forEach(function (n) {
      (idx.links.get(n.id) || []).forEach(function (t) {
        const m = idx.byTitle.get(t.toLowerCase());
        if (!m || m.id === n.id) return;
        const k = n.id < m.id ? n.id + '|' + m.id : m.id + '|' + n.id;
        if (seen.has(k)) return;
        seen.add(k);
        edges.push([n.id, m.id]);
      });
    });

    const hasSealed = idx.notes.some(function (n) { return n.locked; });
    $('graph-note').textContent = hasSealed && !S.key
      ? 'Sealed notes appear without links until you unlock the vault.'
      : (edges.length ? 'Drag a dot to move it. Click a dot to open that note.' : 'Link notes with [[double brackets]] and the lines will appear here.');

    dlg.showModal();
    requestAnimationFrame(function () {
      if (S.graph) S.graph.destroy();
      S.graph = Graph.create($('graph-canvas'), { nodes: nodes, edges: edges }, {
        currentId: S.currentId,
        colors: graphColors,
        onOpen: function (id) {
          dlg.close();
          openNote(id);
        }
      });
    });
  }

  /* ---------- events ---------- */

  function bindEvents() {
    $('btn-new').addEventListener('click', function () {
      const n = createNote(Store.uniqueTitle('Untitled'), '');
      S.mode = 'edit';
      openNote(n.id, { focus: 'title' });
    });
    $('btn-empty-new').addEventListener('click', function () { $('btn-new').click(); });

    $('btn-daily').addEventListener('click', function () {
      openDailyNote(new Date());
    });

    const openQuickActions = function () {
      if ($('command-dialog').open) {
        $('command-dialog').close();
        return;
      }
      openCommandPalette();
    };

    $('search').addEventListener('input', function (e) {
      S.query = e.target.value;
      renderSidebar();
    });
    $('search').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.target.value = '';
        S.query = '';
        renderSidebar();
      }
    });

    $('note-list').addEventListener('click', function (e) {
      const item = e.target.closest('.note-item');
      if (item) openNote(item.dataset.id);
    });

    $('recent-list').addEventListener('click', function (e) {
      const button = e.target.closest('.recent-link');
      if (button) openNote(button.dataset.id);
    });

    $('tag-list').addEventListener('click', function (e) {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      S.tag = S.tag === chip.dataset.tag ? null : chip.dataset.tag;
      renderTags();
      renderSidebar();
    });

    $('title').addEventListener('change', function (e) { renameCurrent(e.target.value); });
    $('title').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (!$('editor').hidden) $('editor').focus();
      else e.target.blur();
    });

    $('editor').addEventListener('input', function (e) {
      const n = current();
      if (!n) return;
      const text = e.target.value;
      if (n.locked) S.cache[n.id] = text;
      else n.body = text;
      n.updated = Date.now();
      markDirty(n.id);
      updateWordCount(text);
      showLinkSuggestions();
      scheduleIndex();
    });
    $('editor').addEventListener('keydown', function (e) {
      if ($('link-suggestions').hidden) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveLinkSelection(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveLinkSelection(-1);
      } else if (e.key === 'Enter' && S.linkMatches.length) {
        e.preventDefault();
        insertLinkSuggestion(S.linkMatches[S.linkIndex].title);
      } else if (e.key === 'Escape') {
        $('link-suggestions').hidden = true;
      }
    });

    $('btn-mode').addEventListener('click', function () {
      S.mode = S.mode === 'edit' ? 'preview' : 'edit';
      renderEditor();
      if (S.mode === 'edit' && !$('editor').hidden) $('editor').focus();
    });

    $('btn-focus').addEventListener('click', function () { toggleFocusMode(); });
    $('btn-lock-note').addEventListener('click', toggleNoteLock);
    $('btn-pin').addEventListener('click', toggleCurrentPin);
    $('btn-delete').addEventListener('click', deleteCurrent);

    $('btn-sealed-unlock').addEventListener('click', function () { requestVault(); });

    $('btn-vault').addEventListener('click', function () {
      if (S.key) lockVault('Vault locked.');
      else requestVault();
    });
    $('btn-vault-password').addEventListener('click', changeVaultPassword);
    $('password-form').addEventListener('submit', submitVaultPasswordChange);

    $('btn-hide-titles').addEventListener('click', async function () {
      const saved = Store.setHideSealedTitles(!Store.hideSealedTitles());
      renderAll();
      if (!saved) {
        setFlash("Couldn't save the privacy setting.");
        return;
      }
      try { await syncFolder(); } catch (err) {
        console.error(err);
        setFlash("Privacy setting saved locally, but couldn't update the folder copy.");
      }
    });

    $('btn-calendar').addEventListener('click', function () {
      S.calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      renderCalendar();
      $('calendar-dialog').showModal();
    });
    $('calendar-prev').addEventListener('click', function () {
      S.calendarMonth.setMonth(S.calendarMonth.getMonth() - 1);
      renderCalendar();
    });
    $('calendar-next').addEventListener('click', function () {
      S.calendarMonth.setMonth(S.calendarMonth.getMonth() + 1);
      renderCalendar();
    });
    $('calendar-close').addEventListener('click', function () { $('calendar-dialog').close(); });
    $('calendar-grid').addEventListener('click', function (e) {
      const button = e.target.closest('button[data-date]');
      if (!button) return;
      const parts = button.dataset.date.split('-').map(Number);
      openDailyNote(new Date(parts[0], parts[1] - 1, parts[2]));
    });
    $('on-this-day').addEventListener('click', function (e) {
      const button = e.target.closest('button[data-open]');
      if (!button) return;
      $('calendar-dialog').close();
      openNote(button.dataset.open);
    });

    $('btn-trash').addEventListener('click', function () {
      renderTrash();
      $('trash-dialog').showModal();
    });
    $('trash-close').addEventListener('click', function () { $('trash-dialog').close(); });
    $('trash-list').addEventListener('click', function (e) {
      const restore = e.target.closest('button[data-restore]');
      const permanent = e.target.closest('button[data-permanent]');
      if (restore) restoreTrashNote(restore.dataset.restore);
      else if (permanent) permanentlyDeleteTrashNote(permanent.dataset.permanent);
    });

    $('btn-folder').addEventListener('click', connectFolder);
    $('btn-restore-folder').addEventListener('click', restoreFolder);
    $('banner-export').addEventListener('click', exportBackup);
    $('banner-dismiss').addEventListener('click', function () {
      S.exportReminderDismissed = true;
      showBanner('');
    });

    $('preview').addEventListener('click', function (e) {
      const a = e.target.closest('a');
      if (!a) return;
      if (a.classList.contains('wikilink')) {
        e.preventDefault();
        followTitle(a.dataset.title);
      } else if (a.classList.contains('tag')) {
        e.preventDefault();
        S.tag = a.dataset.tag;
        renderTags();
        renderSidebar();
      }
    });

    $('rail').addEventListener('click', function (e) {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.open) openNote(btn.dataset.open);
      else if (btn.dataset.create) followTitle(btn.dataset.create);
    });

    $('btn-graph').addEventListener('click', openGraph);
    $('graph-close').addEventListener('click', function () { $('graph-dialog').close(); });
    $('graph-dialog').addEventListener('close', function () {
      if (S.graph) {
        S.graph.destroy();
        S.graph = null;
      }
    });

    $('btn-export').addEventListener('click', exportBackup);
    $('btn-import').addEventListener('click', function () { $('file-import').click(); });
    $('file-import').addEventListener('change', function (e) {
      importBackup(e.target.files[0]);
      e.target.value = '';
    });

    function setToolsMenuOpen(open, returnFocus) {
      $('side-tools-menu').hidden = !open;
      $('btn-tools').setAttribute('aria-expanded', open ? 'true' : 'false');
      $('btn-tools').setAttribute('aria-label', open ? 'Close tools menu' : 'Open tools menu');
      if (returnFocus) $('btn-tools').focus();
    }

    $('btn-tools').addEventListener('click', function () {
      setToolsMenuOpen($('side-tools-menu').hidden);
    });
    $('side-tools-menu').addEventListener('click', function (e) {
      if (e.target.closest('button')) setToolsMenuOpen(false);
    });
    document.addEventListener('click', function (e) {
      if (!$('side-tools').contains(e.target)) setToolsMenuOpen(false);
    });

    $('btn-menu').addEventListener('click', function () { $('app').classList.add('show-side'); });
    $('backdrop').addEventListener('click', function () { $('app').classList.remove('show-side'); });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('side-tools-menu').hidden) {
        setToolsMenuOpen(false, true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openQuickActions();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleFocusMode();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        if (Store.getVault()) {
          if (S.key) lockVault('Vault locked.');
          else requestVault();
        }
      }
    });

    // keep the auto-lock timer fresh while the person is working
    ['keydown', 'pointerdown', 'input', 'wheel', 'touchstart'].forEach(function (name) {
      document.addEventListener(name, function () { S.lastActive = Date.now(); }, true);
    });
    setInterval(function () {
      if (S.key && Date.now() - S.lastActive > AUTO_LOCK_MS) {
        lockVault('Vault locked after 5 minutes without activity.');
      }
    }, 10000);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('beforeunload', function (e) {
      if (S.dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  /* ---------- start ---------- */

  const WELCOME = [
    'Welcome to your logbook. Everything you write stays in this browser.',
    '',
    '## The basics',
    '',
    '- Write in markdown. Switch between Edit and Preview at the top.',
    '- Link notes with double brackets: `[[Name of a note]]`. In Preview, clicking a link to a note that does not exist yet creates it.',
    '- Add tags with a hash, like `#trip`. Tags show up as filters in the sidebar.',
    '- Choose Today to open the note for today\'s date, or start one.',
    '- Calendar shows daily notes and notes from this day in previous years.',
    '- Type `[[` in the editor to choose a note link.',
    '- Backlinks and the Graph button show how your notes connect.',
    '',
    '## Locking a note',
    '',
    'Choose Lock note to seal a note behind your vault password. You set the password once, and it opens every sealed note. If you forget it, sealed notes cannot be recovered.',
    '',
    'Use Export in the sidebar now and then to save a backup file. Deleted notes stay in Trash for 30 days.',
    'On Chrome or Edge, Connect folder keeps a Markdown copy in a folder you choose.'
  ].join('\n');

  async function init() {
    Store.load();
    let recoveredFolder = false;
    if (Folder.supported()) {
      try {
        if (await Folder.restore()) {
          const folderBackup = await Folder.readBackupIfGranted();
          if (folderBackup && folderBackup.savedAt > Store.getSavedAt()) {
            const parsed = Store.parseBackup(JSON.stringify(folderBackup));
            if (parsed.ok) {
              Store.replaceAllFromFolder(parsed.data);
              recoveredFolder = true;
              Store.save();
              try { await syncFolder(); } catch (err) {
                console.error(err);
                setFlash("Recovered from the folder, but couldn't refresh its backup index.");
              }
            }
          }
        }
      } catch (err) {
        console.error(err);
        setFlash("Couldn't reconnect the Markdown folder. Choose Connect folder to select it again.");
      }
    }
    if (Store.purgeTrash() && !Store.save()) {
      showBanner("Expired Trash couldn't be saved. Export a backup before closing the tab.", 'error');
    }
    S.recentNotes = loadRecentNotes();

    const status = Store.status();
    if (!status.persistent) {
      showBanner(recoveredFolder
        ? "Recovered the latest notes from your folder. Browser storage is unavailable, so keep that folder safe and use Sync folder after edits."
        : "This browser isn't letting the logbook save (private mode or blocked storage). Notes will be lost when you close the tab. Use Export to keep a copy.", 'error');
    } else if (status.recovered) {
      showBanner("Saved data couldn't be read, so the logbook started fresh. The damaged copy is still in this browser under the key logbook.v1.damaged.", 'error');
    }

    if (!Store.all().length) {
      const first = Store.add({ title: 'Start here', body: WELCOME });
      Store.setLastOpen(first.id);
      if (!Store.save() && Folder.hasDirectory()) {
        try { await syncFolder(); } catch (err) {
          console.error(err);
          setFlash("Couldn't save the first note to browser storage or the folder.");
        }
      }
    }

    const last = Store.getLastOpen();
    S.currentId = last && Store.get(last) ? last : mostRecentId();
      if (S.currentId) rememberRecentNote(S.currentId);

      bindEvents();
      renderAll();
      renderTrash();
      refreshExportReminder();
  }

  init();
})();

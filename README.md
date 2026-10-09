# Logbook

A private, Obsidian-style journal that runs entirely in your browser.

## Run it

Open `index.html` in a browser. No build step and no server needed.
You can also serve the folder (for example `python3 -m http.server`) and open `http://localhost:8000`.

Notes are stored in your browser's local storage **for the exact address you opened**.
`file:///.../index.html` and `http://localhost:8000` are different places, so pick one and stick with it.
Clearing site data erases browser notes, so use **Export** now and then. Logbook reminds you when
it has been two weeks since your last JSON backup.

On recent Chrome and Edge versions, choose **Connect folder** to keep a live Markdown copy in a
folder you select. Each note is a `.md` file under `Notes/`, and Trash is mirrored under `Trash/`;
sealed notes remain encrypted. Logbook stages changed files under new names and updates its
`.logbook.json` index last, so the folder backup keeps its previous complete snapshot if a write
fails. The
browser remains the primary copy, and **Restore folder** imports a folder backup after confirming
replacement. A connected folder can also accept edits when browser storage runs out; it can
automatically restore a newer successful folder snapshot on the next launch when permission is
still granted. Keep the selected folder available and use **Sync folder** if access needs to be
re-authorized. Other browsers can continue using Export/Import JSON.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page structure and dialogs |
| `css/style.css` | All styling, light and dark |
| `js/crypto.js` | Vault encryption (PBKDF2 → AES-GCM via the browser's Web Crypto) |
| `js/markdown.js` | Markdown rendering, `[[links]]`, `#tags` |
| `js/store.js` | Saving and loading notes, backups |
| `js/folder.js` | Optional Markdown folder backup and restore |
| `js/graph.js` | Graph view |
| `js/app.js` | Ties everything together |

## Highlights

- Quick actions: press `Ctrl/Cmd + K` for a command palette to open notes, create a new note,
  jump to Today, open the calendar, or toggle focus mode.
- Recent notes: the sidebar keeps a short, local list of recently opened notes for faster switching.
- Focus mode: press `Ctrl/Cmd + B` or the Focus button to hide the sidebar and rail while you write.
- Outline view: headings in the current note are surfaced in the right rail to quickly jump around.
- Visual note linking: typed `[[...]]` suggestions, backlinks, and graph connections all work in the existing browser-only model.

## How locking works

- You set one vault password. It is never stored. The app keeps a random salt and a small encrypted check value to verify later attempts.
- Locking a note encrypts its text. Only the title stays readable.
- Sealed text exists in plain form only in memory while the vault is open. The vault locks on request, or after 5 minutes without activity.
- **Change password** is available only while unlocked. It prepares new ciphertext for every
  sealed note, then commits the entire new vault and note set in one local-storage write. With a
  connected folder, the versioned Markdown snapshot is committed by switching its index only
  after all changed files are written. If a folder write fails after the browser commit, the
  browser copy remains valid and you can retry with **Sync folder**.
- A forgotten vault password cannot be recovered. The optional hint is stored unencrypted.
- Exports keep sealed notes encrypted.
- Deleted notes go to **Trash** for 30 days and can be restored before expiry.
- Use **Pin note** to keep important notes at the top of the sidebar; pins are included
  in JSON exports and connected-folder backups.
- **Hide sealed titles** masks locked titles in the sidebar, current-note header, and graph until
  the vault is unlocked.
- **Calendar** shows daily notes (notes titled `YYYY-MM-DD`) and a small “On this day” list.
- Type `[[` in the editor and use the arrow keys/Enter to select a note title.

## Known limits

- Renaming a note updates `[[links]]` in other notes, but sealed notes can only be updated while the vault is open.
- Notes live in one browser on one device. Folder copies are local backups, not live cross-device
  sync; edits made directly to Markdown files are not merged automatically.

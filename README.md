# <img src="icons/icon-96.png" alt="" width="40" height="40" align="absmiddle"> tabnotes

Markdown notes that live in your Firefox tabs. Click the toolbar button and a note opens as a tab, right next to the page it belongs to. Keep a note under a ticket, a document or a [Sidebery](https://addons.mozilla.org/firefox/addon/sidebery/) group, and it stays there, even after you restart Firefox.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/note-dark.png">
  <img alt="A note tab with the markdown editor on the left and the live preview on the right" src="docs/screenshots/note-light.png">
</picture>

## Features

- **Notes as tabs.** Each note is a normal tab, nested under the tab you opened it from if you use Sidebery.
- **Editor and live preview.** Work side by side, or show only one of the two. Everything saves as you type.
- **Rich previews.** Task lists you can tick, tables, highlighted code with a Copy button, and [Mermaid](https://mermaid.js.org/) diagrams.
- **Images.** Drop or paste images into a note, up to 25 MB each.
- **All notes.** Search, reopen and tidy up every note in one place, including tabs you closed.
- **A bin.** Deleted notes stay for 30 days before they are removed.
- **Light and dark.** Follow your system or pick one.
- **Private.** Notes stay in this Firefox on this device. The extension makes no network requests.

## Install

You need Firefox 143 or newer.

1. Open the [latest release](https://github.com/Semior001/tabnotes/releases/latest) and click the `.xpi` file.
2. Confirm the install. If Firefox only downloads the file, open `about:addons`, click the gear menu, choose "Install Add-on From File..." and pick the file.

Updates are not automatic: install each new version the same way. Your notes stay in place.

The extension asks for these permissions:

| Permission | Why |
| --- | --- |
| `storage` | Keep your notes and images in Firefox |
| `tabs` | Open note tabs and find the ones already open |
| `sessions` | Restore note tabs you closed |

## Using tabnotes

### Write a note

Click the tabnotes button in the toolbar. Type markdown on the left and see the result on the right. Press `Ctrl+E` (`Cmd+E` on Mac) to switch between both panes, the editor only and the preview only.

The preview works too:

- Click a checkbox to tick the task.
- Hover over a code block to copy it.
- Double-click a block to jump to it in the editor.
- Click a link to open it in a new tab.

To add an image, drop it into the editor or paste it from the clipboard.

### Find your notes

Open **All notes** from the header of any note. Notes are grouped into Open, Recently closed, Other notes and Bin. Click a row to go to the note, reopen its tab or restore it along with its window.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/all-notes-dark.png">
  <img alt="The All notes page with sections for open, recently closed, other and binned notes" src="docs/screenshots/all-notes-light.png">
</picture>

Press `/` to search. Tick rows, or Shift-click a range, to move several notes to the Bin at once. "Undo" brings them back, but not their tabs.

### Delete and restore

"Move to Bin" closes the note's tabs and keeps the note for 30 days. Open the Bin section in All notes to restore it or delete it forever.

### Settings

Choose the default title for new notes, the font size for all notes, and the theme.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/settings-dark.png">
  <img alt="The Settings page with default title, font size and theme" src="docs/screenshots/settings-light.png">
</picture>

## Keyboard shortcuts

Use `Cmd` instead of `Ctrl` on Mac.

| Keys | Action |
| --- | --- |
| `Ctrl+E` | Switch between split, editor and preview |
| `Ctrl+B` | Bold |
| `Ctrl+I` | Italic |
| `Ctrl+K` | Insert a link |
| `Ctrl+F` | Find |
| `Ctrl+G` / `Shift+Ctrl+G` | Next / previous match |
| `Shift+Ctrl+F` | Replace (`Cmd+Alt+F` on Mac) |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Larger / smaller / default font size |
| `/` on All notes | Search |
| `Esc` on All notes | Clear the selection |

## Good to know

- **Removing the extension deletes your notes.** Notes are stored inside the extension, and there is no sync or export. They do not move to another device or Firefox profile.
- Remote images, such as `![](https://...)`, do not load. Add the image to the note instead.
- HTML in a note is shown as plain text.
- A deleted image still takes up space for at least 7 days, so you can undo the change.
- Keep a note open if it shows a save error, for example when storage is full. Closing the tab loses the unsaved text.

## Development

Building, testing and releasing are covered in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

[MIT](LICENSE). The packaged extension includes third-party code, listed with its licenses in `THIRD_PARTY_LICENSES.txt` at the root of the `.xpi`.

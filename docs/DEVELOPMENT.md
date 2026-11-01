# tabnotes development

User documentation is in [README.md](../README.md). This file holds the detailed behaviour, build, release and test notes.

## Behaviour

Firefox (MV2) extension: markdown notes as tabs, nested under the tab they were opened from.

- The toolbar button (no popup) opens a new note tab (`note/note.html?id=<uuid>`) as a child of the current tab via `openerTabId`, so Sidebery nests it under that tab or Sidebery group. A note under a Jira ticket tab or a named group is how notes go "into a folder". The URL names no kind, so the note page takes it from Settings.
- A note tab has a side-by-side markdown editor and live preview. `Ctrl+E` / `Cmd+E` (the physical E key, on any keyboard layout) or the mode button cycles split, editor only and preview only (on mac, `Ctrl+E` in the editor stays CodeMirror's move to line end). Edits are saved after 500ms and flushed when the tab closes.
- The editor is CodeMirror 5: markdown highlighting (fenced code too, for js, go, python, shell, yaml, css, html/xml and sql, including aliases like `js`, `py`, `sh`), line numbers, soft wrapping, list continuation on Enter, `Tab` / `Shift+Tab` indent, bracket matching and auto-closing. Shortcuts (`Cmd` instead of `Ctrl` on mac, where `Ctrl+B` / `Ctrl+K` keep CodeMirror's emacs bindings in the editor), active while the editor has focus:
  - `Ctrl+B` / `Ctrl+I` wrap the selection in `**` / `_`, or unwrap it when already wrapped; `Ctrl+K` inserts a link (`[selection](url)` with `url` selected, or `[](url)` with the cursor in the brackets).
  - Search: `Ctrl+F` find, `Ctrl+G` / `Shift+Ctrl+G` next / previous, `Shift+Ctrl+F` replace, `Shift+Ctrl+R` replace all (CodeMirror's default keys; on mac `Cmd+Alt+F` replace and `Shift+Cmd+Alt+F` replace all).
- Font size: one size (10-32px, default 14) for the editor and preview of every note tab, applied live. On a note page `Ctrl+=` (or `Ctrl++`) / `Ctrl+-` change it by 1px and `Ctrl+0` resets it to 14; these replace Firefox page zoom on note pages. The Settings field applies when you press Enter or leave the field, and always shows the current size: a change from a note tab replaces a value typed but not yet applied.
- Theme: System, Light or Dark, set in Settings (default System) and applied live to every note, All notes and Settings tab, including the editor, highlighted code and mermaid diagrams, which redraw. System follows `prefers-color-scheme`, which in Firefox follows Settings > General > Website appearance, so it means the OS or browser theme only when that is Automatic.
- The tab title is the note title, set when the note is created from the default title in Settings ("Notes" unless changed) and changed by renaming the note in its header. Other tabs of a stored note follow a rename live; a blank note's new title stays in its own tab, as only `storage.local.remove` runs.
- Rename: click `#title`, or focus it and press Enter or Space, to get an input holding the title, selected, with a hint listing the variables and functions. Enter or leaving the input commits and Esc cancels; Enter and Esc return focus to the title. Switching tab or window keeps the input open, and `Ctrl+E` does nothing in it, Firefox's own action included. Text left as it was opened, surrounding spaces aside, writes nothing, and a result that is empty keeps the old title. A tab that stopped saving does not open the input, and a stop closes an open one without committing. A blank note keeps a new title in memory only, as a blank note is not stored; typing then stores it, and closing the tab loses it.
- Title templates: the default title and a rename accept `{name}` or `{name | fn arg | fn}`, with functions running left to right. Variables are `{date}` (`2026-11-01`), `{time}` (`14:05`) and `{weekday}` (`Sunday`, always English), all local time, plus `{tab}` and `{host}`, the title and hostname of the tab the note was opened from, read once when the note page loads. Functions are `trunc N` (at most N code points including the `…`, N an integer from 1), `lower` and `upper`. A placeholder with an unknown variable or function or a wrong argument stays as literal text, as does `{}`; `{{date}}` gives `{2026-11-01}`. `{tab}` and `{host}` are empty with no opener or a closed one, as for a tab All notes opens with `tabs.create`, and `{host}` is empty unless the URL is `http:` or `https:`. A template expands once, at creation or commit, so the note stores plain text; a default that expands to nothing gives "Notes".
- Settings: the default title is stored as typed, template included, and the same hint shows under its field. Changing it affects only new notes. "Notes created by the toolbar button" picks Permanent (the default) or Temporary.
- Note kinds: a permanent note stays until it is deleted. A temporary note closed for 30 days moves to the bin by itself, for a 7-day stay. A stored note with no `temporary` flag is permanent, so notes from older versions never expire. The kind is set at creation, by `&temporary=1` or `&temporary=0` from All notes or else by Settings, and a stored note ignores both. The `#kind` header button shows the kind and toggles it, with the rule in its tooltip; it is hidden on a binned note and on a tab that stopped saving. Other tabs of the note follow the change live. A blank note keeps its kind in memory only, as a blank note is not stored.
- Close clock: a sweep in the background script, every 10 minutes and not at startup, compares stored notes with open note tabs. A live temporary note with no tab enters `closedNotes` with the sweep's time, and one that is open, permanent, binned or gone leaves it. A note is due when the latest of that time, `updatedAt` and `restoredAt` is 30 days old, so a restore restarts the clock even if no sweep saw the note binned. Before writing, the sweep reads the due notes and the tabs again, and skips a note that is open, binned, gone, no longer temporary, edited or restored since. If any read fails it writes nothing and bins nothing, since an empty tab list would make every note look closed. A failed write keeps the id in the map, so the next sweep retries it. It does not run at startup because the background page starts before session restore, when open tabs would look closed; a sweep during a slow restore can only add an entry, and binning needs one already 30 days old. A session under 10 minutes runs no sweep, which errs towards keeping notes.
- Note tabs survive Firefox restarts in their tree position: Firefox session restore and Sidebery keep the URL, and the `id` in it names the note.
- Links in the preview never navigate the note tab: `http(s)` links (click or middle-click) open in a new child tab, every other scheme is ignored.
- Header links: the note page has "All notes" and "Settings", All notes has "Settings", Settings has "All notes". "All notes" focuses an open All notes tab instead of opening a second one.
- **All notes** (`recovery/recovery.html`) lists every stored note, one line each, in up to four sections, refreshed live on tab, session and note changes. Sections with no notes are hidden, and headings show counts. A row shows the note's name, a plain text preview and its age. A live temporary note also shows "Temporary" and, outside Open, the days left of its close clock (the full 30 with no `closedNotes` entry yet), as the map can be one interval stale for an open note. A note with the default title, either "Notes" or the text set in Settings, is named by its first heading or line, also if it was renamed to exactly that text. A title expanded from a template differs from the template, so such a note shows that title. Clicking a row runs its main action, and the other actions show on hover or keyboard focus:
  - Open: go to the tab. "Make temporary" or "Make permanent", "Move to Bin".
  - Recently closed: restore the tab, or the window ("Restore window (N tabs)" in the tooltip) when closed with its window. "Make temporary" or "Make permanent", "Move to Bin".
  - Other notes: open a note tab. "Make temporary" or "Make permanent", "Move to Bin".
  - Bin, closed by default: "Restore", "Delete forever" (asks for confirmation), "Empty bin" (asks too, and covers notes the search hides). Shows days left.
  - Search covers note content and titles other than the default, highlights hits and shows the text around them. "New permanent note" and "New temporary note" open an empty note of that kind, whatever Settings says.
  - Selection: tick rows, Shift-click for a range, or use "Select all" in a section. A bar then replaces the header with "Make permanent", "Make temporary" and "Move to Bin", or "Restore" and "Delete forever" for Bin notes: live and Bin notes cannot be selected together. Esc or "Clear" ends it, and `/` focuses search.
  - "Move to Bin" offers "Undo" until the next bulk action or reload. Undo restores the notes but not their tabs, so they list under Recently closed or Other notes.
  - A kind change closes no tabs and has no Undo: running the opposite action is the undo. It also ends an Undo still on offer from an earlier move. A note already of that kind is not written or stamped, so a mixed selection does not restart any clock or reorder rows. The status line counts only notes that changed.
- **Bin**: Move to Bin asks every tab of the note to save and stop, closes them, then moves the note to the bin. Binned notes are purged by the background script (on startup and every 24h) 30 days after deletion, or 7 days after an automatic move. A manual move stays at 30 days for both kinds, and a restored note keeps its kind and goes back to the full stay, with its close clock starting again. An open tab of a binned note shows a banner with days left and "Restore"; if the note is deleted forever or purged, the tab shows "This note was deleted" and stops saving.
- A note is stored only once it has content; clearing a note's content removes it, unless the note is in the bin.
- The preview renders markdown; raw HTML in a note is shown as text. Fenced code blocks are highlighted (highlight.js, common languages). ```` ```mermaid ```` blocks render as diagrams (mermaid, `securityLevel: 'strict'`; `%%{init}%%` directives cannot set the security keys or `themeCSS` / `fontFamily` / `altFontFamily`); the 3.6 MB mermaid script is loaded only once a preview contains one. An invalid diagram stays as its source text. Diagrams render only while the preview is visible (mermaid cannot lay them out in a hidden pane), so in editor-only mode, or when the preview is hidden while they render, they render once the preview is shown again.
- The preview is interactive; every change goes through the editor, so saving, undo and other tabs of the note work as for typing:
  - Clicking a task checkbox toggles `[ ]` / `[x]` in the source. A box whose source line cannot be proven does not tick, and logs `tabnotes: toggle task:`. A click right after typing, before the preview has caught up, only refreshes it; click again. A tab that stopped saving does not toggle.
  - Code blocks have a Copy button, shown on hover and on keyboard focus. Diagrams have none. A failed copy keeps the Copy label and logs `tabnotes: copy code:`.
  - Double-clicking a block moves the editor cursor to that block's first line, leaving preview-only mode for split if needed. Links, checkboxes and buttons do not jump, and a block means a top-level one: anywhere in a list goes to the start of the list. In a tab that stopped saving the editor takes no focus and does not scroll, so a jump only moves its hidden cursor.
  - In split mode the two panes scroll together. The pane you last used leads.
- **Images**: drop image files into the editor, or paste an image from the clipboard, to add them to a note at the drop position or over the selection.
  - Each image is stored on its own and the note text holds a short reference, `![name](tabnotes-image:<uuid>)`. The reference works in any note of this install, so it can be moved or copied between notes. Copied out of the extension it is only text: the image stays behind.
  - An image can be up to 25 MB. A larger file is refused, and a refused or failed image shows a message on the page and changes no note text.
  - A paste holding both text and an image stays text, so cells copied from an office app are not pasted as a picture, unless the text is a lone URL or absolute path, which is what Copy Image and file managers put next to the image: then the image is pasted. A drop with no images keeps CodeMirror's handling, which inserts text files; in a drop that holds an image, other files are skipped and the message names them. A file dropped on the note page outside the editor is ignored.
  - Removing a reference does not free space right away: an image is deleted at least 7 days after the background script first finds it unreferenced, on startup or every 24h, so undo and moving a reference between notes keep working. An image referenced only by a note in the bin stays: Delete starts no clock, so the images of a binned note take its 30 or 7 bin days plus the 7 days, while Delete forever takes the 7 days alone.
  - If a note cannot be saved, for example because images filled storage, the page shows a message until a later save lands. Keep the tab open meanwhile: closing it loses the unsaved text.
- TypeScript bundled by esbuild into plain pages, with no framework and no runtime network access. `marked`, CodeMirror, highlight.js and mermaid are pinned npm dependencies.

Permissions: `storage`, `tabs`, `sessions`. Requires Firefox 143+ (`storage.local.getKeys`).

## Load in Firefox

`task install:debug` (after `npm ci`) builds `dist/` and starts Firefox with the extension as a temporary add-on. On Linux, macOS and Windows that is `web-ext run`: a throwaway profile, reloading on changes in `dist/`. In WSL it is the Windows Firefox, driven by `scripts/install-debug.ps1` because `web-ext` cannot reach it from WSL: a separate profile in `%TEMP%\tabnotes-dev`, next to any Firefox already open. It exits once the add-on is loaded and does not watch files, so run it again to rebuild and reload.

By hand:

1. Run `npm ci` once (needs Node, see Tests), then `task build:dist` (or `node scripts/build.js`) to write the unpacked extension to `dist/`.
2. Open `about:debugging#/runtime/this-firefox`.
3. "Load Temporary Add-on..." and pick `dist/manifest.json`, not the one at the repo root. After a rebuild, press "Reload" there.
4. Use "Inspect" there to open devtools for the background script; open a note, All notes or Settings tab while it is attached.

Temporary add-ons are removed on restart and get a new `moz-extension://` uuid on every load, so note tabs from a previous dev session break. For a permanent install use a signed xpi from a release (see Install).

## Build, sign and install

Release Firefox only installs signed add-ons permanently, and signing runs in the release workflow (see Release). [Taskfile](https://taskfile.dev) tasks wrap the build and Mozilla's `web-ext` (run through `npx`, pinned in `Taskfile.yml`, not a dependency). Run `npm ci` first on a fresh checkout or after a lockfile change:

```
task test           # tsc --noEmit, then node --test
task build:dist     # write the unpacked extension to dist/
task install:debug  # build, then start Firefox with it as a temporary add-on (WSL: the Windows Firefox)
task lint           # build:dist, then the AMO linter on dist/
task build          # test + lint, then web-ext-artifacts/tabnotes-<version>.zip
task sign           # run by the release workflow: test + lint, upload dist/ and the source to AMO as unlisted, download the signed .xpi
```

The root `manifest.json` holds the placeholder version `0.0.0`, so a build without `RELEASE_VERSION` is `0.0.0`. The release tag sets the real version.

`task sign` is the entry point of the release workflow, not a local command. It refuses to run without `RELEASE_VERSION`, as it would burn the placeholder on AMO, and without `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` in the environment. It packages `dist/` from the working tree but archives the source from `HEAD`, so it also refuses a dirty tree (untracked files count, ignored ones do not).

### Install

Open the GitHub release of the version and click its `.xpi`. If Firefox only downloads it, install the file from `about:addons` > the gear menu > "Install Add-on From File...". Which of the two a release link gives is unverified (Manual verification). There are no automatic updates, so install each new version the same way.

### Building from source

For AMO reviewers: `sign` uploads `web-ext-artifacts/source-<version>.zip`, a `git archive --format=zip HEAD` of the tagged commit, next to the package. The `manifest.json` in that source says `0.0.0`, because the version comes from the tag and is written into the build only. Dependencies are pinned in `package-lock.json`. To reproduce the package of version X.Y.Z from that source, with Node `^22.18.0 || >=23.6.0` and npm:

```
npm ci
RELEASE_VERSION=X.Y.Z node scripts/build.js
```

`dist/` is then the extension. esbuild bundles the entries under `src/` (TypeScript and CSS, not minified), `manifest.json` is copied in with its version set to `RELEASE_VERSION`, `icons/` and the three HTML pages are copied in, `vendor/mermaid.min.js` is an unmodified copy of `node_modules/mermaid/dist/mermaid.min.js`, and `THIRD_PARTY_LICENSES.txt` is generated from the lockfile, `node_modules` and `scripts/mermaid-bundled-licenses.txt`. A signed xpi also has a `META-INF/` directory, which AMO's signing adds. A `RELEASE_VERSION` that is not `X.Y.Z` fails the build; an empty one counts as unset.

### Release

Releases are published on GitHub, while the xpi is unlisted on AMO: there is no AMO listing, and the only place to get it is the release page, from where it is installed by hand.

Push `main`, then tag a commit on it:

```
git tag vX.Y.Z && git push origin vX.Y.Z
```

The tag is the version: CI writes it into `dist/manifest.json` and commits nothing back. Only strict `vX.Y.Z` tags release. A pre-release suffix is rejected, as AMO's version format would not take a semver pre-release as is. The tag has to be above the highest version on AMO, which holds 0.6.0, so the next tag is at least `v0.7.0`. The guard sees only the tags in the repo, and versions up to 0.6.0 have none, so a mistyped burned version fails only at AMO.

`.github/workflows/release.yml` then runs two jobs, one run per tag at a time:

1. `guard`, with no secrets: the tag is a strict `vX.Y.Z`, the tagged commit is on `origin/main`, and the tag is the highest version among the strict tags, so a mistyped lower tag stops before signing. The actor check is a job-level `if` on both jobs: for anyone but the repo owner they show as skipped, with no error.
2. `release`, in the `release` environment, once the owner approves the deployment: `npm ci`, then `task sign` with `RELEASE_VERSION` (tests, lint, clean tree, source zip, AMO), within a 30 minute job limit. The signed xpi is uploaded as the `signed-xpi` workflow artifact right after signing, then the notes are written and `gh release create` publishes the release with the xpi attached.

`.github/workflows/ci.yml` runs `task test`, `tests/build.test.js` with `RELEASE_VERSION` set, as `task sign` does, and `task lint` on pushes and pull requests to `main`, with a read-only token and no secrets.

**Secrets.** All live in the `release` environment, not at repo level, so a job outside it cannot read them.

| Key | Required | Source |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | no, notes fall back without it | `claude setup-token` |
| `WEB_EXT_API_KEY` | yes | AMO API credentials, "JWT issuer" |
| `WEB_EXT_API_SECRET` | yes | AMO API credentials, "JWT secret" |

Get the AMO credentials at https://addons.mozilla.org/developers/addon/api/key/ (Developer Hub > Tools > Manage API Keys > "Generate new credentials"). The secret is shown only once. The key looks like `user:12345678:123`, the secret is 64 hex chars.

**Maintainer-only guards.** A tag-triggered workflow runs the workflow file of the tagged commit, so a check inside the file does not bind someone who can push that commit and tag. GitHub settings are the real boundary, and they live outside this repo, so until they are set only the workflow checks apply. Before the first tag, create the `release` environment with the tag policy below and the secrets above: without them `task sign` stops at its credentials precondition.

- Tag ruleset `release tags` on `refs/tags/v*`: restricts creation, update and deletion, with the repository admin role as the only bypass.
- `release` environment with a deployment policy of type tag, not branch, allowing only `v*.*.*`. A branch-type entry would let a branch named `v1.2.3` through. The owner is its required reviewer, so a release waits for approval in the Actions run before it reads the secrets.
- `main` ruleset on `refs/heads/main` blocking force-push and deletion, with no bypass. With other collaborators, also require PRs, since the guards limit who releases, not what `main` holds: code on `main` is signed by the next tag.
- Release immutability, as a write collaborator could otherwise replace assets on a published release.
- `sha_pinning_required` in the repo's Actions permissions, so a workflow using an action not pinned to a full SHA fails.
- `ci.yml` checks as required on `main` if PRs become the only path.
- Fork PR approval for all external contributors, Dependabot alerts, secret scanning, push protection and private vulnerability reporting.

The workflow checks are a second layer that catches mistakes and works if a setting is lost. Besides `guard`, the `release` job repeats the actor check, because "Re-run failed jobs" does not re-run a `guard` that passed. The trigger is tag pushes only, with no manual or chained trigger.

**Notes.** `scripts/release-notes.js` writes them, for the commits from the highest lower tag that has a GitHub release, so a burned tag adds no gap, up to this tag. If the list of releases could not be read they start at the highest lower tag, and with no earlier tag they cover all history. With `CLAUDE_CODE_OAUTH_TOKEN` set, Claude Code writes them from the commit log and the merged PRs. If the token is missing or blank, or Claude fails, times out after 2 minutes or returns nothing usable, they fall back to `### Features` and `### Fixes` from conventional commits and PR titles and `### Other` for non-conventional ones. Other conventional types are skipped unless nothing else exists, then all entries go in a plain list. A `::notice` in the log names the source and the reason. A range with no commits writes `No changes since <previous tag>.`. If the script writes no file, the release uses `gh release create --generate-notes`. No notes failure blocks a release.

**Upload uuid cache.** web-ext saves the uuid of an upload in `dist/.amo-upload-uuid` once AMO's validation passes, and reuses it for a rebuild with the same content. The workflow keeps that file in the Actions cache per tag, so a re-run skips the upload and validation. That covers only a failure between validation and submitting the version. It does not cover a failure during validation, where no uuid is saved yet, or anything after the submit, as a reused uuid submits the version again and AMO already holds it.

### Recovery

AMO signs each version once, so nothing in the workflow is undone after a failure. Find the failed step:

- `guard` failed: nothing was signed and no secret was read. Remove the tag with `git push origin :refs/tags/vX.Y.Z`, which needs the ruleset bypass, and locally with `git tag -d vX.Y.Z`, then tag the right commit.
- Both jobs show as skipped: the pusher or the re-runner is not the repo owner. There is no error and nothing ran. Have the owner push the tag or re-run it.
- `release` is refused at the environment, or `task sign` stops at its credentials precondition: the environment policy does not allow the ref, or the `release` environment or its secrets are missing. Fix the setting (Maintainer-only guards) and use "Re-run failed jobs". Nothing was signed.
- `task sign` failed and AMO does not hold the version (https://addons.mozilla.org/developers/addons): use "Re-run failed jobs" for a transient failure. If the code has to change, push the next tag, or remove the tag as above and tag the fixed commit.
- AMO approved after web-ext's 15 minute limit, so the job failed with no artifact: download the signed xpi from AMO into `xpi/` and publish it with the `gh release create` line below.
- `task sign` passed and a later step failed: do not re-run, as that repeats `task sign`. AMO is expected to refuse the version as a duplicate; this is unverified. Publish from the `signed-xpi` artifact, which stays for the repo's artifact retention period. If there is no artifact, as the upload itself failed, download the signed xpi from AMO into `xpi/` instead:

```
gh run download <run-id> --name signed-xpi --dir xpi
gh release create vX.Y.Z xpi/*-X.Y.Z.xpi --verify-tag --title vX.Y.Z --generate-notes
```

Pass `--notes-file` in place of `--generate-notes` to keep the usual format: with `CLAUDE_CODE_OAUTH_TOKEN` unset and the tags fetched, `node scripts/release-notes.js vX.Y.Z prs.json releases.json notes.md` takes missing JSON files and writes commit-based notes. If a burned tag is below this one, run `gh release list --exclude-drafts --limit 1000 --json tagName > releases.json` first, or the range starts at the burned tag.

**Burned versions.** A version AMO holds cannot be signed again, even with a bad build. Push the next tag. The burned tag stays without a release and the next notes cover its commits too.

## Layout

- `package.json`, `package-lock.json` - exact-pinned dependencies
- `tsconfig.json` - compiler options for `tsc --noEmit`
- `Taskfile.yml` - test, build, lint and sign tasks
- `.github/workflows/` - `ci.yml` (test and lint on pushes and pull requests to `main`), `release.yml` (sign and publish on a `vX.Y.Z` tag)
- `manifest.json` - MV2 manifest, copied into the build; background script `background.js`, options page, toolbar button without popup. Its version is the placeholder `0.0.0`
- `src/background.ts` - toolbar click opens a note tab, bin purge, image sweep, close sweep of temporary notes
- `src/note/` - note page (editor, preview, bin banner, image insertion, rename, kind button). `note.ts` imports marked, highlight.js (`highlight.js/lib/common`) and CodeMirror 5 with its markdown/gfm and fenced-code language modes and the overlay, edit, search and dialog addons
- `src/note/codemirror.d.ts` - the `CodeMirror.keyMap` declaration `@types/codemirror` lacks
- `src/options/` - Settings page (default title template for new notes, kind of toolbar notes, font size, theme)
- `src/recovery/` - All notes page
- `src/theme.ts` - blocking script in the head of all three pages: sets `data-theme` before first paint and follows the `theme` storage key
- `src/lib/notes.ts` - pure logic and storage types (storage keys, note URL parsing, edit/trash/restore, `setTemporary`, `trashClosed`, bin days, `closedDaysLeftText`, `KIND_HINT`, saver, `classify`, `matches`, `searchParts`, `plainPreview`, `rowText`, `shortDate`, `titleVars`, `expandTitle`, `selectRange`, `canOpen`, `codeBlockHTML`, `previewExtension`, `taskOffsets`, `toggleTask`, `previewBlocks`, `scrollMap`, `scrollAnchors`, `toggleWrap`, `linkText`, `fontSizeFrom`, `themeFrom`, `isDarkTheme`, image keys, references and `sweepImages`, `sweepClosed`, `stillDue`, `sameFirstSeen`), shared by the note page, All notes, the background script and the tests
- `src/styles/base.css` - design tokens (colours as `light-dark()`) and base control styles, imported by each page stylesheet
- `scripts/build.js` - bundles `src/` with esbuild and writes the unpacked extension to `dist/`, keeping the paths page URLs rely on; the version in `RELEASE_VERSION` is stamped into `dist/manifest.json`; mermaid is copied to `dist/vendor/mermaid.min.js`, not bundled, and loaded on demand by the note page; third-party license texts go to `dist/THIRD_PARTY_LICENSES.txt`
- `scripts/gen-icons.js` - icon generator
- `scripts/release-notes.js` - writes the notes of a GitHub release, run by the release workflow
- `scripts/mermaid-bundled-licenses.txt` - license texts of what `mermaid.min.js` bundles beyond the lockfile, appended to `dist/THIRD_PARTY_LICENSES.txt` by the build
- `LICENSE` - MIT, not packaged
- `tests/` - `node --test` suites
- `dist/` - build output (gitignored), what Firefox loads and `task lint`, `build` and `sign` package

Storage (`browser.storage.local`): one key per note, `note:<id>` = `{title, content, updatedAt, deletedAt, temporary?, binDays?, restoredAt?}` (`deletedAt` is `null` outside the bin, `title` is plain text, already expanded, `temporary` is `true` or absent, `binDays` is set only on an auto-expired note, `restoredAt` is the time of the last restore), `settings` = `{defaultTitle, temporary?}` (the template as typed, `temporary` as on a note), `fontSize` = the editor and preview font size in px (a number, its own key so note tabs and Settings never rewrite each other's keys), `theme` = `system`, `light` or `dark` (its own key too; the extension pages also keep one shared `localStorage` copy, used only for the first paint), one key per image, `image:<uuid>` = `{dataUrl}`, and `imageOrphans` = `{<uuid>: firstSeenAt}`, the unreferenced images the background script has found so far, and `closedNotes` = `{<uuid>: firstSeenClosedAt}`, the live temporary notes it has found with no open tab.

## Tests

```
npm ci
task test
```

`task test` runs `tsc --noEmit`, then `node --test`, Node's built-in test runner. Tests are JavaScript and `require` the `.ts` sources directly, which needs Node `^22.18.0 || >=23.6.0` (`engines` in `package.json`); developed on Node 26. Do not pass a bare directory as an argument: Node 21+ treats positional args as globs.

- `tests/notes.test.js` - `src/lib/notes.ts` unit tests; the checkbox mapping and block lines run against the real marked, by chosen cases and by a seeded property test over generated notes
- `tests/background.test.js`, `tests/note.test.js`, `tests/options.test.js`, `tests/recovery.test.js` - run a bundle of the real entry (`tests/bundle.js`) in a `node:vm` context against a fake DOM and a stubbed `browser` API. The note harness also runs the real marked, highlight.js and CodeMirror (so its key bindings, commands and modes are checked against the real ones), but `tests/codemirror-shim.js` replaces `CodeMirror.fromTextArea` with a fake editor and the harness stubs mermaid, which need a real DOM. Preview interactions (toggle, copy, jump, scroll sync) run there on fake layout values and a stubbed clipboard, so real scrolling, clipboard and layout are in Manual verification.
- `tests/theme.test.js` - `src/theme.ts` in the same kind of harness, with a fake `localStorage`: the mirror applies before any storage reply, storage corrects it, a change during the load wins, a rejected read and a throwing `localStorage` are logged
- `tests/build.test.js` - `scripts/build.js`: every file the manifest and pages name is in the build, nothing else is (no `tests`, `docs`, `src`, `.env`, `node_modules`), the pure logic is bundled and not a global, mermaid is an unbundled copy, third-party CSS comes before note rules, stale files go and `.amo-upload-uuid` stays, `RELEASE_VERSION` is stamped into the built manifest only, `THIRD_PARTY_LICENSES.txt` holds the notices of the shipped packages and of what mermaid bundles, the mermaid list names the installed mermaid, and a package with no license text fails the build
- `tests/deps.test.js` - `package.json`, the lockfile and `node_modules` agree on exact versions of every dependency, mermaid and CodeMirror stay on their majors, `marked` and highlight.js behave as the note page expects
- `tests/static.test.js` - no remote URLs in `src/`, no network APIs in the build (third-party code included), the manifest CSP allows only local loads plus `data:` / `blob:` images, the preview is the only HTML sink (and the sink pattern catches the other HTML-writing APIs), the fetch matcher allows `.fetch()` methods and rejects real calls, the mermaid script `note.ts` loads on demand exists in the build, exact permissions, background and options page present and no popup, referenced files exist in the build, no inline scripts, `theme.js` in each page's head before its stylesheet, `[hidden]` rule and tokens in each built stylesheet, colour tokens in `light-dark()` and the `color-scheme` rules, every coloured CodeMirror and highlight.js selector overridden with tokens, scoped `button`, `input` and `select` rules, the preview position, copy reveal and rename hint rules a fake layout cannot show, the Taskfile packages `dist/`, builds it once, uploads the source, and the preconditions of `sign`, run under bash, refuse it without `RELEASE_VERSION` or the AMO credentials
- `tests/release-notes.test.js` - `scripts/release-notes.js` pure logic, and the script in a temp git repo with a stubbed `claude` on `PATH`: PR matching per merge style, fallback sections, the range past a burned tag, every fallback trigger, and that no AMO or GitHub variable reaches `claude`. Also needs `git`.
- `tests/workflows.test.js` - `.github/workflows/*.yml` as text, as there is no YAML dependency: SHA-pinned actions, the same tool versions in both files, triggers and permissions, secrets only in the `release` job and each in the one step using it, the actor `if` on both jobs, no `${{ }}` in `run:`, the step order recovery relies on, the uuid cache, and which steps may fail. The run blocks execute under bash in a temp repo with `gh` and `task` stubs: the guard's checks, the token check, and the list, notes and publish steps in sequence with the real notes script. Also needs `bash` and `git`.

## Icons

`icons/icon-{16,48,96}.png` are generated by a dependency-free script:

```
node scripts/gen-icons.js
```

## Updating dependencies

Current versions: marked 15.0.12, CodeMirror 5.65.21, highlight.js 11.12.0, mermaid 11.17.2. Versions are exact and nothing floats. Stay on CodeMirror 5.x and mermaid 11.x: the `note.ts` code targets those majors, and mermaid's latest major is 5.5 MB.

1. Run `npm install --save-exact <package>@<version>` Commit `package-lock.json`: its integrity hashes are what check the downloaded bytes.
2. Run `task test`. `tsc` checks the new types, and `tests/static.test.js` rejects network APIs in the build. `fetch` is matched only as a bare or `window`/`globalThis`/`self` call, because mermaid bundles KaTeX, whose parser has a `.fetch()` method. After a marked update, also run the `preview mapping properties` test in `tests/notes.test.js` locally with a higher `PROPERTY_NOTES` and a few other `PROPERTY_SEED` values: checkbox mapping and block lines depend on how marked tokenizes, and the committed count only just catches a missing flip check. It generates notes with nested lists, fences, blockquotes and repeated lines and checks that toggling each non-null offset changes `checked` on exactly that index (a wrong toggle is a bug, a refusal is not), that block lines never go backwards, and that per-token `marked.parser` output matches `marked.parse`.
3. After a mermaid update, re-check the `secure` list in `src/note/note.ts`: it must stay a superset of the default in the new `mermaid.min.js`, plus `themeCSS`, `fontFamily` and `altFontFamily`. `tests/note.test.js` fails if it does not; add the missing keys to the list.
4. Run `task lint`. Warnings from third-party code are expected (`innerHTML` in CodeMirror, highlight.js and mermaid; `DANGEROUS_EVAL` for `eval` / `Function` in mermaid); new errors are not.
5. After a mermaid update, load `dist/` in Firefox, render a diagram and check the console for CSP errors. The MV2 CSP blocks `eval`, which tests cannot catch.
6. After a mermaid update, re-check `scripts/mermaid-bundled-licenses.txt`. `mermaid.min.js` is prebuilt, so the lockfile does not describe it, and the build cannot find these texts in `node_modules`. Read `sources` in `node_modules/mermaid/dist/mermaid.min.js.map`, whose `.pnpm/<name>@<version>` paths give each package (a scoped one as `@scope+name`), and in the maps under `node_modules/@mermaid-js/parser/dist/chunks/mermaid-parser.core/`, as the parser's chunks are bundles themselves. `vscode-uri` and its bundled `path-browserify` show there only as `webpack://LIB/...` paths with no version, and `vscode-uri` with no name either: take `vscode-uri` from the range langium pins, and `path-browserify` from what `vscode-uri`'s range resolves to. For each package or version not in the lockfile, take the license from its npm tarball and compare: a differing text goes in the file as its own section, an equal one in the list at its top. Then update the mermaid version in the file's header: `tests/build.test.js` holds it equal to the installed one, so a mermaid update fails until this step is done.

The build fails if a non-dev package in the lockfile has no license file, so a dependency update can stop there. Add a package that keeps its license text in the `## License` section of its README to `README_LICENSES` in `scripts/build.js`; any other case needs a look at the package.

CI pins live outside `package.json`. The Node and task versions appear in both `.github/workflows/ci.yml` and `release.yml` and a test holds them equal; Node stays inside `engines.node`. Actions are pinned to a full commit SHA with the version in a comment: take the SHA of the new tag from the action's repo and update both. `@anthropic-ai/claude-code` is pinned in the install step of `release.yml`, and `web-ext` in `WEB_EXT` in `Taskfile.yml`.

Dev dependencies follow step 1. After an esbuild update, run `task lint`; `task test` runs the network-API scan on the new build. After a highlight.js update, re-check the 36-language count in `tests/deps.test.js`. A CodeMirror or highlight.js update that adds a coloured selector fails `tests/static.test.js` until `note.css` overrides it, or dark mode would keep its light colour.

## Known limitations

- Note tabs are tied to this install's `moz-extension://` uuid: uninstalling breaks restored note tabs (and clears storage). A temporary add-on from about:debugging gets a new uuid each time, so note tabs from dev sessions break.
- Renaming a tab in Sidebery does not rename the note: the note header does.
- Two tabs of one note race on a title as last write wins: if the second tab's save delay ends before the rename reaches it, it writes the old title, and the renaming tab adopts that.
- A rename still being typed is lost when the tab closes: only the saver is flushed on `pagehide`. A blank note's new title is lost the same way and never reaches its other tabs, as a blank note is not stored.
- Text around an empty variable stays: with no opener `{date} - {tab | trunc 30}` gives `2026-11-01 -` and `{tab} - {host}` gives `-`, which also keeps the `DEFAULT_TITLE` or previous title fallback from applying, as the result is not empty. The expander does not strip separators.
- A note renamed to exactly the default title, "Notes" or the text set in Settings, is named by its first heading or line in All notes, and search skips that title.
- `{tab}` and `{host}` come from the read at load, so a rename gets the opener's title from that moment. A later rename also expands again whatever it finds in the text, so a tab title holding `{date}` survives its first expansion but not a later edit of the title.
- Bin purge runs only while Firefox is open (startup and every 24h). Editing a binned note does not postpone its purge.
- The close sweep runs only while Firefox is open, so a due note waits for the first sweep after a start, at least 10 minutes in. Time with Firefox closed counts towards the 30 days.
- A temporary note reopened and closed between two sweeps without an edit keeps its old clock, as no sweep saw it open.
- A write landing after the close sweep's re-check is overwritten: storage has no transactions, so the re-check narrows the race and does not close it.
- A toggle on All notes does not stop the note's tabs. A tab save landing between the toggle's read and write makes the tab adopt the older content, and a tab save landing before that tab adopts the toggle loses the toggle. Closing this would take a runtime message so only the tab writes, which is more code than a 500 ms window justifies.
- Settings writes `settings` whole from the values it loaded, so a second open Settings tab can overwrite the kind.
- If a note tab cannot be stopped or closed, Delete / Delete forever still write and log a warning; the stopped tab shows "This note was deleted" and saves nothing more.
- Notes on closed tabs older than the 25 most recent sessions appear under Other notes. So would a closed session without a session id, which cannot be restored individually.
- Remote images do not load: the manifest CSP limits images to the extension itself, `data:` and `blob:` URLs, so `![](https://...)` in the preview and mermaid image shapes or `<img>` labels show nothing (`data:` images still render). `file://` images never load from extension pages, whatever the CSP. Raw HTML is shown as text. Publishing on AMO would trigger linter warnings: `innerHTML` in the preview and in bundled CodeMirror and highlight.js and in mermaid, and `eval` / `Function` in mermaid.
- `marked`, highlight.js and CodeMirror are bundled into `note/note.js`, so AMO's known-library hash matching does not recognize them; a listed review reads them through the uploaded source and the lockfile. `vendor/mermaid.min.js` is the unmodified npm file, but whether that hash matching knows it is unverified, so a listed review may ask about the 3.6 MB script.
- Identical diagrams in one note show copies of one cached SVG, so their element ids repeat (mermaid ids are `mermaid-<Date.now()>`). The copies are identical, so references resolve to the same content; with `privacy.resistFingerprinting` clamping the clock, two different diagrams rendered in one tick could share ids and pick up each other's styles or markers.
- Font size shortcuts write storage and apply on its change event, and each press steps from the size applied so far. Presses repeated faster than that may coalesce into one step, and a step pressed right after Ctrl+0 may start from the size before the reset (at 20px, Ctrl+0 then Ctrl+= writes 14, then 21 instead of 15).
- Releases have no automatic updates: there is no AMO listing or `update_url`, so each version is installed by hand from its GitHub release.
- Bin purge and All notes Restore read and then write without compare-and-set: a Restore landing in the few ms between the purge's read and remove on day 30 is purged anyway.
- A preview checkbox can refuse to tick in contrived notes, such as `- [ ] - [ ] x` next to other tasks, a task in a blockquote in a list item (`- > - [ ] a`), or a note holding the private-use characters U+E000 or U+E001; refusing is what keeps a click from ticking the wrong line.
- After a preview toggle, focus stays on the checkbox, so `Ctrl+Z` should do nothing until the editor has focus (reasoned from the code, not tested in Firefox). A double-click jump or scroll position can be a few lines off for a blockquote whose source marked rewrites; it does not affect content.
- Total image capacity is not known in advance: without `unlimitedStorage`, Firefox applies its IndexedDB-equivalent quota, and a write over it fails with a message on the page, for an image and for a note alike. Deleting images frees no space for at least 7 days, and images of a note in the bin only after its 30 or 7 bin days plus those 7.
- Undo after the 7-day grace restores a reference whose image is gone, and the preview shows the alt text. So does a second tab of a cleared note edited after the grace.
- Image removal reads and then writes without compare-and-set: a save landing in the few ms between the sweep's last read and its remove, or text still in a tab's 500 ms save delay, can reference an image past its grace as it is deleted. The reference stays and the preview shows the alt text.
- The grace goes by what sweeps see: a reference added and removed between two sweeps does not restart it, so such an image can go sooner than 7 days after that reference was removed.
- All notes search matches a note's raw markdown, image references included, so a note can list with nothing highlighted.
- A note tab whose close failed stays open and stopped. Undo restores the note but not that tab.
- Any `image/*` file is stored, also a format Firefox may not decode (TIFF, HEIC): the preview then shows only the alt text, with no message.
- A note page that failed to load, or has an invalid id, has no editor and no drop guard, so a file dropped there still navigates the tab.
- The alt text of a missing image keeps the backslash before a `` ` `` or `\` from its file name: marked unescapes only `[` and `]` there.
- An image write or removal delivers its data URL, up to 33 MB, to every open extension page through `storage.onChanged`. The cost is unmeasured.
- The first page opened with Light or Dark set can flash the system colours, as the `localStorage` copy read before first paint does not exist yet. So can a page after that copy became unavailable.
- Transparent images in a note render on the page background, so dark artwork on transparency is hard to see in dark mode.
- A diagram whose `%%{init}%%` sets a theme keeps that theme in both modes.
- Two theme changes within one diagram redraw can leave the preview scrolled up, at the shorter height it had during the redraw.
- A theme change puts the preview back where it was when the redraw ended, so a scroll made during the redraw snaps back, and with the preview driving the editor follows. A preview hidden during the redraw keeps no position.
- The root `manifest.json` and so the source zip AMO gets say `0.0.0`: the version exists only in the tag and the build.
- The guards limit who can release, not what `main` holds: the next tag signs whatever is on it.
- Release notes can repeat or miss a PR title: a rebase-merged PR replaces only its last commit, so its other commits also appear as subjects, and a merged PR outside the newest 40 appears as commit subjects only. Both add lines and lose none.
- `task sign` is one step, so tests, `tsc` and `npx web-ext` run with the AMO credentials in their environment.
- `web-ext` is not in `package-lock.json`, as `npx --yes web-ext@10.8.0` pins only the top level: its transitive dependencies resolve fresh on every runner, without integrity checks, in the step holding the AMO credentials. Accepted, to keep `web-ext` out of the dependencies.
- The upload uuid cache is the one exception to no cache in the release job. A workflow on `main` can save a cache entry matching its restore prefix, and restoring it writes into the job holding the AMO credentials. PR caches cannot reach a tag run, and it takes write access to `main`, which gives more than this already.

## Manual verification

These checks need an interactive Firefox with Sidebery and are not covered by `node --test`:

- [x] `tabs.query({})` returns the full note URL for unloaded restored tabs, which the close sweep rests on: checked automatically once on Firefox 157 headless, with the add-on installed permanently, across two restarts with `restore_on_demand`. The tabs reported `discarded: true` and the query did not load them. Still unverified: crash recovery, tabs discarded later, Windows.
- [ ] Toolbar click on a Jira tab and on a Sidebery group creates a "Notes" tab nested under it.
- [ ] Type, close the note tab right away, reopen from All notes: text intact (pagehide flush).
- [ ] Restart Firefox, once with a note tab as the active tab: note tabs come back in place with their content (restored `moz-extension` tabs load before or with the add-on).
- [ ] Two tabs of the same note: typing in one shows in the other after it saves. Two different notes edited at once: no lost edits.
- [ ] `Ctrl+E` cycles split / editor / preview and is not swallowed by Firefox, also on a non-Latin keyboard layout, including while the editor has focus (on mac `Cmd+E`; `Ctrl+E` in the editor moves to the line end). A diagram typed in editor-only mode renders at its full size once the preview is shown. The editor sizes correctly after returning from preview only.
- [ ] Editor: highlighting in headings, lists and fenced code (also ```` ```js ````, ```` ```py ````), list continuation on Enter, `Tab` / `Shift+Tab`, bracket matching, `Ctrl+F` search and replace, `Ctrl+B` / `Ctrl+I` / `Ctrl+K`. The `Ctrl+F` dialog keeps CodeMirror's own look.
- [ ] Update an installed copy to a new build: existing notes are still there and open note tabs still work.
- [ ] All three pages show one header layout: title on the left, then the controls at equal height.
- [ ] `Ctrl+B` (bookmarks sidebar), `Ctrl+I` (page info), `Ctrl+K` (search bar) and `Ctrl+=` / `Ctrl+-` / `Ctrl+0` (zoom) act on the page and do not also trigger the Firefox action.
- [ ] Two tabs of one note: typing in one updates the other without a save loop or a scroll jump. A font size change in one tab applies to all note tabs and to Settings.
- [ ] Mermaid: the first diagram loads the script and renders with its styles, with no CSP errors in the console (`task lint` reports `eval` / `Function` in `dist/vendor/mermaid.min.js`; the CSP would block them). Editing text around a diagram does not flicker. An invalid diagram shows its source and a `tabnotes: render diagram:` warning, with no error SVG at the bottom of the page.
- [ ] Copy button: `navigator.clipboard.writeText` works from the click handler with no `clipboardWrite` permission. If it does not, the button is dropped or the permission decision goes back to the owner: permissions stay `storage`, `tabs`, `sessions`.
- [ ] A mermaid label with `<input type=checkbox>` above a task list does not shift which task a click ticks.
- [ ] Scroll sync feels right with long notes, images and mermaid diagrams, and does not fight with typing. Dragging the preview's scrollbar right after using the editor moves the editor too: the pane only takes the lead on `wheel`, `pointerdown`, `keydown` or `focusin`, and whether Firefox sends `pointerdown` for a native scrollbar is unverified.
- [ ] Keyboard: Tab reaches a preview checkbox, Space toggles it, focus stays on it after the re-render.
- [ ] Ticking a preview checkbox with a second tab of the same note open updates that tab.
- [ ] Double-click a preview block in a tab showing "This note was deleted": the editor takes no focus and does not scroll, and copying code still works.
- [ ] `Ctrl+Z` right after a preview checkbox click, with focus on the checkbox: expected to do nothing until the editor has focus. Whether that is acceptable is the owner's call.
- [ ] Delete from All notes with unsaved typing in the note tab: the tab closes, the note ends up in the bin (not resurrected).
- [ ] Restore from bin, Delete forever (confirm), and a binned note open in a tab while it is deleted forever: the tab shows "This note was deleted".
- [ ] Changing the default title in Settings affects only new notes.
- [ ] Toolbar click on a long-titled page with `{date} - {tab | trunc 30}` as the default title: header and tab show the expanded title.
- [ ] Rename a note: the tab title changes and Sidebery shows the new name.
- [ ] Rename input: Enter, Esc and blur work, including blur from clicking into the editor (the click lands where it was aimed, as the hint moves nothing), and switching tab or window and coming back keeps the input open with its text. `Ctrl+E` in the input does nothing, and neither does Firefox's own action.
- [ ] Two tabs of a stored note: a rename in one reaches the other's header and tab title. On a blank note the title stays in its own tab.
- [ ] `{tab}` and `{host}` in a rename: empty on a note from All notes "New permanent note" or "New temporary note" and from "Other notes". On a tab restored from Recently closed and after a Firefox restart, note whether the opener survives (unverified).
- [ ] The rename hint over the panes, in both themes, and the hint in Settings.
- [ ] Offline: with the network disconnected, note, All notes and Settings work, and devtools Network shows no requests from extension pages.
- [ ] A note with `![](https://...)` shows no image and a CSP `img-src` violation in the console, and devtools Network shows no request for it; a `data:` image renders.
- [ ] Drop a PNG and a JPEG into the editor: each lands at the drop position.
- [ ] Paste a screenshot, an image copied from a web page, an image copied from the preview, and an image file copied in a file manager: each pastes as an image, not as a URL or path.
- [ ] Paste cells from a spreadsheet: they stay text.
- [ ] Type in split view, and in Editor mode, with a 20 MB image in the note: typing stays responsive, the preview does not jump, and the image shows once the preview is shown again.
- [ ] Tick a task below a tall image, in Preview mode and in split view with the preview driving: the preview does not jump and the box stays in view.
- [ ] Drag a rendered image from the preview into the editor in split view: nothing is inserted.
- [ ] With 20 note tabs open, insert a 20 MB image and let a sweep remove one. If `storage.onChanged` delivery makes this slow, revisit storing data URLs in `storage.local`.
- [ ] Add a 20+ MB image: it stores, reloads and renders without CSP errors, and typing stays responsive.
- [ ] Add a 26 MB image: it is refused with the message.
- [ ] Fill storage until a write fails, to see the real quota and check the message appears. Reconsider the `unlimitedStorage` rule if the quota is too low for 25 MB images.
- [ ] Drop a file on the preview in Preview mode: the tab stays on the note.
- [ ] Open All notes with several large images stored: refreshes stay fast.
- [ ] System theme: switch the OS theme with note, All notes and Settings tabs open: all follow at once and diagrams redraw. Firefox Website appearance must be Automatic for this.
- [ ] Explicit Dark on a light OS, and the reverse: no white flash on a new note tab or on session restore.
- [ ] Dark readability: editor selection and cursor, search dialog with its hint and matches, syntax colours, warning banners, `.preview code`, tables, checkboxes, copy button.
- [ ] All notes rows stay on one line at wide and narrow widths, in both themes, and row actions show on hover and keyboard focus without moving the row.
- [ ] All notes selection: the bar replaces the header with no list movement and stays reachable when scrolled. Shift-click selects a range; check whether Shift+Space does too.
- [ ] `/` on All notes focuses search without typing the character or opening Quick Find.
- [ ] Select and move notes with open tabs: the tabs close, nothing returns after a reload, and Undo brings the notes back.
- [ ] Dark readability on Settings and All notes: the theme select and its open dropdown, inputs, buttons, the search box.
- [ ] Mermaid flowchart and sequence diagrams in dark, with no CSP errors in the console. A theme change keeps the preview's scroll position.
- [ ] Transparent images in a note on the dark background: acceptable, as no backdrop is added.
- [ ] Quit and restart Firefox with temporary note tabs open: after a sweep they are not in `closedNotes`.
- [ ] A note tab reopened just as the sweep writes gets the bin banner with 7 days left and can be restored.
- [ ] The kind button and All notes rows with the kind actions at narrow widths, in both themes.
- [x] The All notes header at 400, 600 and 725px: checked in headless Firefox 157 at those widths. At 720px and below the search field takes its own line, and no label wraps inside a button.
- [ ] No errors in the console of the background script and of the note, All notes and Settings pages.
- [ ] `CLAUDE_CODE_OAUTH_TOKEN` works with `claude --print` on a runner: the log shows `release notes for vX.Y.Z: claude`. A failure only shows as a fallback in that `::notice`.
- [ ] The actor `if` on the `release` job is evaluated again on "Re-run failed jobs".
- [ ] A re-run after AMO approved a version is refused as a duplicate, and how that failure reads.
- [ ] A PR run passes `task test`, the build test with `RELEASE_VERSION` and `task lint`.
- [ ] A tag off `main` fails `guard`.
- [ ] A re-run after a failure in the middle of `task sign` restores the uuid cache: the log of the cache step shows a hit and web-ext reuses the upload.
- [ ] Compare the `gh pr list` and `gh release list` output of a real run with the fixtures in `tests/workflows.test.js` and `tests/release-notes.test.js`, which are hand-written as the repo has no PRs yet.
- [ ] A branch named like a version gets no secrets from the `release` environment.
- [ ] Install the xpi from the release link on a second device; note whether Firefox offers to install or only downloads it.

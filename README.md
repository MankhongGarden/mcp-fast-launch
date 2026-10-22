# mcp-fast-launch

**Start npm-based MCP servers in about 2 seconds instead of `npx -y <pkg>@latest`, and keep them updated in the background.**

> [!WARNING]
> **Experimental.** Built and used daily by one person on one Windows 11 machine since 2026-10-10. Tested on Claude Code 2.1.308 and Node.js 22.22 (2026-10-22). The launcher and updater are plain Node and should work on macOS and Linux, but have only been run on Windows. Not published to npm.

**TL;DR**
- `npx -y <pkg>@latest` asks the npm registry and often reinstalls on every start. With several Claude Code sessions starting several MCP servers at once, that took 7 to 60+ seconds per server here, and Claude Code dropped the slow ones.
- `launch.mjs` runs a version already installed under `pkgs/`, so a server starts as fast as `node` can load it.
- A detached, hidden `update.mjs` checks npm at most every 6 hours, installs a newer version into its own folder, checks that it answers an MCP `initialize`, and switches to it from the next start. A running server is never swapped.
- Optional `onboard.mjs` finds MCP servers in your Claude Code config that still use `npx` and moves them onto the launcher, with backups.
- No dependencies. Three small `.mjs` files plus the optional onboarder.

---

## The problem

Measured on one machine on 2026-10-10 (time from start to the MCP `initialize` reply, machine idle):

| MCP server | `npx -y <pkg>@latest` | `launch.mjs` |
|---|---|---|
| chrome-devtools-mcp | 7.5 s | 2.0 s |
| @supabase/mcp-server-supabase | 19.2 s | 1.2 s |
| @gongrzhe/server-gmail-autoauth-mcp | over 60 s (timed out) | 3.4 s |

Claude Code waits a limited time for each MCP server to start (30 s on the version tested). When several sessions and servers start together, npm contention pushes some past that limit, and those servers are silently missing from the session.

Pinning a version (`npx -y pkg@1.2.3`) avoids most of the registry round trips but you stop getting updates. This tool keeps the fast start of a pinned install and the freshness of `@latest`.

---

## Install

Requirements: Node.js 18+ (tested on 22), `npm` on `PATH`.

```sh
git clone https://github.com/MankhongGarden/mcp-fast-launch
```

Then, in your MCP config (`claude mcp add-json`, `~/.claude.json`, or a project `.mcp.json`), replace

```json
"command": "npx", "args": ["-y", "<pkg>@latest", "...server args"]
```

or the Windows form `"command": "cmd", "args": ["/c", "npx", "-y", "<pkg>@latest", ...]` with

```json
"command": "node", "args": ["/path/to/mcp-fast-launch/launch.mjs", "<pkg>", "--", "...server args"]
```

Example with `chrome-devtools-mcp` attached to an existing browser on port 9222:

```sh
claude mcp add-json chrome-devtools -s user '{"type":"stdio","command":"node","args":["C:\\path\\to\\mcp-fast-launch\\launch.mjs","chrome-devtools-mcp","--","--browserUrl","http://127.0.0.1:9222","--usageStatistics","false"]}'
```

- `env` and `${VAR}` placeholders in the entry stay as they are.
- Packages with several bins: add `--bin <name>` before `--`.
- The first start of a package installs its latest version and is slow once. Run the command by hand first if that would exceed the startup timeout.

---

## How it works

```
Claude Code starts the MCP server
  node launch.mjs <pkg> -- <args>
    |-- reads pkgs/<pkg>/current.txt            (first run: npm view + npm install, slow once)
    |-- runs pkgs/<pkg>/versions/<ver>/node_modules/<pkg>/<bin> <args>   (stdio passed through)
    |-- spawns update.mjs, detached and hidden
    `-- spawns onboard.mjs, only if onboard.enabled exists

update.mjs (background)
  wait 60 s -> skip if checked in the last 6 h (last-check.txt) -> take update.lock
  -> npm view <pkg> version -> newer? npm install into versions/<new>
  -> start it, send MCP initialize, need a reply within 30 s
  -> ok: write current.txt (atomic rename), delete older versions (keep 3)
  -> fail: delete the new folder, log to update.log, stay on the old version
```

- The new version is used from the next start. The server that is running is never replaced.
- One updater per package at a time (`update.lock`; a lock older than 30 minutes is treated as stale).
- `MCP_LAUNCH_DELAY_MS=0` skips the 60-second wait (for testing).
- `MCP_LAUNCH_STAMP_DIR`: if set, and Claude Code's `CLAUDE_PID` is in the environment, the launcher writes `<CLAUDE_PID>-<pkg>.txt` there with the server's PID and start time. Another tool can use this to notice that a session's MCP server was restarted. [claude-code-tab-guard](https://github.com/MankhongGarden/claude-code-tab-guard) uses it for `chrome-devtools-mcp`. Leave it unset otherwise.

Everything lives in the clone: `pkgs/<pkg>/versions/`, `current.txt`, `last-check.txt`, `update.log`. Delete `pkgs/<pkg>` to force a fresh install.

---

## Auto-onboard (optional)

`onboard.mjs` moves MCP servers that are still started with `npx` onto the launcher. It is off until you enable it.

```powershell
node onboard.mjs --dry-run            # report only, works while disabled
pwsh -File enable-onboard.ps1         # dry run, create onboard.enabled, one real pass
pwsh -File disable-onboard.ps1        # off again
```

On macOS/Linux, `touch onboard.enabled` / `rm onboard.enabled` does the same as the two scripts.

- **Trigger.** `launch.mjs` starts it detached when `onboard.enabled` exists. It runs at most once an hour (`last-onboard.txt`), waits 90 s after the session starts (`MCP_ONBOARD_DELAY_MS`), one instance at a time (`onboard.lock`).
- **What it scans.** User-scope and project-local servers in `.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`). It never writes that file itself: changes go through `claude mcp remove` + `claude mcp add-json`. Plus every `.mcp.json` under the folders in `scanDirs` (see below), skipping `exclude` folders.
- **What it skips.** Pinned or ranged versions (`pkg@0.2.0`, `pkg@^1.2`), entries already on a `launch.mjs`, non-npx commands (Python etc.), remote http/sse servers, legacy backslash project keys in `.claude.json`.
- **Before switching** it installs the package into `pkgs/` and requires an MCP `initialize` reply, with `${VAR}` placeholders expanded from the environment. No reply means the config is left as it is.
- **Keeps** `type`, `env`, every server argument (including `${VAR}`), and the rest of the file (line endings, indent; written as UTF-8 without BOM).
- **Backups** go to `backups/mcp-onboard-<yyyyMMdd-HHmm>/` (or `backupDir`) with a `RESTORE.txt` (copy-back lines for files, `claude mcp add-json` lines for `.claude.json` entries).
- **Log** `onboard.log`: one `scanned N entries` line per run. Secret-looking arguments are masked; `env` values are never logged. A failing entry is retried after 24 hours and reported only once (`onboard-state.json`).
- **Manual flags.** `--now` skips the hourly throttle. For tests on copies: `--config <file.mcp.json>` (repeatable) or `--claude-dir <dir containing a .claude.json>`; test runs keep log, state and backups next to the copy and print the notification instead of sending it (`--notify` sends it).

### Configuration

`onboard.config.json` next to `onboard.mjs` (copy `onboard.config.example.json`; every key is optional):

| Key | Default | Meaning |
|---|---|---|
| `scanDirs` | `[]` | Folders searched for `.mcp.json` files. Empty = only `.claude.json` is scanned |
| `exclude` | `["_archive","node_modules","plugin",".git"]` | Folder names skipped while searching. `plugin` is there so `.mcp.json` files you ship to other people keep their `npx` command |
| `forbiddenPaths` | `[]` | Path prefixes the onboarder refuses to read or edit (for example a second Claude Code config you never want touched) |
| `backupDir` | `<clone>/backups` | Where backups go |
| `claudePath` | found on `PATH` | The `claude` executable used for `claude mcp ...`. On Windows the npm `claude.cmd` shim is resolved to the native `claude.exe` next to it; set this if that fails |
| `everythingPath` | `null` | Windows only: path to Everything's `es.exe`. When set, `.mcp.json` files are found through the Everything index instead of walking the folders |
| `notifyCommand` | `null` | Command run after a run that converted or failed something, e.g. `["notify-send", "{text}"]`. `{text}` is replaced by the summary. Unset = the summary only goes to the log |

---

## Limitations

- **Windows-tested only.** `enable-onboard.ps1`, `disable-onboard.ps1` and `everythingPath` are Windows-specific; the rest is plain Node.
- **npm only.** Python MCP servers (`uvx`, venvs) and remote HTTP servers are not handled.
- **The first start of a package is slow** (a normal `npm install`). If that exceeds Claude Code's MCP startup timeout, start the launcher once by hand.
- **A broken release is caught only if it fails `initialize`.** A version that answers `initialize` but misbehaves later becomes current from the next start. Roll back by writing the old version into `pkgs/<pkg>/current.txt` (the previous version folder is kept).
- **Disk use.** Up to three versions per package are kept.
- **The onboarder edits your MCP config.** It backs up first, validates with a real `initialize`, and is off by default, but read the `--dry-run` output before enabling it.
- **Undocumented format.** The onboarder reads `.claude.json` directly (it writes only through the `claude mcp` CLI). Its structure (`mcpServers`, `projects.<path>.mcpServers`) is not a public API and may change.

---

## Development

```sh
npm test      # node --test; pure helpers plus a dry run on a temporary .mcp.json, no network
```

## License

MIT, see [LICENSE](LICENSE).

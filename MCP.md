# SpawnLoft for AI assistants (MCP)

`spawnloft mcp` lets an AI app that speaks the [Model Context Protocol](https://modelcontextprotocol.io)
check on and run the servers on this machine: start one and wait for it, read its console, find out
why it crashed, look at TPS, back it up, install and update plugins, update Paper.

You pick the AI app. SpawnLoft needs no account for this, opens no port and sends nothing on its own.
The app starts `spawnloft mcp` itself and talks to it over stdin and stdout, and the process ends when
the app closes it.

## What the AI provider sees

**Read this before you connect a cloud AI app.** What a tool returns is sent to the model, and for
Claude Desktop, Claude Code or any other hosted assistant, that means to its provider. That includes:

- console lines, which can contain chat messages and player names;
- player names and UUIDs, ops, bans and the whitelist;
- plugin names, versions and server settings such as ports and memory;
- crash report summaries.

These are never sent:

- RCON passwords, database passwords and Discord webhook URLs. They are left out of every result,
  and any output that happens to contain one (for example, a plugin that printed its database URL to
  the console) has it replaced with `[redacted]`.
- Players' IP addresses, which Paper writes to the console on every join. They are shown as
  `[ip hidden]` unless you add `--show-ips`.

A model running on your own machine, through LM Studio for example, keeps all of this on the machine.

## Setting it up

The easiest way is the **AI assistants** section in the app's Settings. It shows the exact
configuration for this install, with its real paths, and has a button to copy it.

### Claude Desktop

Open Settings → Developer → Edit Config, add the `spawnloft` entry under `mcpServers`, save the file
and restart Claude Desktop.

Windows (the default per-user install):

```json
{
  "mcpServers": {
    "spawnloft": {
      "command": "C:\\Users\\YOU\\AppData\\Local\\Programs\\SpawnLoft\\SpawnLoft.exe",
      "args": ["C:\\Users\\YOU\\AppData\\Local\\Programs\\SpawnLoft\\resources\\core\\spawnloft.mjs", "mcp"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

Mac:

```json
{
  "mcpServers": {
    "spawnloft": {
      "command": "/Applications/SpawnLoft.app/Contents/MacOS/SpawnLoft",
      "args": ["/Applications/SpawnLoft.app/Contents/Resources/core/spawnloft.mjs", "mcp"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

`ELECTRON_RUN_AS_NODE` runs the app's built-in runtime as a plain command line instead of opening a
window. The `spawnloft.cmd` launcher in `resources\bin` does the same, but an app that starts
programs without a shell cannot run a `.cmd` file on Windows, so point at the executable.

### Claude Code

```bash
claude mcp add --transport stdio --scope user --env ELECTRON_RUN_AS_NODE=1 spawnloft -- "C:\Users\YOU\AppData\Local\Programs\SpawnLoft\SpawnLoft.exe" "C:\Users\YOU\AppData\Local\Programs\SpawnLoft\resources\core\spawnloft.mjs" mcp
```

On Linux, where the package puts `spawnloft` on your PATH (the desktop `.deb` or `.rpm`, or
`spawnloft-cli`):

```bash
claude mcp add --transport stdio --scope user spawnloft -- spawnloft mcp
```

### LM Studio (a local model)

LM Studio 0.3.17 or later: in the Program tab, choose Install → Edit mcp.json and add the same
`spawnloft` entry shown for Claude Desktop. Pick a model that handles tool calls well; small models
tend to call the wrong tool or invent server names.

### From a source checkout

`node spawnloft.mjs mcp`, with Node 20 or later. No `ELECTRON_RUN_AS_NODE` is needed.

## Options

| Option | Effect |
| --- | --- |
| `--allow-destructive` | Also offer `restore`, `kill` and `upgrade_minecraft`. Without it the assistant is never shown them. |
| `--show-ips` | Stop hiding player IP addresses in console lines. |

Add them after `mcp` in `args`.

## Tools

**Reading.** These change nothing.

| Tool | What it returns |
| --- | --- |
| `list_servers` | Every server and database, with status and ports. |
| `server_status` | One server: running or not, ports, memory, uptime. |
| `get_logs` | The last console lines, up to 500. Filter by `level` (`error`, or `warn`, which includes errors) and by a `grep` pattern. |
| `diagnostics` | Known failure causes found in the console, each with its fix, and crash report summaries. |
| `players` | Who is online, and every player the server knows about. |
| `performance` | CPU and memory over a window, plus TPS and MSPT from the server when it is running. |
| `list_snapshots` | A server's backups, newest first. |
| `verify_snapshot` | Reads a backup end to end and checks it holds what its manifest says. |
| `list_plugins` | Installed plugins or mods, and which ones SpawnLoft manages. |
| `search_plugins` | Search Modrinth and Hangar for plugins or mods this server can load. |
| `check_plugin_updates` | Newer builds of the plugins SpawnLoft installed. |
| `check_server_update` | A newer Paper build, and newer Minecraft versions. |
| `doctor` | This machine's checks: Java, tar, each server's folder, jar, EULA and ports. |

**Actions.** Marked as changes, so your AI app asks before running them.

| Tool | What it does |
| --- | --- |
| `start` | Starts a server and waits up to three minutes for it to be ready. If it fails, returns the likely cause and the last console lines. |
| `stop` / `restart` | Stops gracefully, saving the worlds. |
| `run_command` | One console command over RCON, returning the reply. `stop`, `restart` and `reload` are refused: use the tools, which go through SpawnLoft. |
| `backup` | Takes a snapshot. Safe while the server is running. |
| `install_plugin` / `update_plugin` | Takes a plugins snapshot first, then installs. Takes effect at the next restart. |
| `upgrade_build` | The newest Paper build of the same Minecraft version. The old jar is kept. |

**Destructive**, only with `--allow-destructive`. Each describes what it would do and changes
nothing until it is called again with `confirm: true`.

| Tool | What it does |
| --- | --- |
| `restore` | Overwrites a stopped server's files with a backup. |
| `kill` | Ends the process without saving the world. |
| `upgrade_minecraft` | Moves to a newer Minecraft version. Worlds migrate one way; a snapshot is taken first. |

Deleting a server, database credentials and settings that hold secrets are not available through MCP.

## Trying it

With a server called `survival`, ask:

> Start survival, tell me its TPS once it's up, back it up, then update Paper if there's a newer build
> and restart it.

The assistant calls `start` (progress arrives while it loads), `performance`, `backup`,
`check_server_update`, `upgrade_build` and `restart`, and your AI app asks you before each change.

## Protocol

Newline-delimited JSON-RPC over stdio. Both protocol generations are served: the current
`2026-07-28` revision, where each request carries its version in `_meta`, and the handshake-based
revisions from `2024-11-05` to `2025-11-25`, where a client begins with `initialize`. Tools only;
progress notifications are sent when a request includes a `progressToken`.

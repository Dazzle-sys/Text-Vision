# MCP Integration Guide: Connect text-vision to Your AI Tool

English | [简体中文](integration-guide.md)

This project's core is a single MCP server (`src/index.js`). Integrating = **registering one startup command** in each MCP-capable tool, with zero changes to the core code.

> MCP config formats evolve with tool versions. The examples below are based on current mainstream versions; if yours differs, **follow the tool's official docs** — the format is broadly similar, and the key pair is `command` + `args`.

## 0. Before You Register

> Want to save effort? Copy the "Let AI Install It" prompt from the README's "Installation" section to your AI assistant and let it do the registration and configuration below for you.

First confirm the startup command runs (execute in the project directory and see the MCP start without an immediate error):

```bash
cd text-vision
node src/index.js
```

If it errors here (missing deps, Node too old, etc.), configuring the tool side is pointless. A normal start **silently waits on stdin** (stdio protocol) and prints nothing, so "no output" = normal; Ctrl+C to exit. No config is needed just to start, but **you must set the `VISION_*` env vars before calling a vision tool** (see [section 6](#6-configuration-via-environment-variables-recommended)); otherwise you'll get "vision engine not configured".

**Path tip**: in all tool configs, use **forward slashes** (`text-vision/...`) instead of backslashes. Backslashes in JSON must be escaped as `\\` and are error-prone; Node accepts both, so forward slashes are the least hassle.

## 1. Claude Code

**Recommended**: register via the CLI (writes to the right place automatically):

```bash
claude mcp add text-vision -- node text-vision/src/index.js
```

Or edit a config file by hand (either one):

- **User-level** (available in all projects): the `mcpServers` field of `~/.claude.json`
- **Project-level** (current project only): create `.mcp.json` in the project root

```json
{
  "mcpServers": {
    "text-vision": {
      "command": "node",
      "args": ["text-vision/src/index.js"]
    }
  }
}
```

**Restart Claude Code** after changing the config; reopening the session is also recommended after registering via `claude mcp add`.

> Claude Code supports injecting environment variables into MCP configs (the `env` field); this project is configured entirely through env vars — see [section 6](#6-configuration-via-environment-variables-recommended).

## 2. OpenCode

Edit the project-level `opencode.json` (or global `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "text-vision": {
      "type": "stdio",
      "command": "node",
      "args": ["text-vision/src/index.js"]
    }
  }
}
```

## 3. Cursor

Project-level `.cursor/mcp.json` (or add manually in Cursor Settings → MCP panel):

```json
{
  "mcpServers": {
    "text-vision": {
      "command": "node",
      "args": ["text-vision/src/index.js"]
    }
  }
}
```

## 4. Windsurf

`mcp_config.json` in the project root:

```json
{
  "mcpServers": {
    "text-vision": {
      "command": "node",
      "args": ["text-vision/src/index.js"]
    }
  }
}
```

## 5. Gemini CLI and OpenAI Codex

Gemini CLI (register via command — recommended — or edit the config file):

```bash
gemini mcp add text-vision -- node text-vision/src/index.js
```

Codex CLI (config file is `config.toml`):

```toml
[mcp_servers.text-vision]
command = "node"
args = ["text-vision/src/index.js"]
```

## 6. Configuration via Environment Variables (recommended)

This project **reads no config file**; everything is configured through environment variables (`VISION_*` prefix). Recommended: inject the `env` field directly into the MCP registration config, binding it to the tool and traveling with the config (no need to `export` in a terminal first):

```json
{
  "mcpServers": {
    "text-vision": {
      "command": "node",
      "args": ["text-vision/src/index.js"],
      "env": {
        "VISION_API_BASE": "https://open.bigmodel.cn/api/paas/v4",
        "VISION_API_KEY": "your-GLM-4V-key",
        "VISION_MODEL": "glm-4v-plus",
        "VISION_TIMEOUT": "60000"
      }
    }
  }
}
```

The full list of supported env vars is in the README's "Configuration" section (`VISION_*` prefix). You can also skip the `env` field and export the vars in the terminal before starting (e.g. `export VISION_API_KEY=...`) — either works.

## 7. Moving Machines / Directories

The **only thing to change** in the MCP config is the startup path in `args`. After copying the project:

1. Run `npm install` on the new machine
2. Replace `text-vision` in each tool config with your actual path
3. Reconfigure env vars like `VISION_API_KEY` (best in the MCP config's `env` field)

## 8. Troubleshooting

| Problem | Cause / Fix |
|---|---|
| MCP server shows connection failed / startup error | Run `node text-vision/src/index.js` by hand first to confirm it starts; usually Node < 20 or `npm install` not run |
| `node` not found (Windows) | Node not on PATH; point `command` at Node's full path. Note backslashes must be escaped in JSON (`"command": "C:\\Program Files\\nodejs\\node.exe"`), or just use forward slashes (`"command": "C:/Program Files/nodejs/node.exe"` — Node accepts them), less error-prone |
| The three tools don't show up | Config changed but the tool wasn't restarted; or the server name doesn't match the config |
| Tool call says "vision engine not configured" | `VISION_*` env vars not set — inject them in the MCP config `env` field per [section 6](#6-configuration-via-environment-variables-recommended) (or `export` first) |
| Relative image path not found | Relative paths resolve against **the MCP server's startup directory** — use absolute paths |
| Model replies "I can't see images / please provide the image path" | The rule template doesn't cover the "user pasted/dropped an image" scenario. Update the AGENTS.md/CLAUDE.md in the project root per docs/auto-invoke.en.md section 2 — add the "pasted image → locate the saved file → call describe_image" guidance |

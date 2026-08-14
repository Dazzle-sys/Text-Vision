# MCP Integration Guide: Connect text-vision to Your AI Tool

English | [简体中文](integration-guide.md)

This project exposes a single core MCP server (`src/index.js`). Integrating it into an MCP-capable tool consists of **registering one startup command**, with zero changes to the core code.

> MCP config formats evolve with tool versions. The examples below are based on current mainstream versions. If yours differs, **follow the tool's official documentation** — the general shape is the same, and the essential fields are `command` and `args`.

## 0. Before You Register

First, confirm that the startup command runs (execute it in the project directory and observe that the MCP server starts without an immediate error):

```bash
cd text-vision
node src/index.js
```

If this fails (missing dependencies, Node version too old), configuring the tool side is pointless. A normal start **silently waits on stdin** (stdio protocol) and produces no output, so a silent startup is expected; press Ctrl+C to exit. No configuration is required to start, but **the `VISION_*` env vars must be set before calling a vision tool** (see [section 6](#6-configuration-via-environment-variables-recommended)); otherwise the tool returns "vision engine not configured".

**Path tip**: use **forward slashes** (`text-vision/...`) in every startup path. Backslashes in JSON must be escaped as `\\`, which is error-prone; Node accepts both, so forward slashes are the most reliable.

## 1. Claude Code

**Recommended**: register via the CLI (writes to the correct location automatically):

```bash
claude mcp add text-vision -- node text-vision/src/index.js
```

Alternatively, edit a configuration file (choose one):

- **User-level** (all projects): the `mcpServers` field of `~/.claude.json`
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

> Claude Code supports injecting env vars via the `env` field; this project is configured entirely through env vars — see [section 6](#6-configuration-via-environment-variables-recommended).

## 2. OpenCode

Edit the project-level `opencode.json` (or the global `~/.config/opencode/opencode.json`):

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

Project-level `.cursor/mcp.json` (or add it manually via Cursor Settings → MCP panel):

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

Gemini CLI (CLI registration is recommended; editing the config file is also supported):

```bash
gemini mcp add text-vision -- node text-vision/src/index.js
```

Codex CLI (configuration file is `config.toml`):

```toml
[mcp_servers.text-vision]
command = "node"
args = ["text-vision/src/index.js"]
```

## 6. Configuration via Environment Variables (recommended)

This project **reads no configuration file**; all settings come from env vars (the `VISION_*` prefix). Inject the `env` field directly into the MCP registration configuration so the settings travel with the tool (no need to `export` first):

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
        "VISION_TIMEOUT": "60000",
        "VISION_LOG_FILE": ""
      }
    }
  }
}
```

The complete list of supported env vars is in the README's "Configuration" section. You may also omit the `env` field and `export` the vars in the terminal before starting — either approach is acceptable. The example's `VISION_TIMEOUT` and `VISION_LOG_FILE` are optional; their meanings are in the README's corresponding sections.

## 7. Moving Machines / Directories

The **only field to change** in the MCP configuration is the startup path in `args`. After copying the project:

1. Run `npm install` on the new machine
2. Replace `text-vision` in each tool configuration with your actual path
3. Reconfigure env vars such as `VISION_API_KEY` (preferably in the `env` field)

## 8. Troubleshooting

| Problem | Cause / Resolution |
|---|---|
| MCP server reports a connection failure / startup error | Run `node text-vision/src/index.js` manually to confirm it starts; usually Node < 20 or a missing `npm install` |
| `node` not found (Windows) | Node is not on `PATH`; point `command` at the full Node path. Backslashes must be escaped in JSON (`"command": "C:\\Program Files\\nodejs\\node.exe"`), or preferably use forward slashes (`"command": "C:/Program Files/nodejs/node.exe"`, which Node also accepts) |
| The four tools do not appear | The tool was not restarted after the config change, or the server name does not match |
| Tool calls return "vision engine not configured" | The `VISION_*` env vars are not set — inject them into the `env` field per [section 6](#6-configuration-via-environment-variables-recommended), or `export` them first |
| Relative image paths are not found | Relative paths resolve against **the MCP server's startup directory** — use absolute paths |
| Model replies "I can't see images / please provide the image path" | The rule template doesn't cover the pasted/dropped-image scenario. Update the project root's `AGENTS.md` / `CLAUDE.md` per docs/auto-invoke.en.md section 2 |
| Model doesn't proactively capture the screen | The rule doesn't cover the "proactive capture" scenario. Update the project root's `AGENTS.md` / `CLAUDE.md` per docs/auto-invoke.en.md section 2 (the template includes the "Proactively capture screens" guidance) |

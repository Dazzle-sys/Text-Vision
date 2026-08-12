# Three-Layer Auto-Invocation: Make the Text Model "Look at Images Itself"

English | [简体中文](auto-invoke.md)

The MCP server only solves the "**can** look at images" problem. Making the model "**proactively** look" — deciding on its own to call a vision tool mid-task, instead of waiting for you to feed it a description — is handled by the three layers below. Enable them as needed; each layer builds on the previous one.

| Layer | Carrier | Tools | Trigger | Reliability |
|---|---|---|---|---|
| Rule layer | `CLAUDE.md` / `AGENTS.md` | Claude Code + general (OpenCode, Cursor, Codex…) | model "discipline" | medium (depends on the model) |
| Skill layer | `.claude/skills/text-vision/SKILL.md` | skill-capable tools | auto-load on trigger words | medium-high |
| Hook layer | `hooks/read-image-hook.js` | Claude Code only | intercepts `Read` on images, **forces** a description | high (the model always "sees") |

> **MCP integration is the prerequisite**: register the `text-vision` server first per [integration-guide.en.md](integration-guide.en.md), then configure the three layers on this page.

---

## 1. Hook Layer (Claude Code, most reliable)

**How it works**: every time Claude Code calls the `Read` tool, the `PreToolUse` hook fires first. This repo's `hooks/read-image-hook.js` checks: if the file being read is an image (`.png/.jpg/.jpeg/.webp/.gif/.bmp`), it intercepts, converts it to a text description with the vision model, injects it into the conversation via `additionalContext` (tagged `【图片视觉描述】`), and **denies the original binary read** — the text model never gets the image bytes, only the description.

**stdin→stdout contract** (between the hook and Claude Code):

```jsonc
// stdin input
{ "tool_name": "Read", "tool_input": { "file_path": "..." }, "cwd": "..." }

// stdout output (exit 0, exactly one JSON)
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "图片已转为文字描述,请直接基于注入内容继续分析,不要读取图片二进制。", "additionalContext": "【图片视觉描述】..." } }
```

### 1.1 Register with Claude Code (required — the hook does nothing until registered)

Registering the MCP server ≠ hook active. The hook must be declared separately in Claude Code's `settings.json`. Project-level `.claude/settings.json` is recommended (only affects Claude Code sessions in this project). The `text-vision` in the example is a placeholder for your actual clone path — replace it:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "node text-vision/hooks/read-image-hook.js"
          }
        ]
      }
    ]
  }
}
```

- `matcher: "Read"` limits the hook to intercepting `Read` only, leaving other tools alone
- **Restart Claude Code** after changing the config
- You can also put it in the user-level `~/.claude/settings.json` (applies to all projects), with the same path logic

### 1.2 Behavior details

- **OCR mode**: set the env var `VISION_HOOK_MODE=ocr` (e.g. `VISION_HOOK_MODE=ocr claude`); image reads then go through OCR instead of description — good for captchas/error/document screenshots. The injected tag becomes `【图片视觉OCR】`.
- **Self-protection** (the hook skips these so normal `Read` is unaffected):
  - Any file under a `.git` directory or `node_modules`
  - Files under this repo's own `src/` / `hooks/` directories (prevents recursion)
  - Images at or over `VISION_MAX_IMAGE_MB` (default 10MB)
  - Missing/unreadable files
- **Fail open**: missing vision config, failed requests, timeouts, etc. **never block work** — the hook logs the error and lets the original `Read` through. On failure a text model still gets the raw image bytes — which is why the rule layer exists as a fallback.
- **Timeout**: 30s by default in the hook scenario (overridable via `VISION_TIMEOUT`), so model responses aren't slowed down. Note `VISION_MAX_RETRIES` amplifies total time — see README's "Configuration" section.

### 1.3 Manually verify the hook

```bash
echo '{"tool_name":"Read","cwd":"<absolute repo path>","tool_input":{"file_path":"test/test.png"}}' | node hooks/read-image-hook.js
# image → deny + 【图片视觉描述】; replace file_path with any .txt → allow
```

> Set the `VISION_*` env vars first, otherwise the vision request fails and the hook **lets the Read through** (no deny — see "Fail open" above).

---

## 2. Rule Layer (CLAUDE.md / AGENTS.md)

**How it works**: put a rule file in the project root the tool reads, stating "reading images must go through text-vision tools", so the text model forms a habit. This is the primary trigger mechanism in hook-less tools like OpenCode and Cursor.

> **Key: the rules must cover the "pasted / dropped image" scenario.** Host tools (OpenCode etc.) save a pasted/dropped image as a local file; the model can see the path or filename clue in the message (e.g. `[Image 1] file x.png` / `![image](...)`) but not the content. The rules must tell the model to "not ask for the path, locate the saved file itself, then call `describe_image`" — otherwise the model may reply "I can't see images" and ask the user to resend the image, which is exactly the source of the "asking for the image again" problem.

### 2.1 `CLAUDE.md` (Claude Code-specific, put in the project root)

Ready-made template: [`templates/CLAUDE.md`](../templates/CLAUDE.md) — copy it into the project root. Core requirements:

- The local text model cannot see images; on any image / screenshot / screen / UI / chart / OCR it MUST call a `text-vision` tool, never read image bytes directly
- **A pasted/dropped image is already a local file**; the message carries a path/filename clue; **do NOT reply "I can't see images", do NOT ask for the path** — locate the file and call `describe_image(path)`
- Prefer `ocr_image(path)` for captchas / error / document screenshots; use `screen_capture(focus?)` for the current screen

### 2.2 `AGENTS.md` (general — OpenCode / Cursor / Gemini CLI / Codex, put in the project root)

Ready-made template: [`templates/AGENTS.md`](../templates/AGENTS.md) — copy it into the project root. Core requirements:

- Text-only model cannot see images; on any image / screenshot / screen / UI / OCR, MUST call a `text-vision` tool
- **User pasted / dragged an image → it is already a local file**; do NOT reply "I can't see images" and do NOT ask for the path — locate the file (use the path in the message, or search temp / project dirs for recent images) and call `describe_image(path)`
- Prefer `ocr_image(path)` for captchas / error / document screenshots; use `screen_capture(focus?)` for the current screen

> Why is `AGENTS.md` in English? Rule files in OpenCode/Cursor are often executed by the model as direct instructions, and English triggers more reliably; `CLAUDE.md` stays Chinese since this repo's primary readers are Chinese. Either can be adapted to taste.

---

## 3. Skill Layer (SKILL.md, optional enhancement)

**How it works**: Claude Code and other tools support "skills" — a description file with frontmatter; when the `description`'s trigger words match, the model auto-loads the skill and follows its steps to call tools. More structured than a plain rule.

Put it at `.claude/skills/text-vision/SKILL.md` (Claude Code project-level skill directory). Ready-made template (with frontmatter): [`templates/SKILL.md`](../templates/SKILL.md) — copy it over. When a trigger word hits, the model follows the skill's steps to turn the image into a text description.

---

## 4. How the Three Layers Work Together

| Your scenario | Recommendation |
|---|---|
| Claude Code only | hook layer (register per 1.1) is enough; the rule layer is optional |
| Claude Code + other tools | hook layer + a `CLAUDE.md`/`AGENTS.md` rule in each project root |
| Hook-less tools only (OpenCode/Cursor) | rule layer (2.2 `AGENTS.md`) + optional skill layer, relies on model discipline |

Suggested order: integrate MCP per [integration-guide.en.md](integration-guide.en.md) first → hook layer (1.1) → add the rule/skill layers as needed.

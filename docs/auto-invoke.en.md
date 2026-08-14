# Three-Layer Auto-Invocation: Enabling the Text Model to Read Images on Its Own

English | [简体中文](auto-invoke.md)

The MCP server solves the "**can** read images" problem; the three layers below solve "**actively** read" — the model calling a vision tool on its own during a task rather than waiting for a manually supplied description. Enable them as needed; each builds on the previous one.

> **Division of labor**: the read tools (`describe_image` / `ocr_image`) serve user-pasted and local images; the capture tools (`screen_capture` / `list_windows`) exist for an **executing AI to call on its own for vision** — the model captures when it needs to see a running program's UI/state, without waiting for a manual screenshot. This "proactively capture" guidance is built into the rule templates (see [templates/](../templates/)' "Proactively capture screens" section).

| Layer | Carrier | Tools | Trigger | Reliability |
|---|---|---|---|---|
| Rule layer | `CLAUDE.md` / `AGENTS.md` | Claude Code + general (OpenCode, Cursor, Codex…) | model compliance | medium (depends on the model) |
| Skill layer | `.claude/skills/text-vision/SKILL.md` | tools that support skills | auto-load on trigger words | medium-high |
| Hook layer | `hooks/read-image-hook.js` | Claude Code only | intercepts `Read` on images and **forces** a description | high (the model always "sees") |

> **MCP integration is a prerequisite**: register the `text-vision` server first per [integration-guide.en.md](integration-guide.en.md), then configure the layers on this page.

---

## 1. Hook Layer (Claude Code, the Most Reliable)

**How it works**: every time Claude Code calls `Read`, the `PreToolUse` hook fires first. `hooks/read-image-hook.js` checks whether the file is an image (`.png/.jpg/.jpeg/.webp/.gif/.bmp`); if so, it intercepts, converts the image into a text description via the vision model, injects it through `additionalContext` (tagged `【图片视觉描述】`), and **denies the original binary read** — the text model receives only the description, never the image bytes.

**stdin→stdout contract** (between the hook and Claude Code):

```jsonc
// stdin input
{ "tool_name": "Read", "tool_input": { "file_path": "..." }, "cwd": "..." }

// stdout output (exit 0, exactly one JSON object)
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "该文件是图片,已通过视觉引擎转为文字描述,请直接基于注入的描述内容继续分析,不要读取图片二进制。", "additionalContext": "【图片视觉描述】..." } }
```

### 1.1 Register with Claude Code (required — inactive until registered)

Registering the MCP server does not activate the hook; declare it separately in Claude Code's `settings.json`, ideally project-level `.claude/settings.json` (affects only this project's sessions). `text-vision` is a placeholder — replace it with your actual path:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          { "type": "command", "command": "node text-vision/hooks/read-image-hook.js" }
        ]
      }
    ]
  }
}
```

- `matcher: "Read"` restricts the hook to `Read` only, without affecting other tools
- **Restart Claude Code** after changing the config
- A user-level `~/.claude/settings.json` (all projects) is also supported

### 1.2 Behavior Details

- **OCR mode**: set `VISION_HOOK_MODE=ocr` (e.g. `VISION_HOOK_MODE=ocr claude`); image reads then go through OCR, with the tag `【图片视觉OCR】` — suitable for captchas / error screenshots / document screenshots.
- **Self-protection** (the hook skips these, so normal `Read` is unaffected): files under `.git` or `node_modules`, this repo's own `src/`/`hooks/` directories (prevents recursion), images at or above `VISION_MAX_IMAGE_MB` (default 10MB), and missing/unreadable files.
- **Fail open**: missing config, failed requests, timeouts, etc. **never block work** — the hook logs and lets the original `Read` proceed. In such a failure the text model still receives the raw bytes; that's what the rule layer is for.
- **Timeout**: 30 seconds by default in the hook scenario (overridable via `VISION_TIMEOUT`). `VISION_MAX_RETRIES` amplifies the total time — see the README's "Configuration" section.

### 1.3 Verifying the Hook Manually

```bash
echo '{"tool_name":"Read","cwd":"<absolute repo path>","tool_input":{"file_path":"test/test.png"}}' | node hooks/read-image-hook.js
# image → deny + 【图片视觉描述】; replace file_path with any .txt → allow
```

> Set the `VISION_*` env vars first; otherwise the vision request fails and the hook **lets the `Read` through** (no deny — see "Fail open").

---

## 2. Rule Layer (CLAUDE.md / AGENTS.md)

**How it works**: place a rule file in the project root stating that "reading images must go through the text-vision tools", so the model develops consistent behavior. This is the primary trigger mechanism in hook-less tools such as OpenCode and Cursor.

> **Key: the rules must cover the "pasted / dropped image" scenario.** Host tools save a pasted image as a local file; the model sees the path/filename (`[Image 1] file x.png` / `![image](...)`) but not the content. The rules must instruct the model to "not ask for the path, locate the saved file itself, then call `describe_image`" — otherwise it may reply "I can't see images" and ask the user to resend the image.

### 2.1 `CLAUDE.md` (Claude Code-specific; place in the project root)

Ready-made template: [`templates/CLAUDE.md`](../templates/CLAUDE.md) — copy it into the project root. Core requirements: call a `text-vision` tool on any image; for a pasted image, locate the file and call `describe_image(path)` without asking for the path; prefer `ocr_image(path)` for captchas / error / document screenshots; **proactively use `list_windows()` + `screen_capture(target=…)` when the task involves a running program's UI/state (confirm with the user first if the window may show sensitive content)**.

### 2.2 `AGENTS.md` (general — OpenCode / Cursor / Gemini CLI / Codex; place in the project root)

Ready-made template: [`templates/AGENTS.md`](../templates/AGENTS.md) — copy it into the project root. Core requirements are the same as 2.1 (in English).

> Why is `AGENTS.md` in English? Rule files in OpenCode/Cursor are often executed by the model as direct instructions, and English triggers more reliably; `CLAUDE.md` stays in Chinese for this repo's primary readers. Either may be adjusted to your preference.

---

## 3. Skill Layer (SKILL.md, Optional Enhancement)

**How it works**: a skill is a description file with frontmatter; when a trigger word in the `description` matches, the model auto-loads it and follows its steps to call the tools — more structured than a plain rule.

Place it at `.claude/skills/text-vision/SKILL.md` (the Claude Code project-level skill directory). The ready-made template (with frontmatter) is [`templates/SKILL.md`](../templates/SKILL.md) — copy it over.

---

## 4. How the Three Layers Work Together

| Your scenario | Recommendation |
|---|---|
| Claude Code only | the hook layer (register per 1.1) suffices; the rule layer is optional |
| Claude Code + other tools | hook layer + a `CLAUDE.md` / `AGENTS.md` rule in each project root |
| Hook-less tools only (OpenCode/Cursor) | rule layer (2.2 `AGENTS.md`) + optional skill layer, depending on model compliance |

Suggested order: integrate MCP per [integration-guide.en.md](integration-guide.en.md) first → configure the hook layer (1.1) → add the rule/skill layers as needed.

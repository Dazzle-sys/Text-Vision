# Three-Layer Auto-Invocation: Enabling the Text Model to Read Images on Its Own

English | [简体中文](auto-invoke.md)

The MCP server solves the "**can** read images" problem. Enabling the model to "**actively** read" — that is, deciding on its own to call a vision tool during a task rather than waiting for a manually supplied description — is handled by the three layers described below. Enable them as needed; each layer builds on the previous one.

| Layer | Carrier | Tools | Trigger | Reliability |
|---|---|---|---|---|
| Rule layer | `CLAUDE.md` / `AGENTS.md` | Claude Code + general (OpenCode, Cursor, Codex…) | model compliance | medium (depends on the model) |
| Skill layer | `.claude/skills/text-vision/SKILL.md` | tools that support skills | auto-load on trigger words | medium-high |
| Hook layer | `hooks/read-image-hook.js` | Claude Code only | intercepts `Read` on images and **forces** a description | high (the model always "sees") |

> **MCP integration is a prerequisite**: register the `text-vision` server first per [integration-guide.en.md](integration-guide.en.md), then configure the three layers on this page.

---

## 1. Hook Layer (Claude Code, the Most Reliable)

**How it works**: every time Claude Code calls the `Read` tool, the `PreToolUse` hook fires first. This repository's `hooks/read-image-hook.js` checks whether the file being read is an image (`.png/.jpg/.jpeg/.webp/.gif/.bmp`). If so, it intercepts the read, converts the image into a text description via the vision model, injects it into the conversation through `additionalContext` (tagged `【图片视觉描述】`), and **denies the original binary read** — the text model receives only the description, never the image bytes.

**stdin→stdout contract** (between the hook and Claude Code):

```jsonc
// stdin input
{ "tool_name": "Read", "tool_input": { "file_path": "..." }, "cwd": "..." }

// stdout output (exit 0, exactly one JSON object)
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "图片已转为文字描述,请直接基于注入内容继续分析,不要读取图片二进制。", "additionalContext": "【图片视觉描述】..." } }
```

### 1.1 Register with Claude Code (required — the hook is inactive until registered)

Registering the MCP server does not activate the hook; the hook must be declared separately in Claude Code's `settings.json`. A project-level `.claude/settings.json` is recommended (it affects only Claude Code sessions in this project). In the examples, `text-vision` is a placeholder for the actual path where you cloned this repository — replace it:

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

- `matcher: "Read"` restricts the hook to intercepting `Read` only, without affecting other tools
- **Restart Claude Code** after changing the configuration
- A user-level `~/.claude/settings.json` (applies to all projects) is also supported, with the same path logic

### 1.2 Behavior Details

- **OCR mode**: set the environment variable `VISION_HOOK_MODE=ocr` (e.g. `VISION_HOOK_MODE=ocr claude`); image reads then go through OCR instead of description — suitable for captchas, error screenshots, and document screenshots. The injected tag becomes `【图片视觉OCR】`.
- **Self-protection** (the hook skips these files so normal `Read` operations are unaffected):
  - Any file under a `.git` directory or `node_modules`
  - Files under this repository's own `src/` / `hooks/` directories (prevents recursion)
  - Images at or above `VISION_MAX_IMAGE_MB` (default 10MB)
  - Missing or unreadable files
- **Fail open**: a missing vision configuration, failed requests, timeouts, and similar conditions **never block work**. The hook logs the error and lets the original `Read` proceed. In such a failure, a text model still receives the raw image bytes — which is why the rule layer serves as the fallback.
- **Timeout**: 30 seconds by default in the hook scenario (overridable via `VISION_TIMEOUT`), to avoid slowing model responses. Note that the retry limit `VISION_MAX_RETRIES` amplifies the total time — see the README's "Configuration" section.

### 1.3 Verifying the Hook Manually

```bash
echo '{"tool_name":"Read","cwd":"<absolute repo path>","tool_input":{"file_path":"test/test.png"}}' | node hooks/read-image-hook.js
# image → deny + 【图片视觉描述】; replace file_path with any .txt → allow
```

> Set the `VISION_*` environment variables first; otherwise the vision request fails and the hook **lets the `Read` through** (no deny — see "Fail open" above).

---

## 2. Rule Layer (CLAUDE.md / AGENTS.md)

**How it works**: place a rule file in the project root that the tool reads, stating that "reading images must go through the text-vision tools", so the text model develops consistent behavior. This is the primary trigger mechanism in hook-less tools such as OpenCode and Cursor.

> **Key: the rules must cover the "pasted / dropped image" scenario.** Host tools (OpenCode, etc.) save a pasted or dropped image as a local file; the model can see the path or filename in the message (e.g. `[Image 1] file x.png` / `![image](...)`) but not the content. The rules must instruct the model to "not ask for the path, locate the saved file itself, then call `describe_image`" — otherwise the model may reply "I can't see images" and ask the user to resend the image, which is precisely the origin of repeated image requests.

### 2.1 `CLAUDE.md` (Claude Code-specific; place in the project root)

Ready-made template: [`templates/CLAUDE.md`](../templates/CLAUDE.md) — copy it into the project root. Core requirements:

- The local text model cannot see images; on any image / screenshot / screen / UI / chart / OCR it MUST call a `text-vision` tool, never read image bytes directly
- **A pasted/dropped image is already a local file**; the message carries a path/filename clue; **do NOT reply "I can't see images", do NOT ask for the path** — locate the file and call `describe_image(path)`
- Prefer `ocr_image(path)` for captchas / error / document screenshots; use `screen_capture(focus?)` for the current screen, or `list_windows()` + `screen_capture(target=…)` for a specific program window

### 2.2 `AGENTS.md` (general — OpenCode / Cursor / Gemini CLI / Codex; place in the project root)

Ready-made template: [`templates/AGENTS.md`](../templates/AGENTS.md) — copy it into the project root. Core requirements:

- Text-only model cannot see images; on any image / screenshot / screen / UI / OCR, MUST call a `text-vision` tool
- **User pasted or dropped an image → it is already a local file**; do NOT reply "I can't see images" and do NOT ask for the path — locate the file (use the path in the message, or search temp / project dirs for recent images) and call `describe_image(path)`
- Prefer `ocr_image(path)` for captchas / error / document screenshots; use `screen_capture(focus?)` for the current screen, or `list_windows()` + `screen_capture(target=…)` for a specific program window

> Why is `AGENTS.md` written in English? Rule files in OpenCode/Cursor are often executed by the model as direct instructions, and English triggers more reliably. `CLAUDE.md` remains in Chinese because this repository's primary readers are Chinese. Either file may be adjusted to your preference.

---

## 3. Skill Layer (SKILL.md, Optional Enhancement)

**How it works**: Claude Code and other tools support "skills" — a description file with frontmatter. When a trigger word in the `description` is matched, the model automatically loads the skill and follows its steps to call the tools. A skill is more structured than a plain rule.

Place it at `.claude/skills/text-vision/SKILL.md` (the Claude Code project-level skill directory). The ready-made template (with frontmatter) is [`templates/SKILL.md`](../templates/SKILL.md) — copy it over. When a trigger word is matched, the model follows the skill's steps to convert the image into a text description.

---

## 4. How the Three Layers Work Together

| Your scenario | Recommendation |
|---|---|
| Claude Code only | the hook layer (register per 1.1) suffices; the rule layer is optional |
| Claude Code + other tools | hook layer + a `CLAUDE.md` / `AGENTS.md` rule in each project root |
| Hook-less tools only (OpenCode/Cursor) | rule layer (2.2 `AGENTS.md`) + optional skill layer, depending on model compliance |

Suggested order: integrate MCP per [integration-guide.en.md](integration-guide.en.md) first → configure the hook layer (1.1) → add the rule/skill layers as needed.

# Vision rules

This machine uses a text-only model (e.g. DeepSeek) that cannot see images. When the user mentions an image / screenshot / screen / UI, or a task needs to read `.png/.jpg/.jpeg/.webp/.gif/.bmp` content, you MUST use the `text-vision` tools instead of reading image bytes:

- `describe_image(path, focus?)` — describe an image
- `ocr_image(path)` — extract text from an image (OCR)
- `list_windows()` — list currently open windows (window ID + title + process name + PID; includes minimized ones, marked "minimized")
- `screen_capture(target, focus?, clientArea?)` — capture a **specific program window** and describe it. Usage: see "Proactively capture screens" below. No match errors out explicitly — no full-screen capture

**Proactively capture screens (you capture — the user won't).**
Actively capture when the task involves a running program/window:
- user asks "what is this app doing / what's its state / how do I use it"
- you need the current UI layout, a button, menu, or dialog
- verify a change after an action, or inspect an error/alert dialog

Flow: ① `list_windows()` → ② pick `target` (window ID / process name / title) → ③ `screen_capture(target=…)` → ④ analyze; **screens are a snapshot — re-capture after key actions**. `clientArea=true` (Windows only) strips the frame and title bar.

Guardrail: captures go to a third-party vision API. If the target window may contain passwords/accounts/chat logs/IDs, **confirm with the user before capturing**. No window match errors out — check the process is actually running, never invent UI content.

**When the user pastes or drops an image in the chat**: the host tool has already saved it as a local file, and the message usually carries the path or filename (e.g. `[Image 1] file xxx.png` / `![image](...)`). Do NOT reply "I can't see images" and do NOT ask the user for the path. Locate the file yourself — use the path from the message, or search the temp / project directories for recently created images when only a filename is given — then call `describe_image(path)` (or `ocr_image(path)` for captchas / error / document screenshots).

If a PreToolUse hook is configured, Read on images is auto-converted; this rule is a fallback.

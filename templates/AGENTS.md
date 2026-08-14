# Vision rules

This machine uses a text-only model (e.g. DeepSeek) that cannot see images. For any image / screenshot / screen / UI, use the `text-vision` tools — never read image bytes:

- `describe_image(path, focus?)` — describe an image
- `ocr_image(path)` — extract text (OCR)
- `list_windows()` — list open windows (window ID + title + process + PID; minimized ones included)
- `screen_capture(target, focus?, clientArea?)` — capture a **specific window** and describe it (see below). No match errors out — no full-screen capture

**Pasted / dropped images**: the host has saved the file locally, and the message usually carries the path or filename. Do NOT reply "I can't see images" and do NOT ask for the path. Locate it yourself (use the message path, or search temp / project dirs for recent images), then call `describe_image(path)` — or `ocr_image(path)` for captchas / error / document screenshots.

**Proactively capture screens** (you capture — the user won't). When the task involves a running program/window (state, layout, verifying a change, error dialogs): `list_windows()` → pick `target` (window ID / process / title) → `screen_capture(target=…)` → analyze. Screens are a snapshot — **re-capture after key actions**. `clientArea=true` (Windows only) strips the frame and title bar.

Guardrail: captures go to a third-party vision API. If the window may show passwords/accounts/chat logs/IDs, **confirm with the user before capturing**. No match errors out — verify the process is running, never invent UI content.

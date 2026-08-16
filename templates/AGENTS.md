# Vision rules

This machine uses a text-only model (e.g. DeepSeek) that cannot see images. For any image / screenshot / screen / UI, use the `text-vision` tools — never read image bytes:

- `describe_image(path, focus?, prompt?)` — describe an image (`prompt`, when given, is sent verbatim to the vision model as the full question, overriding `focus` and the default wording)
- `ocr_image(path, prompt?)` — extract text (OCR)
- `list_windows()` — list open windows (window ID + title + process + PID; minimized ones included)
- `screen_capture(target, focus?, prompt?)` — capture a **specific window** and describe it (see below). No match errors out — no full-screen capture

When the task involves a program/window (state, layout, verifying a change, error dialogs), **capture it proactively**:
`list_windows()` → pick `target` (window ID / process / title) → `screen_capture(target=…)` → analyze. Screens are a snapshot — **re-capture after key actions**.

Guardrail: captures go to a third-party vision API. If the window may show passwords/accounts/chat logs/IDs, **confirm with the user before capturing**. No match errors out — verify the process is running, never invent UI content.

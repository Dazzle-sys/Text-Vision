# Vision rules

This machine uses a text-only model (e.g. DeepSeek) that cannot see images. When the user mentions an image / screenshot / screen / UI, or a task needs to read `.png/.jpg/.jpeg/.webp/.gif/.bmp` content, you MUST use the `text-vision` tools instead of reading image bytes:

- `describe_image(path, focus?)` — describe an image
- `ocr_image(path)` — extract text from an image (OCR)
- `list_windows()` — list currently visible windows (title + process name)
- `screen_capture(focus?, target?)` — capture the screen and describe it. Use `screen_capture()` for the current screen; to capture a **specific program window** (avoiding occlusion by other windows), call `list_windows()` first, then `screen_capture(target='process name or title')`

**When the user pastes or drops an image in the chat**: the host tool has already saved it as a local file, and the message usually carries the path or filename (e.g. `[Image 1] file xxx.png` / `![image](...)`). Do NOT reply "I can't see images" and do NOT ask the user for the path. Locate the file yourself — use the path from the message, or search the temp / project directories for recently created images when only a filename is given — then call `describe_image(path)` (or `ocr_image(path)` for captchas / error / document screenshots).

If a PreToolUse hook is configured, Read on images is auto-converted; this rule is a fallback.

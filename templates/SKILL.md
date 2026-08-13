---
name: text-vision
description: 当任务涉及图片、截图、屏幕、界面、UI、OCR、识别、验证码时使用,把图片转为文字描述。触发词:图片 / 截图 / 屏幕 / 界面 / OCR / 识别。
---

# 视觉:把图片转成文字

本机文本模型(DeepSeek 等)看不懂图片。按需调用 text-vision 的工具:

1. **用户粘贴/拖入的图片** → 宿主工具已把图片存为本地文件,消息里通常带路径或文件名线索。**不要回复"我不支持看图",不要向用户索要路径。** 自行定位:优先用消息里的路径;只有文件名时,搜索临时/项目目录里最近创建的图片;定位后调 `describe_image(path)`;验证码/报错/文档截图优先 `ocr_image(path)`
2. **本地图片文件** → `describe_image(path, focus?)`;若是验证码/报错/文档截图,优先 `ocr_image(path)`
3. **当前屏幕** → `screen_capture(focus?)`;要截**指定程序窗口**(避免其他窗口遮挡),先 `list_windows()` 拿窗口清单,再 `screen_capture(focus?, target?)`(`target` 填进程名或窗口标题);若配置了 `VISION_DEFAULT_TARGET`,不传 target 也按它截;需截全屏传 `target=''` 或 `'全屏'`/`'fullscreen'`
4. 拿到文字后,基于它继续分析,不要尝试读图片二进制

若 PreToolUse hook 已生效,读图会自动被转成描述,本技能作为双保险。

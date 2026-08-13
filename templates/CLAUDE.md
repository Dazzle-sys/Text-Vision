# 视觉规则

本机使用 DeepSeek 等**纯文本模型**,看不懂图片。遇到以下情况必须调用 `text-vision` 的视觉工具,不要直接尝试读取图片二进制:

- 用户提到图片/截图/屏幕/界面/UI/图表/OCR/识别
- 需要理解 `.png` `.jpg` `.jpeg` `.webp` `.gif` `.bmp` 文件内容
- **用户粘贴/拖入的图片**:宿主工具(OpenCode 等)已把图片保存为本地文件,消息里通常带路径或文件名线索(如 `[Image 1] file xxx.png` / `![image](...)`)。**不要回复"我不支持看图",不要向用户索要路径。** 自行定位:优先用消息里给出的路径;只有文件名/无完整路径时,搜索临时目录与项目目录里最近创建的图片文件;定位后调用 `describe_image(path)`;若是验证码/报错/文档截图,优先 `ocr_image(path)`。

可用工具:
- `describe_image(path, focus?)` — 描述图片(主体/颜色/布局/图中文字)
- `ocr_image(path)` — 提取图中文字,保留排版
- `list_windows()` — 列出当前打开的可见窗口(标题 + 进程名)
- `screen_capture(focus?, target?)` — 截取屏幕并描述。看当前屏幕直接 `screen_capture()`;要截**指定程序窗口**(避免其他窗口遮挡),先 `list_windows()` 拿窗口清单,再 `screen_capture(target='进程名或标题')`

若已配置 PreToolUse hook(见本项目 docs/auto-invoke.md),读图会自动被拦截转成描述,本规则作为双保险。

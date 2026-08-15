# 视觉规则

本机是纯文本模型(DeepSeek 等),**看不懂图片**,遇图/界面一律调 `text-vision` 工具,别读图片二进制。

- **用户贴图**:宿主工具已存为本地文件,消息里带路径或文件名线索。**别拒绝看图、别向用户索要路径**,自行定位(优先用消息里的路径;只有文件名时搜临时/项目目录里最近创建的图片),然后调 `describe_image(path)`;验证码/报错/文档截图优先 `ocr_image(path)`。

【主动截图看界面】(AI 自己截,别等用户)
任务涉及运行中的程序/窗口(问状态、看布局、验证操作结果、查报错弹窗)时**主动截图**:
`list_windows()` 拿窗口清单 → 按窗口 ID/进程名/标题定 target → `screen_capture(target=…)` → 基于描述分析;界面是动态的,**关键操作后重截确认**。看内容细节加 `clientArea=true`(仅 Windows,去边框标题栏)。

护栏:截图会上传第三方视觉 API,窗口含密码/账号/聊天记录/证件等敏感画面时**先问用户再截**;找不到匹配窗口会明确报错,先确认目标进程在跑,不要瞎编界面内容。

工具:
- `describe_image(path, focus?, prompt?)` — 描述图片(主体/颜色/布局/图中文字);`prompt` 传完整提问时原样作发给视觉模型的 user 消息(覆盖 focus 与默认句式)
- `ocr_image(path, prompt?)` — 提取图中文字,保留排版
- `list_windows()` — 当前打开的窗口清单(窗口 ID+标题+进程名+PID,含最小化)
- `screen_capture(target, focus?, clientArea?, prompt?)` — 截**指定窗口**并描述,用法见【主动截图看界面】

若已配置 PreToolUse hook(详见 text-vision 仓库的 docs/auto-invoke.md),读图会自动被拦截转成描述,本规则作为双保险。

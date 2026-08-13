# 三层自动调用机制:让文本模型"自己去看图"

MCP server 只解决"**能**看图"的问题。要解决"**主动**看图"——模型在任务中自己决定去调用视觉工具,而不是等你手动喂描述——靠下面三层。三层逐层增强,按需启用。

| 层 | 载体 | 适用工具 | 触发方式 | 可靠性 |
|---|---|---|---|---|
| 规则层 | `CLAUDE.md` / `AGENTS.md` | Claude Code + 通用(OpenCode、Cursor、Codex…) | 模型"自觉" | 中(靠模型遵守) |
| 技能层 | `.claude/skills/text-vision/SKILL.md` | 支持技能的工具 | 触发词命中自动加载 | 中高 |
| Hook 层 | `hooks/read-image-hook.js` | 仅 Claude Code | 拦截 `Read` 读图,**强制**注入描述 | 高(模型永远"看得见") |

> **MCP 接入**是前提,先按 [integration-guide.md](integration-guide.md) 注册好 `text-vision` server,再配本页三层。

---

## 1. Hook 层(Claude Code,最可靠)

**原理**:Claude Code 每次调用 `Read` 工具读文件时,`PreToolUse` hook 先被触发。本仓库的 `hooks/read-image-hook.js` 检查:如果读的是图片(`.png/.jpg/.jpeg/.webp/.gif/.bmp`),就拦截下来,用视觉模型转成文字描述,通过 `additionalContext` 注入对话(带 `【图片视觉描述】` 标记),**并 deny 掉原始的二进制读取**——文本模型永远拿不到图片二进制,只会收到描述。

**stdin→stdout 契约**(hook 与 Claude Code 之间):

```jsonc
// stdin 输入
{ "tool_name": "Read", "tool_input": { "file_path": "..." }, "cwd": "..." }

// stdout 输出(exit 0,只输出一个 JSON)
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "该文件是图片,已通过视觉引擎转为文字描述,请直接基于注入的描述内容继续分析,不要读取图片二进制。", "additionalContext": "【图片视觉描述】..." } }
```

### 1.1 注册到 Claude Code(必做,否则 hook 不生效)

MCP server 注册好≠ hook 生效。hook 要在 Claude Code 的 `settings.json` 里单独声明。推荐放**项目级** `.claude/settings.json`(只影响本项目的 Claude Code 会话)。示例里的 `text-vision` 是占位符,指你 clone 本仓库的实际路径,替换成实际路径即可:

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

- `matcher: "Read"` 让 hook 只拦截 `Read`,不干扰其他工具
- 改完配置**重启 Claude Code** 生效
- 也可放用户级 `~/.claude/settings.json`(所有项目生效),路径同理换成实际位置

### 1.2 行为细节

- **OCR 模式**:设环境变量 `VISION_HOOK_MODE=ocr`(如 `VISION_HOOK_MODE=ocr claude`),读图改走 OCR 提取文字,适合验证码/报错截图/文档截图。注入标记变为 `【图片视觉OCR】`。
- **防误伤**(hook 自动跳过,不影响正常 Read):
  - 任何 `.git` 目录、`node_modules` 里的文件
  - 本仓库自身的 `src/`、`hooks/` 目录下的文件(防止递归)
  - 超过 `VISION_MAX_IMAGE_MB`(默认 10MB)的图片
  - 文件不存在/不可读
- **失败放行**:视觉引擎配置缺失、请求失败、超时等,**都不阻断工作**,打印错误后放行原始 Read。失败时若你是文本模型,仍会拿到图片二进制——这就是规则层作为兜底的意义。
- **超时**:hook 场景默认 30s(`VISION_TIMEOUT` 可显式覆盖),避免拖慢模型响应。注意重试上限 `VISION_MAX_RETRIES` 会放大总耗时,见 README「配置」节。

### 1.3 手动验证 hook

```bash
echo '{"tool_name":"Read","cwd":"<本仓库绝对路径>","tool_input":{"file_path":"test/test.png"}}' | node hooks/read-image-hook.js
# 图片 → deny + 【图片视觉描述】;把 file_path 换成任意 .txt → allow
```

> 验证前需先设置 `VISION_*` 环境变量,否则视觉请求会失败并**放行**(不会 deny,见上「失败放行」)。

---

## 2. 规则层(CLAUDE.md / AGENTS.md)

**原理**:在工具读取的项目根放规则文件,写明"看图必须走 text-vision 工具",让文本模型形成自觉。这是 OpenCode、Cursor 等无 hook 工具里最主要的触发方式。

> **关键:规则必须覆盖"粘贴/拖入图片"场景。** 宿主工具(OpenCode 等)会把用户粘贴/拖入的图片保存为本地文件,模型在消息里能看到路径或文件名线索(如 `[Image 1] file x.png` / `![image](...)`)但看不到内容。规则要引导模型"别索要路径、自行定位落盘文件再调 `describe_image`"——否则模型可能回复"我不支持看图"并要求用户重发图片,这正是"重复提供图片"问题的来源。

### 2.1 `CLAUDE.md`(Claude Code 专用,放项目根)

成品模板见 [`templates/CLAUDE.md`](../templates/CLAUDE.md),直接复制到项目根即可。核心要求:

- 本机文本模型看不懂图片,遇到图片/截图/屏幕/界面/UI/图表/OCR 必须调 `text-vision` 工具,不直接读图片二进制
- **用户粘贴/拖入的图片已落盘为本地文件**,消息里带路径/文件名线索;**不要回复"我不支持看图"、不要索要路径**,自行定位后调 `describe_image(path)`
- 验证码/报错/文档截图优先 `ocr_image(path)`;当前屏幕用 `screen_capture(focus?)`(配置了 `VISION_DEFAULT_TARGET` 时默认截该窗口),截指定程序窗口先 `list_windows()` 再 `screen_capture(target='进程名或标题')`

### 2.2 `AGENTS.md`(OpenCode / Cursor / Gemini CLI / Codex 等通用,放项目根)

成品模板见 [`templates/AGENTS.md`](../templates/AGENTS.md),直接复制到项目根即可。核心要求:

- Text-only model cannot see images; on any image / screenshot / screen / UI / OCR, MUST call a `text-vision` tool
- **User pasted or dropped an image → it is already a local file**; do NOT reply "I can't see images" and do NOT ask for the path — locate the file (use the path in the message, or search temp / project dirs for recent images) and call `describe_image(path)`
- Prefer `ocr_image(path)` for captchas / error / document screenshots; use `screen_capture(focus?)` for the current screen, or `list_windows()` + `screen_capture(target=…)` for a specific program window

> 为什么 AGENTS.md 给英文?OpenCode/Cursor 的规则文件常被模型作为指令直接执行,英文命中率更稳;CLAUDE.md 因本仓库读者以中文为主保留中文。两者均可按自己习惯改。

---

## 3. 技能层(SKILL.md,可选增强)

**原理**:Claude Code 等工具支持"技能"(skill)——一个带 frontmatter 的说明文件,`description` 里的触发词命中时,模型自动加载该技能并按其中步骤调用工具。比纯规则更结构化。

放 `.claude/skills/text-vision/SKILL.md`(Claude Code 项目级技能目录),成品模板见 [`templates/SKILL.md`](../templates/SKILL.md)(含 frontmatter),复制过去即可。触发词命中时,模型会按技能步骤把图片转成文字描述。

---

## 4. 三层怎么配合

| 你的场景 | 建议 |
|---|---|
| 只用 Claude Code | hook 层(1.1 注册)就够,规则层可省 |
| Claude Code + 其他工具混用 | hook 层 + 各项目根放 `CLAUDE.md`/`AGENTS.md` 规则 |
| 只有 OpenCode/Cursor 等无 hook 工具 | 规则层(2.2 `AGENTS.md`)+ 可选技能层,靠模型自觉 |

配置顺序建议:先按 [integration-guide.md](integration-guide.md) 接好 MCP → hook 层(1.1)→ 需要时补规则层/技能层。

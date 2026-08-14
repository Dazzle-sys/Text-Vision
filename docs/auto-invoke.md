# 三层自动调用机制:让文本模型"自己去看图"

MCP server 解决"**能**看图";三层机制解决"**主动**看图"——模型在任务中自己决定调用视觉工具,而非等你手动喂描述。三层逐层增强,按需启用:

> **分工定位**:读图类工具(`describe_image` / `ocr_image`)承接用户**贴图**与本地图片;截图类工具(`screen_capture` / `list_windows`)是给**执行任务的 AI 主动调用做视觉识别**的——模型需要看运行中程序的界面/状态时自己截,不靠用户手动截图。这份"主动截图"引导已内置进模板规则(见 [templates/](../templates/) 的【主动截图看界面】段)。

| 层 | 载体 | 适用工具 | 触发方式 | 可靠性 |
|---|---|---|---|---|
| 规则层 | `CLAUDE.md` / `AGENTS.md` | Claude Code + 通用(OpenCode、Cursor、Codex…) | 模型"自觉" | 中(靠模型遵守) |
| 技能层 | `.claude/skills/text-vision/SKILL.md` | 支持技能的工具 | 触发词命中自动加载 | 中高 |
| Hook 层 | `hooks/read-image-hook.js` | 仅 Claude Code | 拦截 `Read` 读图,**强制**注入描述 | 高(模型永远"看得见") |

> **MCP 接入**是前提,先按 [integration-guide.md](integration-guide.md) 注册好 `text-vision` server,再配本页三层。

---

## 1. Hook 层(Claude Code,最可靠)

**原理**:Claude Code 每次 `Read` 读文件时,`PreToolUse` hook 先触发。`hooks/read-image-hook.js` 检查:若读的是图片(`.png/.jpg/.jpeg/.webp/.gif/.bmp`),就拦截下来,用视觉模型转成文字描述,通过 `additionalContext` 注入对话(带 `【图片视觉描述】` 标记),**并 deny 掉原始二进制读取**——文本模型永远只收到描述。

**stdin→stdout 契约**(hook 与 Claude Code 之间):

```jsonc
// stdin 输入
{ "tool_name": "Read", "tool_input": { "file_path": "..." }, "cwd": "..." }

// stdout 输出(exit 0,只输出一个 JSON)
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "该文件是图片,已通过视觉引擎转为文字描述,请直接基于注入的描述内容继续分析,不要读取图片二进制。", "additionalContext": "【图片视觉描述】..." } }
```

### 1.1 注册到 Claude Code(必做,否则 hook 不生效)

MCP 注册好≠ hook 生效。hook 要在 Claude Code 的 `settings.json` 里单独声明,推荐放**项目级** `.claude/settings.json`(只影响本项目会话)。`text-vision` 是占位符,换成你的实际路径:

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

- `matcher: "Read"` 让 hook 只拦截 `Read`,不干扰其他工具
- 改完配置**重启 Claude Code** 生效
- 也可放用户级 `~/.claude/settings.json`(所有项目生效),路径同理

### 1.2 行为细节

- **OCR 模式**:设 `VISION_HOOK_MODE=ocr`(如 `VISION_HOOK_MODE=ocr claude`),读图改走 OCR,注入标记变为 `【图片视觉OCR】`,适合验证码/报错截图/文档截图。
- **防误伤**(hook 自动跳过,不影响正常 Read):`.git` 与 `node_modules` 内文件、本仓库 `src/`/`hooks/` 目录(防递归)、达到或超过 `VISION_MAX_IMAGE_MB`(默认 10MB)的图片、文件不存在/不可读。
- **失败放行**:配置缺失、请求失败、超时等**都不阻断工作**,打印错误后放行原始 Read。此时文本模型仍会拿到图片二进制——规则层就是兜底。
- **超时**:hook 场景默认 30s(`VISION_TIMEOUT` 可覆盖),避免拖慢模型响应。`VISION_MAX_RETRIES` 会放大总耗时,见 README「配置」节。

### 1.3 手动验证 hook

```bash
echo '{"tool_name":"Read","cwd":"<本仓库绝对路径>","tool_input":{"file_path":"test/test.png"}}' | node hooks/read-image-hook.js
# 图片 → deny + 【图片视觉描述】;把 file_path 换成任意 .txt → allow
```

> 验证前需先设 `VISION_*` 环境变量,否则视觉请求失败会**放行**(不会 deny,见「失败放行」)。

---

## 2. 规则层(CLAUDE.md / AGENTS.md)

**原理**:在项目根放规则文件,写明"看图必须走 text-vision 工具",让模型形成自觉。这是 OpenCode、Cursor 等无 hook 工具里最主要的触发方式。

> **关键:规则必须覆盖"粘贴/拖入图片"场景。** 宿主工具会把粘贴/拖入的图片保存为本地文件,模型能看到路径/文件名线索(`[Image 1] file x.png` / `![image](...)`)但看不到内容。规则要引导模型"别索要路径、自行定位落盘文件再调 `describe_image`"——否则模型可能回"我不支持看图"并要求重发图片。

### 2.1 `CLAUDE.md`(Claude Code 专用,放项目根)

成品模板见 [`templates/CLAUDE.md`](../templates/CLAUDE.md),复制到项目根即可。核心要求:遇图必调 `text-vision` 工具、粘贴图片自行定位不索要路径、验证码/报错截图优先 `ocr_image`;**任务涉及运行中程序的界面/状态时主动 `list_windows()` + `screen_capture(target=…)` 截图观察(目标窗口可能含敏感画面时先问用户)**。

### 2.2 `AGENTS.md`(OpenCode / Cursor / Gemini CLI / Codex 等通用,放项目根)

成品模板见 [`templates/AGENTS.md`](../templates/AGENTS.md),复制到项目根即可。核心要求与 2.1 相同(英文版)。

> 为什么 AGENTS.md 给英文?OpenCode/Cursor 的规则文件常被模型作为指令直接执行,英文命中率更稳;CLAUDE.md 因本仓库读者以中文为主保留中文。均可按习惯改。

---

## 3. 技能层(SKILL.md,可选增强)

**原理**:技能(skill)是带 frontmatter 的说明文件,`description` 里的触发词命中时,模型自动加载并按其中步骤调用工具,比纯规则更结构化。

放 `.claude/skills/text-vision/SKILL.md`(Claude Code 项目级技能目录),成品模板见 [`templates/SKILL.md`](../templates/SKILL.md)(含 frontmatter),复制过去即可。

---

## 4. 三层怎么配合

| 你的场景 | 建议 |
|---|---|
| 只用 Claude Code | hook 层(1.1 注册)就够,规则层可省 |
| Claude Code + 其他工具混用 | hook 层 + 各项目根放 `CLAUDE.md`/`AGENTS.md` 规则 |
| 只有 OpenCode/Cursor 等无 hook 工具 | 规则层(2.2 `AGENTS.md`)+ 可选技能层,靠模型自觉 |

配置顺序:先按 [integration-guide.md](integration-guide.md) 接好 MCP → hook 层(1.1)→ 需要时补规则层/技能层。

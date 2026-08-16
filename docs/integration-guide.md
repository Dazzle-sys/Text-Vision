# MCP 接入指南: 把 text-vision 接进你的 AI 工具

[English](integration-guide.en.md) | 简体中文

本项目核心只有一个 MCP server(`src/index.js`),接入 = 在支持 MCP 的工具里**注册一行启动命令**,核心代码零改动。

> 各工具的 MCP 配置格式会随版本演进。本文示例基于当前主流版本,若与你的版本不一致,**以对应工具的官方文档为准**——格式大同小异,重点是 `command` + `args` 这对字段。

## 0. 注册前准备

先确认启动命令能跑(在项目目录执行,能看到 MCP 启动而不立即报错):

```bash
cd text-vision
node src/index.js
```

如果这一步报错(缺依赖、Node 版本过低),工具侧配置了也没用。正常启动会**静默等待 stdin**(stdio 协议),不打印任何东西——"没输出"= 正常,Ctrl+C 退出即可。启动无需配置,但**调用视觉工具前需设 `VISION_*` 环境变量**(见 [第 6 节](#6-用环境变量配置推荐)),否则返回"视觉引擎未配置"。

**路径小技巧**:配置里启动路径建议用**正斜杠**(`text-vision/...`)。JSON 里反斜杠要写成 `\\` 易出错,node 两种都识别,正斜杠最省心。

## 1. Claude Code

**推荐**用命令行注册(自动写入正确位置):

```bash
claude mcp add text-vision -- node text-vision/src/index.js
```

或手动编辑配置文件(二选一):

- **用户级**(所有项目可用):`~/.claude.json` 的 `mcpServers` 字段
- **项目级**(仅当前项目):项目根新建 `.mcp.json`

```json
{
  "mcpServers": {
    "text-vision": {
      "command": "node",
      "args": ["text-vision/src/index.js"]
    }
  }
}
```

改完需**重启 Claude Code** 生效;用 `claude mcp add` 注册的也建议重开会话。

> Claude Code 支持在 MCP 配置注入 `env` 字段(本项目的配置全走环境变量),见 [第 6 节](#6-用环境变量配置推荐)。

## 2. OpenCode

编辑项目级 `opencode.json`(或全局 `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "text-vision": {
      "type": "stdio",
      "command": "node",
      "args": ["text-vision/src/index.js"]
    }
  }
}
```

## 3. Cursor

项目级 `.cursor/mcp.json`(或 Cursor 设置 → MCP 面板手动添加):

```json
{
  "mcpServers": {
    "text-vision": {
      "command": "node",
      "args": ["text-vision/src/index.js"]
    }
  }
}
```

## 4. Windsurf

项目根 `mcp_config.json`:

```json
{
  "mcpServers": {
    "text-vision": {
      "command": "node",
      "args": ["text-vision/src/index.js"]
    }
  }
}
```

## 5. Gemini CLI 与 OpenAI Codex

Gemini CLI(推荐用命令注册,或手动编辑配置文件):

```bash
gemini mcp add text-vision -- node text-vision/src/index.js
```

Codex CLI(配置文件为 `config.toml`):

```toml
[mcp_servers.text-vision]
command = "node"
args = ["text-vision/src/index.js"]
```

## 6. 用环境变量配置(推荐)

本项目**不读任何配置文件**,全部走环境变量(`VISION_*` 前缀)。推荐直接在 MCP 注册配置里注入 `env` 字段,和工具绑定、随配置一起走(不必先开终端 export):

```json
{
  "mcpServers": {
    "text-vision": {
      "command": "node",
      "args": ["text-vision/src/index.js"],
      "env": {
        "VISION_API_BASE": "https://open.bigmodel.cn/api/paas/v4",
        "VISION_API_KEY": "你的GLM-4V的Key",
        "VISION_MODEL": "glm-4v-plus",
        "VISION_TIMEOUT": "60000",
        "VISION_LOG_FILE": ""
      }
    }
  }
}
```

支持的全部环境变量见 README「配置」一节(`VISION_*` 前缀)。也可以不写 `env`,直接在终端导出后启动(如 `export VISION_API_KEY=...`),二选一即可。示例里的 `VISION_TIMEOUT`、`VISION_LOG_FILE` 均可选,含义见 README 对应小节。

> **Claude Code 用户注意**:上面的 `env` 字段只注入到 MCP server 子进程,**对两条 hook(Read 读图 / 粘贴图拦截)不生效**——hook 是 Claude Code 直接启动的独立进程,只读**全局/宿主环境变量**。若要用 hook,请 `export VISION_API_KEY=...`(或写进宿主环境),否则 MCP 工具正常、hook 会静默失效(不注入描述)。详见 [docs/auto-invoke.md](docs/auto-invoke.md)。

## 7. 换机器 / 换目录

MCP 配置里**唯一要改的就是 `args` 里的启动路径**。复制项目后:

1. 新机器先 `npm install`
2. 把各工具配置里的 `text-vision` 换成你的实际路径
3. 重新配置 `VISION_API_KEY` 等环境变量(建议写在 `env` 字段)

## 8. 常见问题

| 问题 | 原因 / 处理 |
|---|---|
| MCP server 连接失败/启动报错 | 先手动跑 `node text-vision/src/index.js` 确认能启动;多数是 Node < 20 或没 `npm install` |
| 提示 node 找不到(Windows) | node 不在 PATH,把 `command` 改为完整路径。JSON 里反斜杠写 `\\`,如 `"command": "C:\\Program Files\\nodejs\\node.exe"`;或用正斜杠 `C:/Program Files/nodejs/node.exe`(node 也能识别) |
| 工具里看不到四个工具 | 配置改完没重启工具;或 server 名与配置不一致 |
| 提示"视觉引擎未配置" | 没设 `VISION_*`,按 [第 6 节](#6-用环境变量配置推荐) 注入 `env`(或先 `export`) |
| 图片路径传相对路径找不到 | 相对路径按 **MCP server 启动目录**解析,建议传绝对路径 |
| 模型回"我不支持看图/请提供图片路径" | 粘贴图自动识别未覆盖。启用技能层(`skills/text-vision/SKILL.md`)或 `paste-image-hook`(见 docs/auto-invoke.md) |
| 模型不主动截图看界面 | 规则未覆盖"主动截图"场景。按 docs/auto-invoke.md 2.x 更新项目根 AGENTS.md/CLAUDE.md(模板含主动截图引导) |

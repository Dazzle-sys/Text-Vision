# MCP 接入指南:把 text-vision 接进你的 AI 工具

本项目核心只有一个 MCP server(`src/index.js`),接入 = 在各支持 MCP 的工具里**注册一行启动命令**,核心代码零改动。

> 各工具的 MCP 配置格式会随版本演进。本文示例基于当前主流版本,若与你所用版本不一致,**以对应工具的官方文档为准**,格式大同小异,重点是 `command` + `args` 这对字段。

## 0. 注册前准备

> 想省事?把 README「安装」里的「让 AI 帮你装」提示词复制给你的 AI 助手,让它自动完成下面的注册与配置。

先确认启动命令能跑(在项目目录执行,能看到 MCP 启动而不立即报错):

```bash
cd text-vision
node src/index.js
```

如果这一步就报错(如缺依赖、Node 版本过低),工具侧配置了也没用。正常启动会**静默等待 stdin**(stdio 协议),不打印任何东西,所以"没输出"= 正常,直接 Ctrl+C 退出即可。启动本身无需配置,但**调用视觉工具前需设置 `VISION_*` 环境变量**(见 [第 6 节](#6-用环境变量配置推荐)),否则会返回"视觉引擎未配置"。

**配置路径小技巧**:所有工具的配置里,启动路径都建议用**正斜杠**(`text-vision/...`)而不是反斜杠。JSON 里反斜杠要写成 `\\` 容易出错,node 两种都能识别,用正斜杠最省心。

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

改完配置文件需**重启 Claude Code** 生效;用 `claude mcp add` 注册的也建议重开会话。

> Claude Code 支持在 MCP 配置里注入环境变量(`env` 字段),本项目的配置全部走环境变量,见本文 [第 6 节](#6-用环境变量配置推荐)。

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

本项目**不读取任何配置文件**,全部通过环境变量(`VISION_*` 前缀)配置。推荐直接在 MCP 注册配置里注入 `env` 字段,和工具绑定、随配置一起走(不必先开终端 export):

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

支持的全部环境变量见 README「配置」一节(`VISION_*` 前缀)。也可以不写 `env` 字段,直接在终端导出后启动(如 `export VISION_API_KEY=...`),二选一即可。其中 `VISION_LOG_FILE` 可选:指定窗口失败/降级时的诊断日志文件路径,不填则写本仓库根 `.text-vision/log.txt`,用于排查"为什么没用指定窗口"。

## 7. 换机器 / 换目录

MCP 配置里**唯一需要改的就是 `args` 里的启动路径**。复制项目后:

1. 新机器先 `npm install`
2. 把各工具配置里的 `text-vision` 换成你的实际路径
3. 重新配置 `VISION_API_KEY` 等环境变量(建议写在 MCP 配置的 `env` 字段里)

## 8. 常见问题

| 问题 | 原因 / 处理 |
|---|---|
| MCP server 显示连接失败/启动报错 | 先手动跑 `node text-vision/src/index.js` 确认能启动;多数是 Node 版本 < 20 或 `npm install` 没执行 |
| 提示 node 找不到(Windows) | node 不在 PATH,把 `command` 改为 node 完整路径。注意 JSON 里反斜杠必须写成 `\\`,即 `"command": "C:\\Program Files\\nodejs\\node.exe"`;或直接用正斜杠 `"command": "C:/Program Files/nodejs/node.exe"`(node 也能识别),更省事 |
| 工具里看不到四个工具 | 配置改完没重启工具;或 server 名与配置里不一致 |
| 调用工具提示"视觉引擎未配置" | 没设 `VISION_*` 环境变量,按 [第 6 节](#6-用环境变量配置推荐) 在 MCP 配置 `env` 字段注入(或先 `export`) |
| 图片路径传相对路径找不到 | 相对路径按 **MCP server 的启动目录**解析,建议传绝对路径 |
| 模型回复"我不支持看图 / 请提供图片路径" | 规则模板未覆盖"用户粘贴/拖入图片"场景。按 docs/auto-invoke.md 2.x 更新项目根 AGENTS.md/CLAUDE.md,加入"粘贴图片→自行定位落盘文件→调 describe_image"指引 |

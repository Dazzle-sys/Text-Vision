# Text-Vision 开发须知

给无视觉文本模型提供视觉能力的 MCP server(图片/截图/屏幕 → 文字描述)。ESM 纯 Node.js(>=20),无构建步骤,依赖仅 `@modelcontextprotocol/server` + `zod`。

## 常用命令

- `npm test` — 全部单测(node:test,`--test-concurrency=1`),网络全部 mock,**无需 `VISION_*` 环境变量**。单跑一个文件:`node --test --test-concurrency=1 test/vision.test.js`
- `npm run check:docs` — 提交前必跑:扫描 README / docs / templates / **本文件**是否含本机绝对路径,命中即失败。写文档、注释、提示文案别写真实绝对路径,用占位符
- `npm run check:version` — 版本一致性:package.json、server.json(顶层 + packages.0)、.claude-plugin/plugin.json 共 **4 处**必须一致,升版本要全改
- `npm run gen:test-image` — 重新生成测试样例图 `test/test.png`
- `npm run test:describe` — 需真实 `VISION_API_BASE` / `VISION_API_KEY` / `VISION_MODEL` 并调用视觉 API;`npm run test:capture` — 真机截屏,无需 env
- 发布前 `prepublishOnly` 自动跑 check:version + check:docs

CI(`.github/workflows/ci.yml`):Node 20/22 × 三平台跑 test + check:docs + check:version;另有 Windows 真机冒烟 `node scripts/smoke-windows.js`(验证 src/scripts/win-enum.ps1 可被 PowerShell 执行)。

## 架构要点

- MCP server 入口 `src/index.js`:`createServer(deps)` 支持注入依赖,测试直接构造 server 验证工具注册与 handler 契约;server 版本号运行时从 package.json 读取,别写死
- 视觉核心 `src/text-vision-client.js` 被 MCP server 与 hooks **两个独立进程复用**,视觉逻辑只此一份;配置全走 `VISION_*` 环境变量,无配置文件
- 平台依赖脚本在 `src/scripts/`(win-enum.ps1 / win-capture.ps1 / win-compress.ps1 / mac-enum.swift);单测全部 mock 平台调用,`test/scripts-snapshot.test.js` 按**内容哨兵**断言脚本关键符号——改脚本时删掉这些符号会挂测试
- `hooks/`(read-image / paste-image)仅 Claude Code 使用,共享逻辑在 `hooks/shared.js`;OpenCode 走不到
- 截图/日志默认落仓库 `.text-vision/`(已 gitignore),仓库只读自动回退 `~/.text-vision`,`VISION_STORAGE_ROOT` 可显式覆盖(见 `src/storage-root.js`)

## 约定与坑

- MCP server 走 stdio:**stdout 只能输出协议数据**,调试日志一律走 stderr(`src/debug.js` 的 debugLog)
- 新模块若"直接运行时才执行副作用",用 `isDirectRun(import.meta.url)` 门控(server/hook 均如此),否则测试 import 会误触发
- 修改工具描述/错误文案后跑 `npm test`:多处测试断言精确字符串(如 `NO_TARGET_MSG`);错误信息必须过 `src/redact.js` 的路径/凭据脱敏,别绕过
- 测试共享基础设施在 `test/helpers.js`(stubFetch / okRes / errRes / makeTempDir);stub 了 `global.fetch` 或注入过模块状态(如 `setStorageRootForTest`)的用例必须对称恢复
- `.text-vision/` 是本机运行态(日志 + 最近 20 张截图,含视觉 API 请求与截图路径),绝不入提交

## 本文件 vs templates/

- `templates/AGENTS.md` / `templates/CLAUDE.md` 是给**使用者**的视觉规则模板(复制进别的项目),不是本仓库开发须知;改模板与改本文件互不影响,都过 check:docs

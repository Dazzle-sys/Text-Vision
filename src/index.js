#!/usr/bin/env node
// text-vision:给无视觉文本模型(DeepSeek 等)提供视觉能力的 MCP server
// 工具:describe_image / ocr_image / screen_capture / list_windows(全部返回纯文字)
// Claude Code、OpenCode 及其他支持 MCP 的工具均可接入。
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { describeImage, describeImageFromBase64, ocrImage, SUPPORTED_EXTS_TEXT } from './text-vision-client.js';
import { captureScreen, NO_TARGET_MSG } from './capture-screen.js';
import { listWindows } from './list-windows.js';
import { appendLog, debugLog } from './log.js';
import { isDirectRun } from './is-direct-run.js';
import { redactLocalPath } from './redact.js';

const SERVER_NAME = 'text-vision';
// 版本号单一来源:从 package.json 读取,避免升版本时只改了一处导致 tools/list 版本与包不一致
const { version: SERVER_VERSION } = createRequire(import.meta.url)('../package.json');

/**
 * 创建 MCP server 并注册四个视觉工具。connect 不在此函数内做,
 * 便于自动化测试直接构造 server 验证工具注册、schema 与 handler 契约。
 * deps 可选,用于测试注入 mock 实现(不传则用真实实现)。
 */
export function createServer(deps = {}) {
  const describe = deps.describe ?? describeImage;
  const ocr = deps.ocr ?? ocrImage;
  const capture = deps.capture ?? captureScreen;
  const describeBase64 = deps.describeBase64 ?? describeImageFromBase64;
  const listWindowsFn = deps.listWindows ?? listWindows;
  const appendLogFn = deps.appendLog ?? appendLog;
  const debugLogFn = deps.debugLog ?? debugLog;

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  /** MCP 文本结果统一形状:{ content, isError }。 */
  function textResult(r) {
    return { content: [{ type: 'text', text: r.text }], isError: !r.ok };
  }

  /**
   * 统一工具 handler 兜底:实现层正常收口为 { ok, text },这里兜底未来回归——任何异常都以
   * 脱敏后的统一错误形态返回,保证 MCP 响应永远是 { content, isError } 形状,且不向客户端
   * 泄露本机路径(redactLocalPath,与 capture-screen 等模块的隐私惯例一致)。
   */
  function wrapTool(prefix, fn) {
    return async (args) => {
      try {
        return await fn(args);
      } catch (err) {
        const msg = `${prefix}失败: ${redactLocalPath(err?.message ?? String(err))}`;
        // 兜底异常同样落盘,避免"该记录却查不到";appendLogFn 已是注入依赖,失败静默不拖垮主流程
        // (await 与下方降级日志一致,防注入的 async 实现 reject 变成 unhandledRejection 拖垮进程)
        try { await appendLogFn('tool_error', msg); } catch { /* 日志失败静默 */ }
        return textResult({ ok: false, text: msg });
      }
    };
  }

  // 四个工具都是"读"类:不修改文件/窗口/系统状态,全部标 readOnlyHint,供客户端(如权限 UI、ChatGPT 插件审核)识别。
  // title 是 tools/list 里的短名,description 是详细说明;readOnlyHint 为 true 表示调用无副作用。
  server.registerTool(
    'describe_image',
    {
      title: '描述本地图片',
      description: '用视觉模型描述一张本地图片(主体、颜色、布局、对象关系、图中文字等)。路径可为相对或绝对路径。用户粘贴/拖入的图片通常已被宿主工具保存为本地文件,消息里通常带路径或文件名线索:有路径直接传;只有文件名时,本工具按路径直接读取本地文件、不做文件搜索,请先用宿主工具(文件搜索/临时目录)定位该文件后传完整路径,不要向用户索要路径。图片内容会发送到第三方视觉 API 处理。',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        path: z.string().describe(`本地图片路径(${SUPPORTED_EXTS_TEXT})`),
        focus: z.string().optional().describe('关注的要点,如"按钮的颜色""图表坐标轴含义""界面元素"')
      })
    },
    wrapTool('描述图片', async ({ path, focus }) => {
      const r = await describe(path, focus);
      return textResult(r);
    })
  );

  server.registerTool(
    'ocr_image',
    {
      title: '提取图片文字',
      description: '提取图片中的文字(OCR),保留排版顺序。适合验证码、报错截图、文档截图。用户粘贴/拖入的截图通常已被宿主工具保存为本地文件:有路径直接传;只有文件名时,本工具按路径直接读取本地文件、不做文件搜索,请先用宿主工具定位该文件后传完整路径。图片内容会发送到第三方视觉 API 处理。',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        path: z.string().describe(`本地图片路径(${SUPPORTED_EXTS_TEXT})`)
      })
    },
    // 'OCR ' 尾随空格:英文缩写与中文"失败"之间保留空格(原手写文案如此)
    wrapTool('OCR ', async ({ path }) => {
      const r = await ocr(path);
      return textResult(r);
    })
  );

  server.registerTool(
    'screen_capture',
    {
      title: '截取指定窗口',
      description: '截取指定程序窗口并用视觉模型描述画面,截屏内容会发送到第三方视觉 API 处理。适合查看某个应用的界面、UI 状态。必须传 target(窗口 ID、进程名或窗口标题,模糊匹配)指定要截的窗口;可先用 list_windows 查看当前有哪些窗口可选。找不到匹配窗口/窗口截图失败会明确报错,不会回退全屏。',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        focus: z.string().optional().describe('关注的要点,如"当前界面布局""错误弹窗内容"'),
        target: z.string().optional().describe('必填:要截取的程序/窗口——窗口 ID、进程名或窗口标题(如 456、chrome、未命名 - 记事本),模糊匹配。被遮挡/最小化窗口也能截到本体内容(该能力仅 Windows 生效;macOS 对被遮挡窗口可能截到遮挡层、最小化到 Dock 的窗口无法枚举)。找不到匹配窗口时明确报错。'),
        clientArea: z.boolean().optional().describe('(仅 Windows 生效)为 true 时截窗口客户区(去边框和标题栏),视觉描述聚焦窗口内容;macOS/Linux 忽略此参数')
      })
    },
    wrapTool('截屏', async ({ focus, target, clientArea }) => {
      // target 必填:本工具只截指定窗口,不再支持全屏/默认窗口。空白 target 也给友好错误,而非走到枚举
      if (!target || !String(target).trim()) {
        return textResult({ ok: false, text: NO_TARGET_MSG });
      }
      const shot = await capture({ target, clientArea });
      // 防御:注入的 capture 实现/未来回归返回空时,给明确错误文案,而非 TypeError(不向客户端抛内部异常)
      if (!shot || typeof shot.b64 !== 'string') {
        return textResult({ ok: false, text: '截屏失败:截屏实现未返回有效的图片数据。' });
      }
      // 截屏 note(降级原因或成功截图的信息提示):截图成功、视觉请求前就写日志,保证即使后续描述失败,原因也已落盘 + stderr
      // 注意:note 不全是"降级"——成功截到窗口时的信息提示(如"窗口原为最小化,已临时恢复")也走同一通道,
      // 事件名固定为 screen_capture_degrade(测试固化),README 已说明该事件含降级原因与成功提示,不都意味着降级
      if (shot?.note) {
        // await 日志:未来 appendLog 若改异步实现,也保证 note 先落盘再继续;失败仍静默,不拖垮主流程
        try { await appendLogFn('screen_capture_degrade', shot.note); } catch { /* 日志失败静默 */ }
        debugLogFn('指定窗口截图 note:', shot.note);
      }
      // 第 4 参是 cfg(缺省走 loadConfig 读 env,这里显式 undefined 占位),第 5 参 source 用于失败日志定位
      // (拼上截图落盘路径,失败时可查是哪个截图文件)、第 6 参 sourceLabel 用于成功日志(纯标签'截屏',不含路径)。
      // 切勿把 source 直接放第 4 位——cfg 会被字符串污染,describeImageFromBase64 误判"视觉引擎未配置"。
      const src = shot?.filePath ? `截屏 ${shot.filePath}` : '截屏';
      // focus 提示词:显式传 focus 用它;否则用 target 原文(窗口 ID/进程名/标题)。target 必填(handler 已校验),
      // 历史契约:显式 target 用原文而非命中的真实窗口名(targetLabel),不额外枚举/不改变提示来源。
      const focusText = focus || `指定的窗口:${target}`;
      const r = await describeBase64(shot.b64, shot.mime, focusText, undefined, src, '截屏');
      // 描述成功才把降级提示拼进返回文本;描述失败时文本是错误文案,note 已通过日志(文件+stderr)传达
      const hint = r.ok && shot?.note ? `\n\n[提示] ${shot.note}` : '';
      // 截图保留在仓库 .text-vision/screenshots(最近 20 张),直接给完整路径方便打开(运行时输出,不入提交)
      const saveHint = r.ok && shot?.filePath ? `\n\n[截图已保存到 ${shot.filePath},可打开查看;仅保留最近 20 张,超出自动清理]` : '';
      return textResult({ ok: r.ok, text: r.text + hint + saveHint });
    })
  );

  server.registerTool(
    'list_windows',
    {
      title: '列出窗口',
      description: '列出当前打开的窗口(含最小化窗口,标注"已最小化";最小化窗口可用 screen_capture 截取,截取时会临时恢复)(窗口 ID + 标题 + 进程名 + PID),供选择 screen_capture 的 target(可传窗口 ID 精确锁定)。纯文本模型看不到屏幕,截指定窗口前先调用本工具拿到窗口清单,再填 screen_capture(target)。',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({})
    },
    wrapTool('枚举窗口', async () => {
      const windows = await listWindowsFn();
      if (!windows.length) {
        return textResult({ ok: false, text: '没有枚举到窗口。可能原因:平台工具缺失(Windows 需已登录桌面会话 / macOS 未授权屏幕录制 / Linux 未装 wmctrl)或当前确实没有打开的窗口。' });
      }
      const lines = windows.map(w => {
        const title = w.title; // 窗口标题原样展示(可能含本机文件路径,运行时输出,不入提交)
        // 元信息:进程名 / PID / 最小化标记
        const meta = [];
        if (w.process) meta.push(`进程:${w.process}`);
        if (w.pid) meta.push(`PID:${w.pid}`);
        if (w.minimized) meta.push('已最小化');
        const metaText = meta.length ? ` (${meta.join(' ')})` : '';
        // 窗口 ID 供 target 直接传(Windows 十进制 HWND / Linux 0x 十六进制 X11 id)
        const idText = w.id ? ` ID:${w.id}` : '';
        return `- ${title}${metaText}${idText}`;
      });
      return textResult({ ok: true, text: `当前打开的窗口(${windows.length}个):\n${lines.join('\n')}` });
    })
  );

  return server;
}

// 启动即连接;工具 handler 已 try/catch,配置缺失等错误都会以 { isError: true } 返回,不会让进程崩溃。
if (isDirectRun(import.meta.url)) {
  try {
    await createServer().connect(new StdioServerTransport());
  } catch (err) {
    console.error(`[text-vision] MCP server 启动失败: ${err?.message ?? err}`);
    process.exit(1);
  }
}

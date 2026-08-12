// text-vision:给无视觉文本模型(DeepSeek 等)提供视觉能力的 MCP server
// 工具:describe_image / ocr_image / screen_capture(全部返回纯文字)
// Claude Code、OpenCode 及其他支持 MCP 的工具均可接入。
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { describeImage, describeImageFromBase64, ocrImage, SUPPORTED_EXTS_TEXT } from './text-vision-client.js';
import { captureScreen, cleanupScreenShot } from './capture-screen.js';
import { isDirectRun } from './is-direct-run.js';

const SERVER_NAME = 'text-vision';
// 版本号单一来源:从 package.json 读取,避免升版本时只改了一处导致 tools/list 版本与包不一致
const { version: SERVER_VERSION } = createRequire(import.meta.url)('../package.json');

/**
 * 创建 MCP server 并注册三个视觉工具。connect 不在此函数内做,
 * 便于自动化测试直接构造 server 验证工具注册、schema 与 handler 契约。
 * deps 可选,用于测试注入 mock 实现(不传则用真实实现)。
 */
export function createServer(deps = {}) {
  const describe = deps.describe ?? describeImage;
  const ocr = deps.ocr ?? ocrImage;
  const capture = deps.capture ?? captureScreen;
  const cleanup = deps.cleanup ?? cleanupScreenShot;
  const describeBase64 = deps.describeBase64 ?? describeImageFromBase64;

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  /** MCP 文本结果统一形状:{ content, isError }。 */
  function textResult(r) {
    return { content: [{ type: 'text', text: r.text }], isError: !r.ok };
  }

  server.registerTool(
    'describe_image',
    {
      description: '用视觉模型描述一张本地图片(主体、颜色、布局、对象关系、图中文字等)。路径可为相对或绝对路径。用户粘贴/拖入的图片通常已被宿主工具保存为本地文件,消息里通常带路径或文件名线索:有路径直接传;只有文件名时,先搜索临时/项目目录里最近创建的图片来定位,不要向用户索要路径。图片内容会发送到第三方视觉 API 处理。',
      inputSchema: z.object({
        path: z.string().describe(`本地图片路径(${SUPPORTED_EXTS_TEXT})`),
        focus: z.string().optional().describe('关注的要点,如"按钮的颜色""图表坐标轴含义""界面元素"')
      })
    },
    async ({ path, focus }) => {
      try {
        const r = await describe(path, focus);
        return textResult(r);
      } catch (err) {
        // 实现层(readLocalImage)已收口为返回值,这里兜底未来回归:任何异常都以统一错误形态返回
        return textResult({ ok: false, text: `描述图片失败: ${err?.message ?? err}` });
      }
    }
  );

  server.registerTool(
    'ocr_image',
    {
      description: '提取图片中的文字(OCR),保留排版顺序。适合验证码、报错截图、文档截图。用户粘贴/拖入的截图通常已被宿主工具保存为本地文件:有路径直接传;只有文件名时,先搜索临时/项目目录里最近创建的图片来定位,不要向用户索要路径。图片内容会发送到第三方视觉 API 处理。',
      inputSchema: z.object({
        path: z.string().describe(`本地图片路径(${SUPPORTED_EXTS_TEXT})`)
      })
    },
    async ({ path }) => {
      try {
        const r = await ocr(path);
        return textResult(r);
      } catch (err) {
        // 同 describe_image:兜底未来回归,保证统一 { content, isError } 形状
        return textResult({ ok: false, text: `OCR 失败: ${err?.message ?? err}` });
      }
    }
  );

  server.registerTool(
    'screen_capture',
    {
      description: '截取当前屏幕(全部显示器,可能含敏感信息)并用视觉模型描述画面,截屏内容会发送到第三方视觉 API 处理。适合查看当前应用界面、UI 状态。',
      inputSchema: z.object({
        focus: z.string().optional().describe('关注的要点,如"当前界面布局""错误弹窗内容"')
      })
    },
    async ({ focus }) => {
      let shot;
      try {
        shot = await capture();
        const r = await describeBase64(shot.b64, shot.mime, focus || '当前屏幕/UI 界面');
        const extra = r.ok ? '\n\n[截图已完成描述,临时文件已自动清理。如需保留截图,请用系统截屏工具。]' : '';
        return textResult({ ok: r.ok, text: r.text + extra });
      } catch (err) {
        return textResult({ ok: false, text: `截屏失败: ${err?.message ?? err}` });
      } finally {
        // 用完即删,避免长时间会话在临时目录堆积 text-vision-shot-*.png
        if (shot?.filePath) cleanup(shot.filePath);
      }
    }
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

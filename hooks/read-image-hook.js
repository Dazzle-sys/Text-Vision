// Claude Code PreToolUse hook:拦截 Read 工具读取图片,自动用视觉模型转成文字描述,
// 通过 additionalContext 注入对话,让 DeepSeek 等无视觉文本模型"看见"图片。
//
// stdin 输入(已核实):
//   { "tool_name": "Read", "tool_input": { "file_path": "..." }, "cwd": "..." }
// stdout 输出(exit 0 时解析,只输出一个 JSON):
//   { "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "...", "additionalContext": "..." } }
//
// 核心逻辑抽成 runHook(input) 便于自动化测试;仅直接运行时才读 stdin 执行。
// 设 VISION_HOOK_MODE=ocr 时,读图走 OCR 而非描述(适合验证码/报错截图/文档截图)。
// 与 paste-image-hook 共享的 stdin 读取/路径防护/vision_note 组装见 shared.js,此处不重复。
import { resolve, isAbsolute, relative, basename } from 'node:path';
import { statSync } from 'node:fs';
import { describeImage, ocrImage, isImagePath, loadConfig, isOverSize } from '../src/text-vision-client.js';
import { isDirectRun } from '../src/is-direct-run.js';
import { applyHookDefaults, readStdin, isProtectedPath, relativeDisplayPath, buildVisionNote } from './shared.js';

export { applyHookDefaults } from './shared.js';

/** 放行(不阻断)的输出对象。 */
function allowOutput() {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
}

/**
 * 处理一条 PreToolUse 输入,返回输出对象;放行(不处理)时返回 null。
 * 纯逻辑,不读写 stdin/stdout,可直接测试。
 */
export async function runHook(input) {
  if (input?.tool_name !== 'Read') return null;

  const raw = input.tool_input?.file_path;
  if (!raw) return null;

  const abs = isAbsolute(raw) ? raw : resolve(input.cwd || process.cwd(), raw);
  if (!isImagePath(abs)) return null;

  // 防误伤:跳过 git 目录与任意 node_modules,以及本仓库自身的 src/hooks(锚定仓库根,
  // 不会误伤其他同名 text-vision 项目里放在 src 下的图片)
  if (isProtectedPath(abs)) return null;

  // 超过 maxImageMB 就放行,避免把超大 base64 塞给视觉 API(与 VISION_MAX_IMAGE_MB 配置保持一致)
  const maxImageMB = loadConfig().maxImageMB;
  try {
    if (isOverSize(statSync(abs).size, maxImageMB)) return null;
  } catch (err) {
    // 只有"文件不存在"静默放行;权限/符号链接环等异常要留日志,否则"本该拦截却没拦住"无迹可查。
    // 只打文件名,不暴露本机绝对路径(含用户名/目录结构)
    if (err.code !== 'ENOENT') console.error(`[text-vision-hook] 读取图片信息失败(${err.code || err.name}): ${basename(abs)}`);
    return null; // 文件不存在/不可读,交给正常流程
  }

  // 可配置 OCR 模式(VISION_HOOK_MODE=ocr):读验证码/报错截图时直接提取文字更实用
  const useOcr = process.env.VISION_HOOK_MODE === 'ocr';
  const r = useOcr ? await ocrImage(abs) : await describeImage(abs);
  if (!r.ok) {
    console.error(`[text-vision-hook] ${r.text}`);
    return null; // 失败放行,不阻断工作
  }

  // 注入的路径用相对 input.cwd(跨盘符等不可用时回退文件名),避免把本机绝对路径(含用户名/目录结构)暴露进上下文
  const showPath = relativeDisplayPath(input.cwd || process.cwd(), abs);

  // 视觉模型输出的内容是不可信数据(可能原样转述图片里的恶意指令),注入前用强边界包裹并再次声明
  const noteBody = buildVisionNote({ scope: 'read', useOcr, showPath, text: r.text });

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: '该文件是图片,已通过视觉引擎转为文字描述,请直接基于注入的描述内容继续分析,不要读取图片二进制。',
      additionalContext: noteBody
    }
  };
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return console.log(JSON.stringify(allowOutput()));
  }
  try {
    const output = await runHook(input);
    console.log(JSON.stringify(output || allowOutput()));
  } catch {
    // runHook 内部正常收口,但防御未来的回归:任何异常都放行,不让 hook 崩溃影响宿主
    console.log(JSON.stringify(allowOutput()));
  }
}

// 仅直接运行(node hooks/read-image-hook.js)时读 stdin 执行;被 import 时不执行,便于测试
if (isDirectRun(import.meta.url)) {
  // 把 hook 场景默认超时合并进本进程 env(独立进程,副作用仅限自身),让后续 loadConfig 读到
  Object.assign(process.env, applyHookDefaults());
  // main 内部已收口异常,这里兜底 stdin 流本身出错等未来回归:任何异常都以 allow 放行,
  // 保证宿主永远能收到单个 JSON(否则会因无 stdout 输出而挂起)
  main().catch(() => console.log(JSON.stringify(allowOutput())));
}

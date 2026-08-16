// Claude Code UserPromptSubmit hook:用户提交消息里带图片(粘贴/拖入)时,自动用视觉模型转成文字描述,
// 通过 additionalContext 注入对话,让 DeepSeek 等无视觉文本模型在收到图片的第一时间"看见"。
// 与 read-image-hook(拦截 Read 读图)互补:这条覆盖"用户直接贴图",那条覆盖"模型主动读图文件"。
//
// stdin 输入(该事件无 tool_input,是用户消息文本):
//   { "hook_event_name": "UserPromptSubmit", "prompt": "分析这张图 [Image 1] C:\\Users\\...\\code.png", "cwd": "..." }
// 图片来源(双通道,兼顾宿主差异):
//   1) input.images 数组(部分宿主把粘贴图作为结构化字段传 file_path)
//   2) prompt 文本里的路径线索:[Image N] <path>、![image](<path>)、裸图片路径
// stdout 输出(exit 0,只输出一个 JSON;不阻断用户消息,只是附加描述):
//   { "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "【粘贴图片视觉描述】..." } }
//
// 设 VISION_HOOK_MODE=ocr 时走 OCR(验证码/报错截图),与 read-image-hook 行为一致。
// 与 read-image-hook 共享的 stdin 读取/路径防护/vision_note 组装见 shared.js,此处不重复。
import { resolve, isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { describeImage, ocrImage, isImagePath, loadConfig, isOverSize } from '../src/text-vision-client.js';
import { isDirectRun } from '../src/is-direct-run.js';
import { applyHookDefaults, readStdin, isProtectedPath, relativeDisplayPath, buildVisionNote } from './shared.js';

// 单次提交最多自动描述的图片数:超出部分交给规则层/工具引导,避免多图粘贴刷爆上下文
const MAX_IMAGES = 4;
// 图片扩展名校验(路径提取出的 token 必须是图片,避免误注入)
const EXT_RE = /\.(?:png|jpe?g|webp|gif|bmp)$/i;

// 从 prompt 提取"看起来是图片路径"的 token(仅两种真实形态,不做裸路径猜测以免误匹配代码里的字符串):
//  - [Image N] 后的路径(Claude Code 粘贴图常见形态):`[Image 1] C:\a.png` / `[Image 1](a.png)` / `[Image #1]: a.png`
//  - markdown 图片:![alt](a.png)
function extractImagePaths(prompt) {
  const found = [];
  const add = p => {
    const cleaned = p.trim().replace(/^['"`(\[]+|['"`)\]>]+$/g, '');
    if (cleaned && EXT_RE.test(cleaned) && !found.includes(cleaned)) found.push(cleaned);
  };
  if (!prompt) return found;
  for (const m of String(prompt).matchAll(/\[Image\s*#?\d*\]\s*[:(]?\s*([^\s"'`)\]>]+)/gi)) add(m[1]);
  for (const m of String(prompt).matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) add(m[1]);
  return found;
}

/**
 * 处理一条 UserPromptSubmit 输入,返回输出对象;无图/无需处理时返回 null。
 * 纯逻辑,不读写 stdin/stdout,可直接测试。
 */
export async function runPasteHook(input) {
  // 图片来源 1:宿主结构化字段(images 数组,每项含 file_path)
  const paths = [];
  if (Array.isArray(input?.images)) {
    for (const img of input.images) {
      const p = img?.file_path || img?.path || (typeof img === 'string' ? img : '');
      if (p) paths.push(p);
    }
  }
  // 图片来源 2:prompt 文本里的路径线索
  paths.push(...extractImagePaths(input?.prompt));

  // 去重 + 规范化,最多 MAX_IMAGES 张
  const seen = new Set();
  const targets = [];
  for (const p of paths) {
    if (targets.length >= MAX_IMAGES) break;
    const abs = isAbsolute(p) ? p : resolve(input?.cwd || process.cwd(), p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!isImagePath(abs)) continue;
    // 防误伤:跳过 git/node_modules/本仓库 src/hooks(与 read-image-hook 同一套防护)
    if (isProtectedPath(abs)) continue;
    targets.push(abs);
  }
  if (!targets.length) return null;

  // 超过 maxImageMB 的图不自动注入(避免超大 base64),放行让规则层/工具兜底
  const maxImageMB = loadConfig().maxImageMB;
  const useOcr = process.env.VISION_HOOK_MODE === 'ocr';
  const parts = [];
  for (const abs of targets) {
    try {
      if (isOverSize(statSync(abs).size, maxImageMB)) continue;
    } catch { continue; } // 文件不存在/不可读:跳过,不打扰用户
    const r = useOcr ? await ocrImage(abs) : await describeImage(abs);
    if (!r.ok) {
      console.error(`[text-vision-hook] ${r.text}`);
      continue; // 失败跳过,不阻断消息
    }
    // 注入路径用相对 input.cwd(跨盘符回退文件名),避免把本机绝对路径暴露进上下文
    const showPath = relativeDisplayPath(input?.cwd || process.cwd(), abs);
    parts.push(buildVisionNote({ scope: 'paste', useOcr, showPath, text: r.text }));
  }
  if (!parts.length) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: parts.join('\n\n')
    }
  };
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } }));
  }
  try {
    const output = await runPasteHook(input);
    // 无注入也输出最小 JSON,避免空 stdout 被宿主当异常处理
    console.log(JSON.stringify(output || { hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } }));
  } catch {
    // 任何异常都不阻断用户消息,只静默跳过注入
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } }));
  }
}

if (isDirectRun(import.meta.url)) {
  // 与 read-image-hook 同一套 hook 场景默认超时(30s,可被 VISION_TIMEOUT 覆盖)
  Object.assign(process.env, applyHookDefaults());
  main().catch(() => console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } })));
}

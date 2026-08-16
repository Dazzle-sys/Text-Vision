// paste-image-hook 测试:runPasteHook 的 prompt/images → additionalContext 注入纯逻辑契约。
// 成功/OCR 场景走真实代码路径(读 test/test.png + mock fetch);无图/放行场景纯逻辑,不触网。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runPasteHook } from '../hooks/paste-image-hook.js';
import { okRes, stubFetch, makeTempDir, REAL_FETCH } from './helpers.js';

const VISION_ENV = ['VISION_API_BASE', 'VISION_API_KEY', 'VISION_MODEL', 'VISION_TIMEOUT', 'VISION_MAX_IMAGE_MB', 'VISION_HOOK_MODE', 'VISION_MAX_RETRIES', 'VISION_LOG_FILE'];
const saved = {};
let tmpLog;
beforeEach(() => {
  for (const k of VISION_ENV) saved[k] = process.env[k];
  for (const k of VISION_ENV) delete process.env[k];
  process.env.VISION_MAX_RETRIES = '0'; // 关闭重试,避免失败用例真等退避
  tmpLog = makeTempDir('text-vision-paste-hook-log-');
  process.env.VISION_LOG_FILE = join(tmpLog.dir, 'log.txt');
});
afterEach(() => {
  for (const k of VISION_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = REAL_FETCH;
  tmpLog.rm();
});

const CWD = process.cwd();
const IMG = join(CWD, 'test', 'test.png'); // 真实存在的样例图

function setupVision() {
  process.env.VISION_API_BASE = 'https://mock.example.com/v1';
  process.env.VISION_API_KEY = 'sk-test-abcdefghij';
  process.env.VISION_MODEL = 'mock-model';
}

// ---------------------------------------------------------------------------
// 无图片 → 返回 null(不注入)
// ---------------------------------------------------------------------------
test('prompt 无图片路径 → null', async () => {
  assert.equal(await runPasteHook({ prompt: '帮我看看这段代码', cwd: CWD }), null);
});

test('prompt 为空 → null', async () => {
  assert.equal(await runPasteHook({ prompt: '', cwd: CWD }), null);
});

test('无 prompt 也无 images → null', async () => {
  assert.equal(await runPasteHook({}), null);
});

test('prompt 里 [Image] 后是非图片扩展名 → null', async () => {
  assert.equal(await runPasteHook({ prompt: '[Image 1] README.md', cwd: CWD }), null);
});

// ---------------------------------------------------------------------------
// 提取路径并注入描述
// ---------------------------------------------------------------------------
test('prompt 含 [Image 1] 路径 → 注入【粘贴图片视觉描述】', async () => {
  setupVision();
  const s = stubFetch(() => okRes('白底,中央有红色圆形'));
  try {
    const out = await runPasteHook({ prompt: `分析这张图 [Image 1] ${IMG}`, cwd: CWD });
    assert.ok(out, '应返回注入输出');
    assert.match(out.hookSpecificOutput.additionalContext, /【粘贴图片视觉描述】/);
    assert.match(out.hookSpecificOutput.additionalContext, /白底,中央有红色圆形/);
    assert.match(out.hookSpecificOutput.additionalContext, /不可信数据/);
  } finally { s.restore(); }
});

test('prompt 含 [Image 1] 相对路径(相对 cwd)→ 注入', async () => {
  setupVision();
  const s = stubFetch(() => okRes('内容'));
  try {
    const out = await runPasteHook({ prompt: '[Image 1] test/test.png', cwd: CWD });
    assert.ok(out);
    assert.match(out.hookSpecificOutput.additionalContext, /test[/\\]test\.png/);
  } finally { s.restore(); }
});

test('prompt 含 markdown 图片 ![](path) → 注入', async () => {
  setupVision();
  const s = stubFetch(() => okRes('markdown 图内容'));
  try {
    const out = await runPasteHook({ prompt: `看图 ![截图](${IMG})`, cwd: CWD });
    assert.ok(out);
    assert.match(out.hookSpecificOutput.additionalContext, /markdown 图内容/);
  } finally { s.restore(); }
});

test('input.images 数组(file_path)→ 注入(宿主结构化字段通道)', async () => {
  setupVision();
  const s = stubFetch(() => okRes('images 数组内容'));
  try {
    const out = await runPasteHook({ prompt: '看这张图', cwd: CWD, images: [{ file_path: IMG, alt_text: 'x' }] });
    assert.ok(out);
    assert.match(out.hookSpecificOutput.additionalContext, /images 数组内容/);
  } finally { s.restore(); }
});

test('同一张图在 prompt 与 images 都出现 → 只注入一次(去重)', async () => {
  setupVision();
  let n = 0;
  const s = stubFetch(() => { n++; return okRes('去重内容'); });
  try {
    const out = await runPasteHook({ prompt: `[Image 1] ${IMG}`, cwd: CWD, images: [{ file_path: IMG }] });
    assert.ok(out);
    assert.equal(n, 1, '同一图只调一次视觉');
  } finally { s.restore(); }
});

test('VISION_HOOK_MODE=ocr → 注入标记变为【粘贴图片视觉OCR】', async () => {
  setupVision();
  process.env.VISION_HOOK_MODE = 'ocr';
  const s = stubFetch(() => okRes('HELLO 2026'));
  try {
    const out = await runPasteHook({ prompt: `[Image 1] ${IMG}`, cwd: CWD });
    assert.ok(out);
    assert.match(out.hookSpecificOutput.additionalContext, /【粘贴图片视觉OCR】/);
    assert.ok(!/【粘贴图片视觉描述】/.test(out.hookSpecificOutput.additionalContext));
  } finally { s.restore(); }
});

// ---------------------------------------------------------------------------
// 边界:失败/超限/防误伤
// ---------------------------------------------------------------------------
test('视觉调用失败 → 跳过该图,返回 null(不阻断消息)', async () => {
  setupVision();
  const s = stubFetch(() => ({ ok: false, status: 500, text: async () => 'boom' }));
  try {
    assert.equal(await runPasteHook({ prompt: `[Image 1] ${IMG}`, cwd: CWD }), null);
  } finally { s.restore(); }
});

test('图片超过 maxImageMB → 跳过(不注入超大 base64)', async () => {
  setupVision();
  process.env.VISION_MAX_IMAGE_MB = '1';
  const big = join(tmpLog.dir, 'big.png');
  writeFileSync(big, Buffer.alloc(1_200_000));
  try {
    assert.equal(await runPasteHook({ prompt: `[Image 1] ${big}`, cwd: CWD }), null);
  } finally { rmSync(big, { force: true }); }
});

test('.git / node_modules 内的图片 → 跳过(防误伤)', async () => {
  setupVision();
  assert.equal(await runPasteHook({ prompt: '[Image 1] node_modules/pkg/icon.png', cwd: CWD }), null);
  assert.equal(await runPasteHook({ prompt: '[Image 1] .git/x.png', cwd: CWD }), null);
});

test('多图:超过 MAX_IMAGES(4)只处理前 4 张', async () => {
  setupVision();
  // 6 个不同路径的图(内容无关,只看数量与上限截断)
  const files = [];
  for (let i = 1; i <= 6; i++) {
    const p = join(tmpLog.dir, `multi-${i}.png`);
    writeFileSync(p, Buffer.alloc(100));
    files.push(p);
  }
  let n = 0;
  const s = stubFetch(() => { n++; return okRes('多图'); });
  try {
    const prompts = files.map((p, i) => `[Image ${i + 1}] ${p}`);
    const out = await runPasteHook({ prompt: prompts.join(' '), cwd: CWD });
    assert.ok(out, '前 4 张应注入');
    assert.equal(n, 4, '最多处理 4 张');
  } finally {
    s.restore();
    for (const p of files) rmSync(p, { force: true });
  }
});

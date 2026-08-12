// read-image-hook 测试:runHook 的 stdin→stdout 纯逻辑契约。
// 成功/OCR 场景走真实代码路径(读 test/test.png + mock fetch);放行场景纯逻辑,不触网。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHook, applyHookDefaults } from '../hooks/read-image-hook.js';
import { __setRetrySleepForTest } from '../src/text-vision-client.js';

const REAL_FETCH = globalThis.fetch;

const VISION_ENV = ['VISION_API_BASE', 'VISION_API_KEY', 'VISION_MODEL', 'VISION_TIMEOUT', 'VISION_MAX_IMAGE_MB', 'VISION_HOOK_MODE'];
const saved = {};
beforeEach(() => {
  for (const k of VISION_ENV) saved[k] = process.env[k];
  for (const k of VISION_ENV) delete process.env[k];
  // 重试退避注入即时实现,避免"视觉调用失败"用例(500 重试一次)真等几百 ms
  __setRetrySleepForTest(() => Promise.resolve());
});
afterEach(() => {
  for (const k of VISION_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = REAL_FETCH;
  __setRetrySleepForTest(null); // 恢复真实 setTimeout
});

const okRes = text => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) });

function stubFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => handler(url, opts);
  return { restore: () => { globalThis.fetch = orig; } };
}

// 指向真实存在的样例图
const CWD = process.cwd();
const IMG = join(CWD, 'test', 'test.png');

// ---------------------------------------------------------------------------
// applyHookDefaults:hook 场景默认 30s 超时
// ---------------------------------------------------------------------------
test('applyHookDefaults:未设 VISION_TIMEOUT 时默认 30000', () => {
  const env = {};
  applyHookDefaults(env);
  assert.equal(env.VISION_TIMEOUT, '30000');
});

test('applyHookDefaults:已显式设置则不覆盖', () => {
  const env = { VISION_TIMEOUT: '10000' };
  applyHookDefaults(env);
  assert.equal(env.VISION_TIMEOUT, '10000');
});

test('applyHookDefaults:显式 VISION_TIMEOUT=0 不被覆盖(钳制交给 buildConfig)', () => {
  const env = { VISION_TIMEOUT: '0' };
  applyHookDefaults(env);
  assert.equal(env.VISION_TIMEOUT, '0');
});

// ---------------------------------------------------------------------------
// 放行(返回 null):不拦截、不注入
// ---------------------------------------------------------------------------
test('非 Read 工具 → 放行', async () => {
  assert.equal(await runHook({ tool_name: 'Bash', tool_input: { command: 'ls' } }), null);
});

test('无 file_path → 放行', async () => {
  assert.equal(await runHook({ tool_name: 'Read', tool_input: {} }), null);
});

test('非图片扩展名 → 放行', async () => {
  assert.equal(await runHook({ tool_name: 'Read', cwd: CWD, tool_input: { file_path: 'README.md' } }), null);
});

test('node_modules 内的图片 → 放行(防误伤)', async () => {
  assert.equal(await runHook({ tool_name: 'Read', cwd: CWD, tool_input: { file_path: 'node_modules/pkg/icon.png' } }), null);
});

test('.git 目录内的图片 → 放行', async () => {
  assert.equal(await runHook({ tool_name: 'Read', cwd: CWD, tool_input: { file_path: '.git/x.png' } }), null);
});

test('本仓库 src/ 下的图片 → 放行(防递归注入)', async () => {
  // 先被 src/ 前缀拦截,不 statSync,文件无需存在
  assert.equal(await runHook({ tool_name: 'Read', cwd: CWD, tool_input: { file_path: 'src/icon.png' } }), null);
});

test('文件不存在 → 放行(交给正常流程)', async () => {
  assert.equal(await runHook({ tool_name: 'Read', cwd: CWD, tool_input: { file_path: 'test/not-exists.png' } }), null);
});

test('图片超过 maxImageMB → 放行,避免把超大 base64 塞给视觉 API', async () => {
  // 建一个 >1MB 的临时"图片"文件(内容无关,只看 size)
  const big = join(tmpdir(), `text-vision-test-big-${Date.now()}.png`);
  writeFileSync(big, Buffer.alloc(1_200_000));
  try {
    process.env.VISION_MAX_IMAGE_MB = '1';
    assert.equal(await runHook({ tool_name: 'Read', cwd: CWD, tool_input: { file_path: big } }), null);
  } finally { rmSync(big, { force: true }); }
});

// ---------------------------------------------------------------------------
// 拦截(返回 deny + additionalContext):成功读图
// ---------------------------------------------------------------------------
test('读取图片 → deny + 注入【图片视觉描述】,含不可信数据声明', async () => {
  process.env.VISION_API_BASE = 'https://mock.example.com/v1';
  process.env.VISION_API_KEY = 'sk-test-abcdefghij';
  process.env.VISION_MODEL = 'mock-model';
  const s = stubFetch(() => okRes('白底,中央有红色圆形'));
  try {
    const out = await runHook({ tool_name: 'Read', cwd: CWD, tool_input: { file_path: IMG } });
    assert.ok(out, '应返回拦截输出');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.additionalContext, /【图片视觉描述】/);
    assert.match(out.hookSpecificOutput.additionalContext, /白底,中央有红色圆形/);
    assert.match(out.hookSpecificOutput.additionalContext, /不可信数据/);
    assert.match(out.hookSpecificOutput.additionalContext, /test[/\\]test\.png/);
  } finally { s.restore(); }
});

test('VISION_HOOK_MODE=ocr → 注入标记变为【图片视觉OCR】且走 OCR 提示词', async () => {
  process.env.VISION_API_BASE = 'https://mock.example.com/v1';
  process.env.VISION_API_KEY = 'sk-test-abcdefghij';
  process.env.VISION_MODEL = 'mock-model';
  process.env.VISION_HOOK_MODE = 'ocr';
  const s = stubFetch(() => okRes('HELLO 2026'));
  try {
    const out = await runHook({ tool_name: 'Read', cwd: CWD, tool_input: { file_path: IMG } });
    assert.ok(out);
    assert.match(out.hookSpecificOutput.additionalContext, /【图片视觉OCR】/);
    assert.ok(!/【图片视觉描述】/.test(out.hookSpecificOutput.additionalContext));
    assert.match(out.hookSpecificOutput.additionalContext, /HELLO 2026/);
  } finally { s.restore(); }
});

test('视觉调用失败 → 放行,不阻断工作', async () => {
  process.env.VISION_API_BASE = 'https://mock.example.com/v1';
  process.env.VISION_API_KEY = 'sk-test-abcdefghij';
  process.env.VISION_MODEL = 'mock-model';
  const s = stubFetch(() => ({ ok: false, status: 500, text: async () => 'boom' }));
  try {
    assert.equal(await runHook({ tool_name: 'Read', cwd: CWD, tool_input: { file_path: IMG } }), null);
  } finally { s.restore(); }
});

// 日志模块测试:落盘追加、默认/配置路径、失败静默、debugLog 门控。全用 fake env,不依赖 process.env 全局。
// 默认路径用例(未配 VISION_LOG_FILE)会触发 resolveStorageRoot 探测,用 setRepoProbeForTest 指到临时目录隔离,
// 避免探针写真实仓库/真实 home;每个用例前 reset,防止探测缓存与注入跨用例泄漏。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isDebug, debugLog, logFilePath, appendLog, isSuccessLog } from '../src/log.js';
import { resolveStorageRoot, setRepoProbeForTest, setHomeProbeForTest, resetStorageRootForTest } from '../src/storage-root.js';

// 每个用例用独立临时目录,避免日志文件互相污染
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'text-vision-log-test-')); resetStorageRootForTest(); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } resetStorageRootForTest(); });

test('logFilePath:未配置 → 存储根下 log.txt(仓库可写时即仓库候选目录)', () => {
  const repoBase = join(dir, 'repo', '.text-vision');
  setRepoProbeForTest(repoBase);
  try {
    assert.equal(logFilePath({}), join(resolveStorageRoot(), 'log.txt'));
    assert.equal(logFilePath({ VISION_LOG_FILE: '' }), join(resolveStorageRoot(), 'log.txt'));
    assert.equal(logFilePath({}), join(repoBase, 'log.txt'), '仓库可写时默认路径即仓库候选下的 log.txt');
  } finally { resetStorageRootForTest(); }
});

test('logFilePath:配置 VISION_LOG_FILE → 返回配置值(去空白)', () => {
  assert.equal(logFilePath({ VISION_LOG_FILE: '  C:/logs/tv.log  ' }), 'C:/logs/tv.log');
});

test('logFilePath:显式 VISION_STORAGE_ROOT → log.txt 落其下(不探测)', () => {
  const root = join(dir, 'explicit-root');
  try {
    assert.equal(logFilePath({ VISION_STORAGE_ROOT: root }), join(root, 'log.txt'));
    assert.equal(existsSync(root), true, '显式根目录应被创建');
  } finally { resetStorageRootForTest(); }
});

test('isSuccessLog:默认开启;0/false 关闭;带空白先 trim;FALSE 大写仍视为开启', () => {
  assert.equal(isSuccessLog({}), true);
  assert.equal(isSuccessLog({ VISION_LOG_SUCCESS: '' }), true);
  assert.equal(isSuccessLog({ VISION_LOG_SUCCESS: '0' }), false);
  assert.equal(isSuccessLog({ VISION_LOG_SUCCESS: 'false' }), false);
  assert.equal(isSuccessLog({ VISION_LOG_SUCCESS: ' 0 ' }), false);   // 尾随空格/.env CRLF 也能正确关闭
  assert.equal(isSuccessLog({ VISION_LOG_SUCCESS: ' false ' }), false);
  assert.equal(isSuccessLog({ VISION_LOG_SUCCESS: 'FALSE' }), true);  // 大小写敏感:大写视为开启
  assert.equal(isSuccessLog({ VISION_LOG_SUCCESS: '1' }), true);
});

test('appendLog:写入指定路径,内容含时间戳 + 事件类型 + 详情', () => {
  const p = join(dir, 'log.txt');
  appendLog('screen_capture_degrade', '窗口原为最小化,已临时恢复截图后还原', { VISION_LOG_FILE: p });
  const content = readFileSync(p, 'utf8');
  assert.match(content, /^\d{4}-\d{2}-\d{2}T.*\[screen_capture_degrade\] 窗口原为最小化,已临时恢复截图后还原\n$/);
});

test('appendLog:连续追加不覆盖', () => {
  const p = join(dir, 'log.txt');
  const env = { VISION_LOG_FILE: p };
  appendLog('a', 'first', env);
  appendLog('b', 'second', env);
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[a\] first$/);
  assert.match(lines[1], /\[b\] second$/);
});

test('appendLog:超过 1MB 轮转阈值 → 旧日志改名 .1,新日志从空文件写', () => {
  const p = join(dir, 'log.txt');
  const env = { VISION_LOG_FILE: p };
  // 首次写入使文件刚好超过 1MB 阈值
  appendLog('a', 'x'.repeat(1024 * 1024 + 200), env);
  assert.equal(existsSync(`${p}.1`), false, '文件超阈值前不轮转');
  // 第二次写入前检测到超阈值 → 旧日志轮转到 .1,当前文件重新开始
  appendLog('b', 'second', env);
  assert.equal(existsSync(`${p}.1`), true, '超阈值后应轮转出 .1');
  assert.match(readFileSync(`${p}.1`, 'utf8'), /\[a\] xxxx/);
  assert.match(readFileSync(p, 'utf8').trim(), /\[b\] second$/);
});

test('appendLog:轮转 .1 存在时被覆盖,不无限堆积旧档', () => {
  const p = join(dir, 'log.txt');
  const env = { VISION_LOG_FILE: p };
  appendLog('a', 'x'.repeat(1024 * 1024 + 200), env); // 写入 A 触发轮转
  appendLog('b', 'y'.repeat(1024 * 1024 + 200), env); // 再次写入触发第二次轮转
  appendLog('c', 'final', env);
  // 只应存在当前文件 + 一份 .1(b 轮转时覆盖了 a 的 .1)
  assert.match(readFileSync(`${p}.1`, 'utf8'), /\[b\] yyyy/);
  assert.match(readFileSync(p, 'utf8').trim(), /\[c\] final$/);
});

test('appendLog:目标目录不存在 → 自动创建后写入', () => {
  const p = join(dir, 'nested', 'sub', 'log.txt');
  appendLog('e', 'detail', { VISION_LOG_FILE: p });
  assert.match(readFileSync(p, 'utf8'), /\[e\] detail/);
});

test('appendLog:路径指向目录(写失败)→ 静默不抛', () => {
  const targetDir = join(dir, 'is-a-dir');
  mkdirSync(targetDir);
  assert.doesNotThrow(() => appendLog('e', 'x', { VISION_LOG_FILE: targetDir }));
});

test('appendLog:仓库只读回退 → 日志补写 [storage_fallback] 说明且只补一次', () => {
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'x'); // 普通文件占位,mkdirSync(recursive) 抛 ENOTDIR,等价仓库不可写
  const homeBase = join(dir, 'home', '.text-vision');
  setRepoProbeForTest(join(blocker, '.text-vision'));
  setHomeProbeForTest(homeBase);
  try {
    appendLog('vision_failed', '第一次', {}); // 未配 VISION_LOG_FILE → 默认走 resolveStorageRoot(仓库只读 → 回退 home)
    appendLog('vision_failed', '第二次', {});
    const lines = readFileSync(join(homeBase, 'log.txt'), 'utf8').trim().split('\n');
    const notes = lines.filter(l => l.includes('[storage_fallback]'));
    assert.equal(notes.length, 1, '回退说明只补一次');
    assert.match(notes[0], /仓库存储不可写.*回退用户目录/, '说明应含回退原因与用户目录');
    assert.ok(lines[0].includes('[vision_failed]'), '首行仍是实际日志,说明行随后');
  } finally { resetStorageRootForTest(); }
});

// debugLog 门控:patch console.error 统计调用次数,结束后恢复
const savedDebug = process.env.DEBUG_VISION;
let errCalls = 0;
let origError;
beforeEach(() => { origError = console.error; errCalls = 0; console.error = () => { errCalls++; }; });
afterEach(() => {
  console.error = origError;
  // savedDebug 原本未设置(undefined)时不能写回字符串 'undefined',应删除变量
  if (savedDebug === undefined) delete process.env.DEBUG_VISION;
  else process.env.DEBUG_VISION = savedDebug;
});

test('debugLog:DEBUG_VISION=1 时打印到 stderr', () => {
  process.env.DEBUG_VISION = '1';
  assert.equal(isDebug(), true);
  debugLog('降级:未找到窗口');
  assert.equal(errCalls, 1);
});

test('debugLog:未配置时静默', () => {
  delete process.env.DEBUG_VISION;
  assert.equal(isDebug(), false);
  debugLog('降级:未找到窗口');
  assert.equal(errCalls, 0);
});

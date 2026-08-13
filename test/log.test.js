// 日志模块测试:落盘追加、默认/配置路径、失败静默、debugLog 门控。全用 fake env,不依赖 process.env 全局。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isDebug, debugLog, logFilePath, appendLog } from '../src/log.js';
import { visionDir } from '../src/repo-root.js';

// 每个用例用独立临时目录,避免日志文件互相污染
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'text-vision-log-test-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } });

test('logFilePath:未配置 → text-vision 仓库根下的 .text-vision/log.txt', () => {
  assert.equal(logFilePath({}), join(visionDir(), 'log.txt'));
  assert.equal(logFilePath({ VISION_LOG_FILE: '' }), join(visionDir(), 'log.txt'));
});

test('logFilePath:配置 VISION_LOG_FILE → 返回配置值(去空白)', () => {
  assert.equal(logFilePath({ VISION_LOG_FILE: '  C:/logs/tv.log  ' }), 'C:/logs/tv.log');
});

test('appendLog:写入指定路径,内容含时间戳 + 事件类型 + 详情', () => {
  const p = join(dir, 'log.txt');
  appendLog('screen_capture_degrade', '未找到指定程序:xyz,已回退全屏', { VISION_LOG_FILE: p });
  const content = readFileSync(p, 'utf8');
  assert.match(content, /^\d{4}-\d{2}-\d{2}T.*\[screen_capture_degrade\] 未找到指定程序:xyz,已回退全屏\n$/);
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

// debugLog 门控:patch console.error 统计调用次数,结束后恢复
const savedDebug = process.env.DEBUG_VISION;
let errCalls = 0;
let origError;
beforeEach(() => { origError = console.error; errCalls = 0; console.error = () => { errCalls++; }; });
afterEach(() => { console.error = origError; process.env.DEBUG_VISION = savedDebug; });

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

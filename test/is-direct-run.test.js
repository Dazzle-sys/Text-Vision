// isDirectRun 测试:判定"当前入口是否被直接运行"。platform 可注入,不依赖真实平台。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDirectRun } from '../src/is-direct-run.js';

// 用测试进程自身的 argv[1] 作为"被直接运行的入口"基准
const ENTRY = realpathSync(resolve(process.argv[1]));

test('linux/win32:入口一致 → 判定为直接运行', () => {
  assert.equal(isDirectRun(pathToFileURL(ENTRY).href, 'linux'), true);
  assert.equal(isDirectRun(pathToFileURL(ENTRY).href, 'win32'), true);
});

test('完全不相关的入口 → 判定为未直接运行', () => {
  assert.equal(isDirectRun(pathToFileURL(resolve('some/other/entry.js')).href, 'linux'), false);
});

test('缺少 entryUrl → false(不误判)', () => {
  assert.equal(isDirectRun('', 'linux'), false);
});

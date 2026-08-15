// storage-root 探测测试:仓库可写/只读回退/缓存/测试注入/回退 stderr 提示。
// 全部用 setRepoProbeForTest / setHomeProbeForTest 把探针与回退目标指到临时目录,绝不写真实仓库或真实 home。
// 模拟"仓库不可写"不用 chmod(Windows 不可靠):把候选路径的祖先做成普通文件,mkdirSync(recursive) 必抛
// ENOTDIR,三个平台一致、等价于不可写。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveStorageRoot, storageFallbackReason, setStorageRootForTest, setRepoProbeForTest, setHomeProbeForTest, resetStorageRootForTest } from '../src/storage-root.js';

const savedDebugEnv = process.env.DEBUG_VISION;
let dir;
let errMsgs = [];
let origError;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tv-storage-root-test-'));
  errMsgs = [];
  origError = console.error;
  console.error = (...a) => { errMsgs.push(a.join(' ')); }; // patch 收集 stderr,供回退提示断言
  resetStorageRootForTest();
});
afterEach(() => {
  console.error = origError;
  resetStorageRootForTest();
  if (savedDebugEnv === undefined) delete process.env.DEBUG_VISION;
  else process.env.DEBUG_VISION = savedDebugEnv;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

test('仓库可写 → 返回仓库候选,无探针残留', () => {
  const candidate = join(dir, 'repo', '.text-vision');
  setRepoProbeForTest(candidate);
  try {
    assert.equal(resolveStorageRoot(), candidate);
    const leftovers = readdirSync(candidate).filter(f => f.startsWith('.tv-probe-'));
    assert.equal(leftovers.length, 0, '探针写入后应被清理,不留残留');
  } finally { resetStorageRootForTest(); }
});

test('仓库不可写(祖先路径是普通文件)→ 回退用户目录并创建', () => {
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'x'); // 普通文件占位,mkdirSync(recursive) 抛 ENOTDIR
  const homeDir = join(dir, 'home', '.text-vision');
  setRepoProbeForTest(join(blocker, '.text-vision'));
  setHomeProbeForTest(homeDir);
  try {
    assert.equal(resolveStorageRoot(), homeDir);
    assert.equal(existsSync(homeDir), true, '回退用户目录应被创建');
  } finally { resetStorageRootForTest(); }
});

test('仓库与用户目录都不可写 → 仍返回用户目录路径、不抛', () => {
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'x');
  const badPath = join(blocker, '.text-vision');
  setRepoProbeForTest(badPath);
  setHomeProbeForTest(badPath);
  try {
    assert.doesNotThrow(() => resolveStorageRoot());
    assert.equal(resolveStorageRoot(), badPath, '用户目录 mkdir 也失败仍返回该路径,写失败交给调用方静默/报错');
  } finally { resetStorageRootForTest(); }
});

test('判定结果进程内缓存;reset 后重新探测', () => {
  const candidate = join(dir, 'repo', '.text-vision');
  const homeDir = join(dir, 'home', '.text-vision');
  setRepoProbeForTest(candidate);
  setHomeProbeForTest(homeDir);
  try {
    assert.equal(resolveStorageRoot(), candidate); // 首次探测,仓库可写
    // 把仓库候选换成普通文件,模拟"仓库变为不可写"
    rmSync(candidate, { recursive: true, force: true });
    writeFileSync(candidate, 'x');
    assert.equal(resolveStorageRoot(), candidate, '命中缓存,不重新探测');
    assert.equal(existsSync(homeDir), false, '命中缓存未回退,home 目录不应被创建');
    // 清除缓存(模拟进程重启)后重新探测:仓库候选仍是文件(不可写)→ 回退 home
    setRepoProbeForTest(candidate); // 该函数会同时清空 cachedRoot
    setHomeProbeForTest(homeDir);
    assert.equal(resolveStorageRoot(), homeDir, '重新探测:仓库候选是文件 → 回退 home');
  } finally { resetStorageRootForTest(); }
});

test('setStorageRootForTest 直接指定存储根,跳过探测', () => {
  const forced = join(dir, 'forced');
  setStorageRootForTest(forced);
  try {
    assert.equal(resolveStorageRoot(), forced);
    assert.equal(existsSync(forced), false, '不触发探测,不创建目录');
  } finally { resetStorageRootForTest(); }
});

test('仓库只读回退时 DEBUG_VISION=1 → stderr 打回退提示', () => {
  process.env.DEBUG_VISION = '1';
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'x');
  setRepoProbeForTest(join(blocker, '.text-vision'));
  setHomeProbeForTest(join(dir, 'home', '.text-vision'));
  try {
    resolveStorageRoot();
    assert.ok(errMsgs.some(m => m.includes('回退')), `stderr 应出现回退提示,实际:${JSON.stringify(errMsgs)}`);
    assert.match(storageFallbackReason(), /仓库存储不可写.*回退用户目录/, 'storageFallbackReason 应含回退说明文案');
  } finally { resetStorageRootForTest(); }
});

test('仓库可写时 DEBUG_VISION=1 → 不打回退提示', () => {
  process.env.DEBUG_VISION = '1';
  const candidate = join(dir, 'repo', '.text-vision');
  setRepoProbeForTest(candidate);
  try {
    resolveStorageRoot();
    assert.equal(errMsgs.length, 0, '仓库可写不应打回退提示');
    assert.equal(storageFallbackReason(), null, '仓库可写时无回退说明');
  } finally { resetStorageRootForTest(); }
});

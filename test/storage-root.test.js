// storage-root 探测测试:仓库可写/只读回退/缓存/测试注入/回退 stderr 提示。
// 全部用 setRepoProbeForTest / setHomeProbeForTest 把探针与回退目标指到临时目录,绝不写真实仓库或真实 home。
// 模拟"仓库不可写"不用 chmod(Windows 不可靠):把候选路径的祖先做成普通文件,mkdirSync(recursive) 必抛
// ENOTDIR,三个平台一致、等价于不可写。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, readdirSync, existsSync, mkdtempSync, mkdirSync } from 'node:fs';
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
  delete process.env.VISION_STORAGE_ROOT; // 防御进程级显式根污染探测/回退用例
  resetStorageRootForTest();
});
afterEach(() => {
  console.error = origError;
  resetStorageRootForTest();
  delete process.env.VISION_STORAGE_ROOT;
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

test('探测成功后顺手清理历史残留的 .tv-probe-* 文件', () => {
  const candidate = join(dir, 'repo', '.text-vision');
  setRepoProbeForTest(candidate);
  try {
    mkdirSync(candidate, { recursive: true }); // 预置目录再放残留
    writeFileSync(join(candidate, '.tv-probe-stale-1'), 'old'); // 历史残留(模拟之前 unlink 失败)
    writeFileSync(join(candidate, '.tv-probe-stale-2'), 'old');
    writeFileSync(join(candidate, 'shot-normal.png'), 'keep');  // 非探针文件不应被删
    assert.equal(resolveStorageRoot(), candidate);
    const leftovers = readdirSync(candidate).filter(f => f.startsWith('.tv-probe-'));
    assert.equal(leftovers.length, 0, '历史探针残留应被清理');
    assert.equal(existsSync(join(candidate, 'shot-normal.png')), true, '业务文件不应被误删');
  } finally { resetStorageRootForTest(); }
});

test('探针残留清理:目录不存在时静默不抛', () => {
  const candidate = join(dir, 'no-such-dir', '.text-vision');
  setRepoProbeForTest(candidate);
  try {
    assert.doesNotThrow(() => resolveStorageRoot());
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

// ---------------------------------------------------------------------------
// 显式 VISION_STORAGE_ROOT:用户意图优先,跳过探测
// ---------------------------------------------------------------------------
test('显式 VISION_STORAGE_ROOT → 直接使用(跳过探测),目录被创建', () => {
  const explicit = join(dir, 'explicit-root');
  try {
    assert.equal(resolveStorageRoot({ VISION_STORAGE_ROOT: explicit }), explicit);
    assert.equal(existsSync(explicit), true, '显式根目录应被创建');
    assert.equal(storageFallbackReason(), null, '显式根不设回退文案');
  } finally { resetStorageRootForTest(); }
});

test('显式 VISION_STORAGE_ROOT → 带首尾空白时 trim 后再用', () => {
  const explicit = join(dir, 'explicit-trim');
  try {
    assert.equal(resolveStorageRoot({ VISION_STORAGE_ROOT: `  ${explicit}  ` }), explicit);
  } finally { resetStorageRootForTest(); }
});

test('显式 VISION_STORAGE_ROOT → 即使仓库候选不可写也用它(不探测不回退)', () => {
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'x'); // 普通文件占位,mkdir(recursive) 抛 ENOTDIR,等价不可写
  const explicit = join(dir, 'explicit-ok');
  setRepoProbeForTest(join(blocker, '.text-vision')); // 即便仓库候选不可写
  setHomeProbeForTest(join(dir, 'home', '.text-vision'));
  try {
    assert.equal(resolveStorageRoot({ VISION_STORAGE_ROOT: explicit }), explicit, '显式根跳过探测');
    assert.equal(storageFallbackReason(), null, '显式根不触发回退语义');
  } finally { resetStorageRootForTest(); }
});

test('显式根目录不可创建(祖先被文件占位)→ 仍返回该路径、不抛', () => {
  const blocker = join(dir, 'blocker2');
  writeFileSync(blocker, 'x');
  const bad = join(blocker, 'sub', 'root');
  try {
    assert.doesNotThrow(() => resolveStorageRoot({ VISION_STORAGE_ROOT: bad }));
    assert.equal(resolveStorageRoot({ VISION_STORAGE_ROOT: bad }), bad, 'mkdir 失败仍返回路径,写失败交给调用方');
  } finally { resetStorageRootForTest(); }
});

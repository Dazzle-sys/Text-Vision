// image-compress 单元测试:tryCompressImage 的档位缩小、达标返回、失败回落逻辑。
// 全部注入 mock execFileFn/spawnFn,不真调系统工具、不触网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tryCompressImage } from '../src/image-compress.js';

function makeInput() {
  const dir = mkdtempSync(join(tmpdir(), 'tv-compress-test-'));
  const input = join(dir, 'big.png');
  writeFileSync(input, Buffer.alloc(5_000_000)); // 5MB 假图片(内容无关,只看大小)
  return { dir, input };
}

// sips 命令参数:['-Z', maxEdge, '-s','format','jpeg','-s','formatOptions','85', in, '--out', out]
// 产物大小 = maxEdge * 800(模拟:档位越大产物越大)
function sipsMock(calls, { alwaysSize } = {}) {
  return async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd !== 'sips') throw new Error(`unexpected cmd ${cmd}`);
    const out = args[args.length - 1];
    const edge = Number(args[1]);
    writeFileSync(out, Buffer.alloc(alwaysSize ?? Math.max(1, Math.floor(edge * 800))));
  };
}

// 退出码 close(0) 的假子进程,供 win32 spawn mock
function fakeChild() {
  const c = new EventEmitter();
  c.stderr = { on() {} };
  c.kill = () => {};
  setImmediate(() => c.emit('close', 0));
  return c;
}

test('darwin:大图超限 → sips 压缩,档位 4096→2048 达 1MB 限内(共调 2 次)', async () => {
  const { dir, input } = makeInput();
  const calls = [];
  try {
    const r = await tryCompressImage(input, 2_000_000, { platform: 'darwin', execFileFn: sipsMock(calls) });
    assert.ok(r, '应压缩成功');
    assert.equal(r.mime, 'image/jpeg');
    assert.ok(r.sizeBytes < 2_000_000);
    assert.equal(calls.length, 2, '4096→3.2MB 超限,2048→1.6MB 达标');
    assert.equal(calls[0].cmd, 'sips');
    assert.equal(calls[1].args[1], '2048', '第二档应缩小到 2048');
    rmSync(r.filePath, { force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('linux:走 ImageMagick convert 命令', async () => {
  const { dir, input } = makeInput();
  const calls = [];
  try {
    const r = await tryCompressImage(input, 1_000_000, {
      platform: 'linux',
      execFileFn: async (cmd, args) => { calls.push({ cmd, args }); writeFileSync(args[args.length - 1], Buffer.alloc(500_000)); }
    });
    assert.ok(r);
    assert.equal(calls[0].cmd, 'convert');
    assert.match(calls[0].args.join(' '), /-resize \d+x\d+ -quality 85/);
    rmSync(r.filePath, { force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('win32:走 PowerShell spawn(psExe 优先),产物达标返回', async () => {
  const { dir, input } = makeInput();
  const calls = [];
  try {
    const r = await tryCompressImage(input, 2_000_000, {
      platform: 'win32',
      psExe: 'pwsh.exe',
      spawnFn: (exe, args, opts) => {
        calls.push({ exe, args, env: opts.env });
        const edge = Number(opts.env.TV_COMPRESS_MAXEDGE);
        writeFileSync(opts.env.TV_COMPRESS_OUT, Buffer.alloc(Math.max(1, Math.floor(edge * 800))));
        return fakeChild();
      }
    });
    assert.ok(r, 'win32 应压缩成功');
    assert.equal(calls[0].exe, 'pwsh.exe', '应使用显式 psExe');
    assert.ok('TV_COMPRESS_IN' in calls[0].env, '路径应经环境变量传入(避免转义问题)');
    rmSync(r.filePath, { force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('工具不可用(execFile 抛错)→ 返回 null,不抛异常', async () => {
  const { dir, input } = makeInput();
  try {
    const r = await tryCompressImage(input, 1_000_000, { platform: 'darwin', execFileFn: async () => { throw new Error('sips not found'); } });
    assert.equal(r, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('压缩到最小档(256)仍超限 → 返回 null', async () => {
  const { dir, input } = makeInput();
  try {
    // 恒产出 2MB > 1MB 上限:5 个档位全失败后返回 null
    const r = await tryCompressImage(input, 1_000_000, { platform: 'darwin', execFileFn: sipsMock([], { alwaysSize: 2_000_000 }) });
    assert.equal(r, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('不支持的平台 → 返回 null', async () => {
  const { dir, input } = makeInput();
  try {
    const r = await tryCompressImage(input, 1_000_000, { platform: 'freebsd' });
    assert.equal(r, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('压缩产物删除:返回的 filePath 是临时 jpeg 且可 stat(调用方负责清理)', async () => {
  const { dir, input } = makeInput();
  try {
    const r = await tryCompressImage(input, 2_000_000, { platform: 'darwin', execFileFn: sipsMock([]) });
    assert.ok(r);
    assert.match(r.filePath, /\.jpeg$/);
    assert.ok(statSync(r.filePath).size > 0);
    rmSync(r.filePath, { force: true });
    assert.throws(() => statSync(r.filePath), '删除后 stat 应抛 ENOENT');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

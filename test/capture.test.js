// 三平台截屏逻辑测试:注入 mock 的 spawn/execFile,不真正调用系统命令。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { captureWindows, captureLinux, captureMac, captureScreen, cleanupScreenShot, redactLocalPath } from '../src/capture-screen.js';

// --- 工具:伪造 spawn 子进程 ---
function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

// ---------------------------------------------------------------------------
// captureWindows
// ---------------------------------------------------------------------------
test('captureWindows:成功 → 返回 .jpeg 路径,路径经环境变量注入子进程', async () => {
  let spawnArgs;
  const child = fakeChild();
  const spawnFn = (cmd, args, opts) => { spawnArgs = { cmd, args, opts }; return child; };
  const p = captureWindows({ spawnFn, timeout: 30000, fallbackDelay: 1000 });
  child.emit('close', 0);
  const outPath = await p;

  assert.equal(spawnArgs.cmd, 'powershell.exe');
  assert.ok(spawnArgs.opts.env.TEXT_VISION_SHOT.endsWith('.jpeg'), '输出路径应为 jpeg');
  assert.equal(outPath, spawnArgs.opts.env.TEXT_VISION_SHOT);
  assert.match(outPath, /text-vision-shot-/);
});

test('captureWindows:退出码非 0 → 拒绝并带退出码线索', async () => {
  const child = fakeChild();
  const spawnFn = () => child;
  const p = captureWindows({ spawnFn, timeout: 30000, fallbackDelay: 1000 });
  child.stderr.emit('data', Buffer.from('Add-Type 失败'));
  child.emit('close', 1);
  await assert.rejects(p, /退出码 1/);
});

test('captureWindows:超时被 kill → 拒绝并带超时提示', async () => {
  const child = fakeChild();
  const spawnFn = () => child;
  const p = captureWindows({ spawnFn, timeout: 50, fallbackDelay: 1000 });
  // 等 killTimer 触发
  await new Promise(r => setTimeout(r, 80));
  assert.equal(child.killed, true, '超时应 kill 子进程');
  child.emit('close', 0); // 被 kill 后仍收到 close,但 wasTimedOut 已标记
  await assert.rejects(p, /超时/);
});

test('captureWindows:spawn 同步抛错 → 拒绝', async () => {
  const spawnFn = () => { throw new Error('powershell.exe 不存在'); };
  await assert.rejects(captureWindows({ spawnFn, timeout: 30000, fallbackDelay: 1000 }), /不存在/);
});

// ---------------------------------------------------------------------------
// captureLinux
// ---------------------------------------------------------------------------
test('captureLinux:第一个可用命令成功写出文件 → 返回该路径', async () => {
  const calls = [];
  const execFileFn = async (cmd, args) => {
    calls.push(cmd);
    // gnome-screenshot: ['-f', outPath]
    writeFileSync(args[1], Buffer.from('pngdata'));
  };
  const outPath = await captureLinux({ execFileFn, timeout: 30000 });
  assert.deepEqual(calls, ['gnome-screenshot']);
  assert.ok(outPath.endsWith('.png'));
});

test('captureLinux:第一个失败 → 尝试下一个候选', async () => {
  const calls = [];
  const execFileFn = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'gnome-screenshot') throw new Error('gnome 不可用');
    // scrot: [outPath]
    writeFileSync(args[0], Buffer.from('pngdata'));
  };
  const outPath = await captureLinux({ execFileFn, timeout: 30000 });
  assert.deepEqual(calls, ['gnome-screenshot', 'scrot']);
  assert.ok(outPath.endsWith('.png'));
});

test('captureLinux:命令"退出码 0 但未产出文件" → 视为失败,继续下一个', async () => {
  const calls = [];
  const execFileFn = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'gnome-screenshot') return; // 不写文件,静默失败
    if (cmd === 'scrot') writeFileSync(args[0], Buffer.from('pngdata'));
  };
  const outPath = await captureLinux({ execFileFn, timeout: 30000 });
  assert.deepEqual(calls, ['gnome-screenshot', 'scrot']);
  assert.ok(outPath.endsWith('.png'));
});

test('captureLinux:全部不可用 → 拒绝并提示安装任一工具', async () => {
  const execFileFn = async () => { throw new Error('not found'); };
  await assert.rejects(captureLinux({ execFileFn, timeout: 30000 }), /均不可用/);
});

// ---------------------------------------------------------------------------
// captureMac
// ---------------------------------------------------------------------------
test('captureMac:screencapture + sips 都成功 → 返回 .jpeg 路径', async () => {
  const calls = [];
  const execFileFn = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'screencapture') writeFileSync(args[1], Buffer.from('rawpng'));
    else if (cmd === 'sips') writeFileSync(args.at(-1), Buffer.from('jpgdata'));
  };
  const outPath = await captureMac({ execFileFn, timeout: 30000 });
  assert.deepEqual(calls, ['screencapture', 'sips']);
  assert.ok(outPath.endsWith('.jpeg'));
});

test('captureMac:sips 不可用 → 退回 PNG 路径', async () => {
  const calls = [];
  const execFileFn = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'screencapture') writeFileSync(args[1], Buffer.from('rawpng'));
    else throw new Error('sips not found');
  };
  const outPath = await captureMac({ execFileFn, timeout: 30000 });
  assert.deepEqual(calls, ['screencapture', 'sips']);
  assert.ok(outPath.endsWith('.png'));
});

test('captureMac:screencapture 本身失败 → 拒绝', async () => {
  const execFileFn = async (cmd) => { if (cmd === 'screencapture') throw new Error('未授权屏幕录制'); };
  await assert.rejects(captureMac({ execFileFn, timeout: 30000 }), /未授权/);
});

// ---------------------------------------------------------------------------
// captureScreen 平台分派(当前环境为 win32)
// ---------------------------------------------------------------------------
test('captureScreen:win32 分派到 captureWindows,返回 b64/mime/sizeBytes', async () => {
  if (process.platform !== 'win32') return; // 该用例仅针对 win32
  const child = fakeChild();
  const spawnFn = (cmd, args, opts) => {
    // spawn 时真实写出 jpeg,模拟 PowerShell 保存成功
    writeFileSync(opts.env.TEXT_VISION_SHOT, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x00]));
    return child;
  };
  const p = captureScreen({ spawnFn, timeout: 30000, fallbackDelay: 1000 });
  child.emit('close', 0);
  const shot = await p;
  try {
    assert.equal(shot.mime, 'image/jpeg');
    assert.ok(shot.b64.length > 0);
    assert.ok(shot.sizeBytes > 0);
    assert.match(shot.filePath, /text-vision-shot-/);
  } finally {
    cleanupScreenShot(shot.filePath); // 清理真实 tmpdir 里的临时截图,避免测试残留目录
  }
});

test('captureScreen:darwin 分派到 captureMac,返回 b64/mime/sizeBytes', async () => {
  if (process.platform !== 'darwin') return; // 该用例仅针对 darwin
  const execFileFn = async (cmd, args) => {
    if (cmd === 'screencapture') writeFileSync(args[1], Buffer.from('rawpng'));
    else if (cmd === 'sips') writeFileSync(args.at(-1), Buffer.from('jpgdata'));
  };
  const shot = await captureScreen({ execFileFn, timeout: 30000 });
  try {
    assert.equal(shot.mime, 'image/jpeg');
    assert.ok(shot.b64.length > 0);
    assert.ok(shot.sizeBytes > 0);
    assert.match(shot.filePath, /text-vision-shot-/);
  } finally {
    cleanupScreenShot(shot.filePath); // 清理真实 tmpdir 里的临时截图,避免测试残留目录
  }
});

// ---------------------------------------------------------------------------
// 错误消息路径脱敏(不向 MCP 客户端泄露含用户名的本机路径)
// ---------------------------------------------------------------------------
test('redactLocalPath:Windows 盘符路径与 Command failed 参数路径被脱敏', () => {
  assert.equal(redactLocalPath('出错: C:\\Users\\illli\\AppData\\Local\\Temp\\text-vision-shot-abc\\shot-1.jpeg'), '出错: [本地路径]');
  assert.equal(redactLocalPath('Command failed: gnome-screenshot -f /tmp/text-vision-shot-abc/shot-1.png'), 'Command failed: gnome-screenshot');
  assert.equal(redactLocalPath('无路径的普通报错'), '无路径的普通报错');
});

test('captureWindows:stderr 含本机绝对路径 → 错误消息被脱敏', async () => {
  const child = fakeChild();
  const spawnFn = () => child;
  const p = captureWindows({ spawnFn, timeout: 30000, fallbackDelay: 1000 });
  child.stderr.emit('data', Buffer.from('Add-Type 失败: C:\\Users\\illli\\AppData\\Local\\Temp\\text-vision-shot-abc\\shot-1.jpeg'));
  child.emit('close', 1);
  const err = await p.then(() => null, e => e);
  assert.ok(err, '应拒绝');
  assert.ok(!/C:\\Users/.test(err.message), '错误消息不得含 Windows 绝对路径');
  assert.ok(!/text-vision-shot/.test(err.message), '错误消息不得泄露截屏临时目录');
  assert.match(err.message, /\[本地路径\]/);
  assert.match(err.message, /Add-Type 失败/); // 错误主体仍保留,便于排查
});

test('captureScreen:底层失败错误含路径 → 兜底脱敏后抛出', async () => {
  if (process.platform !== 'win32') return; // 兜底 catch 依赖平台分派,该用例仅针对 win32
  const child = fakeChild();
  const spawnFn = () => child;
  const p = captureScreen({ spawnFn, timeout: 30000, fallbackDelay: 1000 });
  child.stderr.emit('data', Buffer.from('Save 失败: C:\\Users\\illli\\AppData\\Local\\Temp\\text-vision-shot-abc\\shot-1.jpeg'));
  child.emit('close', 1);
  const err = await p.then(() => null, e => e);
  assert.ok(err, '应拒绝');
  assert.ok(!/text-vision-shot/.test(err.message), 'captureScreen 不得泄露截屏临时目录');
  assert.match(err.message, /\[本地路径\]/);
  assert.match(err.message, /Save 失败/);
});

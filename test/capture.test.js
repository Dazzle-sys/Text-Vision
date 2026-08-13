// 三平台截屏逻辑测试:注入 mock 的 spawn/execFile,不真正调用系统命令。
// 所有写文件测试注入 shotsRoot(临时目录),避免把测试截图写进仓库 .text-vision/。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { captureWindows, captureLinux, captureMac, captureScreen, cleanupScreenShot, defaultShotsDir, pruneShots } from '../src/capture-screen.js';
import { redactLocalPath } from '../src/redact.js';
import { visionDir } from '../src/repo-root.js';

// --- 工具:伪造 spawn 子进程 ---
function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

// 每个测试的独立临时截图目录(模拟 shotsRoot),测试结束自动清理,不污染仓库
function tempShotsRoot() {
  return mkdtempSync(join(tmpdir(), 'tv-test-shots-'));
}
function rmDir(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
function withShots(fn) {
  return async () => {
    const shotsRoot = tempShotsRoot();
    try { await fn(shotsRoot); } finally { rmDir(shotsRoot); }
  };
}

// ---------------------------------------------------------------------------
// captureWindows
// ---------------------------------------------------------------------------
test('captureWindows:成功 → 返回 { filePath },路径经环境变量注入子进程', withShots(async (shotsRoot) => {
  let spawnArgs;
  const child = fakeChild();
  const spawnFn = (cmd, args, opts) => { spawnArgs = { cmd, args, opts }; return child; };
  const p = captureWindows({ shotsRoot, spawnFn, timeout: 30000, fallbackDelay: 1000 });
  child.emit('close', 0);
  const result = await p;

  assert.equal(spawnArgs.cmd, 'powershell.exe');
  assert.ok(spawnArgs.opts.env.TEXT_VISION_SHOT.endsWith('.jpeg'), '输出路径应为 jpeg');
  assert.equal(result.filePath, spawnArgs.opts.env.TEXT_VISION_SHOT);
  assert.ok(result.filePath.startsWith(shotsRoot), '截图应落在 shotsRoot 目录');
  assert.equal(result.note, undefined);
}));

test('captureWindows:退出码非 0 → 拒绝并带退出码线索', withShots(async (shotsRoot) => {
  const child = fakeChild();
  const spawnFn = () => child;
  const p = captureWindows({ shotsRoot, spawnFn, timeout: 30000, fallbackDelay: 1000 });
  child.stderr.emit('data', Buffer.from('Add-Type 失败'));
  child.emit('close', 1);
  await assert.rejects(p, /退出码 1/);
}));

test('captureWindows:超时被 kill → 拒绝并带超时提示', withShots(async (shotsRoot) => {
  const child = fakeChild();
  const spawnFn = () => child;
  const p = captureWindows({ shotsRoot, spawnFn, timeout: 40, fallbackDelay: 1000 });
  // 等 killTimer 触发:40ms 超时 + 200ms 等待留足 5 倍余量,避免 CI 高负载下 setTimeout 迟到导致误失败
  await new Promise(r => setTimeout(r, 200));
  assert.equal(child.killed, true, '超时应 kill 子进程');
  child.emit('close', 0); // 被 kill 后仍收到 close,但 wasTimedOut 已标记
  await assert.rejects(p, /超时/);
}));

test('captureWindows:spawn 同步抛错 → 拒绝', withShots(async (shotsRoot) => {
  const spawnFn = () => { throw new Error('powershell.exe 不存在'); };
  await assert.rejects(captureWindows({ shotsRoot, spawnFn, timeout: 30000, fallbackDelay: 1000 }), /不存在/);
}));

// --- 指定窗口模式(windowId)---
test('captureWindows:带 windowId → env 注入 HWND/NOTE,成功且无 note 文件时 note=undefined', withShots(async (shotsRoot) => {
  let spawnArgs;
  const child = fakeChild();
  const spawnFn = (cmd, args, opts) => { spawnArgs = { cmd, args, opts }; return child; };
  const p = captureWindows({ shotsRoot, spawnFn, timeout: 30000, fallbackDelay: 1000, windowId: '456' });
  child.emit('close', 0);
  const result = await p;
  assert.equal(spawnArgs.opts.env.TEXT_VISION_HWND, '456');
  assert.ok(spawnArgs.opts.env.TEXT_VISION_NOTE.endsWith('note.txt'));
  assert.ok(!/^shot-/.test(basename(spawnArgs.opts.env.TEXT_VISION_NOTE)), 'note 文件应以 note- 开头,避免被 pruneShots 当截图清理/占预算');
  assert.equal(result.filePath, spawnArgs.opts.env.TEXT_VISION_SHOT);
  assert.equal(result.note, undefined);
  assert.equal(existsSync(spawnArgs.opts.env.TEXT_VISION_NOTE), false, 'note 文件不应残留');
}));

test('captureWindows:带 windowId 且 PS 写入 note 文件 → note 返回文本并删除文件', withShots(async (shotsRoot) => {
  let spawnArgs;
  const child = fakeChild();
  const spawnFn = (cmd, args, opts) => {
    spawnArgs = { cmd, args, opts };
    writeFileSync(opts.env.TEXT_VISION_NOTE, 'PrintWindow 输出空白,已降级为窗口区域截图', 'utf8');
    return child;
  };
  const p = captureWindows({ shotsRoot, spawnFn, timeout: 30000, fallbackDelay: 1000, windowId: '456' });
  child.emit('close', 0);
  const result = await p;
  assert.equal(result.note, 'PrintWindow 输出空白,已降级为窗口区域截图');
  assert.equal(existsSync(spawnArgs.opts.env.TEXT_VISION_NOTE), false, 'note 文件应被读取后删除');
}));

test('captureWindows:带 windowId 但退出码非 0 → 拒绝且 note 文件被清理', withShots(async (shotsRoot) => {
  let notePath;
  const child = fakeChild();
  const spawnFn = (cmd, args, opts) => {
    notePath = opts.env.TEXT_VISION_NOTE;
    writeFileSync(notePath, 'x', 'utf8'); // 模拟 PS 已写 note 后进程失败
    return child;
  };
  const p = captureWindows({ shotsRoot, spawnFn, timeout: 30000, fallbackDelay: 1000, windowId: '456' });
  child.stderr.emit('data', Buffer.from('Add-Type 失败'));
  child.emit('close', 1);
  await assert.rejects(p, /退出码 1/);
  assert.equal(existsSync(notePath), false, '失败时 note 文件应被清理');
}));

// ---------------------------------------------------------------------------
// captureLinux
// ---------------------------------------------------------------------------
test('captureLinux:第一个可用命令成功写出文件 → 返回该路径', withShots(async (shotsRoot) => {
  const calls = [];
  const execFileFn = async (cmd, args) => {
    calls.push(cmd);
    writeFileSync(args[1], Buffer.from('pngdata')); // gnome-screenshot: ['-f', outPath]
  };
  const result = await captureLinux({ shotsRoot, execFileFn, timeout: 30000 });
  assert.deepEqual(calls, ['gnome-screenshot']);
  assert.ok(result.filePath.startsWith(shotsRoot));
  assert.ok(result.filePath.endsWith('.png'));
}));

test('captureLinux:第一个失败 → 尝试下一个候选', withShots(async (shotsRoot) => {
  const calls = [];
  const execFileFn = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'gnome-screenshot') throw new Error('gnome 不可用');
    writeFileSync(args[0], Buffer.from('pngdata')); // scrot: [outPath]
  };
  const result = await captureLinux({ shotsRoot, execFileFn, timeout: 30000 });
  assert.deepEqual(calls, ['gnome-screenshot', 'scrot']);
  assert.ok(result.filePath.endsWith('.png'));
}));

test('captureLinux:命令"退出码 0 但未产出文件" → 视为失败,继续下一个', withShots(async (shotsRoot) => {
  const calls = [];
  const execFileFn = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'gnome-screenshot') return; // 不写文件,静默失败
    if (cmd === 'scrot') writeFileSync(args[0], Buffer.from('pngdata'));
  };
  const result = await captureLinux({ shotsRoot, execFileFn, timeout: 30000 });
  assert.deepEqual(calls, ['gnome-screenshot', 'scrot']);
  assert.ok(result.filePath.endsWith('.png'));
}));

test('captureLinux:全部不可用 → 拒绝并提示安装任一工具', withShots(async (shotsRoot) => {
  const execFileFn = async () => { throw new Error('not found'); };
  await assert.rejects(captureLinux({ shotsRoot, execFileFn, timeout: 30000 }), /均不可用/);
}));

test('captureLinux:带 windowId 且 import 成功 → 直接返回该文件,无 note', withShots(async (shotsRoot) => {
  const calls = [];
  const execFileFn = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'import') writeFileSync(args[2], Buffer.from('pngdata')); // import -window <id> <path>
  };
  const result = await captureLinux({ shotsRoot, execFileFn, timeout: 30000, windowId: '0x123' });
  assert.deepEqual(calls.map(c => c[0]), ['import']);
  assert.equal(result.note, undefined);
  assert.ok(result.filePath.endsWith('.png'));
}));

test('captureLinux:带 windowId 但 import 失败 → 回退全屏链并带 note', withShots(async (shotsRoot) => {
  const calls = [];
  const execFileFn = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'import') throw new Error('import 不可用');
    if (cmd === 'gnome-screenshot') writeFileSync(args[1], Buffer.from('pngdata'));
  };
  const result = await captureLinux({ shotsRoot, execFileFn, timeout: 30000, windowId: '0x123' });
  assert.equal(calls[0][0], 'import');
  assert.equal(calls[0][1][1], '0x123'); // import -window <id>
  assert.equal(calls[1][0], 'gnome-screenshot'); // 回退全屏链
  assert.match(result.note, /指定窗口截图失败/);
  assert.ok(result.filePath.endsWith('.png'));
}));

// ---------------------------------------------------------------------------
// captureMac
// ---------------------------------------------------------------------------
test('captureMac:screencapture + sips 都成功 → 返回 .jpeg 路径', withShots(async (shotsRoot) => {
  const calls = [];
  const execFileFn = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'screencapture') writeFileSync(args[1], Buffer.from('rawpng'));
    else if (cmd === 'sips') writeFileSync(args.at(-1), Buffer.from('jpgdata'));
  };
  const result = await captureMac({ shotsRoot, execFileFn, timeout: 30000 });
  assert.deepEqual(calls, ['screencapture', 'sips']);
  assert.ok(result.filePath.startsWith(shotsRoot));
  assert.ok(result.filePath.endsWith('.jpeg'));
}));

test('captureMac:sips 不可用 → 退回 PNG 路径', withShots(async (shotsRoot) => {
  const calls = [];
  const execFileFn = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'screencapture') writeFileSync(args[1], Buffer.from('rawpng'));
    else throw new Error('sips not found');
  };
  const result = await captureMac({ shotsRoot, execFileFn, timeout: 30000 });
  assert.deepEqual(calls, ['screencapture', 'sips']);
  assert.ok(result.filePath.endsWith('.png'));
}));

test('captureMac:screencapture 本身失败 → 拒绝', withShots(async (shotsRoot) => {
  const execFileFn = async (cmd) => { if (cmd === 'screencapture') throw new Error('未授权屏幕录制'); };
  await assert.rejects(captureMac({ shotsRoot, execFileFn, timeout: 30000 }), /未授权/);
}));

test('captureMac:带 windowId → screencapture 参数含 -l<id>', withShots(async (shotsRoot) => {
  const calls = [];
  const execFileFn = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'screencapture') writeFileSync(args[2], Buffer.from('rawpng')); // ['-x', '-l42', png]
    else if (cmd === 'sips') writeFileSync(args.at(-1), Buffer.from('jpgdata'));
  };
  const result = await captureMac({ shotsRoot, execFileFn, timeout: 30000, windowId: '42' });
  assert.deepEqual(calls[0][0], 'screencapture');
  assert.ok(calls[0][1].includes('-l42'));
  assert.equal(result.note, undefined);
}));

test('captureMac:带 windowId 但 screencapture 失败 → 回退全屏并带 note', withShots(async (shotsRoot) => {
  const calls = [];
  const execFileFn = async (cmd, args) => {
    calls.push([cmd, args]);
    // 注意:args.includes('-l') 是数组方法(检查元素严格等于 '-l'),元素是 '-l42' 不匹配,必须用 startsWith 判子串
    if (cmd === 'screencapture' && args.some(a => a.startsWith('-l'))) throw new Error('窗口已关闭');
    if (cmd === 'screencapture') writeFileSync(args[1], Buffer.from('rawpng'));
    else if (cmd === 'sips') writeFileSync(args.at(-1), Buffer.from('jpgdata'));
  };
  const result = await captureMac({ shotsRoot, execFileFn, timeout: 30000, windowId: '42' });
  assert.match(result.note, /指定窗口截图失败/);
  assert.ok(result.filePath.endsWith('.jpeg'));
}));

// ---------------------------------------------------------------------------
// captureScreen 平台分派(deps.platform 可注入,三个平台分派逻辑在任意 CI 平台均可测)
// ---------------------------------------------------------------------------
test('captureScreen:win32 分派到 captureWindows,返回 b64/mime/sizeBytes', withShots(async (shotsRoot) => {
  const child = fakeChild();
  const spawnFn = (cmd, args, opts) => {
    // spawn 时真实写出 jpeg,模拟 PowerShell 保存成功;
    // captureScreen 内部先 await 枚举窗口(spawn 是异步的),这里 setImmediate 异步触发 close 模拟真实 PS 进程
    writeFileSync(opts.env.TEXT_VISION_SHOT, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x00]));
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const shot = await captureScreen({ shotsRoot, spawnFn, timeout: 30000, fallbackDelay: 1000, platform: 'win32' });
  assert.equal(shot.mime, 'image/jpeg');
  assert.ok(shot.b64.length > 0);
  assert.ok(shot.sizeBytes > 0);
  assert.ok(shot.filePath.startsWith(shotsRoot));
  assert.equal(shot.note, undefined);
}));

test('captureScreen:darwin 分派到 captureMac,返回 b64/mime/sizeBytes', withShots(async (shotsRoot) => {
  const execFileFn = async (cmd, args) => {
    if (cmd === 'screencapture') writeFileSync(args[1], Buffer.from('rawpng'));
    else if (cmd === 'sips') writeFileSync(args.at(-1), Buffer.from('jpgdata'));
  };
  const shot = await captureScreen({ shotsRoot, execFileFn, timeout: 30000, platform: 'darwin' });
  assert.equal(shot.mime, 'image/jpeg');
  assert.ok(shot.b64.length > 0);
  assert.ok(shot.sizeBytes > 0);
  assert.ok(shot.filePath.startsWith(shotsRoot));
}));

test('captureScreen:linux 分派到 captureLinux,返回 b64/mime(png)', withShots(async (shotsRoot) => {
  const execFileFn = async (cmd, args) => {
    if (cmd === 'gnome-screenshot') writeFileSync(args[1], Buffer.from('pngdata'));
  };
  const shot = await captureScreen({ shotsRoot, execFileFn, timeout: 30000, platform: 'linux' });
  assert.equal(shot.mime, 'image/png');
  assert.ok(shot.b64.length > 0);
  assert.ok(shot.filePath.startsWith(shotsRoot));
}));

test('captureScreen:不支持的平台 → 明确报错', withShots(async (shotsRoot) => {
  await assert.rejects(captureScreen({ shotsRoot, platform: 'sunos' }), /暂不支持在当前平台\(sunos\)截屏/);
}));

// --- captureScreen target 场景(注入 listWindows,win32 重点)---
test('captureScreen:target 命中 → 走窗口截图,spawn env 含匹配窗口的 HWND', withShots(async (shotsRoot) => {
  let spawnArgs;
  const child = fakeChild();
  const spawnFn = (cmd, args, opts) => {
    spawnArgs = { cmd, args, opts };
    writeFileSync(opts.env.TEXT_VISION_SHOT, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x00]));
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const listWindows = async () => [{ id: '456', process: 'chrome', title: 'Google Chrome', width: 800, height: 600 }];
  const shot = await captureScreen({ target: 'chrome', shotsRoot, listWindows, spawnFn, timeout: 30000, fallbackDelay: 1000, platform: 'win32' });
  assert.equal(spawnArgs.opts.env.TEXT_VISION_HWND, '456');
  assert.equal(shot.note, undefined);
  assert.equal(shot.mime, 'image/jpeg');
}));

test('captureScreen:target 未找到 → 回退全屏,note 含未找到且无 HWND', withShots(async (shotsRoot) => {
  let spawnArgs;
  const child = fakeChild();
  const spawnFn = (cmd, args, opts) => {
    spawnArgs = { cmd, args, opts };
    writeFileSync(opts.env.TEXT_VISION_SHOT, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x00]));
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const listWindows = async () => [];
  const shot = await captureScreen({ target: '不存在的程序xyz', shotsRoot, listWindows, spawnFn, timeout: 30000, fallbackDelay: 1000, platform: 'win32' });
  assert.equal(spawnArgs.opts.env.TEXT_VISION_HWND, undefined, '未命中不应传 HWND');
  assert.match(shot.note, /未找到/);
  assert.match(shot.note, /不存在的程序xyz/);
}));

test('captureScreen:target 为空 → 当全屏处理,无 note 且无 HWND', withShots(async (shotsRoot) => {
  let spawnArgs;
  const child = fakeChild();
  const spawnFn = (cmd, args, opts) => {
    spawnArgs = { cmd, args, opts };
    writeFileSync(opts.env.TEXT_VISION_SHOT, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x00]));
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const listWindows = async () => [{ id: '456', process: 'chrome', title: 'Google Chrome', width: 800, height: 600 }];
  const shot = await captureScreen({ target: '  ', shotsRoot, listWindows, spawnFn, timeout: 30000, fallbackDelay: 1000, platform: 'win32' });
  assert.equal(spawnArgs.opts.env.TEXT_VISION_HWND, undefined);
  assert.equal(shot.note, undefined);
}));

// ---------------------------------------------------------------------------
// 截图目录:VISION_SHOTS_DIR 配置优先,未配置回退仓库 .text-vision/screenshots
// ---------------------------------------------------------------------------
test('defaultShotsDir:VISION_SHOTS_DIR 配置优先(去空白),未配置/空串回退仓库目录', () => {
  assert.equal(defaultShotsDir({ VISION_SHOTS_DIR: 'C:/shots' }), 'C:/shots');
  assert.equal(defaultShotsDir({ VISION_SHOTS_DIR: '  C:/shots  ' }), 'C:/shots', '应去掉首尾空白');
  assert.equal(defaultShotsDir({}), join(visionDir(), 'screenshots'));
  assert.equal(defaultShotsDir({ VISION_SHOTS_DIR: '' }), join(visionDir(), 'screenshots'));
});

// ---------------------------------------------------------------------------
// 截图保留策略:pruneShots(只留最近 max 张)+ cleanupScreenShot(只删文件不删目录)
// ---------------------------------------------------------------------------
test('pruneShots:超过 max 张删除最旧', () => {
  const dir = tempShotsRoot();
  try {
    for (let i = 0; i < 25; i++) writeFileSync(join(dir, `shot-${1000 + i}-abc.jpeg`), 'x');
    pruneShots(dir, 20);
    const left = readdirSync(dir).filter(f => f.startsWith('shot-')).sort();
    assert.equal(left.length, 20);
    assert.ok(left[0].startsWith('shot-1005'), '应删除最旧 5 张(1000-1004),保留 1005 起');
  } finally { rmDir(dir); }
});

test('pruneShots:不超过 max 张不删', () => {
  const dir = tempShotsRoot();
  try {
    writeFileSync(join(dir, 'shot-1-a.jpeg'), 'x');
    writeFileSync(join(dir, 'shot-2-a.jpeg'), 'x');
    pruneShots(dir, 20);
    assert.equal(readdirSync(dir).filter(f => f.startsWith('shot-')).length, 2);
  } finally { rmDir(dir); }
});

test('pruneShots:清理超量 shot-* 旧图,并回收残留的 note-* 临时文件,不碰其它文件', () => {
  const dir = tempShotsRoot();
  try {
    for (let i = 0; i < 25; i++) writeFileSync(join(dir, `shot-${1000 + i}.jpeg`), 'x');
    writeFileSync(join(dir, 'note-1.txt'), 'x');  // 模拟 JS 被硬杀(kill -9)后残留的降级原因文件
    writeFileSync(join(dir, 'readme.md'), 'x');   // 无关文件,不应被碰
    pruneShots(dir, 20);
    const left = readdirSync(dir);
    assert.equal(left.filter(f => f.startsWith('shot-')).length, 20, '应清理超量旧截图');
    assert.equal(left.filter(f => f.startsWith('note-')).length, 0, '残留 note 文件应被回收');
    assert.ok(left.includes('readme.md'), '无关文件不应被清理');
  } finally { rmDir(dir); }
});

test('pruneShots:目录不存在 → 静默不抛', () => {
  assert.doesNotThrow(() => pruneShots(join(tmpdir(), 'no-such-dir-xyz-123'), 20));
});

test('cleanupScreenShot:只删文件,不删目录', () => {
  const dir = tempShotsRoot();
  try {
    const f = join(dir, 'shot-1.jpeg');
    writeFileSync(f, 'x');
    cleanupScreenShot(f);
    assert.equal(existsSync(f), false);
    assert.equal(existsSync(dir), true, '截图目录是持久目录,不应被删除');
  } finally { rmDir(dir); }
});

// ---------------------------------------------------------------------------
// 错误消息路径脱敏(不向 MCP 客户端泄露含用户名的本机路径)
// ---------------------------------------------------------------------------
test('redactLocalPath:Windows 盘符路径 / Unix 路径 / Command failed 参数路径被脱敏', () => {
  assert.equal(redactLocalPath('出错: C:\\Users\\someone\\AppData\\Local\\Temp\\text-vision-shot-abc\\shot-1.jpeg'), '出错: [本地路径]');
  assert.equal(redactLocalPath('Command failed: gnome-screenshot -f /tmp/text-vision-shot-abc/shot-1.png'), 'Command failed: gnome-screenshot');
  assert.equal(redactLocalPath('/home/someone/foo/file.png'), '[本地路径]');
  assert.equal(redactLocalPath('无路径的普通报错'), '无路径的普通报错');
});

test('redactLocalPath:URL 不被撕裂(含 :// 的 scheme 段不误当盘符路径)', () => {
  assert.equal(
    redactLocalPath('请求 https://dashscope.aliyuncs.com/v1/chat/completions 失败'),
    '请求 https://dashscope.aliyuncs.com/v1/chat/completions 失败'
  );
  assert.equal(redactLocalPath('本地 http://127.0.0.1:11434/v1 也不受影响'), '本地 http://127.0.0.1:11434/v1 也不受影响');
});

test('captureWindows:stderr 含本机绝对路径 → 错误消息被脱敏', withShots(async (shotsRoot) => {
  const child = fakeChild();
  const spawnFn = () => child;
  const p = captureWindows({ shotsRoot, spawnFn, timeout: 30000, fallbackDelay: 1000 });
  child.stderr.emit('data', Buffer.from('Add-Type 失败: C:\\Users\\someone\\AppData\\Local\\Temp\\text-vision-shot-abc\\shot-1.jpeg'));
  child.emit('close', 1);
  const err = await p.then(() => null, e => e);
  assert.ok(err, '应拒绝');
  assert.ok(!/C:\\Users/.test(err.message), '错误消息不得含 Windows 绝对路径');
  assert.ok(!/text-vision-shot/.test(err.message), '错误消息不得泄露截屏临时目录');
  assert.match(err.message, /\[本地路径\]/);
  assert.match(err.message, /Add-Type 失败/); // 错误主体仍保留,便于排查
}));

test('captureScreen:底层失败错误含路径 → 兜底脱敏后抛出', withShots(async (shotsRoot) => {
  const child = fakeChild();
  const spawnFn = () => {
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('Save 失败: C:\\Users\\someone\\AppData\\Local\\Temp\\text-vision-shot-abc\\shot-1.jpeg'));
      child.emit('close', 1);
    });
    return child;
  };
  const err = await captureScreen({ shotsRoot, spawnFn, timeout: 30000, fallbackDelay: 1000, platform: 'win32' }).then(() => null, e => e);
  assert.ok(err, '应拒绝');
  assert.ok(!/text-vision-shot/.test(err.message), 'captureScreen 不得泄露截屏临时目录');
  assert.match(err.message, /\[本地路径\]/);
  assert.match(err.message, /Save 失败/);
}));

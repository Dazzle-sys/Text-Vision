// 三平台截屏逻辑测试:注入 mock 的 spawn/execFile,不真正调用系统命令。
// 所有写文件测试注入 shotsRoot(临时目录),避免把测试截图写进仓库 .text-vision/。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { captureWindows, captureLinux, captureMac, captureScreen, cleanupScreenShot, defaultShotsDir, pruneShots } from '../src/capture-screen.js';
import { resolvePsExe } from '../src/ps-exe.js';
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
// resolvePsExe:PowerShell 可执行文件探测
// ---------------------------------------------------------------------------
test('resolvePsExe:VISION_POWERSHELL 显式指定优先(去空白)', () => {
  assert.equal(resolvePsExe({ VISION_POWERSHELL: 'C:/custom/pwsh.exe' }), 'C:/custom/pwsh.exe');
  assert.equal(resolvePsExe({ VISION_POWERSHELL: '  C:/custom/pwsh.exe  ' }), 'C:/custom/pwsh.exe');
});

test('resolvePsExe:未指定时,Program Files 下探测到 pwsh 则用 pwsh', withShots(async (shotsRoot) => {
  // 在临时目录模拟 pwsh 默认安装结构:ProgramFiles\PowerShell\7\pwsh.exe
  const fakePf = join(shotsRoot, 'Program Files');
  mkdirSync(join(fakePf, 'PowerShell', '7'), { recursive: true });
  writeFileSync(join(fakePf, 'PowerShell', '7', 'pwsh.exe'), '');
  assert.equal(resolvePsExe({ ProgramFiles: fakePf }), join(fakePf, 'PowerShell', '7', 'pwsh.exe'));
}));

test('resolvePsExe:pwsh 不存在 → 回退 powershell.exe', () => {
  // ProgramFiles 指向不可能存在的目录 → statSync 抛 ENOENT → 回退
  assert.equal(resolvePsExe({ ProgramFiles: 'C:/no-such-dir-xyz-123' }), 'powershell.exe');
});

// ---------------------------------------------------------------------------
// captureWindows
// ---------------------------------------------------------------------------
test('captureWindows:成功 → 返回 { filePath },路径经 env 注入子进程,note 生命周期正常', withShots(async (shotsRoot) => {
  let spawnArgs;
  const child = fakeChild();
  const spawnFn = (cmd, args, opts) => {
    spawnArgs = { cmd, args, opts };
    writeFileSync(opts.env.TEXT_VISION_SHOT, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])); // 模拟 PS 写出 jpeg
    return child;
  };
  const p = captureWindows({ shotsRoot, spawnFn, psExe: 'powershell.exe', timeout: 30000, fallbackDelay: 1000, windowId: '456' });
  child.emit('close', 0);
  const result = await p;

  assert.equal(spawnArgs.cmd, 'powershell.exe');
  assert.ok(spawnArgs.opts.env.TEXT_VISION_SHOT.endsWith('.jpeg'), '输出路径应为 jpeg');
  assert.equal(spawnArgs.opts.env.TEXT_VISION_HWND, '456', 'windowId 应注入 env');
  assert.ok(spawnArgs.opts.env.TEXT_VISION_NOTE.endsWith('note.txt'), 'note 文件应为 note.txt');
  assert.ok(!/^shot-/.test(basename(spawnArgs.opts.env.TEXT_VISION_NOTE)), 'note 文件应以 note- 开头,避免被 pruneShots 当截图清理/占预算');
  assert.equal(result.filePath, spawnArgs.opts.env.TEXT_VISION_SHOT);
  assert.ok(result.filePath.startsWith(shotsRoot), '截图应落在 shotsRoot 目录');
  assert.equal(result.note, undefined);
  assert.equal(existsSync(spawnArgs.opts.env.TEXT_VISION_NOTE), false, 'note 文件不应残留');
}));

test('captureWindows:退出码非 0 → 拒绝并带退出码线索', withShots(async (shotsRoot) => {
  const child = fakeChild();
  const spawnFn = () => child;
  const p = captureWindows({ shotsRoot, spawnFn, timeout: 30000, fallbackDelay: 1000, windowId: '456' });
  child.stderr.emit('data', Buffer.from('Add-Type 失败'));
  child.emit('close', 1);
  await assert.rejects(p, /PowerShell 退出码 1/);
}));

test('captureWindows:超时被 kill → 拒绝并带超时提示', withShots(async (shotsRoot) => {
  const child = fakeChild();
  const spawnFn = () => child;
  const p = captureWindows({ shotsRoot, spawnFn, timeout: 40, fallbackDelay: 1000, windowId: '456' });
  // 等 killTimer 触发:40ms 超时 + 200ms 等待留足 5 倍余量,避免 CI 高负载下 setTimeout 迟到导致误失败
  await new Promise(r => setTimeout(r, 200));
  assert.equal(child.killed, true, '超时应 kill 子进程');
  child.emit('close', 0); // 被 kill 后仍收到 close,但 wasTimedOut 已标记
  await assert.rejects(p, /超时/);
}));

test('captureWindows:带 windowId 且超时 → 额外跑兜底命令尝试还原最小化窗口', withShots(async (shotsRoot) => {
  // 超时强杀时 PS 的 finally 不执行,窗口可能卡在屏幕外;应再 spawn 一条兜底命令(仅屏幕外窗口才最小化)
  const spawned = [];
  const spawnFn = (cmd, args, opts) => {
    const c = fakeChild();
    spawned.push({ cmd, args, opts, child: c });
    return c;
  };
  const p = captureWindows({ shotsRoot, spawnFn, psExe: 'powershell.exe', timeout: 40, fallbackDelay: 1000, windowId: '456' });
  await new Promise(r => setTimeout(r, 200)); // 等 killTimer 触发
  assert.equal(spawned.length, 2, '主脚本 + 超时兜底各 spawn 一次');
  const fb = spawned[1];
  assert.equal(fb.cmd, 'powershell.exe', '兜底命令复用 PowerShell');
  assert.ok(fb.args[3].includes('ShowWindow($h, 6)'), '兜底命令应最小化窗口');
  assert.ok(fb.args[3].includes('-10000'), '仅当窗口位于屏幕外(SetWindowPos 哨兵坐标附近)才最小化');
  assert.ok(fb.args[3].includes('IsIconic'), '已最小化/已关闭窗口不动,不引入副作用');
  spawned[0].child.emit('close', 0); // 主脚本被 kill 后收到 close → 超时拒绝
  fb.child.emit('close', 0);         // 清掉兜底命令的 5s timer,避免测试悬挂
  await assert.rejects(p, /超时/);
}));

test('captureWindows:spawn 同步抛错 → 拒绝', withShots(async (shotsRoot) => {
  const spawnFn = () => { throw new Error('powershell.exe 不存在'); };
  await assert.rejects(captureWindows({ shotsRoot, spawnFn, timeout: 30000, fallbackDelay: 1000, windowId: '456' }), /不存在/);
}));

test('captureWindows:非数字 windowId → 拒绝(与兜底命令校验一致)', withShots(async (shotsRoot) => {
  // 回归:windowId 会拼进 PS 模板的 [IntPtr][long],非数字值应被拒绝而非注入脚本;
  // 校验在生成输出路径之前,失败时不应残留任何临时文件
  await assert.rejects(
    captureWindows({ shotsRoot, spawnFn: () => fakeChild(), timeout: 30000, fallbackDelay: 1000, windowId: 'abc' }),
    /无效的窗口句柄/
  );
}));

test('captureWindows:windowId 缺失 → 拒绝(只截指定窗口,无全屏模式)', withShots(async (shotsRoot) => {
  await assert.rejects(
    captureWindows({ shotsRoot, spawnFn: () => fakeChild(), timeout: 30000, fallbackDelay: 1000 }),
    /windowId 必传/
  );
}));

test('captureWindows:退出码 0 但未产出截图文件 → 拒绝(与 Linux/Mac 校验对齐)', withShots(async (shotsRoot) => {
  // 回归:exit 0 不代表文件已写出(个别环境静默失败),成功分支应校验产物非空
  const child = fakeChild();
  const spawnFn = () => child; // 不写文件,模拟 PS 静默失败
  const p = captureWindows({ shotsRoot, spawnFn, timeout: 30000, fallbackDelay: 1000, windowId: '456' });
  child.emit('close', 0);
  await assert.rejects(p, /未产出有效截图文件/);
}));

// --- 指定窗口模式(windowId)---
test('captureWindows:clientArea=true → env 注入 TEXT_VISION_CLIENT_AREA=1;false 时不注入', withShots(async (shotsRoot) => {
  for (const [clientArea, expect] of [[true, '1'], [false, undefined]]) {
    let spawnArgs;
    const child = fakeChild();
    const spawnFn = (cmd, args, opts) => {
      spawnArgs = { cmd, args, opts };
      writeFileSync(opts.env.TEXT_VISION_SHOT, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])); // 模拟 PS 写出 jpeg
      return child;
    };
    const p = captureWindows({ shotsRoot, spawnFn, timeout: 30000, fallbackDelay: 1000, windowId: '456', clientArea });
    child.emit('close', 0);
    await p;
    assert.equal(spawnArgs.opts.env.TEXT_VISION_CLIENT_AREA, expect, `clientArea=${clientArea} 时 env 应为 ${expect}`);
  }
}));

test('captureWindows:带 windowId 且 PS 写入 note 文件 → note 返回文本并删除文件', withShots(async (shotsRoot) => {
  let spawnArgs;
  const child = fakeChild();
  const spawnFn = (cmd, args, opts) => {
    spawnArgs = { cmd, args, opts };
    writeFileSync(opts.env.TEXT_VISION_NOTE, 'PrintWindow 输出空白,已降级为窗口区域截图', 'utf8');
    writeFileSync(opts.env.TEXT_VISION_SHOT, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])); // 模拟 PS 写出 jpeg
    return child;
  };
  const p = captureWindows({ shotsRoot, spawnFn, timeout: 30000, fallbackDelay: 1000, windowId: '456' });
  child.emit('close', 0);
  const result = await p;
  assert.equal(result.note, 'PrintWindow 输出空白,已降级为窗口区域截图');
  assert.equal(existsSync(spawnArgs.opts.env.TEXT_VISION_NOTE), false, 'note 文件应被读取后删除');
}));

test('captureWindows:带 windowId 但退出码非 0 → 拒绝,note 降级原因拼进错误且 note 文件被清理', withShots(async (shotsRoot) => {
  let notePath;
  const child = fakeChild();
  const spawnFn = (cmd, args, opts) => {
    notePath = opts.env.TEXT_VISION_NOTE;
    writeFileSync(notePath, '窗口已关闭或句柄无效', 'utf8'); // 模拟 PS 写 note 后进程失败
    return child;
  };
  const p = captureWindows({ shotsRoot, spawnFn, timeout: 30000, fallbackDelay: 1000, windowId: '456' });
  child.stderr.emit('data', Buffer.from('Add-Type 失败'));
  child.emit('close', 1);
  await assert.rejects(p, /窗口截图失败: 窗口已关闭或句柄无效/, '失败原因应拼进错误消息');
  assert.equal(existsSync(notePath), false, '失败时 note 文件应被清理');
}));

test('captureWindows:WIN_PS 含最小化恢复/遮挡守卫/客户区裁剪关键符号(回归守卫)', withShots(async (shotsRoot) => {
  // 字符串包含断言即可,不解析 PowerShell:防止将来误删"最小化临时恢复 + 遮挡守卫 + 客户区裁剪"逻辑
  let winPs;
  const child = fakeChild();
  const spawnFn = (cmd, args, opts) => {
    winPs = args[3];
    writeFileSync(opts.env.TEXT_VISION_SHOT, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])); // 模拟 PS 写出 jpeg
    return child;
  };
  const p = captureWindows({ shotsRoot, spawnFn, timeout: 30000, fallbackDelay: 1000, windowId: '456' });
  child.emit('close', 0);
  await p;
  assert.ok(winPs, '应捕获到 WIN_PS 脚本全文');
  for (const symbol of [
    'SetWindowPos',           // 移出虚拟屏
    'ShowWindow($h, 4)',      // SW_SHOWNOACTIVATE:恢复最小化但不抢焦点
    'ShowWindow($h, 6)',      // SW_MINIMIZE:截完还原最小化
    'DwmFlush',               // 等 DWM 合成
    'IsWindow',               // finally 还原失败守卫(防无效句柄误报)
    'WindowFromPoint',        // 遮挡守卫:命中窗口自身判断
    'IsSelfOrDescendant',     // 遮挡守卫:命中目标窗口自身
    '$cxPts',                 // 遮挡守卫:多点网格采样(中心+四角),而非只查中心点
    '$hitTarget',             // 遮挡守卫:任一采样点命中窗口即放行
    '未能记录窗口原始位置',      // origRect 记录失败 → 提示还原后窗口可能需手动找回
    '-32000',                 // 屏幕外坐标
    '$origRect',              // 记录最小化窗口原始还原位置
    'SetWindowPos($h, [IntPtr]::Zero, $origRect.Left', // 还原时先移回原位置再最小化
    'Test-Transparent',       // 纯色窗口误判修复:只认全透明而非纯色
    'Crop-Frame',             // 客户区裁剪(去边框标题栏)
    'ClientToScreen',         // 客户区左上角坐标转换
    'GetClientRect',          // 客户区尺寸
    'TEXT_VISION_CLIENT_AREA',// clientArea 开关
    'exit 1'                  // 全程失败退出(不再回退全屏)
  ]) {
    assert.ok(winPs.includes(symbol), `WIN_PS 应包含 "${symbol}"`);
  }
}));

// ---------------------------------------------------------------------------
// captureLinux(只截指定窗口,失败明确报错,不再回退全屏链)
// ---------------------------------------------------------------------------
test('captureLinux:带 windowId 且 import 成功 → 直接返回该文件', withShots(async (shotsRoot) => {
  const calls = [];
  const execFileFn = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'import') writeFileSync(args[2], Buffer.from('pngdata')); // import -window <id> <path>
  };
  const result = await captureLinux({ shotsRoot, execFileFn, timeout: 30000, windowId: '0x123' });
  assert.deepEqual(calls.map(c => c[0]), ['import']);
  assert.equal(calls[0][1][1], '0x123', 'import -window 应收到 X11 窗口 id');
  assert.equal(result.note, undefined);
  assert.ok(result.filePath.endsWith('.png'));
}));

test('captureLinux:import 抛错 → 明确报错(不再回退全屏)', withShots(async (shotsRoot) => {
  const execFileFn = async () => { throw new Error('import 不可用'); };
  await assert.rejects(captureLinux({ shotsRoot, execFileFn, timeout: 30000, windowId: '0x123' }), /import -window 不可用或窗口无效/);
}));

test('captureLinux:import 退出码 0 但未产出文件 → 明确报错', withShots(async (shotsRoot) => {
  const execFileFn = async () => { /* 不写文件,静默失败 */ };
  await assert.rejects(captureLinux({ shotsRoot, execFileFn, timeout: 30000, windowId: '0x123' }), /未产出有效截图文件/);
}));

test('captureLinux:windowId 缺失 → 抛错(只截指定窗口)', withShots(async (shotsRoot) => {
  await assert.rejects(captureLinux({ shotsRoot, timeout: 30000 }), /windowId 必传/);
}));

// ---------------------------------------------------------------------------
// captureMac(只截指定窗口,失败明确报错,不再回退全屏)
// ---------------------------------------------------------------------------
test('captureMac:带 windowId 且 screencapture + sips 都成功 → 返回 .jpeg 路径', withShots(async (shotsRoot) => {
  const calls = [];
  const execFileFn = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'screencapture') writeFileSync(args[2], Buffer.from('rawpng')); // ['-x', '-l42', png]
    else if (cmd === 'sips') writeFileSync(args.at(-1), Buffer.from('jpgdata'));
  };
  const result = await captureMac({ shotsRoot, execFileFn, timeout: 30000, windowId: '42' });
  assert.deepEqual(calls, ['screencapture', 'sips']);
  assert.ok(result.filePath.startsWith(shotsRoot));
  assert.ok(result.filePath.endsWith('.jpeg'));
}));

test('captureMac:sips 不可用 → 退回 PNG 路径', withShots(async (shotsRoot) => {
  const calls = [];
  const execFileFn = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'screencapture') writeFileSync(args[2], Buffer.from('rawpng')); // ['-x', '-l42', png]
    else throw new Error('sips not found');
  };
  const result = await captureMac({ shotsRoot, execFileFn, timeout: 30000, windowId: '42' });
  assert.deepEqual(calls, ['screencapture', 'sips']);
  assert.ok(result.filePath.endsWith('.png'));
}));

test('captureMac:screencapture 抛错 → 明确报错(不再回退全屏)', withShots(async (shotsRoot) => {
  const execFileFn = async (cmd) => { if (cmd === 'screencapture') throw new Error('未授权屏幕录制'); };
  await assert.rejects(captureMac({ shotsRoot, execFileFn, timeout: 30000, windowId: '42' }), /指定窗口截图失败/);
}));

test('captureMac:screencapture 退出码 0 但 0 字节文件 → 提示窗口关闭或权限', withShots(async (shotsRoot) => {
  const execFileFn = async () => { /* 不写文件 */ };
  await assert.rejects(captureMac({ shotsRoot, execFileFn, timeout: 30000, windowId: '42' }), /窗口可能已关闭|未授予屏幕录制权限/);
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

test('captureMac:windowId 缺失 → 抛错(只截指定窗口)', withShots(async (shotsRoot) => {
  await assert.rejects(captureMac({ shotsRoot, timeout: 30000 }), /windowId 必传/);
}));

// ---------------------------------------------------------------------------
// captureScreen 平台分派(deps.platform 可注入,三个平台分派逻辑在任意 CI 平台均可测)
// ---------------------------------------------------------------------------
test('captureScreen:win32 分派 → target 命中注入匹配窗口 HWND,返回 b64/mime/sizeBytes', withShots(async (shotsRoot) => {
  let spawnArgs;
  const child = fakeChild();
  const spawnFn = (cmd, args, opts) => {
    spawnArgs = { cmd, args, opts };
    // spawn 时真实写出 jpeg,模拟 PowerShell 保存成功;
    // captureScreen 内部先 await 枚举窗口(spawn 是异步的),这里 setImmediate 异步触发 close 模拟真实 PS 进程
    writeFileSync(opts.env.TEXT_VISION_SHOT, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x00]));
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const listWindows = async () => [{ id: '456', process: 'chrome', title: 'Google Chrome' }];
  const shot = await captureScreen({ target: 'chrome', shotsRoot, listWindows, spawnFn, timeout: 30000, fallbackDelay: 1000, platform: 'win32' });
  assert.equal(spawnArgs.opts.env.TEXT_VISION_HWND, '456', 'target 命中的窗口 id 应注入 env');
  assert.equal(shot.mime, 'image/jpeg');
  assert.ok(shot.b64.length > 0);
  assert.ok(shot.sizeBytes > 0);
  assert.ok(shot.filePath.startsWith(shotsRoot));
  assert.equal(shot.note, undefined);
}));

test('captureScreen:darwin 分派到 captureMac,返回 b64/mime/sizeBytes', withShots(async (shotsRoot) => {
  const execFileFn = async (cmd, args) => {
    if (cmd === 'screencapture') writeFileSync(args[2], Buffer.from('rawpng')); // ['-x', '-l42', png]
    else if (cmd === 'sips') writeFileSync(args.at(-1), Buffer.from('jpgdata'));
  };
  const listWindows = async () => [{ id: '42', process: 'safari', title: 'Safari' }];
  const shot = await captureScreen({ target: 'safari', shotsRoot, execFileFn, listWindows, timeout: 30000, platform: 'darwin' });
  assert.equal(shot.mime, 'image/jpeg');
  assert.ok(shot.b64.length > 0);
  assert.ok(shot.sizeBytes > 0);
  assert.ok(shot.filePath.startsWith(shotsRoot));
}));

test('captureScreen:linux 分派到 captureLinux,返回 b64/mime(png)', withShots(async (shotsRoot) => {
  const execFileFn = async (cmd, args) => {
    if (cmd === 'import') writeFileSync(args[2], Buffer.from('pngdata')); // import -window <id> <path>
  };
  const listWindows = async () => [{ id: '0x123', process: 'firefox', title: 'Firefox' }];
  const shot = await captureScreen({ target: 'firefox', shotsRoot, execFileFn, listWindows, timeout: 30000, platform: 'linux' });
  assert.equal(shot.mime, 'image/png');
  assert.ok(shot.b64.length > 0);
  assert.ok(shot.filePath.startsWith(shotsRoot));
}));

test('captureScreen:不支持的平台 → 明确报错', withShots(async (shotsRoot) => {
  await assert.rejects(captureScreen({ shotsRoot, platform: 'sunos', target: 'chrome', listWindows: async () => [{ id: '1', process: 'chrome', title: 'x' }] }), /暂不支持在当前平台\(sunos\)截屏/);
}));

test('captureScreen:注入 platform 且不注入 listWindows → 窗口枚举透传同一平台(win32 走 PowerShell)', withShots(async (shotsRoot) => {
  // 回归:注入 deps.platform 后截图分派走目标平台,窗口枚举也应透传同一平台,
  // 否则枚举仍按真实 process.platform(CI 上可能走 Linux 枚举),跨平台分派测试不完整
  const enumCalls = [];
  const execFileFn = async (cmd, args) => { enumCalls.push(cmd); return { stdout: '[]' }; };
  const err = await captureScreen({ shotsRoot, platform: 'win32', target: '不存在的窗口xyz', execFileFn, timeout: 30000, fallbackDelay: 1000 }).then(() => null, e => e);
  assert.ok(err, '未命中应抛错');
  assert.match(err.message, /未找到/, '未命中应明确报错,不再回退全屏');
  assert.equal(enumCalls.length, 1, '应调用一次窗口枚举');
  assert.equal(enumCalls[0], resolvePsExe(), 'win32 枚举应走与截图同一的 PowerShell 解析(resolvePsExe)');
}));

// --- captureScreen target 场景(注入 listWindows,win32 重点)---
test('captureScreen:target 未找到 → 明确报错(不再回退全屏)', withShots(async (shotsRoot) => {
  const listWindows = async () => [];
  const err = await captureScreen({ target: '不存在的程序xyz', shotsRoot, listWindows, timeout: 30000, fallbackDelay: 1000, platform: 'win32' }).then(() => null, e => e);
  assert.ok(err, '未命中应抛错');
  assert.match(err.message, /未找到与"不存在的程序xyz"匹配的窗口/);
  assert.match(err.message, /list_windows/, '应引导先用 list_windows 查看窗口');
}));

test('captureScreen:target 为空/纯空白 → 报错提示必须指定 target(不枚举窗口)', withShots(async (shotsRoot) => {
  const listWindows = async () => { throw new Error('不应枚举窗口'); };
  for (const target of [undefined, null, '', '   ']) {
    const err = await captureScreen({ target, shotsRoot, listWindows, timeout: 30000, fallbackDelay: 1000, platform: 'win32' }).then(() => null, e => e);
    assert.ok(err, `target=${JSON.stringify(target)} 应抛错`);
    assert.match(err.message, /必须指定 target/, `target=${JSON.stringify(target)} 应提示必须指定 target`);
    assert.match(err.message, /list_windows/, '应引导先用 list_windows 查看窗口');
  }
}));

test('captureScreen:target 为窗口 ID → 精确命中并走窗口截图', withShots(async (shotsRoot) => {
  let spawnArgs;
  const child = fakeChild();
  const spawnFn = (cmd, args, opts) => {
    spawnArgs = { cmd, args, opts };
    writeFileSync(opts.env.TEXT_VISION_SHOT, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x00]));
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const listWindows = async () => [{ id: '456', process: 'chrome', title: 'Google Chrome' }];
  const shot = await captureScreen({ target: '456', shotsRoot, listWindows, spawnFn, timeout: 30000, fallbackDelay: 1000, platform: 'win32' });
  assert.equal(spawnArgs.opts.env.TEXT_VISION_HWND, '456', 'id target 应精确命中该窗口');
  assert.equal(shot.mime, 'image/jpeg');
  assert.equal(shot.note, undefined);
}));

test('captureScreen:枚举失败 → 明确报错(不再回退全屏)', withShots(async (shotsRoot) => {
  const listWindows = async () => { throw new Error('powershell 枚举失败'); };
  const err = await captureScreen({ target: 'chrome', shotsRoot, listWindows, timeout: 30000, fallbackDelay: 1000, platform: 'win32' }).then(() => null, e => e);
  assert.ok(err, '枚举失败应抛错');
  assert.match(err.message, /无法枚举窗口/);
  assert.match(err.message, /powershell 枚举失败/, '枚举失败原因应透传');
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

test('redactLocalPath:URL 内路径段(/tmp /var/log /home 等词表命中)不被撕裂', () => {
  // 回归:UNIX_PATH_RE 的 (?<!:) 只挡 scheme 后紧跟的 ://,挡不住主机名之后的路径段;
  // 修复前 https://host/tmp/... 会被脱敏成 https://host[本地路径],URL 前置保护解决
  assert.equal(redactLocalPath('https://example.com/tmp/error 出错了'), 'https://example.com/tmp/error 出错了');
  assert.equal(redactLocalPath('详情见 https://example.com/var/log/msg'), '详情见 https://example.com/var/log/msg');
  assert.equal(redactLocalPath('https://example.com/home/dir/a.png'), 'https://example.com/home/dir/a.png');
});

test('redactLocalPath:macOS /Users 与 /Library 绝对路径被脱敏(含用户名不泄漏)', () => {
  // 回归:词表缺 Users(大小写敏感),修复前 mac 主目录路径原样返回,泄漏用户名
  assert.equal(redactLocalPath('/Users/someone/Desktop/a.png'), '[本地路径]');
  assert.equal(redactLocalPath('读取失败 /Users/someone/.ssh/config'), '读取失败 [本地路径]');
  assert.equal(redactLocalPath('/Library/Logs/DiagnosticReports/foo'), '[本地路径]');
});

test('captureWindows:stderr 含本机绝对路径 → 错误消息被脱敏', withShots(async (shotsRoot) => {
  const child = fakeChild();
  const spawnFn = () => child;
  const p = captureWindows({ shotsRoot, spawnFn, timeout: 30000, fallbackDelay: 1000, windowId: '456' });
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
  const err = await captureScreen({ target: 'chrome', shotsRoot, listWindows: async () => [{ id: '456', process: 'chrome', title: 'Google Chrome' }], spawnFn, timeout: 30000, fallbackDelay: 1000, platform: 'win32' }).then(() => null, e => e);
  assert.ok(err, '应拒绝');
  assert.ok(!/text-vision-shot/.test(err.message), 'captureScreen 不得泄露截屏临时目录');
  assert.match(err.message, /\[本地路径\]/);
  assert.match(err.message, /Save 失败/);
}));

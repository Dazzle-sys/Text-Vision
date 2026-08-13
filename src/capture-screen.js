// 跨平台截屏:按操作系统分派系统自带命令,统一返回 { filePath, note? }。
// 支持两种模式:全屏(默认)与指定窗口(captureScreen 传 target,经 list-windows.js 枚举匹配到窗口 id)。
// 截图落盘到 text-vision 仓库根的 .text-vision/screenshots(保留最近 MAX_SHOTS 张),方便查看,不随临时目录清理。
//   win32 → PowerShell + System.Drawing(零安装)
//   darwin → screencapture(内置,零安装)
//   linux → 按序探测 gnome-screenshot / scrot / import(ImageMagick),至少其一
import { spawn, execFile } from 'node:child_process';
import { readFileSync, unlinkSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { promisify } from 'node:util';
import { listWindows, matchWindow } from './list-windows.js';
import { visionDir } from './repo-root.js';

import { redactLocalPath } from './redact.js';

const execFileP = promisify(execFile);
const TIMEOUT = 30000;
// Windows 截图独立超时:PowerShell 冷启动 + 多次 Add-Type C# 编译 + 大屏 CopyFromScreen + JPEG 编码
// 在慢/高负载机器上可能超过 30s,放宽到与 macOS 窗口枚举(60s)一致,避免误杀合法截图
// (killTimer 兜底仍在,卡死进程最坏等 timeout+fallbackDelay)
const WIN_TIMEOUT = 60000;

// 截图统一落盘到 shotsRoot(默认 text-vision 仓库根 .text-vision/screenshots,方便查看;保留最近 MAX_SHOTS 张)。
// 不随系统临时目录清理;目录不存在则创建(仓库根通常可写,只读部署时 mkdir 抛错由上层错误路径处理)。
const MAX_SHOTS = 20;

/**
 * 默认截图目录:VISION_SHOTS_DIR 配置则用它(仓库装在只读位置时的逃生口,如全局 npm / Program Files,
 * 此时仓库内 mkdir 会 EACCES),否则 text-vision 仓库根下的 .text-vision/screenshots
 * (用模块路径定位仓库根,不随启动目录变)。
 */
export function defaultShotsDir(env = process.env) {
  return (env.VISION_SHOTS_DIR || '').trim() || join(visionDir(), 'screenshots');
}

function makeShotsDir(shotsRoot) {
  mkdirSync(shotsRoot, { recursive: true });
  return shotsRoot;
}

function tempShotPath(shotDir, ext = 'png', prefix = 'shot') {
  return join(shotDir, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}

/** 删除单个截图文件(失败残留清理用)。截图目录是持久目录,不做 rmdir。 */
export function cleanupScreenShot(filePath) {
  try { unlinkSync(filePath); } catch { /* 已删除则忽略 */ }
}

/**
 * 保留截图目录中最近 max 张 shot-* 文件,超出删除最旧(文件名以时间戳开头,字典序即时间序)。
 * 同时回收残留的 note-* 临时文件:note 是"读后即删"的降级原因文件,正常路径(成功读删/失败清理)都已清,
 * 能留下的只有 JS 被硬杀(kill -9/断电)时未走到 close 回调的残留,截图成功后统一回收,避免无限累积。
 * 注:并发截屏且另一进程恰在写 note 的极小窗口内可能误删在途 note(后果仅是降级提示丢失),可接受。
 * 目录不存在/读失败静默。用于"截图保留最近 N 张"策略。
 */
export function pruneShots(shotsDir, max) {
  let files;
  try { files = readdirSync(shotsDir); } catch { return; }
  const shots = files.filter(f => /^shot-/.test(f)).sort();
  const excess = shots.length - max;
  for (let i = 0; i < excess; i++) {
    try { unlinkSync(join(shotsDir, shots[i])); } catch { /* 并发删除/已删则忽略 */ }
  }
  for (const f of files) {
    if (/^note-/.test(f)) {
      try { unlinkSync(join(shotsDir, f)); } catch { /* 并发删除/已删则忽略 */ }
    }
  }
}

/** 删除降级原因 note 文件(与截图同目录,用完即删)。 */
function cleanupNotePath(notePath) {
  try { unlinkSync(notePath); } catch { /* 不存在/已删则忽略 */ }
}

// --- Windows:PowerShell 内联脚本(避开执行策略限制) ---
// 指定窗口模式(windowId 非空):PrintWindow(PW_RENDERFULLCONTENT,能取被遮挡窗口)→ 空白校验失败
// → CopyFromScreen 窗口区域 → 仍失败 → 全屏,降级原因经 TEXT_VISION_NOTE 文件逐级累积回传 JS。
// 全屏模式(windowId 为空):直接 VirtualScreen CopyFromScreen。两模式共用同一脚本与 Save-Jpeg。
const WIN_PS = `
$ErrorActionPreference = 'Stop';
Add-Type -AssemblyName System.Drawing;
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class DPI { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }';
# 先声明进程 DPI 感知再取 VirtualScreen/窗口矩形,截屏才按物理像素(否则高分屏/缩放比例下尺寸不准)。
# 返回值刻意忽略:进程已 DPI 感知时重复调用返回 false 是幂等预期,不等于失败,硬校验反而误报。
[DPI]::SetProcessDPIAware() | Out-Null;
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;
public struct WinRect { public int Left, Top, Right, Bottom; }
public class Win32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out WinRect lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}';
$out = $env:TEXT_VISION_SHOT;
$notePath = $env:TEXT_VISION_NOTE;
$script:noteParts = @();
function Write-Note($m) { $script:noteParts += $m }
function Flush-Note { if ($notePath -and $script:noteParts.Count -gt 0) { [System.IO.File]::WriteAllText($notePath, ($script:noteParts -join ';'), (New-Object System.Text.UTF8Encoding($false))) } }
# 网格抽样判断位图是否空白(全黑/全白/全透明):颜色种类<3 视为空白。
# 采样步长按尺寸等分,网格数固定约 24x24,GetPixel 次数 ~576 次,不随窗口大小膨胀。
function Test-Blank($bmp) {
  $sx = [Math]::Max(1, [int]($bmp.Width / 24)); $sy = [Math]::Max(1, [int]($bmp.Height / 24));
  $colors = @{};
  for ($y = 0; $y -lt $bmp.Height; $y += $sy) {
    for ($x = 0; $x -lt $bmp.Width; $x += $sx) {
      $c = $bmp.GetPixel($x, $y).ToArgb(); $colors[$c] = $true;
      if ($colors.Count -ge 3) { return $false }
    }
  }
  return $true;
}
# 保存为 JPEG(质量85):4K 多屏截屏 PNG 常超 maxImageMB(10MB),JPEG 可降到几 MB,视觉描述无损影响
function Save-Jpeg($bmp) {
  $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' };
  $params = New-Object System.Drawing.Imaging.EncoderParameters(1);
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 85L);
  $bmp.Save($out, $enc, $params);
}
function Save-FullScreen {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen;
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;
  $g = [System.Drawing.Graphics]::FromImage($bmp);
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size);
  Save-Jpeg $bmp;
  $g.Dispose(); $bmp.Dispose();
}
$hwndRaw = $env:TEXT_VISION_HWND;
if ($hwndRaw) {
  $h = [IntPtr][long]$hwndRaw;
  $rect = New-Object WinRect;
  if (-not [Win32]::GetWindowRect($h, [ref]$rect)) { Write-Note '窗口已关闭或句柄无效' }
  elseif ([Win32]::IsIconic($h)) { Write-Note '窗口已最小化' }
  else {
    $w = $rect.Right - $rect.Left; $hh = $rect.Bottom - $rect.Top;
    if ($w -le 0 -or $hh -le 0) { Write-Note '窗口尺寸无效' }
    else {
      # 1) PrintWindow PW_RENDERFULLCONTENT=2(能取到被遮挡窗口内容)
      $bmp = New-Object System.Drawing.Bitmap $w, $hh;
      $g = [System.Drawing.Graphics]::FromImage($bmp);
      $hdc = $g.GetHdc();
      $ok = [Win32]::PrintWindow($h, $hdc, 2);
      $g.ReleaseHdc($hdc);
      if ($ok -and -not (Test-Blank $bmp)) { Save-Jpeg $bmp; $g.Dispose(); $bmp.Dispose(); Flush-Note; Write-Output $out; exit 0 }
      $g.Dispose(); $bmp.Dispose();
      # 2) 空白 → CopyFromScreen 窗口区域截图
      Write-Note 'PrintWindow 输出空白或失败(GPU 渲染/被遮挡窗口常见),已降级为窗口区域截图';
      $bmp = New-Object System.Drawing.Bitmap $w, $hh;
      $g = [System.Drawing.Graphics]::FromImage($bmp);
      try {
        $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size);
        if (-not (Test-Blank $bmp)) { Save-Jpeg $bmp; $g.Dispose(); $bmp.Dispose(); Flush-Note; Write-Output $out; exit 0 }
      } catch { }
      $g.Dispose(); $bmp.Dispose();
      Write-Note '窗口区域截图也失败,已回退全屏截图';
    }
  }
}
if (-not (Test-Path $out)) { Save-FullScreen }
Flush-Note; Write-Output $out;
`;

export function captureWindows({ spawnFn = spawn, timeout = WIN_TIMEOUT, fallbackDelay = 5000, windowId = null, shotsRoot } = {}) {
  return new Promise((resolvePromise, reject) => {
    // 输出路径由 JS 端生成并经环境变量注入子进程,不再依赖 stdout 猜路径:
    // 若脚本在 Save 与 Write-Output 之间被超时 kill(或 Save 抛错),JS 仍知道目标路径,
    // 失败分支能按路径清理,不会在截图目录残留失败的截图文件。
    const shotDir = makeShotsDir(shotsRoot || defaultShotsDir());
    const outPath = tempShotPath(shotDir, 'jpeg');
    // 指定窗口模式才注入降级原因通道:PS 降级时把原因写入 note 文件(UTF-8),JS 读后即删。
    // note 文件名用 note- 前缀而非 shot-:pruneShots 只清理 /^shot-/ 的截图文件,
    // 若 note 也以 shot- 开头,残留时会占用"保留最近 20 张"预算或被误删
    const notePath = windowId != null ? tempShotPath(shotDir, 'note.txt', 'note') : null;
    const env = { ...process.env, TEXT_VISION_SHOT: outPath };
    if (windowId != null) {
      env.TEXT_VISION_HWND = String(windowId);
      env.TEXT_VISION_NOTE = notePath;
    }
    let child;
    try {
      child = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PS], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        // 把输出路径经环境变量传给子进程,避免路径含空格/引号时的转义问题
        env
      });
    } catch (e) {
      // spawn 同步抛错(如找不到 powershell.exe)时同样清理临时文件,避免空目录残留
      cleanupScreenShot(outPath);
      if (notePath) cleanupNotePath(notePath);
      throw e;
    }
    let err = '';
    let wasTimedOut = false;
    let settled = false;
    let killTimer, fallbackTimer;
    // settle 要 clearTimeout 两个 timer,故 timer 声明为 let 并在此函数定义后再赋值;
    // settle 只被 timer/事件回调异步调用,调用时两个 timer 均已赋值,不会读到 undefined
    const settle = (fn, value) => { if (!settled) { settled = true; clearTimeout(killTimer); clearTimeout(fallbackTimer); fn(value); } };
    // 所有失败路径都要连 note 文件一起清理,保证 shotDir 可被 rmdir 清空、不残留
    const cleanupAll = () => { if (notePath) cleanupNotePath(notePath); cleanupScreenShot(outPath); };
    killTimer = setTimeout(() => { wasTimedOut = true; child.kill(); }, timeout);
    // kill 后仍可能在极端场景下收不到 close(进程卡死),加兜底 timer 强制结束,避免请求永久挂起
    fallbackTimer = setTimeout(() => {
      // 兜底结束也必须清理,避免卡死场景残留全屏截图;若 PowerShell 仍持有文件句柄导致删除失败,
      // 打一条 stderr 让残留可被人工发现(这是最敏感的全屏截图,宁可多此一举)
      cleanupAll();
      // 兜底超时时子进程可能仍卡死未退出:先 kill,否则它恢复后可能重新写出已删除的截图
      // (kill 幂等,进程已退出时无副作用)
      try { child.kill(); } catch { /* 忽略,不影响 settle */ }
      // 只打文件名,不暴露 tmpdir 绝对路径(含用户名),与本项目其他错误路径的隐私惯例一致
      console.error(`[text-vision] 截屏兜底超时已触发:临时文件可能未清理干净(${basename(outPath)}),若确认残留请手动删除。`);
      settle(reject, new Error(`截屏超时(超过 ${timeout}ms 被中止)${err ? ': ' + redactLocalPath(err).trim().slice(0, 300) : ''}`));
    }, timeout + fallbackDelay);
    child.stderr.on('data', d => { if (err.length < 4096) err += String(d).slice(0, 4096 - err.length); });
    child.on('error', e => {
      cleanupAll(); // spawn 失败时文件未写,幂等清理无副作用
      settle(reject, new Error(redactLocalPath(e?.message ?? String(e))));
    });
    child.on('close', code => {
      // JS 始终知道输出路径:失败(含超时被 kill)也按该路径清理,避免残留全屏截图
      if (code !== 0 || wasTimedOut) {
        cleanupAll();
        // 用 wasTimedOut 标记而非 code==null 判断超时:部分 Windows 环境下 kill 后 code 可能非 null
        const reason = wasTimedOut ? `截屏超时(超过 ${timeout}ms 被中止)` : `截屏失败(PowerShell 退出码 ${code})`;
        settle(reject, new Error(`${reason}: ${redactLocalPath(err).trim().slice(0, 300)}`));
      } else {
        // 成功分支:读 note 文件(PS 降级时才有)→ 读后即删,返回 { filePath, note? }
        let note;
        if (notePath) {
          try { note = readFileSync(notePath, 'utf8').trim() || undefined; } catch { note = undefined; }
          cleanupNotePath(notePath);
        }
        settle(resolvePromise, { filePath: outPath, note });
      }
    });
  });
}

// --- 探测并执行 Linux 截图命令 ---
const LINUX_CANDIDATES = [
  { cmd: 'gnome-screenshot', args: f => ['-f', f] },
  { cmd: 'scrot', args: f => [f] },
  { cmd: 'import', args: f => ['-window', 'root', f] }
];

async function captureLinuxFullScreen({ execFileFn = execFileP, timeout = TIMEOUT, shotsRoot } = {}) {
  const errors = [];
  for (const c of LINUX_CANDIDATES) {
    const shotDir = makeShotsDir(shotsRoot || defaultShotsDir());
    const path = tempShotPath(shotDir);
    try {
      await execFileFn(c.cmd, c.args(path), { timeout });
      // 退出码为 0 不一定代表文件已写出(个别工具在 headless/portal 环境会静默失败),
      // 校验产物非空再返回,否则继续尝试下一个候选,避免把"空文件"当成功结果上传
      let size = 0;
      try { size = statSync(path).size; } catch { /* 文件未写出,按失败处理 */ }
      if (size > 0) return { filePath: path }; // 第一个成功写出文件的命令
      errors.push(`${c.cmd}: 退出码 0 但未产出有效截图文件`);
    } catch (err) {
      errors.push(`${c.cmd}: ${redactLocalPath(err.message).split('\n')[0].slice(0, 80)}`);
    }
    cleanupScreenShot(path);
  }
  throw new Error(
    `截屏失败:${errors.map(e => e.split(':')[0]).join('/')} 均不可用。` +
    `请安装任一:gnome-screenshot、scrot、或 ImageMagick 的 import。` +
    `若已安装仍失败,可能是 Wayland/headless 环境,截图工具需要 X 或 portal 支持。`
  );
}

export async function captureLinux({ execFileFn = execFileP, timeout = TIMEOUT, windowId = null, shotsRoot } = {}) {
  if (windowId != null) {
    // 指定窗口:ImageMagick import -window <id>(已是全屏链末位候选,装了才可能按窗口截)
    const path = tempShotPath(makeShotsDir(shotsRoot || defaultShotsDir()));
    let ok = false;
    try {
      await execFileFn('import', ['-window', windowId, path], { timeout });
      let size = 0;
      try { size = statSync(path).size; } catch { /* 未写出 */ }
      if (size > 0) ok = true;
    } catch { /* import 失败,走降级 */ }
    if (ok) return { filePath: path };
    cleanupScreenShot(path);
    const full = await captureLinuxFullScreen({ execFileFn, timeout, shotsRoot });
    return { filePath: full.filePath, note: '指定窗口截图失败(import -window 不可用或窗口无效),已回退全屏截图' };
  }
  return captureLinuxFullScreen({ execFileFn, timeout, shotsRoot });
}

// --- macOS:截取用系统内置 screencapture,再 sips 转 JPEG(sips 不可用退回 PNG) ---
async function macToJpeg(png, { execFileFn, timeout }) {
  // 大屏/双屏 PNG 常超 maxImageMB,用系统内置 sips 转 JPEG(与 Windows 行为一致)
  const jpg = png.replace(/\.png$/, '.jpeg');
  try {
    await execFileFn('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', png, '--out', jpg], { timeout });
    cleanupScreenShot(png);
    return { filePath: jpg };
  } catch {
    cleanupScreenShot(jpg);
    return { filePath: png }; // sips 不可用的极端环境退回 PNG
  }
}

export async function captureMac({ execFileFn = execFileP, timeout = TIMEOUT, windowId = null, shotsRoot } = {}) {
  if (windowId != null) {
    // 指定窗口:screencapture -l <windowID>(系统内置)。被遮挡窗口在部分 macOS 版本取到的是遮挡内容而非本体。
    const png = tempShotPath(makeShotsDir(shotsRoot || defaultShotsDir()));
    let ok = false;
    try {
      await execFileFn('screencapture', ['-x', `-l${windowId}`, png], { timeout });
      let size = 0;
      try { size = statSync(png).size; } catch { /* 未写出 */ }
      if (size > 0) ok = true; // 0 字节常见于屏幕录制权限未授予,按失败处理
    } catch { /* 窗口截图失败,走降级 */ }
    if (ok) return macToJpeg(png, { execFileFn, timeout });
    cleanupScreenShot(png);
    const full = await captureMac({ execFileFn, timeout, windowId: null, shotsRoot });
    return { filePath: full.filePath, note: '指定窗口截图失败(窗口可能已关闭或未授权屏幕录制),已回退全屏截图' };
  }
  const png = tempShotPath(makeShotsDir(shotsRoot || defaultShotsDir()));
  try {
    await execFileFn('screencapture', ['-x', png], { timeout });
  } catch (err) {
    cleanupScreenShot(png); // 失败路径清理残留
    throw new Error(redactLocalPath(err?.message ?? String(err)));
  }
  return macToJpeg(png, { execFileFn, timeout });
}

// --- target 解析:枚举窗口 → 模糊匹配 → 命中传 id / 未命中或枚举失败记 note → 降级全屏 ---
// 枚举失败(如 wmctrl/swift 缺失、权限不足)与未命中都收敛为"note + 全屏",不抛错、不挂起。
async function resolveTarget(target, listWindowsFn) {
  if (target == null || String(target).trim() === '') return { match: null };
  let windows;
  try {
    windows = await listWindowsFn();
  } catch (err) {
    return { match: null, note: `无法枚举窗口(${redactLocalPath(err?.message ?? String(err)).split('\n')[0].slice(0, 200)}),已回退全屏截图` };
  }
  const match = matchWindow(target, windows);
  if (!match) return { match: null, note: `未找到与"${target}"匹配的窗口,已回退全屏截图` };
  return { match };
}

/**
 * 截取屏幕:全屏或指定窗口,返回 { b64, filePath, sizeBytes, mime, note? }。
 * target 为进程名或窗口标题(模糊匹配),找不到/枚举失败时回退全屏并带 note 说明原因。
 * 截图保留在 shotsRoot(默认仓库根 .text-vision/screenshots),每次成功后 pruneShots 只留最近 MAX_SHOTS 张。
 * deps 可选,用于测试注入 mock 的 spawn/execFile/listWindows,以及 shotsRoot(测试用临时目录避免污染仓库)。
 * platform 也可注入(默认 process.platform),让跨平台分派逻辑可在任意 CI 平台单测。
 */
export async function captureScreen(deps = {}) {
  let filePath;
  try {
    const listWindowsFn = deps.listWindows ?? listWindows;
    const shotsRoot = deps.shotsRoot ?? defaultShotsDir();
    const platform = deps.platform ?? process.platform;
    // target 解析提前到入口:命中传窗口 id,未命中/枚举失败带 note 走全屏(不抛错、不挂起)
    const r = await resolveTarget(deps.target, listWindowsFn);
    const windowId = r.match?.id ?? null;
    let result;
    if (platform === 'win32') result = await captureWindows({ ...deps, listWindowsFn, shotsRoot, windowId });
    else if (platform === 'darwin') result = await captureMac({ ...deps, listWindowsFn, shotsRoot, windowId });
    else if (platform === 'linux') result = await captureLinux({ ...deps, listWindowsFn, shotsRoot, windowId });
    else throw new Error(`暂不支持在当前平台(${platform})截屏`);
    filePath = result.filePath;

    const buf = readFileSync(filePath);
    // 0 字节文件不该当作成功结果发给视觉 API(用真实字节数判断,与 Linux 的 statSync 校验一致)
    if (buf.length === 0) {
      throw new Error('截屏失败:生成的文件为空(截图工具可能未正常工作)');
    }
    const b64 = buf.toString('base64');
    // mime 按实际输出格式推断:Windows/macOS 存 JPEG,Linux 存 PNG,供调用方正确声明 data URL
    const mime = filePath.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    // 截图保留策略:只留最近 MAX_SHOTS 张,超出清最旧(仅统计 shot-* 文件,note 等临时文件不受影响)
    pruneShots(dirname(filePath), MAX_SHOTS);
    // 合并两处降级原因:窗口内部降级 note + target 解析降级 note(运行时路径无需脱敏,枚举错误已在上游脱敏)
    const note = [result.note, r.note].filter(Boolean).map(s => s.trim()).join(';') || undefined;
    return { b64, filePath, sizeBytes: Buffer.byteLength(b64, 'base64'), mime, note };
  } catch (err) {
    if (filePath) cleanupScreenShot(filePath); // 失败路径清理残留,避免截屏失败留下空文件
    // 底层实现(reject 自 captureWindows 等)已逐处脱敏,这里兜底未来回归:任何异常都以不含
    // 本机绝对路径的消息抛出,避免 MCP 客户端读到含用户名的仓库路径
    throw new Error(redactLocalPath(err?.message ?? String(err)));
  }
}

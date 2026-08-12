// 跨平台截屏:按操作系统分派系统自带命令,统一返回 { b64, filePath, sizeBytes }
//  win32 → PowerShell + System.Drawing(零安装)
//  darwin → screencapture(内置,零安装)
//  linux → 按序探测 gnome-screenshot / scrot / import(ImageMagick),至少其一
import { spawn, execFile } from 'node:child_process';
import { readFileSync, unlinkSync, mkdtempSync, rmdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const TIMEOUT = 30000;

// 底层命令错误(stderr / execFile 报错)可能回显本机绝对路径(含用户名的 tmpdir 截屏目录),
// 透传给 MCP 客户端会暴露本机目录结构;统一替换成占位符。两条规则:
//  1. Windows 盘符路径(C:\Users\...),与 scripts/check-doc-paths.js 的 winPath 识别保持一致
//  2. execFile 的 "Command failed: <cmd> <args>" 首行:只留命令名,参数里的 Unix 路径(/tmp 等)随之消失
export function redactLocalPath(s) {
  return String(s)
    .replace(/[A-Za-z]:[\\/][^\s"'()]*/g, '[本地路径]')
    .replace(/Command failed: (\S+).*/g, 'Command failed: $1');
}

// 截屏临时文件放进进程私有的 mkdtemp 子目录(默认仅本用户可读),避免默认权限下
// 全屏截图在"保存→读取→删除"窗口期内被同机其他用户/进程读到(Windows 临时目录 ACL
// 通常已隔离,但 macOS 默认 644)。目录用完随文件一起清空。
function makeShotDir() {
  return mkdtempSync(join(tmpdir(), 'text-vision-shot-'));
}

function tempShotPath(shotDir, ext = 'png') {
  return join(shotDir, `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}

/** 删除截屏临时文件,并尝试清空其专属临时目录(非 shot 目录的父目录不动)。 */
export function cleanupScreenShot(filePath) {
  try { unlinkSync(filePath); } catch { /* 已删除则忽略 */ }
  const dir = dirname(filePath);
  if (basename(dir).startsWith('text-vision-shot-')) {
    try { rmdirSync(dir); } catch { /* 目录非空(如还有失败残留文件)则保留 */ }
  }
}

// --- Windows:PowerShell 内联脚本(避开执行策略限制) ---
export function captureWindows({ spawnFn = spawn, timeout = TIMEOUT, fallbackDelay = 5000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    // 输出路径由 JS 端生成并经环境变量注入子进程,不再依赖 stdout 猜路径:
    // 若脚本在 Save 与 Write-Output 之间被超时 kill(或 Save 抛错),JS 仍知道目标路径,
    // 失败分支能按路径清理,不会在临时目录残留敏感的全屏截图。
    const shotDir = makeShotDir();
    const outPath = tempShotPath(shotDir, 'jpeg');
    const ps = `
$ErrorActionPreference = 'Stop';
Add-Type -AssemblyName System.Drawing;
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class DPI { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }';
# 先声明进程 DPI 感知再取 VirtualScreen,截屏才按物理像素(否则高分屏/缩放比例下尺寸不准)。
# 返回值刻意忽略:进程已 DPI 感知时重复调用返回 false 是幂等预期,不等于失败,硬校验反而误报。
[DPI]::SetProcessDPIAware() | Out-Null;
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen;
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;
$g = [System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size);
# 保存为 JPEG(质量85):4K 多屏截屏 PNG 常超 maxImageMB(10MB),JPEG 可降到几 MB,视觉描述无损影响
$out = $env:TEXT_VISION_SHOT;
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' };
$params = New-Object System.Drawing.Imaging.EncoderParameters(1);
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 85L);
$bmp.Save($out, $enc, $params);
$g.Dispose(); $bmp.Dispose();
Write-Output $out;`;
    let child;
    try {
      child = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        // 把输出路径经环境变量传给子进程,避免路径含空格/引号时的转义问题
        env: { ...process.env, TEXT_VISION_SHOT: outPath }
      });
    } catch (e) {
      // spawn 同步抛错(如找不到 powershell.exe)时同样清理临时目录,避免空目录残留
      cleanupScreenShot(outPath);
      throw e;
    }
    let err = '';
    let wasTimedOut = false;
    let settled = false;
    let killTimer, fallbackTimer;
    // settle 要 clearTimeout 两个 timer,故 timer 声明为 let 并在此函数定义后再赋值;
    // settle 只被 timer/事件回调异步调用,调用时两个 timer 均已赋值,不会读到 undefined
    const settle = (fn, value) => { if (!settled) { settled = true; clearTimeout(killTimer); clearTimeout(fallbackTimer); fn(value); } };
    killTimer = setTimeout(() => { wasTimedOut = true; child.kill(); }, timeout);
    // kill 后仍可能在极端场景下收不到 close(进程卡死),加兜底 timer 强制结束,避免请求永久挂起
    fallbackTimer = setTimeout(() => {
      // 兜底结束也必须清理,避免卡死场景残留全屏截图;若 PowerShell 仍持有文件句柄导致删除失败,
      // 打一条 stderr 让残留可被人工发现(这是最敏感的全屏截图,宁可多此一举)
      cleanupScreenShot(outPath);
      // 兜底超时时子进程可能仍卡死未退出:先 kill,否则它恢复后可能重新写出已删除的截图
      // (kill 幂等,进程已退出时无副作用)
      try { child.kill(); } catch { /* 忽略,不影响 settle */ }
      // 只打文件名,不暴露 tmpdir 绝对路径(含用户名),与本项目其他错误路径的隐私惯例一致
      console.error(`[text-vision] 截屏兜底超时已触发:临时文件可能未清理干净(${basename(outPath)}),若确认残留请手动删除。`);
      settle(reject, new Error(`截屏超时(超过 ${timeout}ms 被中止)${err ? ': ' + redactLocalPath(err).trim().slice(0, 300) : ''}`));
    }, timeout + fallbackDelay);
    child.stderr.on('data', d => { if (err.length < 4096) err += String(d).slice(0, 4096 - err.length); });
    child.on('error', e => {
      cleanupScreenShot(outPath); // spawn 失败时文件未写,幂等清理无副作用
      settle(reject, new Error(redactLocalPath(e?.message ?? String(e))));
    });
    child.on('close', code => {
      // JS 始终知道输出路径:失败(含超时被 kill)也按该路径清理,避免残留全屏截图
      if (code !== 0 || wasTimedOut) {
        cleanupScreenShot(outPath);
        // 用 wasTimedOut 标记而非 code==null 判断超时:部分 Windows 环境下 kill 后 code 可能非 null
        const reason = wasTimedOut ? `截屏超时(超过 ${timeout}ms 被中止)` : `截屏失败(PowerShell 退出码 ${code})`;
        settle(reject, new Error(`${reason}: ${redactLocalPath(err).trim().slice(0, 300)}`));
      } else {
        settle(resolvePromise, outPath);
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

export async function captureLinux({ execFileFn = execFileP, timeout = TIMEOUT } = {}) {
  const errors = [];
  for (const c of LINUX_CANDIDATES) {
    const shotDir = makeShotDir();
    const path = tempShotPath(shotDir);
    try {
      await execFileFn(c.cmd, c.args(path), { timeout });
      // 退出码为 0 不一定代表文件已写出(个别工具在 headless/portal 环境会静默失败),
      // 校验产物非空再返回,否则继续尝试下一个候选,避免把"空文件"当成功结果上传
      let size = 0;
      try { size = statSync(path).size; } catch { /* 文件未写出,按失败处理 */ }
      if (size > 0) return path; // 第一个成功写出文件的命令
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

// --- macOS ---
export async function captureMac({ execFileFn = execFileP, timeout = TIMEOUT } = {}) {
  const png = tempShotPath(makeShotDir());
  try {
    await execFileFn('screencapture', ['-x', png], { timeout });
  } catch (err) {
    cleanupScreenShot(png); // 失败路径清理残留
    throw new Error(redactLocalPath(err?.message ?? String(err)));
  }
  // 大屏/双屏 PNG 常超 maxImageMB,用系统内置 sips 转 JPEG(与 Windows 行为一致)
  const jpg = png.replace(/\.png$/, '.jpeg');
  try {
    await execFileFn('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', png, '--out', jpg], { timeout });
    cleanupScreenShot(png);
    return jpg;
  } catch {
    cleanupScreenShot(jpg);
    return png; // sips 不可用的极端环境退回 PNG
  }
}

/**
 * 截取当前屏幕(全部显示器),返回 { b64, filePath, sizeBytes }。
 * 调用方负责用完后清理(cleanupScreenShot)。
 * deps 可选,用于测试注入 mock 的 spawn/execFile。
 */
export async function captureScreen(deps = {}) {
  let filePath;
  try {
    if (process.platform === 'win32') filePath = await captureWindows(deps);
    else if (process.platform === 'darwin') filePath = await captureMac(deps);
    else if (process.platform === 'linux') filePath = await captureLinux(deps);
    else throw new Error(`暂不支持在当前平台(${process.platform})截屏`);

    const b64 = readFileSync(filePath).toString('base64');
    // 0 字节或损坏文件不该当作成功结果发给视觉 API
    if (!b64) {
      throw new Error('截屏失败:生成的文件为空(截图工具可能未正常工作)');
    }
    // mime 按实际输出格式推断:Windows/macOS 存 JPEG,Linux 存 PNG,供调用方正确声明 data URL
    const mime = filePath.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    return { b64, filePath, sizeBytes: Buffer.byteLength(b64, 'base64'), mime };
  } catch (err) {
    if (filePath) cleanupScreenShot(filePath); // 失败路径清理残留,避免临时文件堆积
    // 底层实现(reject 自 captureWindows 等)已逐处脱敏,这里兜底未来回归:任何异常都以不含
    // 本机绝对路径的消息抛出,避免 MCP 客户端读到含用户名的 tmpdir 路径
    throw new Error(redactLocalPath(err?.message ?? String(err)));
  }
}

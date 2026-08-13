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
import { resolvePsExe } from './ps-exe.js';
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
// 指定窗口模式(windowId 非空):最小化窗口先临时恢复到屏幕外再截,截完还原最小化;
// PrintWindow(PW_RENDERFULLCONTENT,能取被遮挡窗口本体,含多数 GPU 渲染应用)→ 空白则延时重试
// → 未移出屏幕且未被遮挡时才允许 CopyFromScreen 窗口区域 → 仍失败 → 全屏,
// 降级原因经 TEXT_VISION_NOTE 文件逐级累积回传 JS。
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
public struct POINT { public int X, Y; }
public class Win32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out WinRect lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("dwmapi.dll")] public static extern int DwmFlush();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out WinRect pvAttribute, int cbAttribute);
  public static IntPtr WindowFromPointAt(int x, int y) { POINT p = new POINT(); p.X = x; p.Y = y; return WindowFromPoint(p); }
  public static bool IsSelfOrDescendant(IntPtr top, IntPtr target) {
    IntPtr cur = top;
    while (cur != IntPtr.Zero) { if (cur == target) return true; cur = GetParent(cur); }
    return false;
  }
}';
$out = $env:TEXT_VISION_SHOT;
$notePath = $env:TEXT_VISION_NOTE;
$script:noteParts = @();
function Write-Note($m) { $script:noteParts += $m }
function Flush-Note { if ($notePath -and $script:noteParts.Count -gt 0) { [System.IO.File]::WriteAllText($notePath, ($script:noteParts -join ';'), (New-Object System.Text.UTF8Encoding($false))) } }
# 网格抽样判断位图是否"整图同色":PrintWindow 失败/被遮挡窗口(GPU 渲染)时输出为纯黑/纯白/全透明,
# 颜色种类恰为 1。因此只用"出现第 2 种颜色"即判非空白:用"颜色种类<3"会误伤黑底白字/白底黑字等
# 双色正常窗口,导致 PrintWindow 成功的截图被误判空白而降级丢弃(反而截到遮挡层)。
# 采样步长按尺寸等分,网格数固定约 24x24,GetPixel 次数 ~576 次,不随窗口大小膨胀。
function Test-Blank($bmp) {
  $sx = [Math]::Max(1, [int]($bmp.Width / 24)); $sy = [Math]::Max(1, [int]($bmp.Height / 24));
  $colors = @{};
  for ($y = 0; $y -lt $bmp.Height; $y += $sy) {
    for ($x = 0; $x -lt $bmp.Width; $x += $sx) {
      $c = $bmp.GetPixel($x, $y).ToArgb(); $colors[$c] = $true;
      if ($colors.Count -ge 2) { return $false }
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
# 对窗口执行一次 PrintWindow(PW_RENDERFULLCONTENT=2):能取到被遮挡窗口本体,含多数 GPU 渲染应用。
# 非空白则存图返回 $true;失败/空白返回 $false,由调用方决定降级(延时重试/区域截图/全屏)。
function Invoke-PrintWindowSave($h, $w, $hh) {
  $bmp = New-Object System.Drawing.Bitmap $w, $hh;
  $g = [System.Drawing.Graphics]::FromImage($bmp);
  $hdc = $g.GetHdc();
  $ok = $false;
  try { $ok = [Win32]::PrintWindow($h, $hdc, 2) }
  finally { $g.ReleaseHdc($hdc) }
  if ($ok -and -not (Test-Blank $bmp)) { Save-Jpeg $bmp; $g.Dispose(); $bmp.Dispose(); return $true }
  $g.Dispose(); $bmp.Dispose();
  return $false;
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
  $restoredMinimized = $false;
  $savedWindow = $false;
  $origRect = $null;
  try {
    # --- 1) 最小化 → 临时恢复并移出虚拟屏(PrintWindow 对最小化窗口通常输出空白)---
    if ([Win32]::IsIconic($h)) {
      $restoredMinimized = $true;
      Write-Note '窗口原为最小化,已临时恢复截图后还原(任务栏可能短暂闪动)';
      [Win32]::ShowWindow($h, 4) | Out-Null;            # SW_SHOWNOACTIVATE:恢复但不抢焦点
      # 先记录原始还原位置再移出屏幕:SetWindowPos 移走后会更新 rcNormalPosition 为屏幕外坐标,
      # 若不记下原位置,末尾 SW_MINIMIZE 会把 restore 位置定格在屏幕外,用户恢复时窗口不可见
      $origRect = New-Object WinRect;
      if (-not [Win32]::GetWindowRect($h, [ref]$origRect)) {
        $origRect = $null;
        Write-Note '未能记录窗口原始位置,还原最小化后窗口可能需从任务栏手动找回';
      }
      # 移出虚拟屏避免在原位闪现;SWP_NOZORDER 保持 Z 序(PrintWindow 不需要置顶,勿用 HWND_TOPMOST)
      [Win32]::SetWindowPos($h, [IntPtr]::Zero, -32000, -32000, 0, 0, 0x10 -bor 0x1 -bor 0x4) | Out-Null;
      [Win32]::DwmFlush() | Out-Null;
      Start-Sleep -Milliseconds 150;                    # 等应用重绘,避免首帧空白误判
      if ([Win32]::IsIconic($h)) { Write-Note '恢复最小化窗口未生效,内容可能无法截取' }
    }

    # --- 2) 取窗口矩形:恢复之后再取,避免最小化窗口的任务栏位置/异常值 ---
    $rect = New-Object WinRect;
    if (-not [Win32]::GetWindowRect($h, [ref]$rect)) { Write-Note '窗口已关闭或句柄无效' }
    else {
      $w = $rect.Right - $rect.Left; $hh = $rect.Bottom - $rect.Top;
      if ($w -le 0 -or $hh -le 0) {   # 防御:异常时用 DWM 扩展边界兜底
        $drect = New-Object WinRect;
        $cb = [System.Runtime.InteropServices.Marshal]::SizeOf($drect);
        if ([Win32]::DwmGetWindowAttribute($h, 9, [ref]$drect, $cb) -eq 0) { $w = $drect.Right - $drect.Left; $hh = $drect.Bottom - $drect.Top }
      }
      if ($w -le 0 -or $hh -le 0) { Write-Note '窗口尺寸无效' }
      else {
        # --- 3) PrintWindow(PW_RENDERFULLCONTENT):刚恢复的窗口可能仍在渲染 → 延时重试最多 3 次 ---
        $attempts = 0;
        do {
          if (Invoke-PrintWindowSave $h $w $hh) { $savedWindow = $true; break }
          Start-Sleep -Milliseconds 200;
          $attempts++;
        } while ($attempts -lt 3);

        if (-not $savedWindow) {
          Write-Note 'PrintWindow 输出空白或失败,已降级尝试屏幕区域截图';
          # --- 4) 屏幕区域截图:仅当窗口未被移出屏幕、且中心点未被完全遮挡才有意义 ---
          # 窗口移出屏幕后(-32000)该区域是空桌面,CopyFromScreen 截不到本体,必须跳过;
          # 被遮挡时 CopyFromScreen 截到的是遮挡层(误导),用中心点命中窗口自身才截。
          if (-not $restoredMinimized) {
            # 遮挡守卫:3×3 网格多点采样(中心 + 四角附近),任一命中窗口自身(或其后代)即视为未被完全遮挡。
            # 只查中心点会被悬浮球/小工具等恰好遮住中心而误判"完全遮挡"跳过区域截图;多点降低误判率。
            # 小窗口用 Min 收敛到窗口内,避免采样点越界到窗口外。
            $cxPts = @($rect.Left + [int]($w / 2), $rect.Left + [Math]::Min(8, [int]($w / 2)), $rect.Right - [Math]::Min(9, [int]($w / 2)));
            $cyPts = @($rect.Top + [int]($hh / 2), $rect.Top + [Math]::Min(8, [int]($hh / 2)), $rect.Bottom - [Math]::Min(9, [int]($hh / 2)));
            $hitTarget = $false;
            foreach ($cx in $cxPts) {
              foreach ($cy in $cyPts) {
                if ([Win32]::IsSelfOrDescendant([Win32]::WindowFromPointAt($cx, $cy), $h)) { $hitTarget = $true; break }
              }
              if ($hitTarget) { break }
            }
            if ($hitTarget) {
              $bmp = New-Object System.Drawing.Bitmap $w, $hh;
              $g = [System.Drawing.Graphics]::FromImage($bmp);
              try {
                $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size);
                if (-not (Test-Blank $bmp)) { Save-Jpeg $bmp; $g.Dispose(); $bmp.Dispose(); $savedWindow = $true }
                else { $g.Dispose(); $bmp.Dispose(); Write-Note '窗口区域截图也失败' }
              } catch { $g.Dispose(); $bmp.Dispose(); Write-Note '窗口区域截图失败(屏幕捕获可能被禁止)' }
            } else { Write-Note '窗口被完全遮挡,跳过区域截图(避免截到遮挡层)' }
          } else { Write-Note '窗口已移到屏幕外,跳过区域截图' }
        }
      }
    }
  } finally {
    # --- 5) 无论成败:还原最小化(仅当最初是最小化)---
    if ($restoredMinimized) {
      # 先移回原始位置再最小化:直接 SW_MINIMIZE 会把 restore 位置定格在屏幕外(-32000),
      # 用户恢复窗口时会看不到;移回后再最小化,下次恢复回到原位置
      if ($origRect) { [Win32]::SetWindowPos($h, [IntPtr]::Zero, $origRect.Left, $origRect.Top, 0, 0, 0x10 -bor 0x1 -bor 0x4) | Out-Null }
      [Win32]::ShowWindow($h, 6) | Out-Null;   # SW_MINIMIZE
      # IsWindow 守卫:窗口在捕获期间被关闭时,无效句柄的 IsIconic 返回 false,会误报"还原失败"
      if ([Win32]::IsWindow($h) -and -not [Win32]::IsIconic($h)) { Write-Note '未能还原窗口为最小化状态' }
    }
  }
  if ($savedWindow) { Flush-Note; Write-Output $out; exit 0 }
}
if (-not (Test-Path $out)) { if ($hwndRaw) { Write-Note '已回退全屏截图' }; Save-FullScreen }
Flush-Note; Write-Output $out;
`;

/**
 * 超时强杀后的窗口兜底还原。PS 主脚本的 finally 只在脚本自然退出/抛错时执行;JS 超时 child.kill()
 * 是外部强杀,finally 不会运行,此时"最小化临时恢复 + 移出屏幕"的窗口会卡在屏幕外(-32000)且
 * 非最小化,用户点击任务栏恢复也只能回到屏幕外。兜底:对指定窗口跑一段轻量 PS,仅当它仍存在、
 * 非最小化、且位于屏幕外(SetWindowPos 哨兵坐标附近)时才重新最小化——最小化窗口至少在任务栏有
 * 图标,比"悬在屏幕外"好找回。窗口正常/已最小化/已关闭时不动,不引入副作用。
 * 尽力而为:spawn 失败或超时都静默,最坏回到现状,不拖垮主流程。
 */
function restoreMinimizedFallback(hwnd, exe, { spawnFn = spawn } = {}) {
  // 兜底命令把 hwnd 拼进 PS 模板字符串。windowId 目前来自系统枚举(纯数字句柄),但防御未来来源变化:
  // 只接受纯数字,否则跳过(尽力而为,不做也不拖垮主流程)。
  if (!/^\d+$/.test(String(hwnd))) return;
  const ps = `
$h = [IntPtr][long]${hwnd};
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;
public class Wr { [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
public struct RECT { public int L; public int T; public int R; public int B; } }';
$r = New-Object Wr+RECT;
if ([Wr]::IsWindow($h) -and -not [Wr]::IsIconic($h) -and [Wr]::GetWindowRect($h, [ref]$r) -and ($r.L -lt -10000 -or $r.T -lt -10000)) { [Wr]::ShowWindow($h, 6) | Out-Null }
`;
  let child;
  try {
    child = spawnFn(exe, ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, stdio: 'ignore' });
  } catch { return; }
  // 8s:主脚本 60s 超时已说明机器可能偏慢/高负载,冷启动 Add-Type 编译可能超 5s,兜底是最后机会多留余量
  const t = setTimeout(() => { try { child.kill(); } catch { /* 已退出则忽略 */ } }, 8000);
  child.on('close', () => clearTimeout(t));
  child.on('error', () => clearTimeout(t));
}

export function captureWindows({ spawnFn = spawn, timeout = WIN_TIMEOUT, fallbackDelay = 5000, windowId = null, shotsRoot, psExe } = {}) {
  return new Promise((resolvePromise, reject) => {
    // 防御:windowId 会拼进 PS 模板的 [IntPtr][long]$hwndRaw,注入前先校验纯数字,
    // 与 restoreMinimizedFallback 的兜底校验(只接受纯数字)同一标准。当前唯一来源是
    // win32 枚举的 h.ToInt64()(纯数字),校验防未来窗口来源变化把非数字值拼进 PS 脚本。
    if (windowId != null && !/^\d+$/.test(String(windowId))) {
      reject(new Error(`无效的窗口句柄:${windowId}`));
      return;
    }
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
      child = spawnFn(psExe ?? resolvePsExe(), ['-NoProfile', '-NonInteractive', '-Command', WIN_PS], {
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
    killTimer = setTimeout(() => {
      wasTimedOut = true;
      child.kill();
      // PS 主脚本被强杀,finally 不执行:最小化窗口可能卡在屏幕外,额外跑兜底命令尝试还原(尽力而为,失败静默)
      if (windowId != null) restoreMinimizedFallback(String(windowId), psExe ?? resolvePsExe(), { spawnFn });
    }, timeout);
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

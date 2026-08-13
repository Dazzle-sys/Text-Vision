// 三平台当前打开窗口枚举 + 模糊匹配。list_windows 工具与 screen_capture(target) 共用同一份实现:
// 枚举出当前打开窗口清单(Windows 含最小化窗口,标注 minimized),再由 matchWindow 纯函数按
// "进程名优先、标题其次"模糊匹配 target。
// 平台只做"哑"枚举输出(win32=PowerShell、mac=swift、linux=wmctrl),匹配逻辑在 JS 端,可单测。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolvePsExe } from './ps-exe.js';
import { redactLocalPath } from './redact.js';

const execFileP = promisify(execFile);
const ENUM_TIMEOUT = 30000;       // Windows/Linux 枚举超时
const MAC_TIMEOUT = 60000;        // swift 首启编译有 1~2s 延迟,超时放宽
const MAX_BUFFER = 4 * 1024 * 1024;

/**
 * 按 target 在窗口清单里找最佳匹配(纯函数,可单测)。
 * 先进程名后标题,各自内部按 精确(3) > 前缀(2) > 包含(1) 排序;
 * bestRank 跨两遍保持:进程名**精确**命中(3)时标题无法覆盖(精确已是最高 rank);
 * 进程名仅前缀(2)/包含(1)命中时,标题更高 rank(如精确 3)会覆盖,保证跨来源取最高匹配度。
 * 空 target / 无匹配返回 null。
 */
export function matchWindow(target, windows) {
  const t = String(target ?? '').replace(/^['"]+|['"]+$/g, '').trim().toLowerCase();
  if (!t || !Array.isArray(windows) || windows.length === 0) return null;
  const rank = key => (key === t ? 3 : (key.startsWith(t) ? 2 : (key.includes(t) ? 1 : 0)));
  let best = null;
  let bestRank = 0;
  for (const w of windows) { // 第一遍:进程名
    const r = rank((w.process || '').toLowerCase());
    if (r > bestRank) { bestRank = r; best = w; }
    if (r === 3) break;
  }
  // 进程名已精确命中(rank 最高为 3),标题不可能覆盖,跳过第二遍枚举
  if (bestRank === 3) return best;
  for (const w of windows) { // 第二遍:窗口标题
    const r = rank((w.title || '').toLowerCase());
    if (r > bestRank) { bestRank = r; best = w; }
    if (r === 3) break;
  }
  return best;
}

// --- Windows:PowerShell EnumWindows 枚举当前打开窗口(含最小化,输出 minimized 标记),输出 JSON 数组 ---
// 标题用 SendMessageTimeout(WM_GETTEXT, SMTO_ABORTIFHUNG) 而非裸 GetWindowText:
// 后者对无响应进程会同步卡死整个 PS 进程,SMTO_ABORTIFHUNG 让超时(2s)即返回,枚举永不挂起。
const WIN_ENUM_PS = `
$ErrorActionPreference = 'Stop';
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; using System.Diagnostics;
public class WinEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeout")] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeout")] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, StringBuilder lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static string[] Enumerate() {
    var items = new System.Collections.Generic.List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      IntPtr dummy;
      // WM_GETTEXTLENGTH 把文本长度放 lpdwResult(out 参数),SendMessageTimeout 返回值只表示"消息是否处理成功"
      IntPtr ok = SendMessageTimeout(h, 0x000E, IntPtr.Zero, IntPtr.Zero, 0x2, 2000, out dummy);
      if (ok == IntPtr.Zero) return true; // 窗口无响应,跳过
      int len = (int)dummy;
      if (len <= 0 || len > 4096) return true;
      var sb = new StringBuilder(len + 1);
      SendMessageTimeout(h, 0x000D, (IntPtr)(len + 1), sb, 0x2, 2000, out dummy); // WM_GETTEXT:wParam=buffer 长度
      // 注意:外层 Add-Type 用 PS 单引号包 C#,这里的字符串必须用双引号(单引号字符字面量会提前终止 PS 字符串)
      string title = sb.ToString().Replace("\\t", " ").Replace("\\r", " ").Replace("\\n", " ");
      if (string.IsNullOrWhiteSpace(title)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      string proc = "";
      try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { }
      RECT r; GetWindowRect(h, out r);
      int w = r.Right - r.Left, hh = r.Bottom - r.Top;
      // 最小化窗口的 GetWindowRect 可能返回任务栏按钮尺寸甚至 0×0:枚举不需要真实尺寸(输出不展示宽高,
      // screen_capture 也只传 id,捕获端恢复后再取),故对最小化窗口放行,避免丢掉"最小化"这个 target 入口。
      if (w <= 0 || hh <= 0) { if (!IsIconic(h)) return true; }
      items.Add(h.ToInt64() + "\\t" + proc + "\\t" + title + "\\t" + w + "\\t" + hh + "\\t" + (IsIconic(h) ? "1" : "0"));
      return true;
    }, IntPtr.Zero);
    return items.ToArray();
  }
}';
$items = [WinEnum]::Enumerate();
if ($items.Count -eq 0) { '[]' } else { $items | ConvertTo-Json -Compress }
`;

export async function listWindowsWin32({ execFileFn = execFileP, timeout = ENUM_TIMEOUT, psExe } = {}) {
  // 与截屏侧共用 resolvePsExe:显式注入优先,否则按 VISION_POWERSHELL → pwsh 探测 → powershell.exe 解析,
  // 保证纯 pwsh(无 5.x)环境下列举与截屏行为一致,而不是两边各自硬编码 exe。
  const { stdout } = await execFileFn(psExe ?? resolvePsExe(), ['-NoProfile', '-NonInteractive', '-Command', WIN_ENUM_PS], {
    timeout,
    windowsHide: true,
    maxBuffer: MAX_BUFFER
  });
  return parseWin32(stdout);
}

/** 解析 PowerShell 输出的 JSON 数组(tab 分隔行)。空输出/非 JSON 防御性返回 []。 */
export function parseWin32(stdout) {
  try {
    const parsed = JSON.parse(String(stdout).trim());
    // PowerShell 的 ConvertTo-Json 对单元素数组输出裸 JSON 字符串而非数组(已知行为),
    // 统一归一成数组再逐行解析,否则单窗口时 list_windows 会误判为"没有可见窗口"
    const rows = Array.isArray(parsed) ? parsed : (typeof parsed === 'string' ? [parsed] : []);
    return rows.map(row => {
      // 第 6 段是 minimized 标记("1"/"0");旧格式无该段 → 默认 false,向后兼容
      const [id, process = '', title = '', width = '0', height = '0', minimized = '0'] = String(row).split('\t');
      return { id, process, title, width: Number(width) || 0, height: Number(height) || 0, minimized: minimized === '1' };
    });
  } catch {
    return [];
  }
}

// --- macOS:swift 内联脚本调 CGWindowListCopyWindowInfo,输出 tab 分隔行(零额外库,需 Xcode CLT) ---
// 屏幕录制权限未授予时 kCGWindowName 全空(隐私保护),由 JS 侧诊断:有窗口但所有标题为空 → 权限问题。
const MAC_ENUM_SWIFT = `import CoreGraphics
import Foundation
let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for w in info {
  let layer = w[kCGWindowLayer as String] as? Int ?? 0
  guard layer == 0 else { continue }
  let num = w[kCGWindowNumber as String] as? Int ?? 0
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  let title = (w[kCGWindowName as String] as? String ?? "").replacingOccurrences(of: "\\t", with: " ")
  print("\\(num)\\t\\(owner)\\t\\(title)")
}
`;

export async function listWindowsMac({ execFileFn = execFileP, timeout = MAC_TIMEOUT } = {}) {
  const { stdout } = await execFileFn('swift', ['-'], { input: MAC_ENUM_SWIFT, timeout, maxBuffer: MAX_BUFFER });
  const windows = parseMac(stdout);
  if (windows.length > 0 && windows.every(w => !w.title)) {
    throw new Error('macOS 无法读取窗口标题,可能未授予屏幕录制权限(系统设置 → 隐私与安全性 → 屏幕录制)');
  }
  return windows;
}

/** 解析 swift 输出的 tab 分隔行 → 窗口条目;mac 的 CGWindow 枚举拿不到尺寸,置 0。 */
export function parseMac(stdout) {
  return String(stdout)
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      const [id, owner = '', title = ''] = line.split('\t');
      return { id, process: owner, title, width: 0, height: 0 };
    })
    .filter(w => w.id && w.process);
}

// --- Linux:wmctrl -lp 枚举(需安装 wmctrl 包),进程名读 /proc/<pid>/comm ---
const WMCTRL_LINE_RE = /^(\S+)\s+\S+\s+(\S+)\s+\S+\s+(.*)$/;

export async function listWindowsLinux({ execFileFn = execFileP, timeout = ENUM_TIMEOUT } = {}) {
  let stdout;
  try {
    ({ stdout } = await execFileFn('wmctrl', ['-lp'], { timeout, maxBuffer: MAX_BUFFER }));
  } catch (err) {
    // ENOENT = wmctrl 未安装;其它错误(如 Wayland 下不支持)也归为"工具不可用"
    throw new Error(`wmctrl 不可用(需安装 wmctrl 包,且需 X11 窗口管理器): ${redactLocalPath(err?.message ?? String(err)).split('\n')[0].slice(0, 80)}`);
  }
  return parseLinux(stdout);
}

/** 解析 wmctrl -lp 输出;进程名读 /proc/<pid>/comm(读失败留空)。 */
export function parseLinux(stdout) {
  return String(stdout)
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      const m = WMCTRL_LINE_RE.exec(line);
      if (!m) return null;
      const id = m[1];
      const pid = m[2];
      let process = '';
      if (pid && /^\d+$/.test(pid)) {
        try { process = readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { /* 进程已退出 */ }
      }
      const title = (m[3] || '').replace(/\t/g, ' ');
      if (!title) return null;
      return { id, process, title, width: 0, height: 0 };
    })
    .filter(Boolean);
}

/**
 * 按平台分派枚举当前打开窗口,deps 可注入 execFileFn / platform(测试用)。
 * platform 注入供 captureScreen 透传注入的平台(截图与枚举走同一平台),默认 process.platform。
 * 平台不支持时抛错。
 */
export async function listWindows(deps = {}) {
  const execFileFn = deps.execFileFn ?? execFileP;
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') return listWindowsWin32({ execFileFn });
  if (platform === 'darwin') return listWindowsMac({ execFileFn });
  if (platform === 'linux') return listWindowsLinux({ execFileFn });
  throw new Error(`暂不支持在当前平台(${platform})枚举窗口`);
}

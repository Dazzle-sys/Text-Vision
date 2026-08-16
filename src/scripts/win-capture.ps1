
$ErrorActionPreference = 'Stop';
Add-Type -AssemblyName System.Drawing;
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
# 网格抽样骨架:按尺寸等分 24x24 网格逐点抽样,命中谓词立即返回 $true(提前短路),否则遍历完返回 $false。
# 步长按尺寸等分,GetPixel 次数 ~576 次,不随窗口大小膨胀。两个判定(全透明/同色)共用本骨架,避免重复采样循环。
function Test-Grid($bmp, [scriptblock]$hit) {
  $sx = [Math]::Max(1, [int]($bmp.Width / 24)); $sy = [Math]::Max(1, [int]($bmp.Height / 24));
  for ($y = 0; $y -lt $bmp.Height; $y += $sy) {
    for ($x = 0; $x -lt $bmp.Width; $x += $sx) {
      if (& $hit $x $y) { return $true }
    }
  }
  return $false;
}
# 整图全透明判断(所有采样点 A 通道为 0):PrintWindow 失败/未渲染的位图保持初始全透明
# (Format32bppArgb 默认全 0)。与"整图同色"的区别:只认全透明而非纯色,合法的纯黑/纯白窗口
# (黑底终端、白底画布)不会被误判为渲染失败而降级丢弃。必须在保存 JPEG 前判断(JPEG 无 alpha,
# 全透明会编码成纯黑,判断失效)。已知取舍:个别 GPU 窗口 PrintWindow 返回 ok 但输出不透明纯黑,
# 与"合法黑窗口"无法区分,会放行(用户看到黑屏可自行判断),这是刻意信任 PrintWindow 返回值的权衡。
function Test-Transparent($bmp) { return -not (Test-Grid $bmp { param($x,$y) $bmp.GetPixel($x,$y).A -gt 0 }) }
# 整图同色判断:仅用于区域截图(CopyFromScreen)路径,截到空桌面/遮挡层时颜色恰为 1。
# 用"出现第 2 种颜色"即判非空白,避免误伤黑底白字/白底黑字等双色正常窗口。
function Test-Blank($bmp) {
  $colors = @{};
  return -not (Test-Grid $bmp { param($x,$y) $colors[$bmp.GetPixel($x,$y).ToArgb()] = $true; $colors.Count -ge 2 })
}
# 保存为 JPEG(质量85):4K 多屏截屏 PNG 常超 maxImageMB(10MB),JPEG 可降到几 MB,视觉描述无损影响
function Save-Jpeg($bmp) {
  $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' };
  $params = New-Object System.Drawing.Imaging.EncoderParameters(1);
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 85L);
  $bmp.Save($out, $enc, $params);
}
# 统一的"保存位图":直接存 JPEG。返回 $true/$false。
# 调用方需确保传入位图在本函数返回后不再使用(本函数负责 Dispose)。
function Save-Shot($bmp) {
  try { Save-Jpeg $bmp; $bmp.Dispose(); return $true }
  catch { try { $bmp.Dispose() } catch { /* 已释放则忽略 */ }; Write-Note '保存截图失败'; return $false }
}
# 对窗口执行一次 PrintWindow(PW_RENDERFULLCONTENT=2):能取到被遮挡窗口本体,含多数 GPU 渲染应用。
# PrintWindow 返回 $ok 即信任渲染成功(除非全透明)——刻意权衡(见 Test-Transparent 注释)。
# 成功返回 $true;失败返回 $false,由调用方决定降级(延时重试/区域截图)。
function Invoke-PrintWindowSave($h, $w, $hh) {
  $bmp = New-Object System.Drawing.Bitmap $w, $hh;
  $g = [System.Drawing.Graphics]::FromImage($bmp);
  $hdc = $g.GetHdc();
  $ok = $false;
  try { $ok = [Win32]::PrintWindow($h, $hdc, 2) }
  finally { $g.ReleaseHdc($hdc) }
  if ($ok -and -not (Test-Transparent $bmp)) {
    $g.Dispose();
    return (Save-Shot $bmp);
  }
  $g.Dispose(); $bmp.Dispose();
  return $false;
}
$h = [IntPtr][long]$env:TEXT_VISION_HWND;
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
            $copyOk = $false;
            try { $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size); $copyOk = $true }
            catch { Write-Note '窗口区域截图失败(屏幕捕获可能被禁止)' }
            $g.Dispose();
            if ($copyOk) {
              if (Test-Blank $bmp) { $bmp.Dispose(); Write-Note '窗口区域截图也失败' }
              elseif (Save-Shot $bmp) { $savedWindow = $true }
              else { Write-Note '窗口区域截图保存失败' }
            } else { $bmp.Dispose() }
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
# 指定窗口截图全程失败:无有效产物,exit 1(带已累积的降级原因)。不再回退全屏。
if (-not $savedWindow) {
  if ($script:noteParts.Count -eq 0) { Write-Note '窗口截图失败,未产出有效图像' }
  Flush-Note; exit 1
}
Flush-Note; Write-Output $out;

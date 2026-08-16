
$ErrorActionPreference = 'Stop';
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; using System.Diagnostics;
public class WinEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeout")] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeout")] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, StringBuilder lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
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
      string title = sb.ToString().Replace("\t", " ").Replace("\r", " ").Replace("\n", " ");
      if (string.IsNullOrWhiteSpace(title)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      string proc = "";
      try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { }
      // 第 5 段 pid:供 list_windows 展示与"按 PID 精确定位"的 target 选择依据
      items.Add(h.ToInt64() + "\t" + proc + "\t" + title + "\t" + (IsIconic(h) ? "1" : "0") + "\t" + pid);
      return true;
    }, IntPtr.Zero);
    return items.ToArray();
  }
}';
$items = [WinEnum]::Enumerate();
if ($items.Count -eq 0) { '[]' } else { $items | ConvertTo-Json -Compress }

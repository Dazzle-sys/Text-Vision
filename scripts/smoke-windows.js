// Windows 真机冒烟(供 CI 的 windows job 使用):真机执行一次窗口枚举。
// 目的:真机验证 src/scripts/win-enum.ps1 能被 PowerShell 正确执行(语法/API 调用),
// 把"平台回归"从手工 test:capture 提升为自动门禁。
// 退出语义:
//   - 枚举命令本身抛错(脚本语法错/API 调用失败)→ exit 1,CI 失败
//   - 枚举到 0 个窗口 → 打印警告并 exit 0:GitHub Actions 的 Windows runner 常无交互式桌面
//     (以服务会话运行),枚举不到普通窗口是环境限制而非脚本问题,不判失败
//   - 枚举到 ≥1 个窗口 → exit 0
import { listWindows } from '../src/list-windows.js';

try {
  const windows = await listWindows();
  console.log(`[smoke-windows] 枚举成功,共 ${windows.length} 个窗口。`);
  if (windows.length === 0) {
    // runner 无交互桌面(服务会话)时枚举可能为 0,这是环境限制不是脚本故障
    console.log('[smoke-windows] 警告:枚举到 0 个窗口(可能因 runner 无交互式桌面会话)。脚本本身执行成功。');
    process.exit(0);
  }
  const sample = windows.slice(0, 3).map(w => `"${w.title || '(无标题)'}" (${w.process}, PID ${w.pid})`).join('; ');
  console.log(`[smoke-windows] 示例窗口:${sample}`);
} catch (err) {
  // 脚本语法/执行错误会走到这里(而非 0 窗口分支),这是真正的回归,CI 必须失败
  console.error(`[smoke-windows] 窗口枚举执行失败(可能是 win-enum.ps1 回归): ${err?.message ?? err}`);
  process.exit(1);
}

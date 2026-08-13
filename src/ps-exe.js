// PowerShell 可执行文件解析:截屏与窗口枚举共用同一份,避免两侧各自硬编码 powershell.exe
// 导致"截屏用 pwsh、枚举却找不到 exe"的行为分裂。
//
// 行为:优先用 VISION_POWERSHELL 显式指定;未指定时探测 PowerShell Core 的默认安装路径
// (Program Files\PowerShell\7\pwsh.exe),存在则用它,否则回退 Windows 自带 powershell.exe。
// 只装其一(仅 pwsh / 仅 5.x)的环境写死任一都会 ENOENT;只看默认安装路径、不走 PATH 探测,
// 避免 spawn 对 PATH 解析的不确定性。env 可注入(fake env),便于测试。
import { join } from 'node:path';
import { statSync } from 'node:fs';

export function resolvePsExe(env = process.env) {
  const explicit = (env.VISION_POWERSHELL || '').trim();
  if (explicit) return explicit;
  const pwshPath = join(env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  try { if (statSync(pwshPath).isFile()) return pwshPath; } catch { /* 未安装,回退 */ }
  return 'powershell.exe';
}

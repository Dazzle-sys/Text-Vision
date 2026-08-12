// 判断当前模块是否被直接运行(而非被 import),MCP server 与 hook 共用,
// 保证两处"仅直接运行时才执行 main/connect"的判定逻辑只有一份。
//
// 注意:import.meta.url 必须由调用方传入——它在该共享模块内部求值时会指向本文件,
// 而不是调用方的入口脚本(否则 node src/index.js / node hooks/*.js 永远判定为"非直接运行",
// 导致 server 不 connect、hook 不执行 main)。
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 判断当前模块是否被直接运行(而非被 import)。
 * 路径比较:Linux 区分大小写必须严格比较;Windows/macOS 默认大小写不敏感,统一转小写避免误判。
 * 先用 realpath 解析符号链接(避免通过软链启动时 argv[1] 与 import.meta.url 因真实路径不同而误判),
 * 解析失败(路径不存在等)时回退到 resolve 后的原始路径。
 * platform 可注入(测试用),默认取 process.platform。
 */
export function isDirectRun(entryUrl, platform = process.platform) {
  if (!process.argv[1] || !entryUrl) return false;
  const canon = p => { try { return realpathSync(p); } catch { return p; } };
  const entry = canon(fileURLToPath(entryUrl));
  const argv = canon(resolve(process.argv[1]));
  return platform === 'linux' ? argv === entry : argv.toLowerCase() === entry.toLowerCase();
}

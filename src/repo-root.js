// 定位 text-vision 仓库根目录:截图与日志的默认落盘位置。
// 不用 process.cwd()(启动目录)——MCP server 可能在任意目录被拉起,部署到哪都可能;
// 用 import.meta.url 推导:本模块在 src/ 下,父目录即仓库根。这样无论从哪启动、
// 哪个用户调用,截图/日志都落在他们本地那份 text-vision 仓库里(其他克隆仓库的用户也落到各自的仓库)。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根绝对路径(src/ 的上一级)。模块顶层求值,import.meta.url 指向本文件,稳定。
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 仓库内用于存放截图/日志的目录(repoRoot/.text-vision)。 */
export function visionDir() {
  return join(repoRoot, '.text-vision');
}

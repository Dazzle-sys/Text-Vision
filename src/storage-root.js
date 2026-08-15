// 存储根(log.txt 与 screenshots 的公共父目录)解析与探测:
// 默认仓库根下 .text-vision(见 repo-root.js 的 visionDir);仓库不可写(只读安装/全局目录,如
// 全局 npm / Program Files)时,首次使用探针探测后自动回退用户主目录 ~/.text-vision。
// 判定结果进程内缓存:仓库只读与否在启动后一般不变,无需每次写入都重新探测。
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { visionDir } from './repo-root.js';
import { debugLog } from './debug.js';

let cachedRoot = null;        // 探测结果缓存:null = 未探测
let repoProbeOverride = null; // 测试注入:替换仓库候选目录,避免探针写真实仓库
let homeProbeOverride = null; // 测试注入:替换回退用的用户目录,避免测试写真实 home
let fallbackReason = null;    // 回退说明文案(null = 未回退;非 null 供 log.js 补写 storage_fallback 行)

function probeFilePath(baseDir) {
  // 随机名:多进程并发(每客户端一个 server 进程)时互不干扰;清理失败也只留罕见残留
  return join(baseDir, `.tv-probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
}

/**
 * 解析并返回存储根(base 目录,其下有 log.txt 与 screenshots/)。首次调用时探测仓库可写性:
 * 在仓库 .text-vision 创建目录并写入探针文件,成功→仓库模式;任何抛错(权限 EACCES/EROFS、
 * 祖先路径被文件占位 ENOTDIR 等)→回退用户目录 ~/.text-vision(尽力 mkdir,失败仍返回该路径,
 * 后续写失败交给 log 静默 / 截屏报错)。判定结果缓存。
 */
export function resolveStorageRoot() {
  if (cachedRoot !== null) return cachedRoot;
  const repoBase = repoProbeOverride ?? visionDir();
  const probePath = probeFilePath(repoBase);
  try {
    mkdirSync(repoBase, { recursive: true });
    writeFileSync(probePath, '', 'utf8');
  } catch {
    // 仓库不可写 → 回退用户目录;用户目录 mkdir 也失败则仍返回该路径,写失败交给调用方静默/报错
    const homeBase = homeProbeOverride ?? join(homedir(), '.text-vision');
    fallbackReason = `仓库存储不可写(${repoBase}),日志与截图回退用户目录 ${homeBase}`;
    debugLog(fallbackReason);
    try { mkdirSync(homeBase, { recursive: true }); } catch { /* 尽力而为 */ }
    cachedRoot = homeBase;
    return homeBase;
  }
  // 写入成功即判定仓库可写。unlink 独立 try/catch:失败(文件被占/杀软瞬时锁)只留一个
  // gitignored 的 .tv-probe-* 残留(不受 pruneShots/轮转影响),绝不能让清理失败误判成回退
  try { unlinkSync(probePath); } catch { /* 忽略 */ }
  cachedRoot = repoBase;
  return repoBase;
}

/** 回退说明文案(仓库不可写时非 null,含仓库候选与回退到的用户目录),供 log.js 首次写日志时补一条 [storage_fallback] 行。 */
export function storageFallbackReason() {
  return fallbackReason;
}

/** 测试注入:直接指定存储根(跳过探测)。 */
export function setStorageRootForTest(root) { cachedRoot = root; }

/** 测试注入:让探针指向指定仓库候选目录并清缓存(下次 resolve 重新探测)。 */
export function setRepoProbeForTest(dir) { repoProbeOverride = dir; cachedRoot = null; }

/** 测试注入:指定回退用的用户目录并清缓存。 */
export function setHomeProbeForTest(dir) { homeProbeOverride = dir; cachedRoot = null; }

/** 测试清理:清空缓存与全部注入,恢复默认(同文件内用例共享模块实例,必须对称清理)。 */
export function resetStorageRootForTest() {
  cachedRoot = null;
  repoProbeOverride = null;
  homeProbeOverride = null;
  fallbackReason = null;
}

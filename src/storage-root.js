// 存储根(log.txt 与 screenshots 的公共父目录)解析与探测:
// 默认仓库根下 .text-vision(见 repo-root.js 的 visionDir);仓库不可写(只读安装/全局目录,如
// 全局 npm / Program Files)时,首次使用探针探测后自动回退用户主目录 ~/.text-vision。
// 显式设置 VISION_STORAGE_ROOT 时优先:用户明确指定存储根(log 落 ${root}/log.txt、截图落 ${root}/screenshots),
// 跳过探测(显式配置即意图,无需再判断仓库可写性;目录尽力 mkdir)。
// 判定结果进程内缓存:仓库只读与否/显式根在启动后一般不变,无需每次写入都重新探测。
import { mkdirSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
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
 * 清理目录下残留的 .tv-probe-* 探针文件(unlink 失败/进程被硬杀时可能留下)。
 * 幂等静默:目录不存在/读失败/单个删除失败都忽略;只删探针前缀文件,绝不碰业务文件。
 * 随机名 + 探针生命周期极短,并发进程在途的探针被误删的窗口极小(后果仅是对方探测重试),可接受。
 */
function cleanupProbeFiles(baseDir) {
  let names;
  try { names = readdirSync(baseDir); } catch { return; }
  for (const name of names) {
    if (name.startsWith('.tv-probe-')) {
      try { unlinkSync(join(baseDir, name)); } catch { /* 并发删除/已删则忽略 */ }
    }
  }
}

/**
 * 解析并返回存储根(base 目录,其下有 log.txt 与 screenshots/)。
 * env 可注入(fake env,与 logFilePath/defaultShotsDir 同模式),缺省读全局 process.env。
 * 显式 VISION_STORAGE_ROOT:直接 mkdir 并使用(跳过探测),语义=用户意图,日志/截图统一落其下。
 * 否则首次调用时探测仓库可写性:在仓库 .text-vision 创建目录并写入探针文件,成功→仓库模式;
 * 任何抛错(权限 EACCES/EROFS、祖先路径被文件占位 ENOTDIR 等)→回退用户目录 ~/.text-vision
 * (尽力 mkdir,失败仍返回该路径,后续写失败交给 log 静默 / 截屏报错)。判定结果缓存。
 */
export function resolveStorageRoot(env = process.env) {
  if (cachedRoot !== null) return cachedRoot;
  const explicit = (env.VISION_STORAGE_ROOT || '').trim();
  if (explicit) {
    // 显式根:用户意图优先,不探测、不设置回退文案;目录尽力创建(失败仍返回路径,写失败交给调用方)
    debugLog(`存储根使用显式配置 ${explicit}`);
    try { mkdirSync(explicit, { recursive: true }); } catch { /* 尽力而为 */ }
    cleanupProbeFiles(explicit);
    cachedRoot = explicit;
    return explicit;
  }
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
  // gitignored 的 .tv-probe-* 残留;顺手清理本目录历史残留,避免无限累积。
  try { unlinkSync(probePath); } catch { /* 忽略 */ }
  cleanupProbeFiles(repoBase);
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

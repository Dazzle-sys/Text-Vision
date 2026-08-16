// 统一日志出口:stderr 调试日志(DEBUG_VISION=1 门控)+ 落盘日志文件(VISION_LOG_FILE 可配置路径)。
// MCP server 走 stdio,stdout 是协议通道,调试日志只能走 stderr;降级/异常原因再追加写入日志文件,
// 方便"指定窗口截图失败/降级原因"这类问题事后排查。日志写入失败一律静默,不拖垮截图主流程。
// isDebug/debugLog 复用 debug.js(独立模块,避免与 storage-root.js 循环依赖,详见 debug.js 顶部注释)。
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { resolveStorageRoot, storageFallbackReason } from './storage-root.js';
export { isDebug, debugLog } from './debug.js';

/** 日志文件超过该字节数即轮转:旧日志改名 .1,新日志从空文件重新写,避免长期会话无限膨胀。 */
const MAX_LOG_BYTES = 1024 * 1024;

/** 是否把"成功"的视觉调用写入日志文件(VISION_LOG_SUCCESS:默认开,设 0/false 关闭;失败日志不受此开关影响)。
 * 判定:先 trim 首尾空白再比较(避免配置里尾随空格/.env CRLF 让 '0' 静默失效);大小写仍敏感('FALSE' 视为开启),
 * 想关闭请准确填 0 或 false。与 DEBUG_VISION 的精确白名单(仅 1/true)语义相反,是有意区分。
 * env 可注入(fake env),与 logFilePath/appendLog 保持一致,便于测试。 */
export function isSuccessLog(env = process.env) {
  const v = (env.VISION_LOG_SUCCESS || '').trim();
  return v !== '0' && v !== 'false';
}

/**
 * 日志文件路径:VISION_LOG_FILE 配置则用它,否则默认存储根下的 log.txt——存储根由 resolveStorageRoot 解析:
 * 显式 VISION_STORAGE_ROOT 优先(直接用它);否则仓库可写时即仓库根 .text-vision(不随启动目录变,
 * 谁调用都落在各自仓库),仓库只读安装时自动回退用户主目录 ~/.text-vision。
 * env 可注入(fake env),便于测试。
 */
export function logFilePath(env = process.env) {
  return (env.VISION_LOG_FILE || '').trim() || join(resolveStorageRoot(env), 'log.txt');
}

/**
 * 日志文件超过上限时改名 .1(覆盖上一份 .1,只留最近一份旧档),新日志接着从空文件写。
 * stat/rename 失败一律静默(文件不存在、只读、被占用都不该让轮转失败连累本次日志写入)。
 * 返回是否真的发生了轮转(供 append 失败时回滚)。
 */
function maybeRotateLog(p) {
  try {
    if (statSync(p).size >= MAX_LOG_BYTES) {
      renameSync(p, `${p}.1`);
      return true;
    }
  } catch { /* 静默 */ }
  return false;
}

// 轮转后 append 失败(磁盘满/权限突变)时把 .1 回滚回原文件,避免"旧日志已改名、新日志没写进"两头丢
function rollbackLog(p, rotated) {
  if (!rotated) return;
  try { renameSync(`${p}.1`, p); } catch { /* 尽力而为,失败静默 */ }
}

// 仓库只读回退用户目录时,首次写日志补一条 [storage_fallback] 说明(仅一次),让看日志的人知道文件实际落在哪。
// 失败静默:说明只是排障线索,补写失败不影响主日志写入。
let fallbackNoteWritten = false;
function ensureFallbackNote(p) {
  if (fallbackNoteWritten) return;
  const reason = storageFallbackReason();
  if (!reason) return;
  fallbackNoteWritten = true;
  const line = `${new Date().toISOString()} [storage_fallback] ${reason}\n`;
  try { appendFileSync(p, line, 'utf8'); } catch { /* 静默 */ }
}

/**
 * 追加一行日志:`ISO时间 [事件类型] 详情`。目录不存在自动创建;写失败静默(日志失败不能影响主流程)。
 * 文件超过 MAX_LOG_BYTES(1MB)时先轮转(旧日志改名 .1 保留,新日志重新写);轮转后若写入失败则回滚保留旧日志。
 * env 可注入(fake env),便于测试。调用方负责传入排查用的原始 detail(运行时路径无需脱敏)。
 * 注意:MCP server 与 hook 是独立进程,可能并发写同一个日志文件。单行 appendFileSync 写入原子、不会交错;
 * 但 1MB 轮转(stat+rename)跨进程存在极小竞态(两进程同时检测超限、rename 互相干扰),丢一行日志属可接受
 * 的工程权衡,别当作 bug 排查——如需彻底串行,应改成单进程内持文件句柄的顺序写。
 */
export function appendLog(event, detail, env = process.env) {
  const p = logFilePath(env);
  const line = `${new Date().toISOString()} [${event}] ${detail}\n`;
  let rotated = false;
  try {
    rotated = maybeRotateLog(p);
    appendFileSync(p, line, 'utf8');
    ensureFallbackNote(p); // 主日志写入成功(目录已存在)后再补回退说明,避免 ENOENT
  } catch (err) {
    // ENOENT = 目录不存在(用户把 VISION_LOG_FILE 指到深层不存在的目录),补建目录后重试一次
    if (err.code === 'ENOENT') {
      try { mkdirSync(dirname(p), { recursive: true }); rotated = maybeRotateLog(p); appendFileSync(p, line, 'utf8'); ensureFallbackNote(p); return; } catch { /* 静默 */ }
    }
    // 其它写失败(权限/磁盘满/路径指向目录)同样静默;若刚轮转过,回滚保留旧日志,不让本轮失败连累已有记录
    rollbackLog(p, rotated);
  }
}

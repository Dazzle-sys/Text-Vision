// 统一日志出口:stderr 调试日志(DEBUG_VISION=1 门控)+ 落盘日志文件(VISION_LOG_FILE 可配置路径)。
// MCP server 走 stdio,stdout 是协议通道,调试日志只能走 stderr;降级/异常原因再追加写入日志文件,
// 方便"指定窗口失败为何回退全屏"这类问题事后排查。日志写入失败一律静默,不拖垮截图主流程。
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { visionDir } from './repo-root.js';

/** 日志文件超过该字节数即轮转:旧日志改名 .1,新日志从空文件重新写,避免长期会话无限膨胀。 */
const MAX_LOG_BYTES = 1024 * 1024;

/** 是否开启调试日志(DEBUG_VISION=1/true)。 */
export function isDebug() {
  const v = process.env.DEBUG_VISION;
  return v === '1' || v === 'true';
}

/** 调试日志:只在 DEBUG_VISION=1 时打印到 stderr(不影响 MCP stdout 协议)。 */
export function debugLog(...args) {
  if (isDebug()) console.error('[text-vision]', ...args);
}

/** 是否把"成功"的视觉调用写入日志文件(VISION_LOG_SUCCESS:默认开,0/false 关闭;失败日志不受此开关影响)。
 * env 可注入(fake env),与 logFilePath/appendLog 保持一致,便于测试。 */
export function isSuccessLog(env = process.env) {
  const v = env.VISION_LOG_SUCCESS;
  return v !== '0' && v !== 'false';
}

/**
 * 日志文件路径:VISION_LOG_FILE 配置则用它,否则默认 text-vision 仓库根下的 .text-vision/log.txt
 * (用模块路径定位仓库根,不随启动目录变;部署到哪、谁调用都落在各自仓库,方便查看)。
 * env 可注入(fake env),便于测试。
 */
export function logFilePath(env = process.env) {
  return (env.VISION_LOG_FILE || '').trim() || join(visionDir(), 'log.txt');
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
  } catch (err) {
    // ENOENT = 目录不存在(用户把 VISION_LOG_FILE 指到深层不存在的目录),补建目录后重试一次
    if (err.code === 'ENOENT') {
      try { mkdirSync(dirname(p), { recursive: true }); rotated = maybeRotateLog(p); appendFileSync(p, line, 'utf8'); return; } catch { /* 静默 */ }
    }
    // 其它写失败(权限/磁盘满/路径指向目录)同样静默;若刚轮转过,回滚保留旧日志,不让本轮失败连累已有记录
    rollbackLog(p, rotated);
  }
}

// 共享测试基础设施:mock fetch、响应构造、临时目录管理。
// 多个测试文件(vision/hook/paste-hook/capture 等)各自复制过这些片段,抽到这里消除重复。
// 注意:本文件不注册 test(),只被各测试文件 import,不会被 node --test 当测试执行。
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** 测试启动时的原始全局 fetch,供各文件 afterEach 兜底恢复。 */
export const REAL_FETCH = globalThis.fetch;

/** 成功响应构造:content 为模型返回的文本。 */
export const okRes = text => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) });

/** 错误响应构造:status + 响应体文本(text 通道,非 JSON)。 */
export const errRes = (status, bodyText) => ({ ok: false, status, text: async () => bodyText });

/** 替换全局 fetch 并记录每次调用的 url/opts;用返回对象的 restore() 恢复。 */
export function stubFetch(handler) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return handler(url, opts); };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

/** 创建一次性临时目录(测试用,前缀区分来源),afterEach 里用返回的 rm() 清理。 */
export function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, rm: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } } };
}

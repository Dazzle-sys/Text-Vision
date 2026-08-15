// 调试日志门控:DEBUG_VISION=1/true 时打印到 stderr(不影响 MCP stdout 协议)。
// 独立成模块的原因:storage-root.js 在"仓库只读回退用户目录"时也要打调试提示,
// 若放在 log.js 会形成 log.js ⇄ storage-root.js 循环依赖;抽离后双方都依赖本模块,无环。
export function isDebug() {
  const v = process.env.DEBUG_VISION;
  return v === '1' || v === 'true';
}

export function debugLog(...args) {
  if (isDebug()) console.error('[text-vision]', ...args);
}

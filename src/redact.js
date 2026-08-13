// 本地路径脱敏:把字符串里的本机绝对路径替换成占位符。
// 用途:错误消息里的路径替换防刷屏——execFile 报错会回显完整命令行(含 /tmp、盘符等路径),
// 透传给 MCP 客户端会暴露本机目录结构(含用户名),且占满错误信息。错误/日志用,正常返回文本不脱敏。
// 两个路径正则同时被 scripts/check-doc-paths.js 复用(文档路径检查),导出同一份避免双源漂移。
// 无 g 标志(判断用);redactLocalPath 内部用 split/join 全量替换。
//
//  1. Windows 盘符路径(C:\Users\... 或 C:/Users/...)。负向前瞻排除 :// 的 URL scheme 段
//     (如 https:// 的 "s://"),否则脱敏会把 URL 撕裂成 http[本地路径],破坏诊断信息
//  2. Unix 绝对路径(/usr /home /tmp 等常见根目录词开头)。限定常见根目录词,避免把中文句子里
//     用斜杠分隔的词(429/408/500、工具注册/schema/端到端)误当路径
//  3. execFile 的 "Command failed: <cmd> <args>" 首行:只留命令名,参数里的路径随之消失
//     (先于通用替换处理,参数里的路径连同命令本身一起被截断,更干净)
export const WIN_PATH_RE = /[A-Za-z]:[\\/](?![\\/])[^\s"'()]*/;
export const UNIX_PATH_RE = /(?<!:)\/(?:usr|home|etc|var|opt|tmp|mnt|root|dev|run|bin|sbin|lib|srv|media)(?:\/[^\s"'()]*)?/;
const COMMAND_FAILED_RE = /Command failed: (\S+).*/g;

// 无 g 的正则不能全量替换,split/join 等价于 replaceAll(正则无捕获组,分割安全)
export function redactLocalPath(s) {
  return String(s)
    .replace(COMMAND_FAILED_RE, 'Command failed: $1')
    .split(WIN_PATH_RE).join('[本地路径]')
    .split(UNIX_PATH_RE).join('[本地路径]');
}

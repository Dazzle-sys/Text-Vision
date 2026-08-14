// 本地路径脱敏:把字符串里的本机绝对路径替换成占位符。
// 用途:错误消息里的路径替换防刷屏——execFile 报错会回显完整命令行(含 /tmp、盘符等路径),
// 透传给 MCP 客户端会暴露本机目录结构(含用户名),且占满错误信息。错误/日志用,正常返回文本不脱敏。
// 两个路径正则同时被 scripts/check-doc-paths.js 复用(文档路径检查),导出同一份避免双源漂移。
// 路径正则无 g 标志(判断用);redactLocalPath 内部用 split/join 全量替换。
// 例外:COMMAND_FAILED_RE 带 g 标志、用 .replace()(只替换首个"Command failed: 命令名",参数随首行一起被截断)。
//
//  1. Windows 盘符路径(C:\Users\... 或 C:/Users/...)。负向前瞻排除 :// 的 URL scheme 段
//     (如 https:// 的 "s://"),否则脱敏会把 URL 撕裂成 http[本地路径],破坏诊断信息
//  2. Unix 绝对路径(常见根目录词开头)。限定常见根目录词,避免把中文句子里用斜杠分隔的词
//     (429/408/500、工具注册/schema/端到端)误当路径。大小写敏感:macOS 主目录是 /Users、
//     系统库是 /Library(与 Linux 的 /usr /home 同属真实路径形态),因此同时收录大小写两种。
//  3. execFile 的 "Command failed: <cmd> <args>" 首行:只留命令名,参数里的路径随之消失
//     (先于通用替换处理,参数里的路径连同命令本身一起被截断,更干净)
export const WIN_PATH_RE = /[A-Za-z]:[\\/](?![\\/])[^\s"'()]*/;
export const UNIX_PATH_RE = /(?<!:)\/(?:bin|data|dev|etc|home|lib|Library|media|mnt|opt|root|run|sbin|srv|tmp|usr|var|Users)(?:\/[^\s"'()]*)?/;
const COMMAND_FAILED_RE = /Command failed: (\S+).*/g;

// URL 前置保护:UNIX_PATH_RE 的 (?<!:) 只能挡 scheme 后紧跟的 ://(https:// 的 "://"),
// 挡不住主机名之后的路径段——https://host/tmp/... 中 /tmp 前是 host 字符不是 :,
// 会被词表命中、把 URL 撕裂成 http[本地路径]。这里先整体提走 URL(https?:// 到空白/引号/括号),
// 用 NUL 包裹的占位 token 代替,路径脱敏后再原样还原,URL 从此不受任何路径正则影响。
const URL_RE = /https?:\/\/[^\s"'()<>]+/g;
const URL_TOKEN_RE = /\u0000TVURL(\d+)\u0000/g;

// 无 g 的正则不能全量替换,split/join 等价于 replaceAll(正则无捕获组,分割安全)
export function redactLocalPath(s) {
  const urls = [];
  const protectedStr = String(s).replace(URL_RE, m => {
    const i = urls.length;
    urls.push(m);
    return `\u0000TVURL${i}\u0000`; // NUL 不出现在正常文本,路径正则的字符类也不含 NUL,不会被误匹配
  });
  return protectedStr
    .replace(COMMAND_FAILED_RE, 'Command failed: $1')
    .split(WIN_PATH_RE).join('[本地路径]')
    .split(UNIX_PATH_RE).join('[本地路径]')
    .replace(URL_TOKEN_RE, (_, i) => urls[Number(i)] ?? '');
}

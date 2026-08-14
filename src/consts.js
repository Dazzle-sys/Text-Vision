// 命令超时默认值:窗口枚举与截屏跨模块共用,避免各模块各自定义、改一处忘改另一处导致静默分叉。
// 常规 30s:Windows/Linux 的窗口枚举、Linux/macOS 的截图命令。
// 放宽 60s:macOS 枚举(swift 首启编译有 1~2s 延迟)与 Windows 截图(PowerShell 冷启动 + 多次 Add-Type C#
// 编译 + 大屏 CopyFromScreen + JPEG 编码,慢/高负载机器可能超过 30s)统一放宽,避免误杀合法命令。
export const CMD_TIMEOUT = 30000;
export const SLOW_TIMEOUT = 60000;

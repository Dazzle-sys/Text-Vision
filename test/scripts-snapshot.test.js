// 平台脚本内容哨兵回归测试:直接读取 src/scripts/ 下的独立脚本文件,断言关键符号仍在。
// 脚本以文件形式存在后,若未来有人删掉某段核心逻辑(如最小化恢复、遮挡守卫、超时保护),
// 编译/语法层面无感知,只能靠内容断言兜底——与 capture.test.js 对 WIN_PS 的字符串守卫互补。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'scripts');
const read = f => readFileSync(join(scriptsDir, f), 'utf8');

// ---------------------------------------------------------------------------
// win-capture.ps1:指定窗口截屏(最小化恢复 / 遮挡守卫)
// ---------------------------------------------------------------------------
test('win-capture.ps1:关键符号(最小化恢复/遮挡守卫/失败退出)', () => {
  const ps = read('win-capture.ps1');
  for (const symbol of [
    'SetProcessDPIAware',       // 进程 DPI 感知,高分屏按物理像素
    'SetWindowPos',             // 移出虚拟屏 / 还原原位置
    'ShowWindow($h, 4)',        // SW_SHOWNOACTIVATE:恢复最小化但不抢焦点
    'ShowWindow($h, 6)',        // SW_MINIMIZE:截完还原最小化
    'DwmFlush',                 // 等 DWM 合成
    'IsWindow',                 // finally 还原失败守卫
    'WindowFromPoint',          // 遮挡守卫
    'IsSelfOrDescendant',       // 遮挡守卫:命中目标窗口自身
    '$cxPts',                   // 遮挡守卫:多点网格采样
    '-32000',                   // 屏幕外坐标
    '$origRect',                // 记录最小化窗口原始还原位置
    'Test-Transparent',         // 纯色窗口误判修复:只认全透明
    'exit 1'                    // 全程失败退出(不再回退全屏)
  ]) {
    assert.ok(ps.includes(symbol), `win-capture.ps1 应包含 "${symbol}"`);
  }
});

// ---------------------------------------------------------------------------
// win-enum.ps1:窗口枚举(超时保护 / 标题读取)
// ---------------------------------------------------------------------------
test('win-enum.ps1:关键符号(枚举/超时保护/标题/最小化标记)', () => {
  const ps = read('win-enum.ps1');
  for (const symbol of [
    'EnumWindows',           // 顶层窗口枚举
    'IsWindowVisible',       // 只列可见窗口
    'SendMessageTimeout',    // 无响应进程防卡死
    '0x000E',                // WM_GETTEXTLENGTH
    '0x000D',                // WM_GETTEXT
    'IsIconic',              // 最小化标记
    'ConvertTo-Json',        // 输出 JSON
    '2000'                   // SMTO_ABORTIFHUNG 超时
  ]) {
    assert.ok(ps.includes(symbol), `win-enum.ps1 应包含 "${symbol}"`);
  }
});

// ---------------------------------------------------------------------------
// win-compress.ps1:大图压缩
// ---------------------------------------------------------------------------
test('win-compress.ps1:关键符号(缩放/质量/编码器)', () => {
  const ps = read('win-compress.ps1');
  for (const symbol of [
    'System.Drawing',                    // GDI+ 图像处理
    'HighQualityBicubic',                // 高质量缩放插值
    'EncoderParameter',                  // JPEG 质量参数
    'Quality',                           // 质量键
    'TV_COMPRESS_MAXEDGE',               // 最长边档位(经 env 传入)
    'TV_COMPRESS_OUT',                   // 输出路径(经 env 传入)
    'ImageCodecInfo'                     // JPEG 编码器查找
  ]) {
    assert.ok(ps.includes(symbol), `win-compress.ps1 应包含 "${symbol}"`);
  }
});

// ---------------------------------------------------------------------------
// mac-enum.swift:窗口枚举
// ---------------------------------------------------------------------------
test('mac-enum.swift:关键符号(窗口列表/图层过滤/标题脱tab)', () => {
  const swift = read('mac-enum.swift');
  for (const symbol of [
    'CGWindowListCopyWindowInfo',    // 窗口枚举 API
    'optionOnScreenOnly',            // 只列屏幕上的窗口
    'excludeDesktopElements',        // 排除桌面元素
    'kCGWindowLayer',                // 图层过滤(只取 0 层)
    'kCGWindowOwnerName',            // 进程名
    'replacingOccurrences',          // 标题 tab → 空格
    '\\(num)'                        // Swift 字符串插值(输出 tab 分隔)
  ]) {
    assert.ok(swift.includes(symbol), `mac-enum.swift 应包含 "${symbol}"`);
  }
});

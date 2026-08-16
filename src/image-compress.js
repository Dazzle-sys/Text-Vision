// 大图超限自动压缩:用各平台系统工具把图片转成 JPEG(质量 85),逐步缩小最长边直到字节数低于上限。
// 尽力而为:平台工具缺失/压缩后仍超限 → 返回 null,调用方走原报错路径,不阻断主流程、不引入新依赖。
// 平台工具:macOS sips(系统内置)、Linux ImageMagick convert(需安装,与截屏同一依赖)、
// Windows PowerShell + System.Drawing(零安装,与截屏/枚举同一模式)。
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolvePsExe } from './ps-exe.js';

const execFileP = promisify(execFile);

// 压缩最长边档位:从 4096 逐步减半到 256。JPEG q85 下 2048px 长边通常 1MB 内,256px 兜底极窄场景。
const MAX_EDGE_START = 4096;
const MAX_EDGE_MIN = 256;
// 压缩命令超时:系统工具冷启动 + 大图缩放,放宽(与截屏 SLOW_TIMEOUT 同一量级)
const COMPRESS_TIMEOUT = 60000;

/** 压缩用临时输出路径(系统临时目录,用完即删,不落仓库)。 */
function tempOutPath(edge) {
  return join(tmpdir(), `text-vision-compress-${process.pid}-${edge}-${Math.random().toString(36).slice(2, 6)}.jpeg`);
}

// Windows 压缩脚本:LoadImage → 等比缩放到最长边 → 存 JPEG(质量 85)。
// 参数经环境变量传入(与截屏 WIN_PS 同一模式,避免路径含空格/引号时的转义问题)。
// 脚本从独立文件读取(import.meta.url 定位),获得独立 diff 与 PowerShell 语法检查。
const WIN_COMPRESS_PS = readFileSync(new URL('./scripts/win-compress.ps1', import.meta.url), 'utf8');

function runWinCompress(inPath, outPath, maxEdge, { spawnFn = spawn, psExe, fallbackDelay = 3000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env, TV_COMPRESS_IN: inPath, TV_COMPRESS_OUT: outPath, TV_COMPRESS_MAXEDGE: String(maxEdge) };
    let child;
    try {
      child = spawnFn(psExe ?? resolvePsExe(), ['-NoProfile', '-NonInteractive', '-Command', WIN_COMPRESS_PS], { windowsHide: true, stdio: 'ignore', env });
    } catch (e) { reject(e); return; }
    let err = '';
    let settled = false;
    let killTimer, fallbackTimer;
    const settle = (fn, v) => { if (!settled) { settled = true; clearTimeout(killTimer); clearTimeout(fallbackTimer); fn(v); } };
    killTimer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, COMPRESS_TIMEOUT);
    // kill 后仍可能收不到 close(进程卡死),兜底强制结束,避免压缩挂起拖垮读图
    fallbackTimer = setTimeout(() => settle(reject, new Error(`压缩超时(超过 ${COMPRESS_TIMEOUT}ms 被中止)`)), COMPRESS_TIMEOUT + fallbackDelay);
    child.stderr.on('data', d => { if (err.length < 1024) err += String(d); });
    child.on('error', e => settle(reject, e));
    child.on('close', code => {
      if (code === 0) settle(resolvePromise);
      else settle(reject, new Error(`PowerShell 压缩退出码 ${code}${err ? ': ' + err.slice(0, 200) : ''}`));
    });
  });
}

/** 单档压缩(转 JPEG,最长边 maxEdge)。失败抛错(工具缺失/命令失败)。 */
async function compressOnce(platform, inPath, outPath, maxEdge, deps) {
  const { execFileFn = execFileP } = deps;
  if (platform === 'darwin') {
    await execFileFn('sips', ['-Z', String(maxEdge), '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', inPath, '--out', outPath], { timeout: COMPRESS_TIMEOUT });
  } else if (platform === 'linux') {
    await execFileFn('convert', [inPath, '-resize', `${maxEdge}x${maxEdge}`, '-quality', '85', outPath], { timeout: COMPRESS_TIMEOUT });
  } else if (platform === 'win32') {
    await runWinCompress(inPath, outPath, maxEdge, deps);
  } else {
    throw new Error(`暂不支持在当前平台(${platform})自动压缩图片`);
  }
}

/**
 * 图片字节数超限时尝试自动压缩:转 JPEG 并逐步缩小最长边(4096→256),首次字节数低于 maxBytes 即返回。
 * 返回 { filePath, sizeBytes, mime:'image/jpeg' }(调用方负责用完删除 filePath);失败/不支持返回 null。
 * deps 可注入 execFileFn / spawnFn / psExe / platform(测试用,避免真调系统工具)。
 */
export async function tryCompressImage(filePath, maxBytes, deps = {}) {
  const platform = deps.platform ?? process.platform;
  for (let edge = MAX_EDGE_START; edge >= MAX_EDGE_MIN; edge /= 2) {
    const outPath = tempOutPath(edge);
    try {
      await compressOnce(platform, filePath, outPath, Math.floor(edge), deps);
    } catch {
      // 工具不可用/命令失败:已尽力,放弃压缩(继续换更小档位只会重复失败)
      try { unlinkSync(outPath); } catch { /* 未产出 */ }
      break;
    }
    let size = 0;
    try { size = statSync(outPath).size; } catch { /* 未写出 */ }
    if (size > 0 && size < maxBytes) {
      return { filePath: outPath, sizeBytes: size, mime: 'image/jpeg' };
    }
    // 压缩成功但仍超限:删掉,下一档更小
    try { unlinkSync(outPath); } catch { /* 并发删除 */ }
  }
  return null;
}

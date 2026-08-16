// 跨平台指定窗口截屏:按操作系统分派系统自带命令。平台级函数(captureWindows/captureMac/captureLinux)
// 统一返回 { filePath, note? };主入口 captureScreen 再读文件转 base64,返回 { b64, filePath, sizeBytes, mime, note?, targetLabel? }。
// 只支持指定窗口:captureScreen 必传 target(窗口 ID/进程名/标题),经 list-windows.js 枚举匹配到窗口 id 后截取,
// 失败(未命中/枚举失败/窗口截图失败)一律明确报错,不再回退全屏。
// 截图落盘到存储根 screenshots(默认仓库根 .text-vision,仓库只读安装时回退用户主目录 ~/.text-vision,见 storage-root.js;
// 保留最近 MAX_SHOTS 张),方便查看,不随临时目录清理。
//   win32 → PowerShell + System.Drawing(零安装)
//   darwin → screencapture(内置,零安装)
//   linux → ImageMagick import -window(需安装)
import { spawn, execFile } from 'node:child_process';
import { readFileSync, unlinkSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { promisify } from 'node:util';
import { listWindows, matchWindow } from './list-windows.js';
import { resolvePsExe } from './ps-exe.js';
import { resolveStorageRoot } from './storage-root.js';
import { CMD_TIMEOUT, SLOW_TIMEOUT } from './consts.js';

import { redactLocalPath } from './redact.js';

const execFileP = promisify(execFile);
// Windows 截图超时用放宽档(SLOW_TIMEOUT):PowerShell 冷启动 + 多次 Add-Type C# 编译 + 大屏 CopyFromScreen
// + JPEG 编码在慢/高负载机器上可能超过 30s,避免误杀合法截图(killTimer 兜底仍在,卡死进程最坏等 timeout+fallbackDelay)。

// 截图统一落盘到 shotsRoot(默认存储根下 screenshots,保留最近 MAX_SHOTS 张;存储根由 resolveStorageRoot 解析:
// 仓库可写时即仓库根 .text-vision,仓库只读安装时自动回退用户主目录 ~/.text-vision,见 storage-root.js)。
// 不随系统临时目录清理;目录不存在则创建(目录不可写时 mkdir 抛错由上层错误路径处理)。
const MAX_SHOTS = 20;

/**
 * 默认截图目录:VISION_SHOTS_DIR 配置则用它(仓库装在只读位置时的逃生口,如全局 npm / Program Files,
 * 此时仓库内 mkdir 会 EACCES),否则存储根下 screenshots——存储根由 resolveStorageRoot 解析:
 * 显式 VISION_STORAGE_ROOT 优先(直接用它);否则仓库可写时即仓库根 .text-vision/screenshots,
 * 只读时自动回退用户主目录 ~/.text-vision,不随启动目录变。
 */
export function defaultShotsDir(env = process.env) {
  return (env.VISION_SHOTS_DIR || '').trim() || join(resolveStorageRoot(env), 'screenshots');
}

function makeShotsDir(shotsRoot) {
  mkdirSync(shotsRoot, { recursive: true });
  return shotsRoot;
}

function tempShotPath(shotDir, ext = 'png', prefix = 'shot') {
  return join(shotDir, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}

/** 删除单个截图文件(失败残留清理用)。截图目录是持久目录,不做 rmdir。 */
export function cleanupScreenShot(filePath) {
  try { unlinkSync(filePath); } catch { /* 已删除则忽略 */ }
}

/** 错误消息压缩:只留首行、截断到 200 字符并脱敏本机路径(execFile 报错会回显完整命令行,含路径与换行)。 */
function shortErr(err) {
  return redactLocalPath(err?.message ?? String(err)).split('\n')[0].slice(0, 200);
}

/**
 * 保留截图目录中最近 max 张 shot-* 文件,超出删除最旧(文件名以时间戳开头,字典序即时间序)。
 * 同时回收残留的 note-* 临时文件:note 是"读后即删"的降级原因文件,正常路径(成功读删/失败清理)都已清,
 * 能留下的只有 JS 被硬杀(kill -9/断电)时未走到 close 回调的残留,截图成功后统一回收,避免无限累积。
 * 注:并发截屏且另一进程恰在写 note 的极小窗口内可能误删在途 note(后果仅是降级提示丢失),可接受。
 * 目录不存在/读失败静默。用于"截图保留最近 N 张"策略。
 */
export function pruneShots(shotsDir, max) {
  let files;
  try { files = readdirSync(shotsDir); } catch { return; }
  const shots = files.filter(f => /^shot-/.test(f)).sort();
  const excess = shots.length - max;
  for (let i = 0; i < excess; i++) {
    try { unlinkSync(join(shotsDir, shots[i])); } catch { /* 并发删除/已删则忽略 */ }
  }
  for (const f of files) {
    if (/^note-/.test(f)) {
      try { unlinkSync(join(shotsDir, f)); } catch { /* 并发删除/已删则忽略 */ }
    }
  }
}

/** 删除降级原因 note 文件(与截图同目录,用完即删)。 */
function cleanupNotePath(notePath) {
  try { unlinkSync(notePath); } catch { /* 不存在/已删则忽略 */ }
}

// --- Windows:PowerShell 脚本(独立文件,见 src/scripts/win-capture.ps1,避开执行策略限制) ---
// 只截指定窗口(windowId 必传):最小化窗口先临时恢复到屏幕外再截,截完还原最小化;
// PrintWindow(PW_RENDERFULLCONTENT,能取被遮挡窗口本体,含多数 GPU 渲染应用)→ 非全透明则成功;
// PrintWindow 失败/全透明则延时重试 → 未移出屏幕且未被遮挡时才允许 CopyFromScreen 窗口区域 → 仍失败则 exit 1,
// 降级原因经 TEXT_VISION_NOTE 文件逐级累积,失败时随退出码回传 JS 报错。不再有全屏回退。
// 脚本从独立文件读取(import.meta.url 定位),获得独立 diff 与 PowerShell 语法检查;内容仍以 -Command 传入,
// 保持 spawn 参数形态(args[3] 为脚本全文)不变。转义说明:JS 模板字符串里的 \\( 在 .ps1 里还原为 \(。
const WIN_PS = readFileSync(new URL('./scripts/win-capture.ps1', import.meta.url), 'utf8');

/**
 * 超时强杀后的窗口兜底还原。PS 主脚本的 finally 只在脚本自然退出/抛错时执行;JS 超时 child.kill()
 * 是外部强杀,finally 不会运行,此时"最小化临时恢复 + 移出屏幕"的窗口会卡在屏幕外(-32000)且
 * 非最小化,用户点击任务栏恢复也只能回到屏幕外。兜底:对指定窗口跑一段轻量 PS,仅当它仍存在、
 * 非最小化、且位于屏幕外(SetWindowPos 哨兵坐标附近)时才重新最小化——最小化窗口至少在任务栏有
 * 图标,比"悬在屏幕外"好找回。窗口正常/已最小化/已关闭时不动,不引入副作用。
 * 尽力而为:spawn 失败或超时都静默,最坏回到现状,不拖垮主流程。
 */
function restoreMinimizedFallback(hwnd, exe, { spawnFn = spawn } = {}) {
  // 兜底命令把 hwnd 拼进 PS 模板字符串。windowId 目前来自系统枚举(纯数字句柄),但防御未来来源变化:
  // 只接受纯数字,否则跳过(尽力而为,不做也不拖垮主流程)。
  if (!/^\d+$/.test(String(hwnd))) return;
  const ps = `
$h = [IntPtr][long]${hwnd};
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;
public class Wr { [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
public struct RECT { public int L; public int T; public int R; public int B; } }';
$r = New-Object Wr+RECT;
if ([Wr]::IsWindow($h) -and -not [Wr]::IsIconic($h) -and [Wr]::GetWindowRect($h, [ref]$r) -and ($r.L -lt -10000 -or $r.T -lt -10000)) { [Wr]::ShowWindow($h, 6) | Out-Null }
`;
  let child;
  try {
    child = spawnFn(exe, ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, stdio: 'ignore' });
  } catch { return; }
  // 8s:主脚本 60s 超时已说明机器可能偏慢/高负载,冷启动 Add-Type 编译可能超 5s,兜底是最后机会多留余量
  const t = setTimeout(() => { try { child.kill(); } catch { /* 已退出则忽略 */ } }, 8000);
  child.on('close', () => clearTimeout(t));
  child.on('error', () => clearTimeout(t));
}

// 注:平台级函数用不同注入名——captureWindows 用 spawnFn(需持有子进程句柄以便超时 kill),
// captureMac/captureLinux 用 execFileFn(一次性执行、无需 kill 语义);二者是同一注入角色。
export function captureWindows({ spawnFn = spawn, timeout = SLOW_TIMEOUT, fallbackDelay = 5000, windowId, shotsRoot, psExe } = {}) {
  return new Promise((resolvePromise, reject) => {
    // windowId 必传:本工具只截指定窗口,不再有全屏模式。
    // 防御:windowId 会拼进 PS 模板的 [IntPtr][long],注入前先校验纯数字,
    // 与 restoreMinimizedFallback 的兜底校验(只接受纯数字)同一标准。当前唯一来源是
    // win32 枚举的 h.ToInt64()(纯数字),校验防未来窗口来源变化把非数字值拼进 PS 脚本。
    if (windowId == null) {
      reject(new Error('未指定要截取的窗口(windowId 必传)'));
      return;
    }
    if (!/^\d+$/.test(String(windowId))) {
      reject(new Error(`无效的窗口句柄:${windowId}`));
      return;
    }
    // 输出路径由 JS 端生成并经环境变量注入子进程,不再依赖 stdout 猜路径:
    // 若脚本在 Save 与 Write-Output 之间被超时 kill(或 Save 抛错),JS 仍知道目标路径,
    // 失败分支能按路径清理,不会在截图目录残留失败的截图文件。
    const shotDir = makeShotsDir(shotsRoot || defaultShotsDir());
    const outPath = tempShotPath(shotDir, 'jpeg');
    // 降级原因通道:PS 降级/失败时把原因写入 note 文件(UTF-8),JS 失败分支读后拼进错误、成功分支读后即删。
    // note 用 note- 前缀而非 shot-:避免被 pruneShots 的截图预算(/^shot-/)统计成截图;
    // 残留的 note-* 由 pruneShots 统一回收(见其 doc 注释),正常路径读后即删不残留。
    const notePath = tempShotPath(shotDir, 'note.txt', 'note');
    const env = { ...process.env, TEXT_VISION_SHOT: outPath, TEXT_VISION_HWND: String(windowId), TEXT_VISION_NOTE: notePath };
    let child;
    try {
      child = spawnFn(psExe ?? resolvePsExe(), ['-NoProfile', '-NonInteractive', '-Command', WIN_PS], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        // 把输出路径经环境变量传给子进程,避免路径含空格/引号时的转义问题
        env
      });
    } catch (e) {
      // spawn 同步抛错(如找不到 powershell.exe)时同样清理临时文件,避免空目录残留
      cleanupScreenShot(outPath);
      cleanupNotePath(notePath);
      throw e;
    }
    let err = '';
    let wasTimedOut = false;
    let settled = false;
    let killTimer, fallbackTimer;
    // settle 要 clearTimeout 两个 timer,故 timer 声明为 let 并在此函数定义后再赋值;
    // settle 只被 timer/事件回调异步调用,调用时两个 timer 均已赋值,不会读到 undefined
    const settle = (fn, value) => { if (!settled) { settled = true; clearTimeout(killTimer); clearTimeout(fallbackTimer); fn(value); } };
    // 所有失败路径都要连 note 文件一起清理,避免残留截图/note 临时文件
    const cleanupAll = () => { cleanupNotePath(notePath); cleanupScreenShot(outPath); };
    // 失败时读 note(PS 累积的降级原因)→ 拼进错误消息;必须先读再清理(cleanupNotePath 会删文件,顺序反了丢原因)
    const readNote = () => { try { return readFileSync(notePath, 'utf8').trim() || undefined; } catch { return undefined; } };
    killTimer = setTimeout(() => {
      wasTimedOut = true;
      child.kill();
      // PS 主脚本被强杀,finally 不执行:最小化窗口可能卡在屏幕外,额外跑兜底命令尝试还原(尽力而为,失败静默)
      restoreMinimizedFallback(String(windowId), psExe ?? resolvePsExe(), { spawnFn });
    }, timeout);
    // kill 后仍可能在极端场景下收不到 close(进程卡死),加兜底 timer 强制结束,避免请求永久挂起
    fallbackTimer = setTimeout(() => {
      // 兜底结束也必须清理,避免卡死场景残留截图文件;若 PowerShell 仍持有文件句柄导致删除失败,
      // 打一条 stderr 让残留可被人工发现(宁可多此一举)
      cleanupAll();
      // 兜底超时时子进程可能仍卡死未退出:先 kill,否则它恢复后可能重新写出已删除的截图
      // (kill 幂等,进程已退出时无副作用)
      try { child.kill(); } catch { /* 忽略,不影响 settle */ }
      // 只打文件名,不暴露 tmpdir 绝对路径(含用户名),与本项目其他错误路径的隐私惯例一致
      console.error(`[text-vision] 截屏兜底超时已触发:临时文件可能未清理干净(${basename(outPath)}),若确认残留请手动删除。`);
      settle(reject, new Error(`超时(超过 ${timeout}ms 被中止)${err ? ': ' + redactLocalPath(err).trim().slice(0, 300) : ''}`));
    }, timeout + fallbackDelay);
    child.stderr.on('data', d => { if (err.length < 4096) err += String(d).slice(0, 4096 - err.length); });
    child.on('error', e => {
      cleanupAll(); // spawn 失败时文件未写,幂等清理无副作用
      settle(reject, new Error(redactLocalPath(e?.message ?? String(e))));
    });
    child.on('close', code => {
      // JS 始终知道输出路径:失败(含超时被 kill)也按该路径清理,避免残留截图文件
      if (code !== 0 || wasTimedOut) {
        const note = readNote();
        cleanupAll();
        // 用 wasTimedOut 标记而非 code==null 判断超时:部分 Windows 环境下 kill 后 code 可能非 null
        const reason = wasTimedOut
          ? `超时(超过 ${timeout}ms 被中止)${note ? ': ' + redactLocalPath(note) : ''}`
          : (note ? `窗口截图失败: ${redactLocalPath(note)}` : `PowerShell 退出码 ${code}`);
        settle(reject, new Error(`${reason}${err ? ': ' + redactLocalPath(err).trim().slice(0, 300) : ''}`));
      } else {
        // 成功分支:读 note 文件(PS 降级提示才有)→ 读后即删,返回 { filePath, note? }
        const note = readNote();
        cleanupNotePath(notePath);
        // 与 Linux/Mac 对齐:退出码 0 不代表文件一定已写出(个别环境静默失败),校验产物非空才算成功,
        // 避免 0 字节文件被当成功结果消费(PS 内部 Save-Jpeg 失败会 exit 1,这里是双保险)
        let size = 0;
        try { size = statSync(outPath).size; } catch { /* 未写出 */ }
        if (size <= 0) {
          cleanupScreenShot(outPath);
          settle(reject, new Error('窗口截图失败:未产出有效截图文件'));
          return;
        }
        settle(resolvePromise, { filePath: outPath, note });
      }
    });
  });
}

// --- Linux/macOS:系统命令截取指定窗口(import / screencapture),共享同一套骨架 ---
// 两者的流程完全一致:windowId 必传校验 → 生成临时路径 → 系统命令执行 → 产物非空校验 → 返回/抛错。
// 仅"命令 + 错误文案 + 后处理(macToJpeg)"不同,抽成公共 helper,避免两平台骨架重复漂移。

/**
 * 系统命令截窗公共骨架:校验 windowId → 跑系统命令 → 校验产物非空。
 * runCmd(path) 负责用已生成的临时路径执行系统命令;failMsg/emptyMsg 是各自的失败文案;
 * afterFile(path) 可选,用于后处理(如 macOS 转 JPEG),返回最终 { filePath }。
 */
async function captureByCommand({ execFileFn, timeout, windowId, shotsRoot, runCmd, failMsg, emptyMsg, afterFile }) {
  // windowId 必传:只截指定窗口
  if (windowId == null) {
    throw new Error('未指定要截取的窗口(windowId 必传)');
  }
  const path = tempShotPath(makeShotsDir(shotsRoot || defaultShotsDir()));
  let size = 0;
  try {
    await runCmd(path);
    // 退出码为 0 不一定代表文件已写出(个别环境静默失败),校验产物非空才算成功
    try { size = statSync(path).size; } catch { /* 未写出 */ }
  } catch (err) {
    cleanupScreenShot(path);
    throw new Error(`${failMsg}: ${shortErr(err)}`);
  }
  if (size <= 0) {
    cleanupScreenShot(path);
    throw new Error(emptyMsg);
  }
  return afterFile ? afterFile(path) : { filePath: path };
}

// --- Linux:ImageMagick import -window 截取指定窗口(需安装 ImageMagick,且需 X11 窗口管理器)---
// windowId 来自 wmctrl 枚举的 X11 十六进制 id(如 0x01000007),import 接受该形态。失败明确报错,不再回退全屏。
export async function captureLinux({ execFileFn = execFileP, timeout = CMD_TIMEOUT, windowId, shotsRoot } = {}) {
  return captureByCommand({
    execFileFn, timeout, windowId, shotsRoot,
    runCmd: (path) => execFileFn('import', ['-window', windowId, path], { timeout }),
    failMsg: '指定窗口截图失败(import -window 不可用或窗口无效)',
    emptyMsg: '指定窗口截图失败(import 退出码 0 但未产出有效截图文件),请确认 ImageMagick 已安装且窗口有效(X11 环境)'
  });
}

// --- macOS:截取用系统内置 screencapture,再 sips 转 JPEG(sips 不可用退回 PNG) ---
async function macToJpeg(png, { execFileFn, timeout }) {
  // 大屏/双屏 PNG 常超 maxImageMB,用系统内置 sips 转 JPEG(与 Windows 行为一致)
  const jpg = png.replace(/\.png$/, '.jpeg');
  try {
    await execFileFn('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', png, '--out', jpg], { timeout });
    cleanupScreenShot(png);
    return { filePath: jpg };
  } catch {
    cleanupScreenShot(jpg);
    return { filePath: png }; // sips 不可用的极端环境退回 PNG
  }
}

export async function captureMac({ execFileFn = execFileP, timeout = CMD_TIMEOUT, windowId, shotsRoot } = {}) {
  // windowId 必传:只截指定窗口。被遮挡窗口在部分 macOS 版本取到的是遮挡内容而非本体(平台差异)。
  return captureByCommand({
    execFileFn, timeout, windowId, shotsRoot,
    runCmd: (path) => execFileFn('screencapture', ['-x', `-l${windowId}`, path], { timeout }),
    failMsg: '指定窗口截图失败',
    emptyMsg: '指定窗口截图失败(窗口可能已关闭,或未授予屏幕录制权限:系统设置 → 隐私与安全性 → 屏幕录制)',
    afterFile: (path) => macToJpeg(path, { execFileFn, timeout })
  });
}

// --- target 解析:枚举窗口 → 匹配(窗口 ID/进程名/标题)→ 命中传 id,失败一律明确报错 ---
// 不再有全屏回退:未指定 target / 枚举失败 / 未命中都抛错,引导用户先用 list_windows 拿窗口清单。

/** 未指定 target 的统一错误文案(MCP handler 与 resolveTarget 共用,避免两处漂移)。 */
export const NO_TARGET_MSG = '截屏必须指定 target:请先调用 list_windows 查看窗口清单,再传 target(窗口 ID、进程名或标题)';

async function resolveTarget(target, listWindowsFn) {
  const t = target == null ? '' : String(target).trim();
  if (t === '') {
    throw new Error(NO_TARGET_MSG);
  }
  let windows;
  try {
    windows = await listWindowsFn();
  } catch (err) {
    throw new Error(`无法枚举窗口(${shortErr(err)}),请先调用 list_windows 排查`);
  }
  const match = matchWindow(target, windows);
  if (!match) {
    throw new Error(`未找到与"${target}"匹配的窗口,请先用 list_windows 查看当前窗口清单`);
  }
  return { match };
}

/**
 * 截取指定窗口,返回 { b64, filePath, sizeBytes, mime, note?, targetLabel? }。
 * target 必传(窗口 ID/进程名/标题,模糊匹配),找不到/枚举失败/截图失败都明确抛错,不回退全屏。
 * targetLabel 记录实际命中的窗口(命中窗口的 title||process),供上层提示"截的是哪个窗口"。
 * 截图保留在 shotsRoot(默认仓库根 .text-vision/screenshots),每次成功后 pruneShots 只留最近 MAX_SHOTS 张。
 * deps 可选,用于测试注入 mock 的 spawn/execFile/listWindows,以及 shotsRoot(测试用临时目录避免污染仓库)。
 * platform 也可注入(默认 process.platform),让跨平台分派逻辑可在任意 CI 平台单测;
 * 注入 platform 时窗口枚举(listWindows)同样透传该平台,截图与枚举走同一分派,不会按真实平台枚举。
 */
export async function captureScreen(deps = {}) {
  let filePath;
  try {
    const shotsRoot = deps.shotsRoot ?? defaultShotsDir();
    const platform = deps.platform ?? process.platform;
    // listWindowsFn:显式注入用注入的;否则包装真实 listWindows,把注入的 platform/execFileFn 透传,
    // 让"注入 platform 测跨平台分派"时窗口枚举与截图走同一平台(否则枚举仍按真实 process.platform,分派测试不完整)
    const listWindowsFn = deps.listWindows ?? (() => listWindows({ platform, execFileFn: deps.execFileFn }));
    // target 必传解析:空白/未指定抛错;命中传窗口 id,未命中/枚举失败抛明确错误(不再回退全屏)。
    const r = await resolveTarget(deps.target, listWindowsFn);
    const windowId = r.match.id;
    const targetLabel = r.match.title || r.match.process || null;
    let result;
    if (platform === 'win32') result = await captureWindows({ ...deps, shotsRoot, windowId });
    else if (platform === 'darwin') result = await captureMac({ ...deps, shotsRoot, windowId });
    else if (platform === 'linux') result = await captureLinux({ ...deps, shotsRoot, windowId });
    else throw new Error(`暂不支持在当前平台(${platform})截屏`);
    filePath = result.filePath;

    const buf = readFileSync(filePath);
    // 0 字节文件不该当作成功结果发给视觉 API(用真实字节数判断,与 Linux 的 statSync 校验一致)
    if (buf.length === 0) {
      throw new Error('生成的文件为空(截图工具可能未正常工作)');
    }
    const b64 = buf.toString('base64');
    // mime 按实际输出格式推断:Windows/macOS 存 JPEG,Linux 存 PNG,供调用方正确声明 data URL
    const mime = filePath.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    // 截图保留策略:只留最近 MAX_SHOTS 张,超出清最旧(仅统计 shot-* 文件,note 等临时文件不受影响)
    pruneShots(dirname(filePath), MAX_SHOTS);
    // 窗口内部降级 note(如"窗口原为最小化,已临时恢复");target 解析失败已抛错,无需再合并
    const note = result.note?.trim() || undefined;
    return { b64, filePath, sizeBytes: buf.length, mime, note, targetLabel };
  } catch (err) {
    if (filePath) cleanupScreenShot(filePath); // 失败路径清理残留,避免截屏失败留下空文件
    // 底层实现(reject 自 captureWindows 等)已逐处脱敏,这里兜底未来回归:任何异常都以不含
    // 本机绝对路径的消息抛出,避免 MCP 客户端读到含用户名的仓库路径
    throw new Error(redactLocalPath(err?.message ?? String(err)));
  }
}

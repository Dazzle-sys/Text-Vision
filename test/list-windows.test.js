// 窗口枚举与匹配测试:matchWindow 纯函数 + 三平台输出解析。全部 mock,不调真实系统命令。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchWindow,
  listWindowsWin32, parseWin32,
  listWindowsMac, parseMac,
  listWindowsLinux, parseLinux
} from '../src/list-windows.js';

// ---------------------------------------------------------------------------
// matchWindow(纯函数,先进程名后标题,精确>前缀>包含)
// ---------------------------------------------------------------------------
const WS = [
  { id: '1', process: 'chrome', title: 'Google Chrome', width: 800, height: 600 },
  { id: '2', process: 'notepad', title: '未命名 - 记事本', width: 400, height: 300 },
  { id: '3', process: 'explorer', title: '文件资源管理器', width: 500, height: 400 }
];

test('matchWindow:空 target 返回 null', () => {
  assert.equal(matchWindow('', WS), null);
  assert.equal(matchWindow('   ', WS), null);
  assert.equal(matchWindow(undefined, WS), null);
  assert.equal(matchWindow('calc', null), null);
  assert.equal(matchWindow('calc', []), null);
});

test('matchWindow:进程名精确命中优先于标题命中', () => {
  const m = matchWindow('chrome', WS);
  assert.equal(m.id, '1');
});

test('matchWindow:进程名无匹配时落到标题包含命中', () => {
  const m = matchWindow('chrome', [{ id: '9', process: 'x', title: 'chrome helper' }]);
  assert.equal(m.id, '9'); // 进程名 'x' 无匹配,标题 contains(1) 命中
});

test('matchWindow:进程名前缀命中可被标题精确命中覆盖(跨来源取最高 rank)', () => {
  const list = [
    { id: 'a', process: 'chrome_web', title: '杂项' }, // 进程名前缀(2)
    { id: 'b', process: 'x', title: 'chrome' }         // 标题精确(3)
  ];
  assert.equal(matchWindow('chrome', list).id, 'b');
});

test('matchWindow:进程名精确命中时标题无法覆盖', () => {
  const list = [
    { id: 'a', process: 'chrome', title: '杂项' }, // 进程名精确(3)
    { id: 'b', process: 'x', title: 'chrome' }     // 标题精确(3),需 rank > 3 才覆盖 → 保持进程名
  ];
  assert.equal(matchWindow('chrome', list).id, 'a');
});

test('matchWindow:标题模糊命中(进程名无匹配时)', () => {
  const m = matchWindow('记事本', WS);
  assert.equal(m.id, '2');
});

test('matchWindow:精确 > 前缀 > 包含', () => {
  const list = [
    { id: 'a', process: 'x', title: 'calculator' },
    { id: 'b', process: 'y', title: 'calc' },
    { id: 'c', process: 'z', title: 'my-calc-app' }
  ];
  assert.equal(matchWindow('calc', list).id, 'b'); // 精确
  const list2 = [
    { id: 'a', process: 'x', title: 'calculator' },
    { id: 'c', process: 'z', title: 'my-calc-app' }
  ];
  assert.equal(matchWindow('calc', list2).id, 'a'); // 前缀(calculator.startsWith calc)
  assert.equal(matchWindow('calc', [{ id: 'c', process: 'z', title: 'my-calc-app' }]).id, 'c'); // 包含
});

test('matchWindow:去掉首尾引号后匹配', () => {
  const m = matchWindow('"chrome"', WS);
  assert.equal(m.id, '1');
});

test('matchWindow:大小写不敏感', () => {
  const m = matchWindow('CHROME', WS);
  assert.equal(m.id, '1');
});

test('matchWindow:无任何匹配返回 null', () => {
  assert.equal(matchWindow('不存在的程序xyz', WS), null);
});

// ---------------------------------------------------------------------------
// parseWin32(PowerShell JSON 数组输出)
// ---------------------------------------------------------------------------
test('parseWin32:解析 JSON 数组(tab 分隔行)→ 窗口条目', () => {
  const ws = parseWin32('["123\\tchrome\\tGoogle Chrome\\t800\\t600","456\\tnotepad\\t未命名 - 记事本\\t400\\t300"]');
  assert.equal(ws.length, 2);
  assert.equal(ws[0].id, '123');
  assert.equal(ws[0].process, 'chrome');
  assert.equal(ws[0].title, 'Google Chrome');
  assert.equal(ws[0].width, 800);
  assert.equal(ws[0].height, 600);
});

test('parseWin32:空输出 / 非 JSON / 空数组 → 防御性返回 []', () => {
  assert.deepEqual(parseWin32(''), []);
  assert.deepEqual(parseWin32('   '), []);
  assert.deepEqual(parseWin32('not-json'), []);
  assert.deepEqual(parseWin32('[]'), []);
});

test('parseWin32:行字段不足时补默认值不崩溃', () => {
  const ws = parseWin32('["789\\tcalc"]');
  assert.equal(ws[0].id, '789');
  assert.equal(ws[0].width, 0);
});

test('parseWin32:单元素数组(PowerShell 输出裸 JSON 字符串)→ 仍解析出 1 个窗口', () => {
  // ConvertTo-Json 对单元素数组输出 "123\tchrome\tTitle\t800\t600"(带引号),不是 [...]
  const ws = parseWin32('"123\\tchrome\\tGoogle Chrome\\t800\\t600"');
  assert.equal(ws.length, 1);
  assert.equal(ws[0].id, '123');
  assert.equal(ws[0].process, 'chrome');
  assert.equal(ws[0].title, 'Google Chrome');
});

// ---------------------------------------------------------------------------
// parseMac(swift tab 分隔行)
// ---------------------------------------------------------------------------
test('parseMac:解析 tab 行 → 窗口条目(process=owner,尺寸置 0)', () => {
  const ws = parseMac('123\tGoogle Chrome\t新标签页\n456\tTerminal\ttest');
  assert.equal(ws.length, 2);
  assert.equal(ws[0].id, '123');
  assert.equal(ws[0].process, 'Google Chrome');
  assert.equal(ws[0].title, '新标签页');
  assert.equal(ws[0].width, 0);
});

test('parseMac:空输出 → []', () => {
  assert.deepEqual(parseMac(''), []);
});

test('parseMac:缺 id/owner 的行被过滤', () => {
  assert.equal(parseMac('\t\tno-id-line').length, 0);
});

// ---------------------------------------------------------------------------
// parseLinux(wmctrl -lp 输出,/proc/<pid>/comm 读失败留空)
// ---------------------------------------------------------------------------
test('parseLinux:解析 wmctrl 行 → id/title;/proc 读不到 → process 空串', () => {
  const ws = parseLinux('0x01000007  0  12345  myhost  未命名 - 记事本\n0x0200000a  0  1  myhost  gnome-shell');
  assert.equal(ws.length, 2);
  assert.equal(ws[0].id, '0x01000007');
  assert.equal(ws[0].process, ''); // pid 12345 测试机不存在 → comm 读失败 → 空
  assert.equal(ws[0].title, '未命名 - 记事本');
  assert.equal(ws[1].title, 'gnome-shell');
});

test('parseLinux:空输出/无标题行 → 过滤', () => {
  assert.deepEqual(parseLinux(''), []);
  assert.equal(parseLinux('0x01000007  0  12345  myhost  \n').length, 0);
});

// ---------------------------------------------------------------------------
// 平台实现:命令缺失 → 明确错误;mac 权限诊断
// ---------------------------------------------------------------------------
test('listWindowsWin32:execFileFn 抛错 → 向上传播', async () => {
  const execFileFn = async () => { throw new Error('powershell 不可用'); };
  await assert.rejects(listWindowsWin32({ execFileFn }), /powershell 不可用/);
});

test('listWindowsLinux:wmctrl 未安装(ENOENT)→ 提示安装 wmctrl', async () => {
  const err = Object.assign(new Error('spawn wmctrl ENOENT'), { code: 'ENOENT' });
  const execFileFn = async () => { throw err; };
  await assert.rejects(listWindowsLinux({ execFileFn }), /wmctrl 不可用/);
});

test('listWindowsMac:有窗口但标题全空 → 判定屏幕录制权限未授予', async () => {
  const execFileFn = async () => ({ stdout: '123\tGoogle Chrome\t\n456\tTerminal\t\n' });
  await assert.rejects(listWindowsMac({ execFileFn }), /屏幕录制权限/);
});

test('listWindowsMac:正常 tab 行 → 返回窗口清单', async () => {
  const execFileFn = async () => ({ stdout: '123\tGoogle Chrome\t新标签页\n' });
  const ws = await listWindowsMac({ execFileFn });
  assert.equal(ws.length, 1);
  assert.equal(ws[0].title, '新标签页');
});

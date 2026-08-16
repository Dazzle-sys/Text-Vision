// MCP server 冒烟测试:createServer 注册四个工具,走 InMemoryTransport 真实协议
// 验证 tools/list(工具名与 schema)与 tools/call(handler 契约)。全部注入 mock 实现,不触网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/index.js';
import { repoRoot } from '../src/repo-root.js';

// 最小 MCP JSON-RPC 客户端(内存传输)
function makeClient(t) {
  let id = 0;
  const pending = new Map();
  t.onmessage = (msg) => {
    if (msg?.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  return {
    request(method, params) {
      const mid = String(++id);
      return new Promise(res => { pending.set(mid, res); t.send({ jsonrpc: '2.0', id: mid, method, params }); });
    },
    notify(method, params) { t.send({ jsonrpc: '2.0', method, params }); }
  };
}

// 用 mock 实现创建已连好的 server,返回客户端(附带 logs 记录 appendLog 调用,供降级日志断言)
async function startServer(overrides = {}) {
  const logs = [];
  const server = createServer({
    describe: async (path) => ({ ok: true, text: `描述:${path}` }),
    ocr: async (path) => ({ ok: true, text: `OCR:${path}` }),
    capture: async ({ target }) => ({ b64: 'aGk=', mime: 'image/png' }),
    // 参数对象断言:index.js 调 describeBase64 时 cfg 必须缺省(undefined,走 loadConfig)、source 带来源
    // (mock 无 filePath 时是纯 '截屏';capture 带 filePath 时是 "截屏 <截图路径>")、sourceLabel='截屏'
    // (成功日志纯标签)。防未来把 source 误放 cfg 位(参数错位回归会溜过 3 参 mock)——真实链路由下方专用用例兜底
    describeBase64: async ({ b64, mime, focus, cfg, source, sourceLabel }) => {
      assert.equal(cfg, undefined, 'cfg 必须缺省(undefined),由 describeImageFromBase64 内部走 loadConfig');
      assert.equal(b64, 'aGk=', 'b64 应来自截屏产物');
      assert.equal(mime, 'image/png', 'mime 应来自截屏产物');
      assert.ok(String(source).startsWith('截屏'), 'source 应以"截屏"开头,可带截图文件路径');
      assert.equal(sourceLabel, '截屏', 'sourceLabel 应为截屏(成功日志纯标签)');
      return { ok: true, text: `截图:${focus}` };
    },
    listWindows: async () => [],
    appendLog: async (event, detail) => { logs.push([event, detail]); },
    debugLog: () => {},
    ...overrides
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([clientT.start(), server.connect(serverT)]);
  const c = makeClient(clientT);
  c.logs = logs;
  await c.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } });
  c.notify('notifications/initialized');
  return c;
}

test('tools/list:注册了四个工具,名称与 schema 正确', async () => {
  const c = await startServer();
  const res = await c.request('tools/list', {});
  const tools = res.result.tools;
  assert.equal(tools.length, 4);
  const names = tools.map(t => t.name).sort();
  assert.deepEqual(names, ['describe_image', 'list_windows', 'ocr_image', 'screen_capture']);

  const describe = tools.find(t => t.name === 'describe_image');
  assert.equal(describe.inputSchema.properties.path.type, 'string');
  assert.equal(describe.inputSchema.properties.focus.type, 'string');
  assert.equal(describe.inputSchema.properties.prompt.type, 'string', 'describe_image 应有 prompt 参数');
  assert.ok(!describe.inputSchema.required.includes('focus'), 'focus 可选');
  assert.ok(!describe.inputSchema.required.includes('prompt'), 'prompt 可选');

  const ocr = tools.find(t => t.name === 'ocr_image');
  assert.equal(ocr.inputSchema.properties.path.type, 'string');
  assert.equal(ocr.inputSchema.properties.prompt.type, 'string', 'ocr_image 应有 prompt 参数');
  assert.deepEqual(ocr.inputSchema.required, ['path']);

  const screen = tools.find(t => t.name === 'screen_capture');
  assert.equal(screen.inputSchema.properties.target.type, 'string');
  assert.equal(screen.inputSchema.properties.focus.type, 'string');
  assert.equal(screen.inputSchema.properties.prompt.type, 'string', 'screen_capture 应有 prompt 参数');
  assert.equal(screen.inputSchema.properties.clientArea.type, 'boolean', 'clientArea 应为布尔参数');
  // 全可选字段时 zod 可能省略 required 数组(undefined 等价于空),统一用空数组兜底断言
  // (target 必填由 handler 校验,不走 zod schema,便于给友好错误文案)
  const required = screen.inputSchema.required || [];
  assert.ok(!required.includes('target'), 'target 可选(schema 层)');
  assert.ok(!required.includes('focus'), 'focus 可选');
  assert.ok(!required.includes('prompt'), 'prompt 可选');

  // 工具注释:title 短名 + readOnlyHint(四个工具都是读类,无副作用)
  const annotations = ['describe_image', 'ocr_image', 'screen_capture', 'list_windows']
    .map(n => tools.find(t => t.name === n));
  for (const t of annotations) {
    assert.ok(t.title, `${t.name} 应有 title`);
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} 应标注 readOnlyHint`);
  }
  assert.equal(tools.find(t => t.name === 'describe_image').title, '描述本地图片');
});

test('tools/call screen_capture:clientArea=true → capture 收到 clientArea(透传)', async () => {
  const seen = [];
  const c = await startServer({
    capture: async (args) => { seen.push(args); return { b64: 'aGk=', mime: 'image/png' }; }
  });
  await c.request('tools/call', { name: 'screen_capture', arguments: { target: 'chrome', clientArea: true } });
  assert.equal(seen[0].target, 'chrome');
  assert.equal(seen[0].clientArea, true, 'clientArea 应透传给 capture 实现');
});

test('tools/call describe_image:mock 描述结果原样返回,isError=false', async () => {
  const c = await startServer();
  const res = await c.request('tools/call', { name: 'describe_image', arguments: { path: 'a.png' } });
  assert.equal(res.result.content[0].text, '描述:a.png');
  assert.equal(res.result.isError, false);
});

test('tools/call ocr_image:走 OCR 注入实现', async () => {
  const c = await startServer();
  const res = await c.request('tools/call', { name: 'ocr_image', arguments: { path: 'code.png' } });
  assert.equal(res.result.content[0].text, 'OCR:code.png');
});

test('tools/call describe_image:传 prompt → mock describe 收到 (path, focus, prompt)', async () => {
  const seen = [];
  const c = await startServer({
    describe: async (path, focus, prompt) => { seen.push({ path, focus, prompt }); return { ok: true, text: 'ok' }; }
  });
  const res = await c.request('tools/call', { name: 'describe_image', arguments: { path: 'a.png', prompt: '这个图标是什么?' } });
  assert.equal(res.result.isError, false);
  assert.deepEqual(seen, [{ path: 'a.png', focus: undefined, prompt: '这个图标是什么?' }], 'prompt 应原样透传给实现层');
});

test('tools/call ocr_image:传 prompt → mock ocr 收到 (path, prompt)', async () => {
  const seen = [];
  const c = await startServer({
    ocr: async (path, prompt) => { seen.push({ path, prompt }); return { ok: true, text: 'ok' }; }
  });
  const res = await c.request('tools/call', { name: 'ocr_image', arguments: { path: 'code.png', prompt: '提取所有中文' } });
  assert.equal(res.result.isError, false);
  assert.deepEqual(seen, [{ path: 'code.png', prompt: '提取所有中文' }], 'prompt 应原样透传给实现层');
});

test('tools/call screen_capture:传 prompt → describeBase64 收到原样 prompt、focus 仍为默认句式', async () => {
  const seen = [];
  const c = await startServer({
    describeBase64: async (opts) => {
      assert.equal(opts.cfg, undefined, 'cfg 必须缺省(undefined),走 loadConfig');
      seen.push(opts);
      return { ok: true, text: '截图:ok' };
    }
  });
  const res = await c.request('tools/call', { name: 'screen_capture', arguments: { target: 'chrome', prompt: '看这个窗口的布局' } });
  assert.equal(res.result.isError, false);
  assert.equal(seen[0].focus, '指定的窗口:chrome', 'focus 仍为默认句式(供无 prompt 时模板兜底)');
  assert.equal(seen[0].prompt, '看这个窗口的布局', 'prompt 原样透传');
});

test('tools/call screen_capture:不传 target → 明确报错(必须指定 target)', async () => {
  const c = await startServer();
  const res = await c.request('tools/call', { name: 'screen_capture', arguments: {} });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /必须指定 target/);
  assert.match(res.result.content[0].text, /list_windows/);
});

test('tools/call screen_capture:带 target → 截屏并描述,未降级不写日志', async () => {
  const c = await startServer();
  const res = await c.request('tools/call', { name: 'screen_capture', arguments: { target: 'chrome' } });
  assert.equal(res.result.content[0].text, '截图:指定的窗口:chrome');
  assert.equal(res.result.isError, false);
  assert.deepEqual(c.logs, [], '未降级时不应写日志');
});

test('tools/call screen_capture:显式 target 时 focus 用 target 原文(忽略 targetLabel)→ 契约固化', async () => {
  const c = await startServer({
    capture: async () => ({ b64: 'aGk=', mime: 'image/png', targetLabel: 'Google Chrome' })
  });
  const res = await c.request('tools/call', { name: 'screen_capture', arguments: { target: 'chrome' } });
  assert.equal(res.result.content[0].text, '截图:指定的窗口:chrome');
  assert.equal(res.result.isError, false);
});

test('tools/call screen_capture:返回 filePath → 提示截图保存位置(完整路径方便打开)', async () => {
  const c = await startServer({
    capture: async () => ({ b64: 'aGk=', mime: 'image/png', filePath: join(repoRoot, '.text-vision', 'screenshots', 'shot-123.jpeg') })
  });
  const res = await c.request('tools/call', { name: 'screen_capture', arguments: { target: 'chrome' } });
  assert.match(res.result.content[0].text, /截图已保存到 .*shot-123\.jpeg/);
  assert.ok(res.result.content[0].text.includes(join(repoRoot, '.text-vision', 'screenshots', 'shot-123.jpeg')), '应返回完整绝对路径');
});

test('tools/call screen_capture:mock capture 带 filePath → source 拼上截图路径,sourceLabel 保持纯标签', async () => {
  // 失败日志要能定位到是哪个截图文件:index.js 把 source 拼成 "截屏 <filePath>",成功日志用 sourceLabel 纯标签
  const filePath = join(repoRoot, '.text-vision', 'screenshots', 'shot-456.jpeg');
  const c = await startServer({
    capture: async () => ({ b64: 'aGk=', mime: 'image/png', filePath }),
    describeBase64: async ({ source, sourceLabel, cfg }) => {
      assert.equal(cfg, undefined, 'cfg 必须缺省(undefined),走 loadConfig');
      assert.equal(source, `截屏 ${filePath}`, 'source 应拼上截图落盘路径,供失败日志定位');
      assert.equal(sourceLabel, '截屏', 'sourceLabel 应为纯标签,不含路径');
      return { ok: true, text: '截图:ok' };
    }
  });
  const res = await c.request('tools/call', { name: 'screen_capture', arguments: { target: 'chrome' } });
  assert.equal(res.result.isError, false);
  // capture 带 filePath 时返回文本还会拼 [截图已保存到 ...],用前缀断言只看描述文本
  assert.ok(res.result.content[0].text.startsWith('截图:ok'), '描述文本应为截图:ok');
});

test('tools/call screen_capture:返回 note → 文本含[提示]且 appendLog 落盘 + 日志', async () => {
  const c = await startServer({
    capture: async () => ({ b64: 'aGk=', mime: 'image/png', note: '窗口原为最小化,已临时恢复截图后还原' })
  });
  const res = await c.request('tools/call', { name: 'screen_capture', arguments: { target: 'xyz' } });
  assert.match(res.result.content[0].text, /\[提示\] 窗口原为最小化,已临时恢复截图后还原/);
  assert.equal(res.result.isError, false);
  assert.deepEqual(c.logs, [['screen_capture_degrade', '窗口原为最小化,已临时恢复截图后还原']]);
});

test('tools/call screen_capture:描述失败时 note 不拼入返回文本,但日志已写', async () => {
  const c = await startServer({
    capture: async () => ({ b64: 'aGk=', mime: 'image/png', note: '窗口已最小化' }),
    describeBase64: async () => ({ ok: false, text: '视觉请求超时(90000ms)' })
  });
  const res = await c.request('tools/call', { name: 'screen_capture', arguments: { target: 'notepad' } });
  assert.ok(!res.result.content[0].text.includes('[提示]'), '描述失败时文本是错误文案,不拼 note');
  assert.match(res.result.content[0].text, /视觉请求超时/);
  assert.deepEqual(c.logs, [['screen_capture_degrade', '窗口已最小化']], '降级原因仍已落盘');
});

test('tools/call screen_capture:描述失败但有 filePath → 错误文本仍附截图保存路径(用户知情)', async () => {
  const c = await startServer({
    capture: async () => ({ b64: 'aGk=', mime: 'image/png', filePath: join(repoRoot, '.text-vision', 'screenshots', 'shot-fail.jpeg') }),
    describeBase64: async () => ({ ok: false, text: '视觉请求超时(90000ms)' })
  });
  const res = await c.request('tools/call', { name: 'screen_capture', arguments: { target: 'notepad' } });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /视觉请求超时/);
  assert.match(res.result.content[0].text, /截图已保存到 .*shot-fail\.jpeg/, '描述失败也应提示截图落盘位置');
});

test('tools/call list_windows:返回窗口清单 → 文本含标题、进程、PID 与 ID', async () => {
  const c = await startServer({
    listWindows: async () => [
      { id: '1', process: 'chrome', title: 'Google Chrome', pid: 1234 },
      { id: '2', process: 'notepad', title: '未命名 - 记事本', pid: 5678 }
    ]
  });
  const res = await c.request('tools/call', { name: 'list_windows', arguments: {} });
  assert.equal(res.result.isError, false);
  assert.match(res.result.content[0].text, /Google Chrome/);
  assert.match(res.result.content[0].text, /进程:chrome/);
  assert.match(res.result.content[0].text, /PID:1234/, '应显示进程 PID');
  assert.match(res.result.content[0].text, /ID:1/, '应显示窗口 ID 供 target 直传');
  assert.match(res.result.content[0].text, /未命名 - 记事本/);
});

test('tools/call list_windows:窗口标题含本机路径 → 原样保留(运行时输出,不入提交)', async () => {
  const c = await startServer({
    listWindows: async () => [{ id: '1', process: 'explorer', title: 'C:\\Users\\someone\\Desktop\\a.txt' }]
  });
  const res = await c.request('tools/call', { name: 'list_windows', arguments: {} });
  assert.match(res.result.content[0].text, /C:\\Users\\someone\\Desktop\\a\.txt/, '窗口标题应原样返回');
  assert.ok(!res.result.content[0].text.includes('[本地路径]'), '不应再替换为占位符');
});

test('tools/call list_windows:最小化窗口 → 标注 已最小化,未最小化窗口不标注', async () => {
  const c = await startServer({
    listWindows: async () => [
      { id: '1', process: 'chrome', title: 'Google Chrome' },
      { id: '2', process: 'notepad', title: '未命名 - 记事本', minimized: true }
    ]
  });
  const res = await c.request('tools/call', { name: 'list_windows', arguments: {} });
  assert.equal(res.result.isError, false);
  assert.ok(res.result.content[0].text.includes('未命名 - 记事本 (进程:notepad 已最小化)'), '最小化窗口应标注 已最小化');
  assert.ok(!res.result.content[0].text.includes('Google Chrome (进程:chrome 已最小化)'), '未最小化窗口不应标注');
});

test('tools/call list_windows:空清单 → isError=true 且提示可能原因', async () => {
  const c = await startServer(); // listWindows mock 返回 []
  const res = await c.request('tools/call', { name: 'list_windows', arguments: {} });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /没有枚举到窗口/);
});

test('tools/call list_windows:枚举抛错 → isError=true 且透传错误', async () => {
  const c = await startServer({
    listWindows: async () => { throw new Error('wmctrl 不可用'); }
  });
  const res = await c.request('tools/call', { name: 'list_windows', arguments: {} });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /wmctrl 不可用/);
});

test('tools/call 失败:实现返回 ok:false → isError=true 且内容透传', async () => {
  const server = createServer({
    describe: async () => ({ ok: false, text: '视觉引擎未配置。请设置环境变量…' }),
    ocr: async () => ({ ok: true, text: 'x' }),
    capture: async () => { throw new Error('no tool'); },
    describeBase64: async () => ({ ok: true, text: 'x' })
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([clientT.start(), server.connect(serverT)]);
  const c = makeClient(clientT);
  await c.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } });
  c.notify('notifications/initialized');

  const res = await c.request('tools/call', { name: 'describe_image', arguments: { path: 'a.png' } });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /视觉引擎未配置/);
});

test('tools/call 兜底:实现抛含本机路径的异常 → 统一错误形态且路径脱敏', async () => {
  const c = await startServer({
    describe: async () => { throw new Error('读取失败: C:\\Users\\someone\\Desktop\\a.png'); }
  });
  const res = await c.request('tools/call', { name: 'describe_image', arguments: { path: 'a.png' } });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /描述图片失败/);
  assert.ok(!res.result.content[0].text.includes('C:\\Users\\someone'), '本机路径应被脱敏');
  assert.match(res.result.content[0].text, /\[本地路径\]/);
  assert.ok(c.logs.some(([ev, detail]) => ev === 'tool_error' && detail.includes('描述图片失败')), '兜底异常应落盘 tool_error');
});

test('tools/call screen_capture:capture 返回 undefined → 明确错误而非 TypeError', async () => {
  const c = await startServer({
    capture: async () => undefined
  });
  const res = await c.request('tools/call', { name: 'screen_capture', arguments: { target: 'chrome' } });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /未返回有效的图片数据/);
});

test('tools/call screen_capture:capture 抛含路径异常 → 兜底统一错误形态且路径脱敏', async () => {
  const c = await startServer({
    capture: async () => { throw new Error('截屏失败: C:\\Users\\someone\\Desktop\\a.png'); }
  });
  const res = await c.request('tools/call', { name: 'screen_capture', arguments: { target: 'chrome' } });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /截屏失败/);
  assert.ok(!res.result.content[0].text.includes('C:\\Users\\someone'), '本机路径应被脱敏');
  assert.match(res.result.content[0].text, /\[本地路径\]/);
  assert.ok(c.logs.some(([ev, detail]) => ev === 'tool_error' && detail.includes('截屏失败')), '兜底异常应落盘 tool_error');
});

test('tools/call screen_capture:真实 describeImageFromBase64 链路(不注入 mock)→ 描述成功', async () => {
  // 回归防护:index.js 调 describeBase64 走 options 对象,capture 产物(b64/mime)与 source/sourceLabel 正确透传。
  // 若 source 被误当 cfg 传,describeImageFromBase64 会把 cfg 当字符串、读不到 apiKey,误报"视觉引擎未配置",
  // 本用例 isError 断言即失败——此前各用例全注入 mock,从未覆盖真实参数契约,该回归会溜过 CI。
  const saved = {};
  for (const k of ['VISION_API_BASE', 'VISION_API_KEY', 'VISION_MODEL', 'VISION_LOG_FILE']) saved[k] = process.env[k];
  const logDir = mkdtempSync(join(tmpdir(), 'tv-mcp-log-'));
  const REAL_FETCH = globalThis.fetch;
  try {
    process.env.VISION_API_BASE = 'https://mock.example.com/v1';
    process.env.VISION_API_KEY = 'sk-test-abcdefghij';
    process.env.VISION_MODEL = 'mock-model';
    process.env.VISION_LOG_FILE = join(logDir, 'log.txt'); // 真实 appendLog 落临时目录,不污染仓库日志
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '屏幕上有任务栏和窗口' } }] }) });
    const server = createServer({
      describe: async () => ({ ok: true, text: 'x' }),
      ocr: async () => ({ ok: true, text: 'x' }),
      capture: async () => ({ b64: 'aGk=', mime: 'image/png' }),
      listWindows: async () => [],
      appendLog: () => {},
      debugLog: () => {}
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([clientT.start(), server.connect(serverT)]);
    const c = makeClient(clientT);
    await c.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } });
    c.notify('notifications/initialized');
    const res = await c.request('tools/call', { name: 'screen_capture', arguments: { target: 'chrome' } });
    assert.equal(res.result.isError, false);
    assert.match(res.result.content[0].text, /屏幕上有任务栏和窗口/);
  } finally {
    for (const k of ['VISION_API_BASE', 'VISION_API_KEY', 'VISION_MODEL', 'VISION_LOG_FILE']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    globalThis.fetch = REAL_FETCH;
    try { rmSync(logDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

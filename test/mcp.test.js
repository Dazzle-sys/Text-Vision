// MCP server 冒烟测试:createServer 注册四个工具,走 InMemoryTransport 真实协议
// 验证 tools/list(工具名与 schema)与 tools/call(handler 契约)。全部注入 mock 实现,不触网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { join } from 'node:path';
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
    describeBase64: async (b64, mime, focus) => ({ ok: true, text: `截图:${focus}` }),
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
  assert.ok(!describe.inputSchema.required.includes('focus'), 'focus 可选');

  const ocr = tools.find(t => t.name === 'ocr_image');
  assert.equal(ocr.inputSchema.properties.path.type, 'string');
  assert.deepEqual(ocr.inputSchema.required, ['path']);

  const screen = tools.find(t => t.name === 'screen_capture');
  assert.equal(screen.inputSchema.properties.target.type, 'string');
  assert.equal(screen.inputSchema.properties.focus.type, 'string');
  // 全可选字段时 zod 可能省略 required 数组(undefined 等价于空),统一用空数组兜底断言
  const required = screen.inputSchema.required || [];
  assert.ok(!required.includes('target'), 'target 可选');
  assert.ok(!required.includes('focus'), 'focus 可选');

  const listW = tools.find(t => t.name === 'list_windows');
  assert.ok(listW, '应注册 list_windows');
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

test('tools/call screen_capture:截屏 → 描述', async () => {
  const c = await startServer();
  const res = await c.request('tools/call', { name: 'screen_capture', arguments: {} });
  assert.equal(res.result.content[0].text, '截图:当前屏幕/UI 界面');
  assert.equal(res.result.isError, false);
});

test('tools/call screen_capture:带 target → focus 提示指定的窗口', async () => {
  const c = await startServer();
  const res = await c.request('tools/call', { name: 'screen_capture', arguments: { target: 'chrome' } });
  assert.equal(res.result.content[0].text, '截图:指定的窗口:chrome');
  assert.equal(res.result.isError, false);
  assert.deepEqual(c.logs, [], '未降级时不应写日志');
});

test('tools/call screen_capture:返回 filePath → 提示截图保存位置(完整路径方便打开)', async () => {
  const c = await startServer({
    capture: async () => ({ b64: 'aGk=', mime: 'image/png', filePath: join(repoRoot, '.text-vision', 'screenshots', 'shot-123.jpeg') })
  });
  const res = await c.request('tools/call', { name: 'screen_capture', arguments: {} });
  assert.match(res.result.content[0].text, /截图已保存到 .*shot-123\.jpeg/);
  assert.ok(res.result.content[0].text.includes(join(repoRoot, '.text-vision', 'screenshots', 'shot-123.jpeg')), '应返回完整绝对路径');
});

test('tools/call screen_capture:返回 note → 文本含[提示]且 appendLog 落盘 + 日志', async () => {
  const c = await startServer({
    capture: async () => ({ b64: 'aGk=', mime: 'image/png', note: '未找到与"xyz"匹配的窗口,已回退全屏截图' })
  });
  const res = await c.request('tools/call', { name: 'screen_capture', arguments: { target: 'xyz' } });
  assert.match(res.result.content[0].text, /\[提示\] 未找到与"xyz"匹配的窗口,已回退全屏截图/);
  assert.equal(res.result.isError, false);
  assert.deepEqual(c.logs, [['screen_capture_degrade', '未找到与"xyz"匹配的窗口,已回退全屏截图']]);
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

test('tools/call list_windows:返回窗口清单 → 文本含标题与进程名', async () => {
  const c = await startServer({
    listWindows: async () => [
      { id: '1', process: 'chrome', title: 'Google Chrome', width: 800, height: 600 },
      { id: '2', process: 'notepad', title: '未命名 - 记事本', width: 400, height: 300 }
    ]
  });
  const res = await c.request('tools/call', { name: 'list_windows', arguments: {} });
  assert.equal(res.result.isError, false);
  assert.match(res.result.content[0].text, /Google Chrome/);
  assert.match(res.result.content[0].text, /进程:chrome/);
  assert.match(res.result.content[0].text, /未命名 - 记事本/);
});

test('tools/call list_windows:窗口标题含本机路径 → 原样保留(运行时输出,不入提交)', async () => {
  const c = await startServer({
    listWindows: async () => [{ id: '1', process: 'explorer', title: 'C:\\Users\\someone\\Desktop\\a.txt', width: 500, height: 400 }]
  });
  const res = await c.request('tools/call', { name: 'list_windows', arguments: {} });
  assert.match(res.result.content[0].text, /C:\\Users\\someone\\Desktop\\a\.txt/, '窗口标题应原样返回');
  assert.ok(!res.result.content[0].text.includes('[本地路径]'), '不应再替换为占位符');
});

test('tools/call list_windows:空清单 → isError=true 且提示可能原因', async () => {
  const c = await startServer(); // listWindows mock 返回 []
  const res = await c.request('tools/call', { name: 'list_windows', arguments: {} });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /没有枚举到可见窗口/);
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
});

test('tools/call screen_capture:capture 抛含路径异常 → 兜底统一错误形态且路径脱敏', async () => {
  const c = await startServer({
    capture: async () => { throw new Error('截屏失败: C:\\Users\\someone\\Desktop\\a.png'); }
  });
  const res = await c.request('tools/call', { name: 'screen_capture', arguments: {} });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /截屏失败/);
  assert.ok(!res.result.content[0].text.includes('C:\\Users\\someone'), '本机路径应被脱敏');
  assert.match(res.result.content[0].text, /\[本地路径\]/);
});

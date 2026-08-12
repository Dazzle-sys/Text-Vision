// MCP server 冒烟测试:createServer 注册三个工具,走 InMemoryTransport 真实协议
// 验证 tools/list(工具名与 schema)与 tools/call(handler 契约)。全部注入 mock 实现,不触网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../src/index.js';

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

// 用 mock 实现创建已连好的 server,返回客户端
async function startServer() {
  const server = createServer({
    describe: async (path) => ({ ok: true, text: `描述:${path}` }),
    ocr: async (path) => ({ ok: true, text: `OCR:${path}` }),
    capture: async () => ({ b64: 'aGk=', mime: 'image/png' }),
    describeBase64: async (b64, mime, focus) => ({ ok: true, text: `截图:${focus}` })
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([clientT.start(), server.connect(serverT)]);
  const c = makeClient(clientT);
  await c.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } });
  c.notify('notifications/initialized');
  return c;
}

test('tools/list:注册了三个工具,名称与 schema 正确', async () => {
  const c = await startServer();
  const res = await c.request('tools/list', {});
  const tools = res.result.tools;
  assert.equal(tools.length, 3);
  const names = tools.map(t => t.name).sort();
  assert.deepEqual(names, ['describe_image', 'ocr_image', 'screen_capture']);

  const describe = tools.find(t => t.name === 'describe_image');
  assert.equal(describe.inputSchema.properties.path.type, 'string');
  assert.equal(describe.inputSchema.properties.focus.type, 'string');
  assert.ok(!describe.inputSchema.required.includes('focus'), 'focus 可选');

  const ocr = tools.find(t => t.name === 'ocr_image');
  assert.equal(ocr.inputSchema.properties.path.type, 'string');
  assert.deepEqual(ocr.inputSchema.required, ['path']);
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

test('tools/call screen_capture:截屏 → 描述,附临时文件已清理说明', async () => {
  const c = await startServer();
  const res = await c.request('tools/call', { name: 'screen_capture', arguments: {} });
  assert.equal(res.result.content[0].text, '截图:当前屏幕/UI 界面\n\n[截图已完成描述,临时文件已自动清理。如需保留截图,请用系统截屏工具。]');
  assert.equal(res.result.isError, false);
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

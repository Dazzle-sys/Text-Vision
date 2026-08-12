// 视觉调用核心测试:请求错误路径(超时/429 重试/401 不重试/空内容)、
// 错误体脱敏、base64 输入校验、本地图片读取。
// 全部通过替换全局 fetch 模拟网络,不消耗视觉 API。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { describeImageFromBase64, readLocalImage, describeImage, ocrImage, __setRetrySleepForTest } from '../src/text-vision-client.js';

// 测试注入用配置(避免依赖真实环境变量)
const CFG = {
  apiBase: 'https://mock.example.com/v1',
  apiKey: 'sk-test-abcdefghij', // 长度 >= 8,脱敏逻辑才会替换
  model: 'mock-model',
  timeoutMs: 5000,
  maxImageMB: 10,
  maxTokens: null, // 未配置,由 callVision 按场景取默认
  maxRetries: 1
};

// 替换全局 fetch 并记录调用;调用方用 finally 恢复
function stubFetch(handler) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return handler(url, opts); };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

// 常见响应构造
const okRes = text => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) });
const errRes = (status, bodyText) => ({ ok: false, status, text: async () => bodyText });

// 合法小图 base64(1 字节内容,解码后非空)
const B64 = Buffer.from('x').toString('base64'); // "eA=="

const REAL_FETCH = globalThis.fetch;
afterEach(() => { globalThis.fetch = REAL_FETCH; }); // 兜底恢复,避免用例残留替换

// describeImage / ocrImage 内部走 loadConfig()(读环境变量),这里统一设置便于这两个用例
const VISION_ENV = ['VISION_API_BASE', 'VISION_API_KEY', 'VISION_MODEL'];
const savedEnv = {};
beforeEach(() => {
  for (const k of VISION_ENV) savedEnv[k] = process.env[k];
  process.env.VISION_API_BASE = 'https://mock.example.com/v1';
  process.env.VISION_API_KEY = 'sk-test-abcdefghij';
  process.env.VISION_MODEL = 'mock-model';
  // 重试退避注入即时实现,避免 429/5xx 重试用例真等几百 ms
  __setRetrySleepForTest(() => Promise.resolve());
});
afterEach(() => {
  for (const k of VISION_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __setRetrySleepForTest(null); // 恢复真实 setTimeout
});

// ---------------------------------------------------------------------------
// base64 输入校验
// ---------------------------------------------------------------------------
test('base64 输入非法字符 → 拒绝', async () => {
  const r = await describeImageFromBase64('!!!not-base64!!!', 'image/png', null, CFG);
  assert.equal(r.ok, false);
  assert.match(r.text, /base64/);
});

test('base64 长度非法(mod 4 == 1,解码为残缺字节)→ 拒绝', async () => {
  const r = await describeImageFromBase64('abcdE', 'image/png', null, CFG);
  assert.equal(r.ok, false);
  assert.match(r.text, /base64/);
});

test('空 base64(0 字节内容)不当作成功内容发出去', async () => {
  const r = await describeImageFromBase64('', 'image/png', null, CFG);
  assert.equal(r.ok, false);
  assert.match(r.text, /空/);
});

test('base64 超过 maxImageMB → 拒绝,不发请求', async () => {
  const big = Buffer.alloc(1_500_000).toString('base64'); // ~2MB 解码字节
  const s = stubFetch(() => okRes('x'));
  try {
    const r = await describeImageFromBase64(big, 'image/png', null, { ...CFG, maxImageMB: 1 });
    assert.equal(r.ok, false);
    assert.match(r.text, /过大/);
    assert.equal(s.calls.length, 0, '超限时不应发出请求');
  } finally { s.restore(); }
});

// ---------------------------------------------------------------------------
// 未配置检查
// ---------------------------------------------------------------------------
test('未配置视觉引擎(空 base/apiKey/model)→ 明确提示,不发请求', async () => {
  const s = stubFetch(() => okRes('x'));
  try {
    const r = await describeImageFromBase64(B64, 'image/png', null, { ...CFG, apiBase: '', apiKey: '', model: '' });
    assert.equal(r.ok, false);
    assert.match(r.text, /未配置/);
    assert.equal(s.calls.length, 0);
  } finally { s.restore(); }
});

// ---------------------------------------------------------------------------
// 成功与错误路径
// ---------------------------------------------------------------------------
test('成功:返回模型文字并 trim', async () => {
  const s = stubFetch(() => okRes('  图片里有只猫  '));
  try {
    const r = await describeImageFromBase64(B64, 'image/png', '关注猫', CFG);
    assert.equal(r.ok, true);
    assert.equal(r.text, '图片里有只猫');
    // 请求体携带 base64 data URL 与 prompt
    const body = JSON.parse(s.calls[0].opts.body);
    assert.match(body.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
    assert.match(body.messages[1].content[0].text, /关注猫/);
    assert.equal(body.max_tokens, 2048, '未配置 maxTokens 时描述用默认 2048');
    assert.equal(s.calls.length, 1);
  } finally { s.restore(); }
});

test('429 按 maxRetries 重试后成功', async () => {
  let n = 0;
  const s = stubFetch(() => (++n === 1 ? errRes(429, 'rate limited') : okRes('第二次成功')));
  try {
    const r = await describeImageFromBase64(B64, 'image/png', null, CFG);
    assert.equal(r.ok, true);
    assert.equal(r.text, '第二次成功');
    assert.equal(s.calls.length, 2, '应重试一次');
  } finally { s.restore(); }
});

test('401 认证错误不重试(最多只发一次)', async () => {
  const s = stubFetch(() => errRes(401, 'invalid api key'));
  try {
    const r = await describeImageFromBase64(B64, 'image/png', null, { ...CFG, maxRetries: 3 });
    assert.equal(r.ok, false);
    assert.match(r.text, /HTTP 401/);
    assert.equal(s.calls.length, 1, '401 不应重试');
  } finally { s.restore(); }
});

test('5xx 可重试,重试次数受 maxRetries 上限约束', async () => {
  const s = stubFetch(() => errRes(503, 'overloaded'));
  try {
    const r = await describeImageFromBase64(B64, 'image/png', null, { ...CFG, maxRetries: 2 });
    assert.equal(r.ok, false);
    assert.equal(s.calls.length, 3, '应重试 2 次(共 3 次请求)');
  } finally { s.restore(); }
});

test('超时(AbortError)不重试,给出明确超时文案', async () => {
  // 模拟 fetch 尊重 abort 信号:abort 时以 AbortError 拒绝,否则永不返回
  const s = stubFetch((url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      reject(e);
    });
  }));
  try {
    const r = await describeImageFromBase64(B64, 'image/png', null, { ...CFG, timeoutMs: 50, maxRetries: 2 });
    assert.equal(r.ok, false);
    assert.match(r.text, /超时/);
    assert.equal(s.calls.length, 1, '超时不可重试,只发一次');
  } finally { s.restore(); }
});

test('响应不是合法 JSON → 明确报错,不重试', async () => {
  const s = stubFetch(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } }));
  try {
    const r = await describeImageFromBase64(B64, 'image/png', null, CFG);
    assert.equal(r.ok, false);
    assert.match(r.text, /合法 JSON/);
    assert.equal(s.calls.length, 1);
  } finally { s.restore(); }
});

test('模型返回空内容 → 不算成功', async () => {
  const s = stubFetch(() => okRes('   '));
  try {
    const r = await describeImageFromBase64(B64, 'image/png', null, CFG);
    assert.equal(r.ok, false);
    assert.match(r.text, /空内容/);
  } finally { s.restore(); }
});

test('模型未返回 content(choices 缺失)→ 不算成功', async () => {
  const s = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ choices: [] }) }));
  try {
    const r = await describeImageFromBase64(B64, 'image/png', null, CFG);
    assert.equal(r.ok, false);
    assert.match(r.text, /未返回内容/);
  } finally { s.restore(); }
});

test('maxTokens=0 → 请求体不含 max_tokens 字段(显式关闭)', async () => {
  const s = stubFetch(() => okRes('x'));
  try {
    await describeImageFromBase64(B64, 'image/png', null, { ...CFG, maxTokens: 0 });
    const body = JSON.parse(s.calls[0].opts.body);
    assert.ok(!('max_tokens' in body), '显式 0 不应发送 max_tokens 字段');
  } finally { s.restore(); }
});

test('maxTokens 正数 → 请求体携带指定值', async () => {
  const s = stubFetch(() => okRes('x'));
  try {
    await describeImageFromBase64(B64, 'image/png', null, { ...CFG, maxTokens: 1000 });
    const body = JSON.parse(s.calls[0].opts.body);
    assert.equal(body.max_tokens, 1000);
  } finally { s.restore(); }
});

// ---------------------------------------------------------------------------
// 错误体脱敏
// ---------------------------------------------------------------------------
test('错误响应体回显本机 apiKey → 替换为 [REDACTED]', async () => {
  const leaky = JSON.stringify({ error: { message: 'invalid key sk-test-abcdefghij', token: 'sk-test-abcdefghij' } });
  const s = stubFetch(() => errRes(400, leaky));
  try {
    const r = await describeImageFromBase64(B64, 'image/png', null, CFG);
    assert.equal(r.ok, false);
    assert.ok(!r.text.includes('sk-test-abcdefghij'), '不得回显 apiKey');
    assert.match(r.text, /\[REDACTED\]/);
  } finally { s.restore(); }
});

test('非 JSON 的凭据行(Authentication: Bearer sk-xxx)整行丢弃', async () => {
  const leaky = 'Something went wrong\nAuthentication: Bearer sk-test-abcdefghij\nTry again';
  const s = stubFetch(() => errRes(500, leaky));
  try {
    const r = await describeImageFromBase64(B64, 'image/png', null, CFG);
    assert.equal(r.ok, false);
    assert.ok(!r.text.includes('sk-test-abcdefghij'));
    assert.ok(!r.text.includes('Authentication: Bearer'), '敏感行应被整行删除');
    assert.match(r.text, /Something went wrong/);
  } finally { s.restore(); }
});

test('脱敏后若整段只剩敏感信息 → 提示已隐藏', async () => {
  // 整段是"凭据形态"的行(非 JSON,整行被丢弃) → lines 为空 → 走"已隐藏"分支
  const s = stubFetch(() => errRes(500, 'Authorization: Bearer sk-test-abcdefghij'));
  try {
    const r = await describeImageFromBase64(B64, 'image/png', null, CFG);
    assert.equal(r.ok, false);
    assert.ok(!r.text.includes('sk-test-abcdefghij'));
    assert.match(r.text, /已隐藏/);
  } finally { s.restore(); }
});

// ---------------------------------------------------------------------------
// 本地图片读取(readLocalImage / describeImage / ocrImage)
// ---------------------------------------------------------------------------
test('不支持的扩展名 → 明确提示', async () => {
  const r = await readLocalImage('test/note.txt', 'prompt', false, CFG);
  assert.equal(r.ok, false);
  assert.match(r.text, /不支持的图片格式/);
});

test('文件不存在(相对路径)→ 提示找不到文件并说明相对 cwd 解析', async () => {
  const r = await readLocalImage('test/not-exists.png', 'prompt', false, CFG);
  assert.equal(r.ok, false);
  assert.match(r.text, /找不到文件/);
});

test('describeImage 读取真实 test/test.png 并成功描述(mock fetch)', async () => {
  const s = stubFetch(() => okRes('白底,中央有红色圆形'));
  try {
    const r = await describeImage('test/test.png', '描述颜色');
    assert.equal(r.ok, true);
    assert.equal(r.text, '白底,中央有红色圆形');
  } finally { s.restore(); }
});

test('ocrImage 走 OCR 提示词(mock fetch 校验请求体)', async () => {
  const s = stubFetch(() => okRes('HELLO WORLD'));
  try {
    const r = await ocrImage('test/test.png');
    assert.equal(r.ok, true);
    const body = JSON.parse(s.calls[0].opts.body);
    assert.match(body.messages[1].content[0].text, /提取图中所有文字/);
    assert.equal(body.max_tokens, 4096, 'OCR 默认更长输出上限');
  } finally { s.restore(); }
});

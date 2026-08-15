// 视觉调用核心测试:请求错误路径(超时/429 重试/401 不重试/空内容)、
// 错误体脱敏、base64 输入校验、本地图片读取。
// 全部通过替换全局 fetch 模拟网络,不消耗视觉 API。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describeImageFromBase64, readLocalImage, describeImage, ocrImage, clearVisionCache } from '../src/text-vision-client.js';

// 测试注入用配置(避免依赖真实环境变量)
const CFG = {
  apiBase: 'https://mock.example.com/v1',
  apiKey: 'sk-test-abcdefghij', // 长度 >= 8,脱敏逻辑才会替换
  model: 'mock-model',
  timeoutMs: 5000,
  maxImageMB: 10,
  maxTokens: null, // 未配置,由 callVision 按场景取默认
  maxRetries: 1,
  retrySleep: () => Promise.resolve() // 重试退避即时返回,避免 429/5xx 用例真等几百 ms
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
// VISION_LOG_FILE 同样指向每次用例独立的临时目录,避免测试把日志写进仓库 .text-vision/log.txt
const VISION_ENV = ['VISION_API_BASE', 'VISION_API_KEY', 'VISION_MODEL', 'VISION_LOG_FILE', 'VISION_LOG_SUCCESS'];
const savedEnv = {};
let logDir = '';
beforeEach(() => {
  for (const k of VISION_ENV) savedEnv[k] = process.env[k];
  process.env.VISION_API_BASE = 'https://mock.example.com/v1';
  process.env.VISION_API_KEY = 'sk-test-abcdefghij';
  process.env.VISION_MODEL = 'mock-model';
  logDir = mkdtempSync(join(tmpdir(), 'text-vision-test-log-'));
  process.env.VISION_LOG_FILE = join(logDir, 'log.txt');
  // 清除外部环境可能设的 VISION_LOG_SUCCESS,保证"成功默认写日志"用例不受 ambient 环境(如 CI 全局设 0)影响
  delete process.env.VISION_LOG_SUCCESS;
});
afterEach(() => {
  for (const k of VISION_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { rmSync(logDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
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

test('单行 JSON 错误体回显 "Bearer <JWT>" → 令牌被脱敏(带 scheme 前缀不再绕过)', async () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const leaky = JSON.stringify({ error: { message: 'invalid_token', raw: `Bearer ${jwt}` } });
  const s = stubFetch(() => errRes(401, leaky));
  try {
    const r = await describeImageFromBase64(B64, 'image/png', null, CFG);
    assert.equal(r.ok, false);
    assert.ok(!r.text.includes(jwt), '完整 JWT 不应泄漏');
    assert.ok(!r.text.includes(jwt.split('.')[1]), 'JWT payload 段不应泄漏');
    assert.match(r.text, /\[REDACTED\]/);
  } finally { s.restore(); }
});

test('JSON 错误体在敏感字段名(access_token)下回显裸 JWT → 值被脱敏', async () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const s = stubFetch(() => errRes(401, JSON.stringify({ error: { access_token: jwt } })));
  try {
    const r = await describeImageFromBase64(B64, 'image/png', null, CFG);
    assert.ok(!r.text.includes(jwt.split('.')[1]), 'JWT payload 段不应泄漏');
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

test('错误响应体为空 → 报"响应体为空",不误标成"敏感信息已隐藏"', async () => {
  const s = stubFetch(() => errRes(500, ''));
  try {
    const r = await describeImageFromBase64(B64, 'image/png', null, CFG);
    assert.equal(r.ok, false);
    assert.match(r.text, /响应体为空/);
    assert.ok(!r.text.includes('已隐藏'), '空 body 不应被误标成敏感信息已隐藏');
  } finally { s.restore(); }
});

test('错误响应体为空白字符 → 同样报"响应体为空"', async () => {
  const s = stubFetch(() => errRes(500, '   \n\t  '));
  try {
    const r = await describeImageFromBase64(B64, 'image/png', null, CFG);
    assert.match(r.text, /响应体为空/);
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

test('文件不存在(相对路径)→ 回显用户传入的相对路径(便于核对拼写),并说明相对 cwd 解析', async () => {
  const r = await readLocalImage('test/not-exists.png', 'prompt', false, CFG);
  assert.equal(r.ok, false);
  assert.match(r.text, /找不到文件/);
  assert.ok(r.text.includes('test/not-exists.png'), '相对路径不含本机结构,应原样回显便于用户核对拼写');
  assert.match(r.text, /相对路径/, '仍说明相对路径解析规则');
});

test('文件不存在(绝对路径)→ 绝对路径(可能含用户名)脱敏为占位符,不泄露本机结构', async () => {
  const r = await readLocalImage('C:\\Users\\someone\\Desktop\\not-exists.png', 'prompt', false, CFG);
  assert.equal(r.ok, false);
  assert.match(r.text, /找不到文件/);
  assert.match(r.text, /\[本地路径\]/, '绝对路径(可能含用户名/启动目录)应以占位符出现');
  assert.ok(!r.text.includes('someone'), '不得泄露用户名');
  assert.ok(!r.text.includes('not-exists.png'), '绝对路径的文件名也整体脱敏');
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

// ---------------------------------------------------------------------------
// 调用者提供的完整提示词(prompt):原样作为 user 消息,不走固定模板
// ---------------------------------------------------------------------------
test('describeImage 传 prompt → user 消息原样等于 prompt,不被模板包裹', async () => {
  const s = stubFetch(() => okRes('描述成功'));
  try {
    const r = await describeImage('test/test.png', null, '这个图标代表什么含义?');
    assert.equal(r.ok, true);
    const body = JSON.parse(s.calls[0].opts.body);
    assert.equal(body.messages[1].content[0].text, '这个图标代表什么含义?');
    assert.match(body.messages[0].content, /视觉描述助手/, '系统提示词仍为固定描述护栏,不受 prompt 影响');
  } finally { s.restore(); }
});

test('ocrImage 传 prompt → user 消息原样等于 prompt,系统仍为 OCR、max_tokens 4096', async () => {
  const s = stubFetch(() => okRes('文字'));
  try {
    const r = await ocrImage('test/test.png', '提取图中所有中文并保留表格排版');
    assert.equal(r.ok, true);
    const body = JSON.parse(s.calls[0].opts.body);
    assert.equal(body.messages[1].content[0].text, '提取图中所有中文并保留表格排版');
    assert.match(body.messages[0].content, /OCR 文字提取助手/, '系统提示词仍为 OCR');
    assert.equal(body.max_tokens, 4096, 'OCR 场景默认输出上限不变');
  } finally { s.restore(); }
});

test('describeImageFromBase64 传 prompt(第 7 位)→ user 消息原样等于 prompt', async () => {
  const s = stubFetch(() => okRes('图表分析'));
  try {
    const r = await describeImageFromBase64(B64, 'image/png', null, CFG, undefined, undefined, '分析这张图表的坐标轴与趋势');
    assert.equal(r.ok, true);
    const body = JSON.parse(s.calls[0].opts.body);
    assert.equal(body.messages[1].content[0].text, '分析这张图表的坐标轴与趋势');
  } finally { s.restore(); }
});

test('prompt 为空白 → 视为未传,回退 focus 模板', async () => {
  const s = stubFetch(() => okRes('x'));
  try {
    await describeImageFromBase64(B64, 'image/png', '关注颜色', CFG, undefined, undefined, '   ');
    const body = JSON.parse(s.calls[0].opts.body);
    assert.match(body.messages[1].content[0].text, /重点关注:关注颜色/, '空白 prompt 应回退到 focus 默认句式');
  } finally { s.restore(); }
});

// ---------------------------------------------------------------------------
// 日志落盘:视觉调用失败必写、成功默认写(VISION_LOG_SUCCESS=0 关闭),写入 VISION_LOG_FILE
// ---------------------------------------------------------------------------
test('HTTP 失败 → 写 [vision_failed],含 HTTP 状态与模型', async () => {
  const s = stubFetch(() => errRes(400, 'bad request'));
  try {
    await describeImageFromBase64(B64, 'image/png', null, CFG);
    const content = readFileSync(join(logDir, 'log.txt'), 'utf8');
    assert.match(content, /\[vision_failed\]/);
    assert.match(content, /HTTP 400/);
    assert.match(content, /模型=mock-model/);
  } finally { s.restore(); }
});

test('成功 → 默认写 [vision_ok],含耗时', async () => {
  const s = stubFetch(() => okRes('ok'));
  try {
    await describeImageFromBase64(B64, 'image/png', null, CFG);
    const content = readFileSync(join(logDir, 'log.txt'), 'utf8');
    assert.match(content, /\[vision_ok\]/);
    assert.match(content, /耗时=\d+ms/);
  } finally { s.restore(); }
});

test('成功日志不拼路径:[vision_ok] 只含来源标签,不含被看图绝对路径', async () => {
  const s = stubFetch(() => okRes('ok'));
  try {
    await describeImage('test/test.png'); // 走 readLocalImage,失败行会带绝对路径;成功行应只有 "描述"
    const content = readFileSync(join(logDir, 'log.txt'), 'utf8');
    assert.match(content, /\[vision_ok\] 描述 成功/, '成功行应只含来源标签');
    assert.ok(!content.includes('test.png'), '成功日志不应包含被看图路径');
    assert.ok(!/^[A-Za-z]:\\/m.test(content), '成功日志不应包含盘符绝对路径');
  } finally { s.restore(); }
});

test('VISION_LOG_SUCCESS=0 → 成功不写日志', async () => {
  process.env.VISION_LOG_SUCCESS = '0';
  const s = stubFetch(() => okRes('ok'));
  try {
    await describeImageFromBase64(B64, 'image/png', null, CFG);
    const logPath = join(logDir, 'log.txt');
    // 成功日志被关闭时可能根本没创建日志文件,容忍存在/不存在两种状态,只要没有 [vision_ok] 行
    const content = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    assert.ok(!content.includes('[vision_ok]'), '关闭成功日志后不应写 [vision_ok]');
  } finally { s.restore(); }
});

test('文件不存在 → 写 [vision_failed],日志保留原始绝对路径便于定位', async () => {
  await readLocalImage('C:\\Users\\someone\\Desktop\\no.png', 'prompt', false, CFG);
  const content = readFileSync(join(logDir, 'log.txt'), 'utf8');
  assert.match(content, /\[vision_failed\]/);
  assert.match(content, /找不到文件/);
  assert.ok(content.includes('no.png'), '日志应记录原始路径(本地私有文件,不入 git)');
});

test('VISION_LOG_SUCCESS=0 → 失败仍写 [vision_failed](失败日志不受开关影响)', async () => {
  process.env.VISION_LOG_SUCCESS = '0';
  const s = stubFetch(() => errRes(400, 'bad request'));
  try {
    await describeImageFromBase64(B64, 'image/png', null, CFG);
    const content = readFileSync(join(logDir, 'log.txt'), 'utf8');
    assert.match(content, /\[vision_failed\]/, '失败日志不应受 VISION_LOG_SUCCESS=0 影响');
    assert.ok(!content.includes('[vision_ok]'), '关闭成功日志后不应写 [vision_ok]');
  } finally { s.restore(); }
});

test('base64 非法输入 → 写 [vision_failed],含来源标签', async () => {
  await describeImageFromBase64('!!!not-base64!!!', 'image/png', null, CFG);
  const content = readFileSync(join(logDir, 'log.txt'), 'utf8');
  assert.match(content, /\[vision_failed\]/);
  assert.match(content, /base64 输入包含非法字符/);
  assert.match(content, /截屏/, '失败行应含来源标签');
});

test('base64 超限 → 写 [vision_failed],不发请求', async () => {
  // maxImageMB 是直接注入对象,不受 buildConfig 钳制;约 2KB 输入超过 0.001MB 限制即触发
  const bigB64 = Buffer.alloc(2000).toString('base64');
  await describeImageFromBase64(bigB64, 'image/png', null, { ...CFG, maxImageMB: 0.001 });
  const content = readFileSync(join(logDir, 'log.txt'), 'utf8');
  assert.match(content, /\[vision_failed\]/);
  assert.match(content, /图片过大/);
});

test('视觉引擎未配置 → 写 [vision_failed],含 模型=(空)', async () => {
  const saved = {};
  for (const k of ['VISION_API_BASE', 'VISION_API_KEY', 'VISION_MODEL']) saved[k] = process.env[k];
  try {
    delete process.env.VISION_API_BASE;
    delete process.env.VISION_API_KEY;
    delete process.env.VISION_MODEL;
    await describeImageFromBase64(B64, 'image/png', null, undefined); // 不传 cfg,走 loadConfig 读 env
    const content = readFileSync(join(logDir, 'log.txt'), 'utf8');
    assert.match(content, /\[vision_failed\]/);
    assert.match(content, /视觉引擎未配置/);
    assert.match(content, /模型=\(空\)/);
  } finally {
    for (const k of ['VISION_API_BASE', 'VISION_API_KEY', 'VISION_MODEL']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('图片为空文件(stat 预检 0 字节)→ 写 [vision_failed]', async () => {
  // 空文件(0 字节)在 stat 预检就被拦截,返回"图片内容为空"并写日志;
  // 目录同理(statSync 的 size 为 0),指向目录时走的也是这条分支,而非读取错误分支
  const emptyPng = join(logDir, 'empty.png');
  writeFileSync(emptyPng, '');
  try {
    await readLocalImage(emptyPng, 'prompt', false, CFG);
    const content = readFileSync(join(logDir, 'log.txt'), 'utf8');
    assert.match(content, /\[vision_failed\]/);
    assert.match(content, /图片内容为空/);
  } finally { rmSync(emptyPng, { force: true }); }
});

test('VISION_LOG_SUCCESS=false → 成功不写日志(false 与 0 等价)', async () => {
  process.env.VISION_LOG_SUCCESS = 'false';
  const s = stubFetch(() => okRes('ok'));
  try {
    await describeImageFromBase64(B64, 'image/png', null, CFG);
    const logPath = join(logDir, 'log.txt');
    const content = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    assert.ok(!content.includes('[vision_ok]'), 'VISION_LOG_SUCCESS=false 后不应写 [vision_ok]');
  } finally { s.restore(); }
});

test('describeImageFromBase64 传 source(带截图路径)→ 失败日志含原始路径', async () => {
  // 截屏失败日志应能定位到是哪个截图文件:index.js 把 source 拼成 "截屏 <filePath>"
  const s = stubFetch(() => errRes(400, 'bad request'));
  try {
    await describeImageFromBase64(B64, 'image/png', null, CFG, '截屏 C:\\shots\\shot-1.jpeg', '截屏');
    const content = readFileSync(join(logDir, 'log.txt'), 'utf8');
    assert.match(content, /\[vision_failed\]/);
    assert.match(content, /截屏/, '失败行应含来源标签');
    assert.ok(content.includes('shot-1.jpeg'), '失败日志应含截图文件路径,便于定位是哪个截图');
  } finally { s.restore(); }
});

test('describeImageFromBase64 传 source(带路径)+sourceLabel → 成功日志只含 sourceLabel,不含路径', async () => {
  // 成功日志用 sourceLabel('截屏')而非带路径的 source,维持"成功行不含路径"承诺
  const s = stubFetch(() => okRes('ok'));
  try {
    await describeImageFromBase64(B64, 'image/png', null, CFG, '截屏 C:\\shots\\shot-1.jpeg', '截屏');
    const content = readFileSync(join(logDir, 'log.txt'), 'utf8');
    assert.match(content, /\[vision_ok\] 截屏 成功/, '成功日志应只含纯来源标签');
    assert.ok(!content.includes('shot-1.jpeg'), '成功日志不应包含截图文件路径');
  } finally { s.restore(); }
});

// ---------------------------------------------------------------------------
// 多端点 fallback(apiBases):主端点不可用(网络/5xx/429/超时)→ 换下一个;确定性失败不换
// ---------------------------------------------------------------------------
test('多端点:主端点 503 → 重试后 fallback 到备用端点成功', async () => {
  // CFG.maxRetries=1:主端点 503 先重试一次,仍失败才换备用端点
  const s = stubFetch((url) => url.includes('primary.example.com') ? errRes(503, 'down') : okRes('备用端点成功'));
  try {
    const cfg2 = { ...CFG, apiBases: ['https://primary.example.com/v1', 'https://backup.example.com/v1'], apiBase: 'https://primary.example.com/v1' };
    const r = await describeImageFromBase64(B64, 'image/png', null, cfg2);
    assert.equal(r.ok, true);
    assert.equal(r.text, '备用端点成功');
    assert.equal(s.calls.length, 3, '主端点 503 重试一次 + 备用端点一次,共 3 次请求');
  } finally { s.restore(); }
});

test('多端点:主端点超时(AbortError)→ fallback 到备用端点', async () => {
  const s = stubFetch((url) => url.includes('primary.example.com')
    ? new Promise((resolve, reject) => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); })
    : okRes('备用成功'));
  try {
    const cfg2 = { ...CFG, apiBases: ['https://primary.example.com/v1', 'https://backup.example.com/v1'] };
    const r = await describeImageFromBase64(B64, 'image/png', null, cfg2);
    assert.equal(r.ok, true);
    assert.equal(r.text, '备用成功');
    assert.equal(s.calls.length, 2, '超时不重试但应 fallback');
  } finally { s.restore(); }
});

test('多端点:主端点 401(认证错)→ 不 fallback(换端点同 key 不解决)', async () => {
  const s = stubFetch(() => errRes(401, 'invalid key'));
  try {
    const cfg2 = { ...CFG, apiBases: ['https://primary.example.com/v1', 'https://backup.example.com/v1'] };
    const r = await describeImageFromBase64(B64, 'image/png', null, cfg2);
    assert.equal(r.ok, false);
    assert.equal(s.calls.length, 1, '401 不应 fallback 到备用端点');
  } finally { s.restore(); }
});

test('多端点:两个端点都失败 → 返回失败,两个端点都留失败日志', async () => {
  const s = stubFetch((url) => errRes(500, 'boom'));
  try {
    const cfg2 = { ...CFG, apiBases: ['https://primary.example.com/v1', 'https://backup.example.com/v1'] };
    const r = await describeImageFromBase64(B64, 'image/png', null, cfg2);
    assert.equal(r.ok, false);
    assert.match(r.text, /HTTP 500/);
    const content = readFileSync(join(logDir, 'log.txt'), 'utf8');
    // 主端点 500 重试一次(2 条)+ 备用端点 500(1 条),fallback 链路每步都留痕
    assert.match(content, /\[vision_failed\]/);
  } finally { s.restore(); }
});

test('多端点:注入只有 apiBase(无 apiBases)→ 兼容单端点', async () => {
  const s = stubFetch(() => okRes('单端点'));
  try {
    const r = await describeImageFromBase64(B64, 'image/png', null, CFG); // CFG 无 apiBases 字段
    assert.equal(r.ok, true);
    assert.equal(r.text, '单端点');
    assert.equal(s.calls.length, 1);
  } finally { s.restore(); }
});

// ---------------------------------------------------------------------------
// 成功结果缓存(cacheSize):同图同问命中,省视觉调用
// ---------------------------------------------------------------------------
test('缓存:cacheSize>0 → 同图同问第二次命中,不发第二次请求', async () => {
  let n = 0;
  const s = stubFetch(() => { n++; return okRes('内容A'); });
  try {
    const cfgC = { ...CFG, cacheSize: 10 };
    const r1 = await describeImageFromBase64(B64, 'image/png', null, cfgC);
    assert.equal(r1.ok, true);
    const r2 = await describeImageFromBase64(B64, 'image/png', null, cfgC);
    assert.equal(r2.ok, true);
    assert.equal(r2.text, '内容A');
    assert.equal(n, 1, '第二次应命中缓存,不发请求');
  } finally { s.restore(); clearVisionCache(); }
});

test('缓存:不同 prompt 不命中', async () => {
  let n = 0;
  const s = stubFetch(() => { n++; return okRes('x'); });
  try {
    const cfgC = { ...CFG, cacheSize: 10 };
    await describeImageFromBase64(B64, 'image/png', '提示A', cfgC);
    await describeImageFromBase64(B64, 'image/png', '提示B', cfgC);
    assert.equal(n, 2, 'prompt 不同不命中');
  } finally { s.restore(); clearVisionCache(); }
});

test('缓存:cacheSize=0(默认)→ 不缓存,重复调用各发一次', async () => {
  let n = 0;
  const s = stubFetch(() => { n++; return okRes('x'); });
  try {
    await describeImageFromBase64(B64, 'image/png', null, CFG);
    await describeImageFromBase64(B64, 'image/png', null, CFG);
    assert.equal(n, 2, 'cacheSize=0 不缓存');
  } finally { s.restore(); }
});

test('缓存:命中时写 [vision_cache] 日志,且不写 [vision_ok](未实际调用)', async () => {
  const s = stubFetch(() => okRes('ok'));
  try {
    const cfgC = { ...CFG, cacheSize: 10 };
    await describeImageFromBase64(B64, 'image/png', null, cfgC);
    await describeImageFromBase64(B64, 'image/png', null, cfgC);
    const content = readFileSync(join(logDir, 'log.txt'), 'utf8');
    assert.match(content, /\[vision_cache\]/);
    const okCount = (content.match(/\[vision_ok\]/g) || []).length;
    assert.equal(okCount, 1, '只有第一次实际调用写 vision_ok');
  } finally { s.restore(); clearVisionCache(); }
});

// ---------------------------------------------------------------------------
// 大图超限自动压缩(集成):readLocalImage 超限 → 尝试压缩,成功用产物发送 / 失败回落报错
// ---------------------------------------------------------------------------
test('大图超限:自动压缩成功 → 用 JPEG 压缩产物发送并返回描述', async () => {
  const big = join(logDir, 'big.png');
  writeFileSync(big, Buffer.alloc(1_500_000)); // 1.5MB > 1MB 上限
  const execFileFn = async (cmd, args) => { writeFileSync(args[args.length - 1], Buffer.alloc(200_000)); };
  const cfgC = { ...CFG, maxImageMB: 1, compressDeps: { platform: 'darwin', execFileFn } };
  const s = stubFetch((url, opts) => {
    const body = JSON.parse(opts.body);
    const imgUrl = body.messages[1].content[1].image_url.url;
    assert.match(imgUrl, /^data:image\/jpeg;base64,/, '压缩产物应声明为 JPEG');
    return okRes('压缩后内容');
  });
  try {
    const r = await readLocalImage(big, 'prompt', false, cfgC);
    assert.equal(r.ok, true);
    assert.equal(r.text, '压缩后内容');
  } finally { s.restore(); }
});

test('大图超限:压缩不可用(工具缺失)→ 回落到原报错,不发请求', async () => {
  const big = join(logDir, 'big.png');
  writeFileSync(big, Buffer.alloc(1_500_000));
  const cfgC = { ...CFG, maxImageMB: 1, compressDeps: { platform: 'darwin', execFileFn: async () => { throw new Error('no tool'); } } };
  const s = stubFetch(() => okRes('x'));
  try {
    const r = await readLocalImage(big, 'prompt', false, cfgC);
    assert.equal(r.ok, false);
    assert.match(r.text, /图片过大/);
    assert.equal(s.calls.length, 0, '压缩失败不应发请求');
  } finally { s.restore(); }
});

test('大图超限:压缩后仍超限 → 回落到原报错', async () => {
  const big = join(logDir, 'big.png');
  writeFileSync(big, Buffer.alloc(1_500_000));
  const cfgC = { ...CFG, maxImageMB: 1, compressDeps: { platform: 'darwin', execFileFn: async (cmd, args) => { writeFileSync(args[args.length - 1], Buffer.alloc(2_000_000)); } } };
  const s = stubFetch(() => okRes('x'));
  try {
    const r = await readLocalImage(big, 'prompt', false, cfgC);
    assert.equal(r.ok, false);
    assert.match(r.text, /图片过大/);
    assert.equal(s.calls.length, 0);
  } finally { s.restore(); }
});

test('图片为空文件(0 字节)→ 不尝试压缩,直接报错(压缩空文件无意义)', async () => {
  const empty = join(logDir, 'empty.png');
  writeFileSync(empty, '');
  let compressCalled = false;
  const cfgC = { ...CFG, maxImageMB: 1, compressDeps: { platform: 'darwin', execFileFn: async () => { compressCalled = true; } } };
  const r = await readLocalImage(empty, 'prompt', false, cfgC);
  assert.equal(r.ok, false);
  assert.match(r.text, /内容为空/);
  assert.equal(compressCalled, false, '空文件不应触发压缩');
});

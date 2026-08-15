// 配置解析测试:VISION_* 环境变量 → buildConfig 的解析、数字回退与钳制。
// 全部基于纯函数 buildConfig(),不触网。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../src/text-vision-client.js';

const VISION_KEYS = ['VISION_API_BASE', 'VISION_API_KEY', 'VISION_MODEL', 'VISION_TIMEOUT',
  'VISION_MAX_IMAGE_MB', 'VISION_MAX_TOKENS', 'VISION_MAX_RETRIES', 'VISION_CACHE_SIZE'];

// 保存/恢复环境变量,避免用例间互相污染
const saved = {};
beforeEach(() => {
  for (const k of VISION_KEYS) saved[k] = process.env[k];
  for (const k of VISION_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of VISION_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test('空环境变量 → 默认值(apiBase 为空)', () => {
  const cfg = buildConfig();
  assert.equal(cfg.apiBase, '');
  assert.equal(cfg.apiKey, '');
  assert.equal(cfg.model, '');
  assert.equal(cfg.timeoutMs, 90000);
  assert.equal(cfg.maxImageMB, 10);
  assert.equal(cfg.maxTokens, null); // null = 未配置,由调用方按场景取默认
  assert.equal(cfg.maxRetries, 1);
});

test('正常配置正确解析,apiBase 去掉尾部斜杠', () => {
  process.env.VISION_API_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1/';
  process.env.VISION_API_KEY = 'sk-1234567890';
  process.env.VISION_MODEL = 'qwen-vl-max';
  process.env.VISION_TIMEOUT = '5000';
  process.env.VISION_MAX_IMAGE_MB = '20';
  process.env.VISION_MAX_TOKENS = '1000';
  process.env.VISION_MAX_RETRIES = '3';
  const cfg = buildConfig();
  assert.equal(cfg.apiBase, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(cfg.apiKey, 'sk-1234567890');
  assert.equal(cfg.model, 'qwen-vl-max');
  assert.equal(cfg.timeoutMs, 5000);
  assert.equal(cfg.maxImageMB, 20);
  assert.equal(cfg.maxTokens, 1000);
  assert.equal(cfg.maxRetries, 3);
});

test('字符串型 env 带首尾空白 → 统一 trim(apiBase 再去尾斜杠,避免空白进 URL/鉴权头/请求体)', () => {
  process.env.VISION_API_BASE = '  https://dashscope.aliyuncs.com/compatible-mode/v1/  ';
  process.env.VISION_API_KEY = '  sk-1234567890  ';
  process.env.VISION_MODEL = '  qwen-vl-max  ';
  const cfg = buildConfig();
  assert.equal(cfg.apiBase, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(cfg.apiKey, 'sk-1234567890');
  assert.equal(cfg.model, 'qwen-vl-max');
});

test('非数字配置回退默认值,避免 Number() 得到 NaN', () => {
  process.env.VISION_TIMEOUT = 'abc';
  process.env.VISION_MAX_IMAGE_MB = 'not-a-number';
  process.env.VISION_MAX_RETRIES = 'x';
  const cfg = buildConfig();
  assert.equal(cfg.timeoutMs, 90000);
  assert.equal(cfg.maxImageMB, 10);
  assert.equal(cfg.maxRetries, 1);
});

test('数值钳制:VISION_TIMEOUT=0 不会"立即超时",钳到下限 1000', () => {
  process.env.VISION_TIMEOUT = '0';
  assert.equal(buildConfig().timeoutMs, 1000);
  process.env.VISION_TIMEOUT = '-500';
  assert.equal(buildConfig().timeoutMs, 1000);
});

test('VISION_MAX_IMAGE_MB 下限 1,上限不做限制', () => {
  process.env.VISION_MAX_IMAGE_MB = '0.5';
  assert.equal(buildConfig().maxImageMB, 1);
  process.env.VISION_MAX_IMAGE_MB = '-5';
  assert.equal(buildConfig().maxImageMB, 1);
});

test('VISION_MAX_RETRIES 钳制到 0-5', () => {
  process.env.VISION_MAX_RETRIES = '99';
  assert.equal(buildConfig().maxRetries, 5);
  process.env.VISION_MAX_RETRIES = '-1';
  assert.equal(buildConfig().maxRetries, 0);
  process.env.VISION_MAX_RETRIES = '2.9';
  assert.equal(buildConfig().maxRetries, 2); // 取整
});

test('VISION_MAX_TOKENS 负数/非数字 → null(未配置,由调用方按场景取默认)', () => {
  process.env.VISION_MAX_TOKENS = '-100';
  assert.equal(buildConfig().maxTokens, null);
  process.env.VISION_MAX_TOKENS = 'abc';
  assert.equal(buildConfig().maxTokens, null);
});

test('VISION_MAX_TOKENS=0 → 0(显式关闭:不发送 max_tokens 字段)', () => {
  process.env.VISION_MAX_TOKENS = '0';
  assert.equal(buildConfig().maxTokens, 0);
});

test('VISION_API_BASE 逗号分隔多端点 → apiBases 数组,apiBase 取第一个(向后兼容)', () => {
  process.env.VISION_API_BASE = 'https://one.example.com/v1, https://two.example.com/v1/ ';
  const cfg = buildConfig();
  assert.equal(cfg.apiBase, 'https://one.example.com/v1');
  assert.deepEqual(cfg.apiBases, ['https://one.example.com/v1', 'https://two.example.com/v1']);
});

test('VISION_API_BASE 只一个端点(无逗号)→ apiBases 单元素', () => {
  process.env.VISION_API_BASE = 'https://only.example.com/v1';
  const cfg = buildConfig();
  assert.deepEqual(cfg.apiBases, ['https://only.example.com/v1']);
});

test('VISION_API_BASE 空 → apiBases 空数组(未配置)', () => {
  assert.deepEqual(buildConfig().apiBases, []);
});

test('VISION_CACHE_SIZE:默认 0(关闭缓存)', () => {
  assert.equal(buildConfig().cacheSize, 0);
});

test('VISION_CACHE_SIZE:正数开启,负数/非数字钳到 0(不缓存)', () => {
  process.env.VISION_CACHE_SIZE = '50';
  assert.equal(buildConfig().cacheSize, 50);
  process.env.VISION_CACHE_SIZE = '-1';
  assert.equal(buildConfig().cacheSize, 0);
  process.env.VISION_CACHE_SIZE = 'abc';
  assert.equal(buildConfig().cacheSize, 0);
  process.env.VISION_CACHE_SIZE = '0.5';
  assert.equal(buildConfig().cacheSize, 0); // 取整
});

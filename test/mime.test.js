// MIME 魔数识别、图片路径判断、大小限制、URL 凭据脱敏测试。
// 全部基于纯函数,不触网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffMime, isImagePath, isOverSize, redactUrlCreds, SUPPORTED_EXTS_TEXT } from '../src/text-vision-client.js';

// 用真实文件头构造测试字节(只需魔数前缀,不用完整文件)
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const GIF = Buffer.from('GIF89a');
const WEBP = Buffer.from('RIFF\x00\x00\x00\x00WEBP');
// BITMAPFILEHEADER(14 字节):"BM" + 文件大小 + 保留字段(6-7 恒为 0)+ 数据偏移
const BMP = Buffer.from([0x42, 0x4D, 0x36, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00, 0x00, 0x00]);

test('sniffMime:按文件头识别真实 MIME', () => {
  assert.equal(sniffMime(JPEG), 'image/jpeg');
  assert.equal(sniffMime(PNG), 'image/png');
  assert.equal(sniffMime(GIF), 'image/gif');
  assert.equal(sniffMime(WEBP), 'image/webp');
  assert.equal(sniffMime(BMP), 'image/bmp');
});

test('sniffMime:识别不了返回 null(此时调用方回退扩展名)', () => {
  assert.equal(sniffMime(Buffer.from('hello world')), null);
  assert.equal(sniffMime(Buffer.alloc(0)), null);
});

test('sniffMime:buffer 过短不误判(长度不足时返回 null)', () => {
  assert.equal(sniffMime(Buffer.from([0xFF])), null);
  assert.equal(sniffMime(Buffer.from([0x89])), null);
  assert.equal(sniffMime(Buffer.from('BM')), null); // BMP 需 >= 8 字节
});

test('sniffMime:以 "BM" 开头但保留字段非 0 的文本不误判为 BMP', () => {
  assert.equal(sniffMime(Buffer.from('BMxxxxxx')), null);
});

test('isImagePath:按扩展名判断(忽略大小写)', () => {
  assert.equal(isImagePath('a.png'), true);
  assert.equal(isImagePath('a.JPG'), true);
  assert.equal(isImagePath('a.jpeg'), true);
  assert.equal(isImagePath('a.webp'), true);
  assert.equal(isImagePath('a.gif'), true);
  assert.equal(isImagePath('a.bmp'), true);
  assert.equal(isImagePath('a.txt'), false);
  assert.equal(isImagePath('a.PNG2'), false);
  assert.equal(isImagePath('noext'), false);
});

test('SUPPORTED_EXTS_TEXT 列出全部支持格式', () => {
  assert.equal(SUPPORTED_EXTS_TEXT, '.png/.jpg/.jpeg/.webp/.gif/.bmp');
});

test('isOverSize:达到或超过上限即拦截(含恰好等于)', () => {
  assert.equal(isOverSize(10 * 1024 * 1024, 10), true);
  assert.equal(isOverSize(10 * 1024 * 1024 + 1, 10), true);
  assert.equal(isOverSize(9 * 1024 * 1024, 10), false);
  assert.equal(isOverSize(0, 10), false);
});

test('redactUrlCreds:去除 URL 内嵌 user:pass 凭据', () => {
  assert.equal(redactUrlCreds('https://user:pass@host/v1'), 'https://[REDACTED]@host/v1');
  assert.equal(redactUrlCreds('https://host/v1'), 'https://host/v1');
  assert.equal(redactUrlCreds('无 URL 的普通报错'), '无 URL 的普通报错');
});

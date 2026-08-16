// hooks/shared.js 纯函数测试:isProtectedPath / buildVisionNote / relativeDisplayPath / applyHookDefaults。
// 这些是两条 hook 的共享逻辑,独立成模块后直接单测,防"同逻辑双实现"再次漂移。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProtectedPath, buildVisionNote, relativeDisplayPath, applyHookDefaults } from '../hooks/shared.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// isProtectedPath:防误伤路径判定(纯函数)
// ---------------------------------------------------------------------------
test('isProtectedPath:.git 内路径 → true', () => {
  assert.equal(isProtectedPath('C:\\repo\\.git\\x.png'), true);
  assert.equal(isProtectedPath('/repo/.git/x.png'), true);
});

test('isProtectedPath:node_modules 内路径 → true', () => {
  assert.equal(isProtectedPath('C:\\proj\\node_modules\\pkg\\icon.png'), true);
  assert.equal(isProtectedPath('/proj/node_modules/pkg/icon.png'), true);
});

test('isProtectedPath:本仓库 src/ 与 hooks/ 内路径 → true', () => {
  // shared.js 锚定仓库根:src/ 与 hooks/ 顶层目录都被保护(防递归注入)
  assert.equal(isProtectedPath(join(ROOT, 'src', 'index.js')), true);
  assert.equal(isProtectedPath(join(ROOT, 'hooks', 'read-image-hook.js')), true);
});

test('isProtectedPath:普通图片路径 → false', () => {
  assert.equal(isProtectedPath('C:\\Users\\me\\Desktop\\a.png'), false);
  assert.equal(isProtectedPath('/home/me/pics/a.png'), false);
  assert.equal(isProtectedPath('test/test.png'), false);
});

test('isProtectedPath:非本仓库的同名 src 目录(其他 text-vision 项目)→ 不误伤', () => {
  // 只锚定 shared.js 所在仓库根,其他项目 src/ 下的图片不应被保护
  assert.equal(isProtectedPath('D:\\other\\text-vision\\src\\banner.png'), false);
});

// ---------------------------------------------------------------------------
// buildVisionNote:注入文案组装
// ---------------------------------------------------------------------------
test('buildVisionNote:read 描述 → 标题【图片视觉描述】+ 不可信声明包裹', () => {
  const note = buildVisionNote({ scope: 'read', useOcr: false, showPath: 'a.png', text: '内容' });
  assert.match(note, /【图片视觉描述】文件 a\.png/);
  assert.match(note, /<vision_note>/);
  assert.match(note, /不可信数据/);
  assert.match(note, /^【图片视觉描述】文件 a\.png\n<vision_note>\n/);
  assert.ok(note.endsWith('</vision_note>'));
  assert.ok(!note.includes('【粘贴'), 'read 场景不应带"粘贴"前缀');
});

test('buildVisionNote:paste OCR → 标题【粘贴图片视觉OCR】', () => {
  const note = buildVisionNote({ scope: 'paste', useOcr: true, showPath: 'b.png', text: 'HELLO' });
  assert.match(note, /【粘贴图片视觉OCR】文件 b\.png/);
  assert.match(note, /HELLO/);
});

test('buildVisionNote:read OCR → 标题【图片视觉OCR】', () => {
  const note = buildVisionNote({ scope: 'read', useOcr: true, showPath: 'c.png', text: 'x' });
  assert.match(note, /【图片视觉OCR】/);
  assert.ok(!note.includes('粘贴'));
});

test('buildVisionNote:文本原样保留在包裹内', () => {
  const text = '白底,中央有红色圆形。\n第二行内容';
  const note = buildVisionNote({ scope: 'read', useOcr: false, showPath: 'd.png', text });
  assert.ok(note.includes(text), '视觉模型输出应原样保留');
});

// ---------------------------------------------------------------------------
// relativeDisplayPath:展示路径(cwd 内相对,否则回退文件名)
// ---------------------------------------------------------------------------
test('relativeDisplayPath:目标在 cwd 内 → 相对路径', () => {
  assert.equal(relativeDisplayPath('C:\\proj', 'C:\\proj\\sub\\a.png'), 'sub\\a.png');
});

test('relativeDisplayPath:目标在 cwd 外 → 回退文件名', () => {
  assert.equal(relativeDisplayPath('C:\\proj', 'D:\\elsewhere\\b.png'), 'b.png');
});

test('relativeDisplayPath:跨盘符时回退文件名', () => {
  assert.equal(relativeDisplayPath('C:\\proj', 'D:\\other\\deep\\c.png'), 'c.png');
});

// ---------------------------------------------------------------------------
// applyHookDefaults:hook 场景默认 30s 超时(不修改入参)
// ---------------------------------------------------------------------------
test('applyHookDefaults:未设 VISION_TIMEOUT 时默认 30000(不修改入参)', () => {
  const env = {};
  const out = applyHookDefaults(env);
  assert.equal(out.VISION_TIMEOUT, '30000');
  assert.ok(!('VISION_TIMEOUT' in env), '纯函数不应修改入参');
});

test('applyHookDefaults:已显式设置则不覆盖', () => {
  const out = applyHookDefaults({ VISION_TIMEOUT: '10000' });
  assert.equal(out.VISION_TIMEOUT, '10000');
});

test('applyHookDefaults:显式 VISION_TIMEOUT=0 不被覆盖(钳制交给 buildConfig)', () => {
  const out = applyHookDefaults({ VISION_TIMEOUT: '0' });
  assert.equal(out.VISION_TIMEOUT, '0');
});

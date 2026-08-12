// 防止发布后他人 clone 到别的目录导致文档失效。命中即打印"文件:行号"。
//
// 用法:node scripts/check-doc-paths.js(已注册为 npm run check:docs)
// AGENTS.md / CLAUDE.md 为本地文件(已 gitignore),仅在本机存在时被检查。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = join(root, 'docs');
const templatesDir = join(root, 'templates');
const targets = [
  'README.md',
  'README.en.md',
  'AGENTS.md',
  'CLAUDE.md',
  ...readdirSync(docsDir).filter(f => f.endsWith('.md')).map(f => join('docs', f)),
  // 模板会被复制进项目根、进入模型上下文,同样不该含本机绝对路径,一并检查
  ...readdirSync(templatesDir).filter(f => f.endsWith('.md')).map(f => join('templates', f))
].filter(f => existsSync(join(root, f)));

// 整行放行:URL(http/https)、node 完整路径教学示例(integration-guide 常见问题里讲 Windows 怎么写 node.exe)
function isWhitelisted(line) {
  return /:\/\//.test(line) || /Program Files/.test(line) || /node\.exe/.test(line);
}

// 疑似绝对路径识别:
//  - winPath:Windows 盘符路径(C:\Users\xx 或 C:/Users/xx)
//  - unixPath:Unix 绝对路径。限定常见根目录词开头(/usr/local/bin、/home/user/file),
//    避免把中文句子里用斜杠分隔的词(429/408/500、工具注册/schema/端到端)误当路径。
//    (?<!:) 排除 URL 的 ://(URL 行虽已被 isWhitelisted 整行放行,这里双保险)。
const winPath = /[A-Za-z]:[\\/][^\s"'()]*/;
const unixPath = /(?<!:)\/(?:usr|home|etc|var|opt|tmp|mnt|root|dev|run|bin|sbin|lib|srv|media)(?:\/[^\s"'()]*)?/;

for (const file of targets) {
  const lines = readFileSync(join(root, file), 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (isWhitelisted(line)) return;
    if (winPath.test(line) || unixPath.test(line)) {
      console.log(`${file}:${i + 1}: ${line.trim()}`);
    }
  });
}

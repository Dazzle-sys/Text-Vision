// 版本一致性校验:比对 package.json / server.json / .claude-plugin/plugin.json 三处 version,
// 不一致即退出码 1,拦截"release 时漏改一处导致注册清单与包版本漂移"。
// 仿照 check-doc-paths.js 的先例(命中即打印"文件:行号"),已接入 prepublishOnly 与 npm run check:version。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 待校验:文件相对路径 → 版本字段取值路径(点分隔)。server.json 有两处 version(顶层 + packages[0])。
const TARGETS = [
  { file: 'package.json', path: 'version' },
  { file: 'server.json', path: 'version' },
  { file: 'server.json', path: 'packages.0.version' },
  { file: '.claude-plugin/plugin.json', path: 'version' }
];

function pick(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

const found = new Map(); // 版本号 → [{file, path}]
let missing = false;
for (const t of TARGETS) {
  let json;
  try {
    json = JSON.parse(readFileSync(join(root, t.file), 'utf8'));
  } catch (err) {
    console.error(`check:version 无法读取 ${t.file}: ${err.message}`);
    missing = true;
    continue;
  }
  const v = pick(json, t.path);
  if (v == null) {
    console.error(`check:version ${t.file} 缺少字段 ${t.path}`);
    missing = true;
    continue;
  }
  if (!found.has(v)) found.set(v, []);
  found.get(v).push(`${t.file}:${t.path}`);
}

if (missing) {
  console.error('\ncheck:version 失败:存在无法读取或缺失版本字段的文件。');
  process.exit(1);
}
if (found.size > 1) {
  console.error(`check:version 失败:发现 ${found.size} 个不同的版本号:`);
  for (const [v, locs] of found) {
    console.error(`  ${v} ← ${locs.join(', ')}`);
  }
  console.error('\n请统一三处版本号后重新运行。');
  process.exit(1);
}
console.log(`check:version 通过:所有清单版本一致(${[...found.keys()][0]})。`);

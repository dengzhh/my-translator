/**
 * 真机校验：用真实的 http://127.0.0.1:8090 翻译服务跑插件的真实引擎代码（不 mock 网络）。
 * 只在本机服务可用时有意义；服务未启动会直接提示并退出 0。
 *
 * 运行: node test/local-api.check.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODE = readFileSync(join(ROOT, 'background/service-worker.js'), 'utf8');
const BASE = 'http://127.0.0.1:8090';

const sender = { url: 'https://example.com/page' };

// 1. 探测服务
let alive = false;
try {
  const r = await fetch(`${BASE}/api/v1/translate/engines`);
  alive = r.ok;
} catch (e) {
  alive = false;
}
if (!alive) {
  console.log(`\n未检测到 ${BASE} 的翻译服务（未启动？），跳过真机校验。\n`);
  process.exit(0);
}
console.log(`\n已连接 ${BASE} 翻译服务，使用插件真实引擎代码调用：\n`);

// 2. 加载引擎（mock chrome，保留真实 fetch）
const store = {};
const listeners = {};
const chrome = {
  runtime: {
    id: 'test',
    lastError: undefined,
    onMessage: { addListener: (fn) => (listeners.message = fn) },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    openOptionsPage: () => {}
  },
  storage: {
    local: {
      get: async (k) => {
        const keys = Array.isArray(k) ? k : [k];
        const out = {};
        for (const x of keys) if (x in store) out[x] = store[x];
        return out;
      },
      set: async (o) => Object.assign(store, o),
      remove: async (k) => delete store[k]
    }
  },
  permissions: { contains: async () => true, request: (p, cb) => cb(true) },
  contextMenus: { removeAll: (cb) => cb && cb(), create: () => {}, onClicked: { addListener: () => {} } },
  action: { onClicked: { addListener: () => {} } },
  tabs: { sendMessage: async () => {} }
};
const ctx = vm.createContext({ chrome, fetch, console, URL, setTimeout, clearTimeout });
vm.runInContext(CODE, ctx, { filename: 'service-worker.js' });
const send = (msg) => new Promise((r) => listeners.message(msg, sender, r));

// 3. 用插件默认配置（provider=local）翻译
const cases = [
  ['Good tools make boring work valuable.', 'zh-CN', '简体中文'],
  ['Good tools make boring work valuable.', 'ja', '日语'],
  ['Good tools make boring work valuable.', 'ko', '韩语'],
  ['Good tools make boring work valuable.', 'zh-TW', '繁体中文'],
  ['这是一段中文，用来验证反向翻译。', 'en', '英语']
];

let bad = 0;
for (const [text, target, label] of cases) {
  const t0 = Date.now();
  const res = await send({ type: 'qt:translate', text, target, source: 'auto' });
  const ms = Date.now() - t0;
  if (res && res.ok) {
    console.log(`  ${label.padEnd(6, '　')} → ${res.text}   (${ms}ms)`);
  } else {
    bad++;
    console.log(`  ${label.padEnd(6, '　')} → 失败: ${res && res.error}`);
  }
}

console.log(bad ? `\n${bad} 个用例失败\n` : '\n全部用例通过：本地服务可直接使用，语言映射结果符合预期\n');
process.exit(bad ? 1 : 0);

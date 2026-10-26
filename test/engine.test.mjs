/**
 * 后台翻译引擎自动化测试：用 vm 加载真实 service-worker.js，
 * mock chrome API 与 fetch，验证各 provider 的请求构造、响应解析、缓存与脱敏。
 * 运行: node test/engine.test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODE = readFileSync(join(ROOT, 'background/service-worker.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''));
  }
}

/* ---------- 构造运行环境 ---------- */
function makeEnv(initialConfig = {}, opts = {}) {
  const store = { qt_config: Object.assign({ apiKey: 'sk-test', deeplKey: 'dk-test' }, initialConfig) };
  const calls = [];
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
      onChanged: { addListener: () => {} },
      local: {
        get: async (key) => {
          const keys = Array.isArray(key) ? key : [key];
          const out = {};
          for (const k of keys) if (k in store) out[k] = JSON.parse(JSON.stringify(store[k]));
          return out;
        },
        set: async (obj) => {
          Object.assign(store, JSON.parse(JSON.stringify(obj)));
        },
        remove: async (k) => {
          delete store[k];
        }
      }
    },
    permissions: {
      contains: async () => opts.hasPermission !== false,
      request: (p, cb) => cb(opts.grantPermission !== false)
    },
    contextMenus: { removeAll: (cb) => cb && cb(), create: () => {}, onClicked: { addListener: () => {} } },
    action: { onClicked: { addListener: () => {} } },
    tabs: {
      query: (q, cb) => cb(opts.tabs || []),
      sendMessage: async () => {}
    },
    scripting: opts.noScripting
      ? undefined
      : {
          executeScript: async (o) => {
            calls.push({ inject: o });
            // 模拟浏览器内置页面注入失败（无权限）
            if (String(o.target && o.target.tabId) === 'chrome-page') throw new Error('cannot access');
            return [];
          }
        }
  };

  const fetchMock = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const handler = opts.fetchHandler || (() => ({ status: 200, body: {} }));
    const r = handler(String(url), init);
    return {
      ok: (r.status || 200) < 400,
      status: r.status || 200,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
    };
  };

  const ctx = vm.createContext({
    chrome,
    fetch: fetchMock,
    console,
    URL,
    setTimeout,
    clearTimeout
  });
  vm.runInContext(CODE, ctx, { filename: 'service-worker.js' });

  const send = (msg, sender = { url: 'https://example.com/page' }) =>
    new Promise((resolve) => {
      listeners.message(msg, sender, resolve);
    });

  return { store, calls, send };
}

const contentSender = { url: 'https://example.com/article' };
const extSender = { url: 'chrome-extension://abc/options/options.html' };

/* ---------- 1. OpenAI 兼容 ---------- */
console.log('\n[1] OpenAI 兼容接口');
{
  const env = makeEnv(
    { provider: 'openai', endpoint: 'https://api.example.com/v1/chat/completions', model: 'glm-4-flash' },
    {
      fetchHandler: () => ({
        status: 200,
        body: { choices: [{ message: { content: '"你好，世界。"' } }] }
      })
    }
  );
  const res = await env.send({ type: 'qt:translate', text: 'Hello, world.', target: 'zh-CN' }, contentSender);
  ok(res.ok === true, '调用成功');
  ok(res.text === '你好，世界。', '返回正文并剥掉外层引号', res.text);

  const call = env.calls[0];
  ok(call.url === 'https://api.example.com/v1/chat/completions', '请求打到配置的 endpoint');
  ok(call.init.headers.Authorization === 'Bearer sk-test', '带上 Bearer 密钥');
  const body = JSON.parse(call.init.body);
  ok(body.model === 'glm-4-flash', 'model 正确');
  ok(body.messages[0].role === 'system', '包含 system 提示词');
  ok(body.messages[0].content.includes('简体中文'), '提示词注入了目标语言中文名');
  ok(body.messages[1].content === 'Hello, world.', '用户文本原样传递');
}

/* ---------- 2. 错误响应 ---------- */
console.log('\n[2] 接口报错处理');
{
  const env = makeEnv(
    { provider: 'openai', endpoint: 'https://api.example.com/v1/chat/completions' },
    { fetchHandler: () => ({ status: 401, body: '{"error":"invalid api key"}' }) }
  );
  const res = await env.send({ type: 'qt:translate', text: 'hi', target: 'zh-CN' }, contentSender);
  ok(res.ok === false, '失败被捕获而不是抛异常');
  ok(/401/.test(res.error), '错误信息包含 HTTP 状态', res.error);
  ok(/invalid api key/.test(res.error), '错误信息包含接口原文');
}

/* ---------- 3. DeepL ---------- */
console.log('\n[3] DeepL');
{
  const env = makeEnv(
    { provider: 'deepl', deeplPlan: 'free' },
    { fetchHandler: () => ({ status: 200, body: { translations: [{ text: '你好' }] } }) }
  );
  const res = await env.send({ type: 'qt:translate', text: 'Hello', target: 'zh-CN' }, contentSender);
  ok(res.ok && res.text === '你好', '译文正确', res.text);
  const call = env.calls[0];
  ok(call.url === 'https://api-free.deepl.com/v2/translate', 'Free 套餐走 api-free 域名', call.url);
  ok(call.init.headers.Authorization === 'DeepL-Auth-Key dk-test', '使用独立的 deeplKey');
  const body = JSON.parse(call.init.body);
  ok(body.target_lang === 'ZH-HANS', 'zh-CN 映射为 ZH-HANS', body.target_lang);
  ok(Array.isArray(body.text) && body.text[0] === 'Hello', 'text 传数组');
}

/* ---------- 4. Google ---------- */
console.log('\n[4] Google 翻译');
{
  const env = makeEnv(
    { provider: 'google', googleKey: 'g-key' },
    {
      fetchHandler: () => ({
        status: 200,
        body: { data: { translations: [{ translatedText: '你好' }] } }
      })
    }
  );
  const res = await env.send({ type: 'qt:translate', text: 'Hello', target: 'zh-CN' }, contentSender);
  ok(res.ok && res.text === '你好', '译文正确', res.text);
  const u = new URL(env.calls[0].url);
  ok(u.hostname === 'translation.googleapis.com', '域名正确');
  ok(u.searchParams.get('key') === 'g-key', 'key 放在 query 上');
  ok(u.searchParams.get('target') === 'zh', 'zh-CN 只取主语言 zh');
  ok(JSON.parse(env.calls[0].init.body).q === 'Hello', 'q 参数正确');
}

/* ---------- 5. 自定义接口 ---------- */
console.log('\n[5] 自定义接口（模板 + 路径取值）');
{
  const env = makeEnv(
    {
      provider: 'custom',
      endpoint: 'https://my.api/translate',
      customMethod: 'POST',
      customHeaders: '{"Content-Type":"application/json","X-Token":"t1"}',
      customBody: '{"q":"{{text}}","to":"{{target}}"}',
      customPath: 'data.result.0.text'
    },
    {
      fetchHandler: () => ({
        status: 200,
        body: { data: { result: [{ text: '自定义译文' }] } }
      })
    }
  );
  const res = await env.send(
    { type: 'qt:translate', text: 'a "quoted" line\nsecond', target: 'ja' },
    contentSender
  );
  ok(res.ok && res.text === '自定义译文', '嵌套路径取值成功', res.text);
  const body = JSON.parse(env.calls[0].init.body);
  ok(body.q === 'a "quoted" line\nsecond', '模板里的引号与换行正确转义（未破坏 JSON）', body.q);
  ok(body.to === 'ja', '目标语言注入成功');
  ok(env.calls[0].init.headers['X-Token'] === 't1', '自定义请求头生效');
}

/* ---------- 6. 缓存 ---------- */
console.log('\n[6] 缓存与强制刷新');
{
  let n = 0;
  const env = makeEnv(
    { provider: 'openai', endpoint: 'https://api.example.com/v1/chat/completions', cacheEnabled: true },
    {
      fetchHandler: () => {
        n++;
        return { status: 200, body: { choices: [{ message: { content: '译文' + n } }] } };
      }
    }
  );
  const a = await env.send({ type: 'qt:translate', text: 'same text', target: 'zh-CN' }, contentSender);
  const b = await env.send({ type: 'qt:translate', text: 'same text', target: 'zh-CN' }, contentSender);
  ok(a.text === '译文1' && b.text === '译文1', '相同文本第二次命中缓存');
  ok(b.cached === true, '标记 cached');
  ok(n === 1, '只发了一次网络请求，实际=' + n);

  const c = await env.send(
    { type: 'qt:translate', text: 'same text', target: 'zh-CN', force: true },
    contentSender
  );
  ok(c.text === '译文2' && !c.cached, 'force:true 绕过缓存重新请求', c.text);
  ok(n === 2, '网络请求次数 +1，实际=' + n);
}

/* ---------- 7. 权限 ---------- */
console.log('\n[7] 域名权限');
{
  const env = makeEnv(
    { provider: 'openai', endpoint: 'https://unauthed.example.com/v1/chat/completions' },
    { hasPermission: false, grantPermission: false }
  );
  const res = await env.send({ type: 'qt:translate', text: 'hi', target: 'zh-CN' }, contentSender);
  ok(res.ok === false, '无权限时不发送请求');
  ok(res.needPermission === true, '返回 needPermission');
  ok(res.origin === 'https://unauthed.example.com/*', '返回需授权的 origin', res.origin);
  ok(env.calls.length === 0, '确实没有发起网络请求');
}

/* ---------- 8. 密钥脱敏 ---------- */
console.log('\n[8] 配置下发脱敏');
{
  const env = makeEnv({ provider: 'openai' });
  const forContent = await env.send({ type: 'qt:getConfig' }, contentSender);
  ok(forContent.config.apiKey === undefined, '网页侧拿不到 apiKey');
  ok(forContent.config.deeplKey === undefined, '网页侧拿不到 deeplKey');
  ok(forContent.config.googleKey === undefined, '网页侧拿不到 googleKey');
  ok(forContent.config.hasKey === true, '但仍能知道“已配置”');
  ok(forContent.config.targetLang === 'zh-CN', '普通配置正常下发');

  const forOptions = await env.send({ type: 'qt:getConfig' }, extSender);
  ok(forOptions.config.apiKey === 'sk-test', '扩展设置页能拿到完整配置');
}

/* ---------- 9. 截断 ---------- */
console.log('\n[9] 超长文本截断');
{
  const env = makeEnv(
    { provider: 'openai', endpoint: 'https://api.example.com/v1/chat/completions', maxChars: 10 },
    { fetchHandler: () => ({ status: 200, body: { choices: [{ message: { content: 'ok' } }] } }) }
  );
  await env.send({ type: 'qt:translate', text: 'x'.repeat(50), target: 'zh-CN' }, contentSender);
  const body = JSON.parse(env.calls[0].init.body);
  ok(body.messages[1].content.length === 10, '按 maxChars 截断，实际=' + body.messages[1].content.length);
}

/* ---------- 10. 本地翻译服务 127.0.0.1:8090 ---------- */
console.log('\n[10] 本地翻译服务 Web To OpenAPI');
{
  const env = makeEnv(
    { provider: 'local', localEndpoint: 'http://127.0.0.1:8090/api/v1/translate', localEngine: 'baidu' },
    {
      fetchHandler: (url, init) => {
        const b = JSON.parse(init.body);
        return {
          status: 200,
          body: {
            source: 'web-to-openapi (online translator)',
            engine: b.engine,
            from: b.from,
            to: b.to,
            text: b.q,
            translation: '译文<' + b.to + '>',
            segments: ['译文<' + b.to + '>'],
            elapsed_ms: 512
          }
        };
      }
    }
  );
  const res = await env.send({ type: 'qt:translate', text: 'Hello', target: 'ja' }, contentSender);
  ok(res.ok === true, '调用成功');
  ok(res.text === '译文<jp>', '从 translation 字段取到译文', res.text);

  const call = env.calls[0];
  ok(call.url === 'http://127.0.0.1:8090/api/v1/translate', '请求地址正确', call.url);
  ok(call.init.method === 'POST', '使用 POST');
  ok(call.init.headers['Content-Type'] === 'application/json', 'Content-Type 正确');
  const body = JSON.parse(call.init.body);
  ok(body.q === 'Hello', 'q = 待翻译文本');
  ok(body.from === 'auto', 'from 默认 auto');
  ok(body.to === 'jp', '「日语」映射为 jp', body.to);
  ok(body.engine === 'baidu', 'engine 透传配置');
  ok(body.detail === false, 'detail=false 加快响应');

  // 全部目标语言的映射
  const map = [
    ['zh-CN', 'zh'],
    ['zh-TW', 'cht'],
    ['en', 'en'],
    ['ja', 'jp'],
    ['ko', 'kor'],
    ['fr', 'fra'],
    ['de', 'de'],
    ['es', 'spa'],
    ['ru', 'ru'],
    ['pt', 'pt'],
    ['it', 'it'],
    ['ar', 'ara'],
    ['th', 'th'],
    ['vi', 'vie'],
    ['id', 'id'],
    ['hi', 'hi'],
    ['tr', 'tr']
  ];
  let bad = [];
  for (let i = 0; i < map.length; i++) {
    const [ui, expect] = map[i];
    await env.send({ type: 'qt:translate', text: 't' + i, target: ui }, contentSender);
    const b = JSON.parse(env.calls[env.calls.length - 1].init.body);
    if (b.to !== expect) bad.push(`${ui}→${b.to}(应 ${expect})`);
  }
  ok(bad.length === 0, '17 种目标语言代码映射全部正确', bad.join(', '));
}

/* ---------- 11. 本地服务异常返回 ---------- */
console.log('\n[11] 本地服务异常');
{
  const env = makeEnv(
    { provider: 'local' },
    { fetchHandler: () => ({ status: 200, body: { error: 'engine unavailable' } }) }
  );
  const res = await env.send({ type: 'qt:translate', text: 'hi', target: 'zh-CN' }, contentSender);
  ok(res.ok === false, '缺 translation 字段时报错而不是返回空');
  ok(/translation/.test(res.error), '错误信息指出字段缺失', res.error);

  const env2 = makeEnv({ provider: 'local' }, { fetchHandler: () => ({ status: 500, body: 'boom' }) });
  const res2 = await env2.send({ type: 'qt:translate', text: 'hi', target: 'zh-CN' }, contentSender);
  ok(res2.ok === false && /500/.test(res2.error), 'HTTP 500 被正确上报', res2.error);
}

/* ---------- 12. 免刷新注入 ---------- */
console.log('\n[12] 注入到已打开的标签页');
{
  const env = makeEnv(
    { provider: 'local' },
    {
      tabs: [{ id: 11, url: 'https://a.com/x' }, { id: 22, url: 'https://b.com/y' }, { id: 'chrome-page', url: 'chrome://settings' }]
    }
  );
  const res = await env.send({ type: 'qt:injectAll' }, extSender);
  ok(res.ok === true, 'qt:injectAll 可用');
  ok(res.injected === 2, '注入了 2 个可用标签页，实际=' + res.injected);
  ok(res.skipped === 1, '浏览器内置页被跳过而不是整体失败，实际=' + res.skipped);

  const injects = env.calls.map((c) => c.inject).filter(Boolean);
  ok(injects.length === 3, '对 3 个标签页都做了尝试（含内置页）');
  ok(
    JSON.stringify(injects.map((i) => i.target.tabId)) === JSON.stringify([11, 22, 'chrome-page']),
    '逐个标签页注入，顺序与查询结果一致',
    JSON.stringify(injects.map((i) => i.target.tabId))
  );
  const files = injects.map((i) => i.files);
  ok(
    files.every((f) => JSON.stringify(f) === JSON.stringify(['lib/langs.js', 'content/content.js'])),
    '注入文件顺序正确（先语言表后主脚本）',
    JSON.stringify(files[0])
  );
  ok(
    env.calls.some((c) => c.inject && c.inject.target.tabId === 11) &&
      env.calls.some((c) => c.inject && c.inject.target.tabId === 22),
    '按 tabId 逐个注入'
  );

  const noScript = makeEnv({ provider: 'local' }, { noScripting: true, tabs: [{ id: 1 }] });
  const r2 = await noScript.send({ type: 'qt:injectAll' }, extSender);
  ok(r2.injected === 0 && r2.skipped === 0, '没有 scripting 权限时安全返回而不是抛错');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);

/**
 * 我的翻译 —— 后台翻译引擎
 * 所有网络请求都在这里发出，content script 只负责 UI。
 */

const DEFAULT_CONFIG = {
  enabled: true,
  paused: false, // 临时暂停：选中文字不再自动弹出浮窗（Alt+T / 右键菜单仍可用）
  provider: 'local', // local | openai | deepl | google | custom
  // 本地翻译服务（Web To OpenAPI）：POST /api/v1/translate  {q, from, to, engine, detail}
  localEndpoint: 'http://127.0.0.1:8090/api/v1/translate',
  localEngine: 'baidu',
  endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  apiKey: '',
  model: 'glm-4-flash',
  targetLang: 'zh-CN',
  sourceLang: 'auto',
  temperature: 0.2,
  systemPrompt:
    'You are a professional translation engine. Translate the user text into {{target}} accurately and naturally. ' +
    'Preserve the original formatting, line breaks, punctuation style and any markup. ' +
    'Output ONLY the translated text, without explanations, notes or quotation marks.',
  showBubble: true,
  autoCopy: false,
  maxChars: 4000,
  deeplPlan: 'free', // free | pro
  deeplKey: '',
  googleKey: '',
  // 自定义 provider
  customMethod: 'POST',
  customHeaders: '{\n  "Content-Type": "application/json"\n}',
  customBody:
    '{\n  "model": "{{model}}",\n  "messages": [\n    { "role": "user", "content": "Translate into {{target}}:\\n\\n{{text}}" }\n  ]\n}',
  customPath: 'choices.0.message.content',
  // 内置（无需配置）的兜底：完全离线时给出提示
  cacheEnabled: true
};

const LANG_NAME = {
  'zh-CN': '简体中文',
  'zh-TW': '繁体中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  es: '西班牙语',
  ru: '俄语',
  pt: '葡萄牙语',
  it: '意大利语',
  ar: '阿拉伯语',
  th: '泰语',
  vi: '越南语',
  id: '印尼语',
  hi: '印地语',
  tr: '土耳其语'
};

function langName(code) {
  if (!code || code === 'auto') return '自动检测';
  return LANG_NAME[code] || code;
}

/* 本地服务用百度体系的语言代码，这里做映射（不赌它的别名解析） */
const LOCAL_LANG = {
  'zh-CN': 'zh',
  'zh-TW': 'cht',
  en: 'en',
  ja: 'jp',
  ko: 'kor',
  fr: 'fra',
  de: 'de',
  es: 'spa',
  ru: 'ru',
  pt: 'pt',
  it: 'it',
  ar: 'ara',
  th: 'th',
  vi: 'vie',
  id: 'id',
  hi: 'hi',
  tr: 'tr'
};

function toLocalCode(code, isSource) {
  if (!code || code === 'auto') return isSource ? 'auto' : 'zh'; // to 不接受 auto
  return LOCAL_LANG[code] || String(code).toLowerCase();
}

function toDeepLCode(code) {
  const map = {
    'zh-CN': 'ZH-HANS',
    'zh-TW': 'ZH-HANT',
    en: 'EN-US',
    pt: 'PT-BR'
  };
  return map[code] || String(code || '').toUpperCase();
}

/* ---------------- 配置读写 ---------------- */

async function getConfig() {
  const raw = await chrome.storage.local.get('qt_config');
  return Object.assign({}, DEFAULT_CONFIG, raw.qt_config || {});
}

async function setConfig(patch) {
  const cur = await getConfig();
  const next = Object.assign({}, cur, patch);
  await chrome.storage.local.set({ qt_config: next });
  return next;
}

/* ---------------- 缓存（LRU，最多 300 条） ---------------- */

const CACHE_KEY = 'qt_cache';
const CACHE_MAX = 300;

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

async function cacheGet(key) {
  const data = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
  const hit = data[key];
  if (!hit) return null;
  hit.ts = Date.now();
  data[key] = hit;
  await chrome.storage.local.set({ [CACHE_KEY]: data });
  return hit.value;
}

async function cacheSet(key, value) {
  const data = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
  data[key] = { value, ts: Date.now() };
  const keys = Object.keys(data);
  if (keys.length > CACHE_MAX) {
    keys.sort((a, b) => data[a].ts - data[b].ts);
    for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete data[k];
  }
  await chrome.storage.local.set({ [CACHE_KEY]: data });
}

/* ---------------- 权限 ---------------- */

function originOf(url) {
  try {
    const u = new URL(url);
    return u.origin + '/*';
  } catch (e) {
    return null;
  }
}

async function ensurePermission(url) {
  const origin = originOf(url);
  if (!origin) return { ok: false, needPermission: true, origin: url };
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (!has) {
    // 尝试静默申请（必须在用户手势链路内才可能成功，options 页保存时会主动申请）
    const granted = await new Promise((resolve) => {
      chrome.permissions.request({ origins: [origin] }, (ok) => {
        void chrome.runtime.lastError; // 无用户手势时这里会报错，静默处理
        resolve(!!ok);
      });
    }).catch(() => false);
    if (!granted) return { ok: false, needPermission: true, origin };
  }
  return { ok: true };
}

/* ---------------- Provider 实现 ---------------- */

async function callOpenAI(cfg, text, target, source) {
  const body = {
    model: cfg.model || 'gpt-4o-mini',
    temperature: Number(cfg.temperature) || 0,
    messages: [
      {
        role: 'system',
        content: (cfg.systemPrompt || DEFAULT_CONFIG.systemPrompt).replace('{{target}}', langName(target))
      },
      { role: 'user', content: text }
    ]
  };
  if (source && source !== 'auto') {
    body.messages[0].content += ` The source language is ${langName(source)}.`;
  }

  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (cfg.apiKey || '')
    },
    body: JSON.stringify(body)
  });
  return parseOpenAI(res);
}

async function parseOpenAI(res) {
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}：${txt.slice(0, 300)}`);
  let json;
  try {
    json = JSON.parse(txt);
  } catch (e) {
    throw new Error('返回不是合法 JSON：' + txt.slice(0, 200));
  }
  const content = json?.choices?.[0]?.message?.content;
  if (content == null) {
    // 兼容部分网关直接返回 { data: "..." } / { result: "..." }
    if (typeof json.data === 'string') return clean(json.data);
    if (typeof json.result === 'string') return clean(json.result);
    throw new Error('未在返回中找到译文（choices[0].message.content）');
  }
  return clean(typeof content === 'string' ? content : JSON.stringify(content));
}

/* 本地翻译服务：POST /api/v1/translate，返回 { translation, segments, ... } */
async function callLocal(cfg, text, target, source) {
  const url = (cfg.localEndpoint || DEFAULT_CONFIG.localEndpoint).trim();
  const body = {
    q: text,
    from: toLocalCode(source, true),
    to: toLocalCode(target),
    engine: (cfg.localEngine || 'baidu').trim(),
    detail: false
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}：${txt.slice(0, 300)}`);
  let json;
  try {
    json = JSON.parse(txt);
  } catch (e) {
    return clean(txt); // 纯文本返回
  }
  const out =
    json.translation != null
      ? json.translation
      : json.data && json.data.translation != null
      ? json.data.translation
      : Array.isArray(json.segments) && json.segments.length
      ? json.segments.join('')
      : null;
  if (out == null) throw new Error('返回中没有 translation 字段：' + txt.slice(0, 200));
  return clean(typeof out === 'string' ? out : JSON.stringify(out));
}

async function callDeepL(cfg, text, target, source) {
  const base =
    cfg.deeplPlan === 'pro' ? 'https://api.deepl.com/v2/translate' : 'https://api-free.deepl.com/v2/translate';
  const body = {
    text: [text],
    target_lang: toDeepLCode(target)
  };
  if (source && source !== 'auto') body.source_lang = String(source).toUpperCase().split('-')[0];

  const res = await fetch(base, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'DeepL-Auth-Key ' + (cfg.deeplKey || '')
    },
    body: JSON.stringify(body)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}：${txt.slice(0, 300)}`);
  const json = JSON.parse(txt);
  const out = json?.translations?.[0]?.text;
  if (out == null) throw new Error('未在返回中找到译文（translations[0].text）');
  return clean(out);
}

async function callGoogle(cfg, text, target, source) {
  const url = new URL('https://translation.googleapis.com/language/translate/v2');
  url.searchParams.set('key', (cfg.googleKey || cfg.apiKey || '').trim());
  url.searchParams.set('target', String(target).split('-')[0]);
  url.searchParams.set('format', 'text');
  if (source && source !== 'auto') url.searchParams.set('source', String(source).split('-')[0]);

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text })
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}：${txt.slice(0, 300)}`);
  const json = JSON.parse(txt);
  const out = json?.data?.translations?.[0]?.translatedText;
  if (out == null) throw new Error('未在返回中找到译文（data.translations[0].translatedText）');
  return clean(out);
}

function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{\{(\w+)\}\}/g, (m, key) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}

function pickByPath(obj, path) {
  if (!path) return obj;
  const parts = String(path).split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

async function callCustom(cfg, text, target, source) {
  const vars = {
    text: JSON.stringify(text).slice(1, -1), // 转义后塞进 JSON 模板
    rawText: text,
    target,
    source: source || 'auto',
    model: cfg.model || ''
  };
  let headers = {};
  try {
    headers = JSON.parse(cfg.customHeaders || '{}');
  } catch (e) {
    throw new Error('自定义请求头不是合法 JSON');
  }
  const bodyStr = renderTemplate(cfg.customBody || '', vars);

  const res = await fetch(cfg.endpoint, {
    method: (cfg.customMethod || 'POST').toUpperCase(),
    headers,
    body: cfg.customMethod === 'GET' ? undefined : bodyStr
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}：${txt.slice(0, 300)}`);
  let json;
  try {
    json = JSON.parse(txt);
  } catch (e) {
    return clean(txt); // 纯文本接口直接返回
  }
  const out = pickByPath(json, cfg.customPath);
  if (out == null) throw new Error(`按取值路径 "${cfg.customPath}" 未取到内容`);
  return clean(typeof out === 'string' ? out : JSON.stringify(out));
}

function clean(s) {
  return String(s)
    .replace(/^\s+|\s+$/g, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
}

/* ---------------- 统一入口 ---------------- */

async function doTranslate({ text, target, source, force }) {
  const cfg = await getConfig();
  if (!text || !text.trim()) throw new Error('没有可翻译的文本');

  const limit = Number(cfg.maxChars) || 4000;
  if (text.length > limit) text = text.slice(0, limit);

  const targetLang = target || cfg.targetLang || 'zh-CN';
  const sourceLang = source || cfg.sourceLang || 'auto';

  const url =
    cfg.provider === 'local'
      ? (cfg.localEndpoint || DEFAULT_CONFIG.localEndpoint).trim()
      : cfg.provider === 'deepl'
      ? cfg.deeplPlan === 'pro'
        ? 'https://api.deepl.com/v2/translate'
        : 'https://api-free.deepl.com/v2/translate'
      : cfg.provider === 'google'
      ? 'https://translation.googleapis.com/language/translate/v2'
      : cfg.endpoint;

  const perm = await ensurePermission(url);
  if (!perm.ok) {
    return { ok: false, needPermission: true, origin: perm.origin };
  }

  const cacheKey = hash([cfg.provider, cfg.model, cfg.endpoint, targetLang, sourceLang, text].join('|'));
  if (cfg.cacheEnabled && !force) {
    const cached = await cacheGet(cacheKey);
    if (cached) return { ok: true, text: cached, cached: true, model: cfg.model, provider: cfg.provider };
  }

  const t0 = Date.now();
  let out;
  switch (cfg.provider) {
    case 'local':
      out = await callLocal(cfg, text, targetLang, sourceLang);
      break;
    case 'deepl':
      out = await callDeepL(cfg, text, targetLang, sourceLang);
      break;
    case 'google':
      out = await callGoogle(cfg, text, targetLang, sourceLang);
      break;
    case 'custom':
      out = await callCustom(cfg, text, targetLang, sourceLang);
      break;
    case 'openai':
    default:
      out = await callOpenAI(cfg, text, targetLang, sourceLang);
      break;
  }

  if (cfg.cacheEnabled) await cacheSet(cacheKey, out);
  return {
    ok: true,
    text: out,
    cached: false,
    provider: cfg.provider,
    // 本地服务没有“模型”概念，显示它实际使用的引擎
    model: cfg.provider === 'local' ? (cfg.localEngine || 'baidu') : cfg.model,
    ms: Date.now() - t0
  };
}

/* ---------------- 消息 ---------------- */

/* 内容脚本运行在网页上下文里，回传配置时把密钥擦掉 */
function isExtensionPage(sender) {
  return !!(sender && typeof sender.url === 'string' && sender.url.startsWith('chrome-extension://'));
}

function redact(cfg, sender) {
  if (isExtensionPage(sender)) return cfg;
  const out = Object.assign({}, cfg);
  out.hasKey = !!(cfg.apiKey || cfg.deeplKey || cfg.googleKey);
  delete out.apiKey;
  delete out.deeplKey;
  delete out.googleKey;
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'qt:getConfig': {
          const cfg = await getConfig();
          sendResponse({ ok: true, config: redact(cfg, sender) });
          break;
        }
        case 'qt:setConfig': {
          const next = await setConfig(msg.patch || {});
          sendResponse({ ok: true, config: redact(next, sender) });
          break;
        }
        case 'qt:translate': {
          const r = await doTranslate(msg);
          sendResponse(r);
          break;
        }
        case 'qt:clearCache': {
          await chrome.storage.local.remove(CACHE_KEY);
          sendResponse({ ok: true });
          break;
        }
        case 'qt:requestOrigin': {
          const granted = await new Promise((res) => chrome.permissions.request({ origins: [msg.origin] }, res));
          sendResponse({ ok: !!granted });
          break;
        }
        case 'qt:hasPermission': {
          const has = await chrome.permissions.contains({ origins: [msg.origin] });
          sendResponse({ ok: has });
          break;
        }
        case 'qt:openOptions': {
          // 设置一律在网页浮窗内就地展开，绝不再把用户的网页导航走
          const r = await openSettingsInline(sender && sender.tab);
          sendResponse(r);
          break;
        }
        // 浮窗内设置面板用：取原始配置（含 API Key 等敏感字段），只允许扩展自己的页面 / 内容脚本调用
        case 'qt:getConfigRaw': {
          const c = await getConfig();
          sendResponse({ ok: true, config: c });
          break;
        }
        case 'qt:exportConfig': {
          const c = await getConfig();
          sendResponse({ ok: true, json: JSON.stringify(c, null, 2) });
          break;
        }
        case 'qt:injectAll': {
          const r = await injectIntoOpenTabs();
          sendResponse({ ok: true, injected: r.injected, skipped: r.skipped });
          break;
        }
        case 'qt:injectTab': {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: msg.tabId },
              files: INJECT_FILES
            });
            sendResponse({ ok: true });
          } catch (e) {
            void chrome.runtime.lastError;
            sendResponse({ ok: false, error: String((e && e.message) || e) });
          }
          break;
        }
        /* 仅供 e2e 校验「右键菜单/图标兜底也走就地展开」，不参与真实业务流程 */
        case 'qt:openSettingsInlineProbe': {
          const r = await openSettingsInline({ id: msg.tabId });
          sendResponse({ supported: true, mode: r.mode || '', ok: r.ok === true });
          break;
        }
        default:
          sendResponse({ ok: false, error: '未知消息类型' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();
  return true; // 保持异步响应
});

/* ---------------- 注入到已打开的页面（免刷新） ---------------- */

const INJECT_FILES = ['lib/langs.js', 'content/content.js'];

async function injectIntoOpenTabs() {
  if (!chrome.tabs || !chrome.scripting) return { injected: 0, skipped: 0 };
  // 不按 url 过滤：没有 "tabs" 权限时拿不到 url，过滤会得到空列表。
  // 直接对全部标签页尝试，内置页/PDF 会失败并被下面的 catch 跳过。
  const tabs = await new Promise((r) => {
    try {
      chrome.tabs.query({}, (t) => r(t || []));
    } catch (e) {
      r([]);
    }
  });
  let injected = 0;
  let skipped = 0;
  for (const tab of tabs) {
    if (tab && tab.id != null) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: INJECT_FILES });
        injected++;
        continue;
      } catch (e) {
        void chrome.runtime.lastError;
      }
    }
    skipped++;
  }
  return { injected, skipped };
}

/* ---------------- 打开设置页 ---------------- */

/**
 * 优先在网页里就地展开设置面板；只有该页注入不了脚本时才退回 openOptions。
 * 用户的核心诉求：点“设置”不能把他正在看的网页顶掉。
 */
async function openSettingsInline(tab) {
  const tabId = tab && tab.id;
  if (tabId == null) return { ok: false, fallback: true };

  // 先试直接发消息（内容脚本多半已经在了）
  const ping = await new Promise((r) =>
    chrome.tabs.sendMessage(tabId, { type: 'qt:ping' }, (res) => {
      void chrome.runtime.lastError;
      r(res || null);
    })
  );

  if (!ping || ping.ok !== true) {
    // 没注入过 → 免刷新注入一次
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: INJECT_FILES });
    } catch (e) {
      void chrome.runtime.lastError;
      return { ok: false, fallback: true };
    }
  }

  const res = await new Promise((r) =>
    chrome.tabs.sendMessage(tabId, { type: 'qt:openSettings' }, (x) => {
      void chrome.runtime.lastError;
      r(x || null);
    })
  );
  if (res && res.ok === true) return { ok: true, mode: 'inline' };
  return { ok: false, fallback: true };
}

/**
 * 兜底打开设置页（仅当当前页面实在注入不了脚本时才会走到，例如 edge:// 页面）。
 *
 * ⚠️ 绝不导航用户正在看的网页：不用 chrome.runtime.openOptionsPage()（会跳到
 * edge://extensions/?options=<id>），也不用 chrome.tabs.update 复用原标签页。
 * 一律在新标签页里打开设置页，用户原页面原封不动。
 */
async function openOptions() {
  const url = chrome.runtime.getURL('options/options.html');
  try {
    await chrome.tabs.create({ url });
    return { ok: true, mode: 'newtab' };
  } catch (e) {
    void chrome.runtime.lastError;
    return { ok: false, error: '无法打开设置页' };
  }
}

/* 仅供 e2e 测试直接调用，不参与任何真实业务流程 */
globalThis.__qtOpenOptions = openOptions;

/* ---------------- 右键菜单 ---------------- */

function setupMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'qt-translate-selection',
      title: '用「我的翻译」翻译选中文本',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'qt-open-options',
      title: '打开「我的翻译」设置',
      contexts: ['action']
    });
  });
}

/* ---- 暂停状态在工具栏图标上标出来，免得用户忘了自己关过 ---- */
async function syncBadge(paused) {
  if (!chrome.action || !chrome.action.setBadgeText) return;
  try {
    await chrome.action.setBadgeText({ text: paused ? '❚❚' : '' });
    if (paused && chrome.action.setBadgeBackgroundColor) {
      await chrome.action.setBadgeBackgroundColor({ color: '#9aa4b2' });
    }
    if (chrome.action.setTitle) {
      await chrome.action.setTitle({
        title: paused ? '我的翻译（划词浮窗已暂停，点我恢复）' : '我的翻译'
      });
    }
  } catch (e) {}
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.qt_config) {
    const next = changes.qt_config.newValue || {};
    syncBadge(!!next.paused);
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  setupMenus();
  getConfig().then((c) => syncBadge(!!c.paused));
  // 安装/更新后，已打开的标签页不会自动注入内容脚本 → 主动补一次，免去手动刷新
  await injectIntoOpenTabs();
  // 首次安装引导到设置页（新标签页打开，此时用户还没在看什么网页）
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(async () => {
  setupMenus();
  getConfig().then((c) => syncBadge(!!c.paused));
  await injectIntoOpenTabs();
});

chrome.contextMenus &&
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab || !tab.id) return;
    if (info.menuItemId === 'qt-translate-selection') {
      chrome.tabs.sendMessage(tab.id, { type: 'qt:menu-translate' }).catch(() => {});
    } else if (info.menuItemId === 'qt-open-options') {
      // 优先在网页里就地展开，绝不把用户正在看的页面导航走
      const r = await openSettingsInline(tab);
      if (!r.ok && r.fallback) openOptions();
    }
  });

/* 右键图标且没配置 popup 时的兜底（本项目配了 popup，正常不会走到） */
chrome.action &&
  chrome.action.onClicked &&
  chrome.action.onClicked.addListener(async (tab) => {
    const r = await openSettingsInline(tab);
    if (!r.ok && r.fallback) openOptions();
  });

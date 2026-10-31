/**
 * 我的翻译 —— 内容脚本
 * 职责：监听选区 → 鼠标右上角弹气泡 → 用户点击后翻译 → 浮窗展示译文
 * 全部 UI 挂在 Shadow DOM 下，样式与页面完全隔离。
 */
(function () {
  // 已注入过就退出。注意标记放在最后：初始化中途万一抛错，重新注入还能自愈
  if (window.__QT_LOADED__) return;

  // 版本戳：改了代码后在页面控制台能看到，用来确认标签页跑的是新注入的脚本。
  // 扩展「重新加载」不会重新注入已打开标签页的内容脚本，必须刷新页面。
  const QT_VER = '1.0.2';
  try { console.info('[quick-translate] content script v' + QT_VER + ' injected'); } catch (e) {}

  const LANGS = window.QT_LANGS || [['zh-CN', '简体中文'], ['en', '英语']];
  const langName = window.QT_langName || ((c) => c);

  let cfg = { enabled: true, paused: false, showBubble: true, targetLang: 'zh-CN', sourceLang: 'auto', autoCopy: false, maxChars: 4000 };
  let host = null;
  let shadow = null;
  let bubble = null;
  let panel = null;
  let settings = null;
  let toast = null;
  let toastTimer = 0;

  const state = {
    text: '',
    anchor: { x: 0, y: 0 },
    range: null,
    busy: false,
    result: '',
    target: 'zh-CN',
    dragged: false,
    follow: true
  };

  /* ============ 样式 ============ */
  const CSS = `
:host, * { box-sizing: border-box; }
.qt-root {
  --qt-bg: #ffffff;
  --qt-fg: #1f2328;
  --qt-muted: #6b7280;
  --qt-border: #e5e7eb;
  --qt-accent: #2563eb;
  --qt-accent-fg: #ffffff;
  --qt-hover: #f3f4f6;
  --qt-shadow: 0 8px 28px rgba(15, 23, 42, .18), 0 2px 6px rgba(15, 23, 42, .08);
}
@media (prefers-color-scheme: dark) {
  .qt-root {
    --qt-bg: #1f2328;
    --qt-fg: #e6edf3;
    --qt-muted: #9aa4b2;
    --qt-border: #30363d;
    --qt-accent: #3b82f6;
    --qt-hover: #2b333d;
    --qt-shadow: 0 8px 28px rgba(0, 0, 0, .5);
  }
}
.qt-card {
  position: fixed;
  z-index: 2147483647;
  font: 13px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
  color: var(--qt-fg);
  background: var(--qt-bg);
  border: 1px solid var(--qt-border);
  border-radius: 10px;
  box-shadow: var(--qt-shadow);
  overflow: hidden;
  animation: qt-in .12s ease-out;
}
/* 只用位移做入场：动画在后台标签页可能被合成器挂起，
   若用 opacity 起点会导致浮窗长时间半透明甚至看不见 */
@keyframes qt-in { from { transform: translateY(4px); } to { transform: none; } }

/* ---- 气泡 ---- */
.qt-bubble { display: flex; align-items: center; gap: 4px; padding: 5px; }
.qt-main {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 11px; border: none; border-radius: 7px; cursor: pointer;
  background: var(--qt-accent); color: var(--qt-accent-fg);
  font-size: 13px; font-weight: 500; white-space: nowrap;
}
.qt-main:hover { filter: brightness(1.08); }
.qt-main svg { width: 14px; height: 14px; fill: currentColor; }
.qt-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: none; border-radius: 7px; cursor: pointer;
  background: transparent; color: var(--qt-muted);
}
.qt-icon-btn:hover { background: var(--qt-hover); color: var(--qt-fg); }
.qt-icon-btn svg { width: 15px; height: 15px; fill: currentColor; }
.qt-lang-sel {
  height: 28px; max-width: 118px; padding: 0 6px; cursor: pointer;
  border: 1px solid var(--qt-border); border-radius: 7px;
  background: var(--qt-bg); color: var(--qt-fg); font-size: 12px;
}
.qt-lang-sel:focus { outline: 2px solid var(--qt-accent); outline-offset: -1px; }

/* ---- 结果面板 ---- */
.qt-panel { width: 380px; max-width: calc(100vw - 24px); display: flex; flex-direction: column; }
.qt-head {
  display: flex; align-items: center; gap: 6px; padding: 7px 8px;
  border-bottom: 1px solid var(--qt-border); background: var(--qt-bg);
  cursor: move; user-select: none;
}
.qt-title { font-size: 12px; font-weight: 600; color: var(--qt-muted); margin-right: auto; padding-left: 2px; }
.qt-body { padding: 12px 14px; overflow: auto; max-height: 300px; }
.qt-result { white-space: pre-wrap; word-break: break-word; font-size: 14px; line-height: 1.75; }
.qt-status { display: flex; align-items: center; gap: 8px; color: var(--qt-muted); font-size: 13px; padding: 4px 0; }
.qt-dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--qt-accent);
  animation: qt-pulse 1s infinite ease-in-out;
}
@keyframes qt-pulse { 0%,100% { opacity: .25; } 50% { opacity: 1; } }
.qt-err { color: #d92d20; font-size: 13px; white-space: pre-wrap; word-break: break-word; }
.qt-err code { background: var(--qt-hover); padding: 1px 4px; border-radius: 4px; font-size: 12px; }
.qt-src { margin-top: 10px; border-top: 1px dashed var(--qt-border); padding-top: 8px; }
.qt-src summary { cursor: pointer; font-size: 12px; color: var(--qt-muted); }
.qt-src-text {
  margin-top: 6px; font-size: 12.5px; color: var(--qt-muted);
  white-space: pre-wrap; word-break: break-word; max-height: 110px; overflow: auto;
}
.qt-foot {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  border-top: 1px solid var(--qt-border); font-size: 11.5px; color: var(--qt-muted);
}
.qt-foot .qt-spacer { margin-left: auto; }
.qt-link {
  border: none; background: none; color: var(--qt-accent); cursor: pointer;
  font-size: 11.5px; padding: 2px 4px; border-radius: 4px;
}
.qt-link:hover { background: var(--qt-hover); }

/* ---- 暂停提示条 ---- */
.qt-toast {
  position: fixed; right: 16px; bottom: 16px;
  display: flex; align-items: center; gap: 8px;
  padding: 8px 9px 8px 14px;
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
  color: var(--qt-fg); background: var(--qt-bg);
  border: 1px solid var(--qt-border); border-radius: 10px;
  box-shadow: var(--qt-shadow); max-width: min(420px, calc(100vw - 32px));
}
.qt-toast-btn {
  display: inline-flex; align-items: center; gap: 5px; flex: none;
  border: none; border-radius: 7px; cursor: pointer;
  background: var(--qt-accent); color: var(--qt-accent-fg);
  padding: 4px 10px; font-size: 12.5px; font-weight: 500; white-space: nowrap;
}
.qt-toast-btn:hover { filter: brightness(1.08); }
.qt-toast-btn svg { width: 12px; height: 12px; fill: currentColor; }

/* ---- 浮窗内设置面板（不跳转网页，就地展开） ---- */
.qt-settings {
  width: 420px; max-width: calc(100vw - 24px);
  display: flex; flex-direction: column; max-height: min(560px, calc(100vh - 32px));
}
.qt-settings .qt-body { padding: 12px 14px; max-height: none; flex: 1; }
.qt-tabs { display: flex; gap: 4px; }
.qt-tab {
  border: none; background: none; cursor: pointer; padding: 4px 9px; border-radius: 6px;
  font-size: 12px; color: var(--qt-muted); font-family: inherit;
}
.qt-tab:hover { background: var(--qt-hover); color: var(--qt-fg); }
.qt-tab.on { background: var(--qt-accent); color: var(--qt-accent-fg); }
.qt-pane { display: none; flex-direction: column; gap: 8px; }
.qt-pane.on { display: flex; }
.qt-f { display: flex; align-items: center; gap: 8px; }
.qt-f > .qt-fl { width: 68px; flex: none; font-size: 12px; color: var(--qt-muted); }
.qt-f > input[type="text"], .qt-f > input[type="password"], .qt-f > input[type="number"],
.qt-f > select, .qt-f > textarea {
  flex: 1; min-width: 0; padding: 5px 8px; font-size: 12.5px; color: var(--qt-fg);
  background: var(--qt-bg); border: 1px solid var(--qt-border); border-radius: 7px; font-family: inherit;
}
.qt-f > textarea { resize: vertical; line-height: 1.5; font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; }
.qt-f > input:focus, .qt-f > select:focus, .qt-f > textarea:focus {
  outline: 2px solid var(--qt-accent); outline-offset: -1px;
}
.qt-f.col { flex-direction: column; align-items: stretch; gap: 4px; }
.qt-f.col > .qt-fl { width: auto; }
.qt-hint { margin: 0; font-size: 11px; line-height: 1.5; color: var(--qt-muted); }
.qt-hint code, .qt-code {
  background: var(--qt-hover); color: var(--qt-fg); padding: 0 3px; border-radius: 3px;
  font-family: ui-monospace, Consolas, monospace; font-size: 10.5px;
}
.qt-checks { display: flex; flex-direction: column; gap: 5px; }
.qt-checks label {
  display: flex; align-items: center; gap: 6px; font-size: 12.5px; cursor: pointer;
}
.qt-checks input { accent-color: var(--qt-accent); width: 14px; height: 14px; margin: 0; }
.qt-perm { font-size: 11px; word-break: break-all; color: var(--qt-muted); }
.qt-perm.ok { color: #067647; }
.qt-perm.bad { color: #d92d20; }
.qt-row-btn { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.qt-btn {
  padding: 5px 12px; border-radius: 7px; font-size: 12.5px; cursor: pointer;
  border: 1px solid var(--qt-border); background: var(--qt-bg); color: var(--qt-fg); font-family: inherit;
}
.qt-btn:hover { background: var(--qt-hover); }
.qt-btn.primary { background: var(--qt-accent); border-color: var(--qt-accent); color: var(--qt-accent-fg); }
.qt-btn.primary:hover { filter: brightness(1.08); }
.qt-btn:disabled { opacity: .55; cursor: default; }
.qt-tip { font-size: 11.5px; color: #067647; }
.qt-test-out { font-size: 12px; white-space: pre-wrap; word-break: break-word; color: var(--qt-fg); }
.qt-test-out.ok { color: #067647; }
.qt-test-out.bad { color: #d92d20; }
.qt-hidden { display: none !important; }
`;

  /* ============ 图标 ============ */
  const ICON = {
    translate: '<svg viewBox="0 0 24 24"><path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 00-2 2v14h2V3h12V1zm3 4H8a2 2 0 00-2 2v14a2 2 0 002 2h11a2 2 0 002-2V7a2 2 0 00-2-2zm0 16H8V7h11v14z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M17.65 6.35A8 8 0 1019.73 14h-2.08A6 6 0 1112 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><path d="M19.14 12.94a7.07 7.07 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.61-.22l-2.39.96a7.03 7.03 0 00-1.62-.94l-.36-2.54a.5.5 0 00-.5-.42h-3.84a.5.5 0 00-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 00-.61.22L2.65 8.84a.5.5 0 00.12.64l2.03 1.58a7.07 7.07 0 000 1.88L2.77 14.5a.5.5 0 00-.12.64l1.92 3.32c.13.22.39.31.61.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.09.48 0 .61-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.6A3.6 3.6 0 1112 8.4a3.6 3.6 0 010 7.2z"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
  };

  /* ============ DOM 初始化 ============ */
  function ensureHost() {
    if (host) return;
    // 宿主必须是支持 attachShadow 的元素（textarea 不支持，实测抛 NotSupportedError），
    // 所以仍用 div。但额外加 contenteditable：站点（GitHub/知乎/B站）的单键快捷键会先判断
    // 「用户是不是正在输入」，依据是 e.target.tagName 或 document.activeElement。
    // Shadow DOM 会把事件 target 重定向成宿主，宿主若是普通 div 就会被判定为「没在输入」，
    // 于是站点抢走焦点、弹出自己的搜索框，浮窗还在却打不了字。
    // 宿主带 contenteditable 时，activeElement.isContentEditable 为 true，
    // 这两种判断都会认为用户正在输入，站点快捷键不再触发。
    host = document.createElement('div');
    host.id = 'quick-translate-host';
    host.setAttribute('contenteditable', 'plaintext-only');
    host.setAttribute('tabindex', '-1');
    host.setAttribute('spellcheck', 'false');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'all:initial;position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;opacity:0;' +
      'z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'open' });
    // 优先用 adoptedStyleSheets：不受页面 CSP 对 <style> 的限制
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch (e) {
      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);
    }

    const root = document.createElement('div');
    root.className = 'qt-root';
    shadow.appendChild(root);

    bubble = buildBubble();
    panel = buildPanel();
    settings = buildSettings();
    toast = buildToast();
    root.appendChild(bubble);
    root.appendChild(panel);
    root.appendChild(settings);
    root.appendChild(toast);

    (document.body || document.documentElement).appendChild(host);
  }

  function langOptions(selected) {
    return LANGS.map(
      ([code, name]) => `<option value="${code}"${code === selected ? ' selected' : ''}>${name}</option>`
    ).join('');
  }

  function buildBubble() {
    const el = document.createElement('div');
    el.className = 'qt-card qt-bubble qt-hidden';
    el.innerHTML = `
      <button class="qt-main" data-act="translate">${ICON.translate}<span data-role="label">翻译</span></button>
      <select class="qt-lang-sel" data-role="lang" title="目标语言">${langOptions(state.target)}</select>
      <button class="qt-icon-btn" data-act="settings" title="设置">${ICON.settings}</button>
      <button class="qt-icon-btn" data-act="pause" title="暂停划词浮窗（临时不再自动弹出）">${ICON.pause}</button>
    `;
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      e.preventDefault();
      e.stopPropagation();
      if (act.dataset.act === 'translate') startTranslate();
      if (act.dataset.act === 'settings') openSettings();
      if (act.dataset.act === 'pause') pausePopup();
    });
    el.addEventListener('change', (e) => {
      if (e.target.matches('[data-role="lang"]')) {
        setTarget(e.target.value);
        if (state.result) startTranslate(true);
      }
    });
    return el;
  }

  function buildPanel() {
    const el = document.createElement('div');
    el.className = 'qt-card qt-panel qt-hidden';
    el.innerHTML = `
      <div class="qt-head" data-role="drag">
        <span class="qt-title" data-role="title">译文</span>
        <select class="qt-lang-sel" data-role="lang" title="目标语言">${langOptions(state.target)}</select>
        <button class="qt-icon-btn" data-act="copy" title="复制译文">${ICON.copy}</button>
        <button class="qt-icon-btn" data-act="retry" title="重新翻译">${ICON.refresh}</button>
        <button class="qt-icon-btn" data-act="close" title="关闭 (Esc)">${ICON.close}</button>
      </div>
      <div class="qt-body">
        <div class="qt-status" data-role="status"><span class="qt-dot"></span><span data-role="status-text">翻译中…</span></div>
        <div class="qt-result qt-hidden" data-role="result"></div>
        <div class="qt-err qt-hidden" data-role="err"></div>
        <details class="qt-src" data-role="srcWrap">
          <summary>原文（<span data-role="srcLen">0</span> 字）</summary>
          <div class="qt-src-text" data-role="src"></div>
        </details>
      </div>
      <div class="qt-foot">
        <span data-role="meta"></span>
        <span class="qt-spacer"></span>
        <button class="qt-link" data-act="settings">设置</button>
      </div>
    `;
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'close') hideAll();
      else if (act === 'copy') copyResult(btn);
      else if (act === 'retry') startTranslate(true);
      else if (act === 'settings') openSettings();
    });
    el.addEventListener('change', (e) => {
      if (e.target.matches('[data-role="lang"]')) {
        setTarget(e.target.value);
        startTranslate(true);
      }
    });
    // 键盘隔离由 window 捕获阶段的 isolateKeys 统一处理（见 bindEvents）
    makeDraggable(el);
    return el;
  }

  function makeDraggable(el) {
    const head = el.querySelector('[data-role="drag"]');
    let sx = 0;
    let sy = 0;
    let ox = 0;
    let oy = 0;
    let on = false;
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('button, select')) return;
      const r = el.getBoundingClientRect();
      on = true;
      sx = e.clientX;
      sy = e.clientY;
      ox = r.left;
      oy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!on) return;
      state.dragged = true;
      state.follow = false;
      place(el, ox + (e.clientX - sx), oy + (e.clientY - sy), { absolute: true });
    });
    document.addEventListener('mouseup', () => {
      on = false;
    });
  }

  /* ============ 浮窗内设置面板 ============ */
  function buildSettings() {
    const el = document.createElement('div');
    el.className = 'qt-card qt-settings qt-hidden';
    el.innerHTML = `
      <div class="qt-head" data-role="drag">
        <span class="qt-title">设置</span>
        <button class="qt-tab on" data-tab="api">接口</button>
        <button class="qt-tab" data-tab="behave">语言</button>
        <button class="qt-tab" data-tab="test">测试</button>
        <button class="qt-icon-btn" data-act="settings-close" title="关闭设置 (Esc)">${ICON.close}</button>
      </div>
      <div class="qt-body">
        <!-- 接口 -->
        <div class="qt-pane on" data-pane="api">
          <div class="qt-f">
            <span class="qt-fl">接口类型</span>
            <select data-k="provider">
              <option value="local">本地翻译服务（8090，免密钥）</option>
              <option value="openai">OpenAI 兼容</option>
              <option value="deepl">DeepL</option>
              <option value="google">Google 翻译</option>
              <option value="custom">自定义 HTTP 接口</option>
            </select>
          </div>
          <div data-group="local">
            <div class="qt-f"><span class="qt-fl">接口地址</span><input type="text" data-k="localEndpoint" placeholder="http://127.0.0.1:8090/api/v1/translate" /></div>
            <div class="qt-f"><span class="qt-fl">翻译引擎</span><input type="text" data-k="localEngine" placeholder="baidu" /></div>
          </div>
          <div data-group="openai" class="qt-hidden">
            <div class="qt-f">
              <span class="qt-fl">服务商</span>
              <select data-act="preset">
                <option value="">选择以自动填充</option>
                <option value="zhipu">智谱 GLM</option>
                <option value="deepseek">DeepSeek</option>
                <option value="siliconflow">硅基流动</option>
                <option value="openai">OpenAI</option>
                <option value="moonshot">Moonshot</option>
                <option value="ollama">本地 Ollama</option>
              </select>
            </div>
            <div class="qt-f"><span class="qt-fl">接口地址</span><input type="text" data-k="endpoint" placeholder="https://.../chat/completions" /></div>
            <div class="qt-f"><span class="qt-fl">API Key</span><input type="password" data-k="apiKey" placeholder="sk-..." autocomplete="off" /></div>
            <div class="qt-f"><span class="qt-fl">模型</span><input type="text" data-k="model" placeholder="glm-4-flash" /></div>
            <div class="qt-f"><span class="qt-fl">温度</span><input type="number" data-k="temperature" min="0" max="2" step="0.1" /></div>
            <div class="qt-f col"><span class="qt-fl">系统提示词</span><textarea data-k="systemPrompt" rows="3"></textarea></div>
          </div>
          <div data-group="deepl" class="qt-hidden">
            <div class="qt-f">
              <span class="qt-fl">套餐</span>
              <select data-k="deeplPlan"><option value="free">API Free</option><option value="pro">API Pro</option></select>
            </div>
            <div class="qt-f"><span class="qt-fl">Auth Key</span><input type="password" data-k="deeplKey" autocomplete="off" /></div>
          </div>
          <div data-group="google" class="qt-hidden">
            <div class="qt-f"><span class="qt-fl">API Key</span><input type="password" data-k="googleKey" autocomplete="off" /></div>
          </div>
          <div data-group="custom" class="qt-hidden">
            <div class="qt-f"><span class="qt-fl">接口地址</span><input type="text" data-k="customEndpoint" /></div>
            <div class="qt-f">
              <span class="qt-fl">方法</span>
              <select data-k="customMethod"><option value="POST">POST</option><option value="GET">GET</option></select>
            </div>
            <div class="qt-f"><span class="qt-fl">取值路径</span><input type="text" data-k="customPath" placeholder="choices.0.message.content" /></div>
            <div class="qt-f col"><span class="qt-fl">请求头（JSON）</span><textarea data-k="customHeaders" rows="2" spellcheck="false"></textarea></div>
            <div class="qt-f col"><span class="qt-fl">请求体模板</span><textarea data-k="customBody" rows="4" spellcheck="false"></textarea></div>
          </div>
          <div class="qt-row-btn">
            <span class="qt-perm" data-role="perm"></span>
            <button class="qt-btn" data-act="perm">授权该接口域名</button>
          </div>
        </div>
        <!-- 语言与行为 -->
        <div class="qt-pane" data-pane="behave">
          <div class="qt-f"><span class="qt-fl">目标语言</span><select data-k="targetLang">${langOptions(state.target)}</select></div>
          <div class="qt-f"><span class="qt-fl">原文语言</span><select data-k="sourceLang"><option value="auto">自动检测</option>${langOptions('')}</select></div>
          <div class="qt-f"><span class="qt-fl">最大字符</span><input type="number" data-k="maxChars" min="200" max="20000" step="100" /></div>
          <div class="qt-checks">
            <label><input type="checkbox" data-k="enabled" /> 启用插件</label>
            <label><input type="checkbox" data-k="showBubble" /> 选区后自动弹出浮窗</label>
            <label><input type="checkbox" data-k="paused" /> 暂停自动弹出（临时关闭）</label>
            <label><input type="checkbox" data-k="autoCopy" /> 翻译后自动复制到剪贴板</label>
            <label><input type="checkbox" data-k="cacheEnabled" /> 启用译文缓存</label>
          </div>
          <p class="qt-hint"><kbd class="qt-code">Alt</kbd>+<kbd class="qt-code">T</kbd> 直接翻译选中文本，<kbd class="qt-code">Esc</kbd> 关闭浮窗。</p>
        </div>
        <!-- 测试 -->
        <div class="qt-pane" data-pane="test">
          <div class="qt-f col"><span class="qt-fl">测试文本</span><textarea data-k="testText" rows="2">Good tools make boring work valuable.</textarea></div>
          <div class="qt-row-btn">
            <button class="qt-btn primary" data-act="test">测试翻译</button>
            <button class="qt-btn" data-act="clearCache">清除缓存</button>
            <button class="qt-btn" data-act="export">导出配置</button>
            <button class="qt-btn" data-act="import">导入配置</button>
            <input type="file" accept="application/json" data-role="file" hidden />
          </div>
          <div class="qt-test-out" data-role="testOut"></div>
        </div>
      </div>
      <div class="qt-foot">
        <button class="qt-btn primary" data-act="save">保存设置</button>
        <span class="qt-tip" data-role="tip"></span>
        <span class="qt-spacer"></span>
      </div>
    `;
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act], [data-tab]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.tab) switchTab(btn.dataset.tab);
      else onSettingsAct(btn.dataset.act, btn);
    });
    // 键盘隔离由 window 捕获阶段的 isolateKeys 统一处理（见 bindEvents）
    el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.k === 'provider') applySettingsProvider(true);
      else if (t.dataset.act === 'preset') applyPreset(t.value);
      else if (/^(endpoint|customEndpoint|deeplPlan|localEndpoint)$/.test(t.dataset.k || '')) updatePermState();
    });
    makeDraggable(el);
    return el;
  }

  const PRESETS = {
    zhipu: { endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash' },
    deepseek: { endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
    siliconflow: { endpoint: 'https://api.siliconflow.cn/v1/chat/completions', model: 'Qwen/Qwen2.5-7B-Instruct' },
    openai: { endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
    moonshot: { endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k' },
    ollama: { endpoint: 'http://localhost:11434/v1/chat/completions', model: 'qwen2.5:7b' }
  };

  function sEl(sel) {
    return settings ? settings.querySelector(sel) : null;
  }

  function switchTab(name) {
    if (!settings) return;
    settings.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    settings.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('on', p.dataset.pane === name));
  }

  function applySettingsProvider(keepDirty) {
    const p = (sEl('[data-k="provider"]') || {}).value || 'local';
    settings.querySelectorAll('[data-group]').forEach((g) => {
      g.classList.toggle('qt-hidden', g.dataset.group !== p);
    });
    if (!keepDirty) updatePermState();
    else updatePermState();
  }

  function applyPreset(key) {
    const p = PRESETS[key];
    if (!p) return;
    const ep = sEl('[data-k="endpoint"]');
    const md = sEl('[data-k="model"]');
    if (ep) ep.value = p.endpoint;
    if (md) md.value = p.model;
    updatePermState();
  }

  function settingsUrl() {
    const p = (sEl('[data-k="provider"]') || {}).value || 'local';
    const val = (k) => {
      const n = sEl('[data-k="' + k + '"]');
      return n ? String(n.value || '').trim() : '';
    };
    if (p === 'local') return val('localEndpoint') || 'http://127.0.0.1:8090/api/v1/translate';
    if (p === 'deepl') {
      return val('deeplPlan') === 'pro' ? 'https://api.deepl.com/v2/translate' : 'https://api-free.deepl.com/v2/translate';
    }
    if (p === 'google') return 'https://translation.googleapis.com/language/translate/v2';
    if (p === 'custom') return val('customEndpoint');
    return val('endpoint');
  }

  function originOf(url) {
    try {
      return new URL(url).origin + '/*';
    } catch (e) {
      return null;
    }
  }

  function updatePermState() {
    const box = sEl('[data-role="perm"]');
    const btn = sEl('[data-act="perm"]');
    if (!box || !btn) return;
    const origin = originOf(settingsUrl());
    if (!origin) {
      box.className = 'qt-perm bad';
      box.textContent = '接口地址不是合法 URL';
      btn.classList.add('qt-hidden');
      return;
    }
    btn.classList.remove('qt-hidden');
    send({ type: 'qt:hasPermission', origin }, (r) => {
      const has = !!(r && r.ok);
      box.className = 'qt-perm ' + (has ? 'ok' : 'bad');
      box.textContent = has ? '已授权 ' + origin : '尚未授权 ' + origin;
      btn.textContent = has ? '已授权' : '授权该接口域名';
      btn.disabled = has;
    });
  }

  function fillSettings(c) {
    if (!settings) return;
    const put = (k, v) => {
      const n = sEl('[data-k="' + k + '"]');
      if (!n) return;
      if (n.type === 'checkbox') n.checked = !!v;
      else n.value = v == null ? '' : v;
    };
    put('provider', c.provider || 'local');
    put('localEndpoint', c.localEndpoint || 'http://127.0.0.1:8090/api/v1/translate');
    put('localEngine', c.localEngine || 'baidu');
    put('endpoint', c.endpoint || '');
    put('apiKey', c.apiKey || '');
    put('model', c.model || '');
    put('temperature', c.temperature == null ? 0.2 : c.temperature);
    put('systemPrompt', c.systemPrompt || '');
    put('deeplPlan', c.deeplPlan || 'free');
    put('deeplKey', c.deeplKey || '');
    put('googleKey', c.googleKey || '');
    put('customEndpoint', c.customEndpoint || c.endpoint || '');
    put('customMethod', c.customMethod || 'POST');
    put('customPath', c.customPath || '');
    put('customHeaders', c.customHeaders || '');
    put('customBody', c.customBody || '');
    put('targetLang', c.targetLang || 'zh-CN');
    put('sourceLang', c.sourceLang || 'auto');
    put('maxChars', c.maxChars || 4000);
    put('enabled', c.enabled);
    put('showBubble', c.showBubble);
    put('paused', c.paused);
    put('autoCopy', c.autoCopy);
    put('cacheEnabled', c.cacheEnabled);
    applySettingsProvider();
  }

  function collectSettings() {
    const get = (k) => {
      const n = sEl('[data-k="' + k + '"]');
      if (!n) return undefined;
      if (n.type === 'checkbox') return n.checked;
      return String(n.value || '').trim();
    };
    const provider = get('provider') || 'local';
    const patch = {
      enabled: get('enabled'),
      provider,
      targetLang: get('targetLang'),
      sourceLang: get('sourceLang'),
      maxChars: Number(get('maxChars')) || 4000,
      showBubble: get('showBubble'),
      paused: get('paused'),
      autoCopy: get('autoCopy'),
      cacheEnabled: get('cacheEnabled'),
      temperature: Number(get('temperature')) || 0,
      systemPrompt: get('systemPrompt'),
      customMethod: get('customMethod'),
      customPath: get('customPath'),
      customHeaders: get('customHeaders'),
      customBody: get('customBody'),
      customEndpoint: get('customEndpoint'),
      deeplPlan: get('deeplPlan'),
      googleKey: get('googleKey')
    };
    if (provider === 'local') {
      patch.localEndpoint = get('localEndpoint');
      patch.localEngine = get('localEngine') || 'baidu';
    } else if (provider === 'openai') {
      patch.endpoint = get('endpoint');
      patch.apiKey = get('apiKey');
      patch.model = get('model');
    } else if (provider === 'deepl') {
      patch.deeplKey = get('deeplKey');
    } else if (provider === 'custom') {
      patch.endpoint = get('customEndpoint');
    }
    return patch;
  }

  function tip(text) {
    const el = sEl('[data-role="tip"]');
    if (!el) return;
    el.textContent = text;
    clearTimeout(tip.timer);
    tip.timer = setTimeout(() => (el.textContent = ''), 2200);
  }

  function saveSettings() {
    const patch = collectSettings();
    const origin = originOf(settingsUrl());
    // 权限申请必须紧跟用户手势，不能被 await 打断
    if (origin) {
      try {
        chrome.permissions.request({ origins: [origin] }, () => void chrome.runtime.lastError);
      } catch (e) {}
    }
    send({ type: 'qt:setConfig', patch }, (res) => {
      if (res && res.ok) {
        cfg = Object.assign({}, cfg, res.config);
        state.target = cfg.targetLang || state.target;
        if (cfg.paused) hideAll();
        tip('已保存 ✓');
        updatePermState();
      } else {
        tip('保存失败');
      }
    });
  }

  function runSettingsTest(btn) {
    const out = sEl('[data-role="testOut"]');
    const txt = sEl('[data-k="testText"]');
    const patch = collectSettings();
    out.className = 'qt-test-out';
    out.textContent = '翻译中…';
    btn.disabled = true;
    send({ type: 'qt:setConfig', patch }, () => {
      send(
        {
          type: 'qt:translate',
          text: (txt && txt.value) || 'Hello world',
          target: patch.targetLang,
          source: patch.sourceLang,
          force: true
        },
        (res) => {
          btn.disabled = false;
          if (!res) {
            out.className = 'qt-test-out bad';
            out.textContent = '扩展无响应，请重试';
            return;
          }
          if (res.ok) {
            out.className = 'qt-test-out ok';
            out.textContent =
              res.text + (res.ms ? '\n（' + res.ms + 'ms' + (res.cached ? ' · 缓存' : '') + '）' : '');
            cfg = Object.assign({}, cfg, patch);
          } else if (res.needPermission) {
            out.className = 'qt-test-out bad';
            out.textContent = '缺少域名授权：' + res.origin + '（点左上「授权该接口域名」）';
          } else {
            out.className = 'qt-test-out bad';
            out.textContent = '失败：' + (res.error || '未知错误');
          }
        }
      );
    });
  }

  function onSettingsAct(act, btn) {
    if (act === 'settings-close') hideSettings();
    else if (act === 'save') saveSettings();
    else if (act === 'perm') {
      const origin = originOf(settingsUrl());
      if (!origin) return;
      try {
        chrome.permissions.request({ origins: [origin] }, () => {
          void chrome.runtime.lastError;
          updatePermState();
        });
      } catch (e) {}
    } else if (act === 'test') runSettingsTest(btn);
    else if (act === 'clearCache') {
      send({ type: 'qt:clearCache' }, () => tip('缓存已清除 ✓'));
    } else if (act === 'export') {
      const blob = new Blob([JSON.stringify(collectSettings(), null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'quick-translate-config.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    } else if (act === 'import') {
      const f = sEl('[data-role="file"]');
      if (f) f.click();
    }
  }

  function bindImport() {
    const f = sEl('[data-role="file"]');
    if (!f || f.__qtBound) return;
    f.__qtBound = true;
    f.addEventListener('change', async () => {
      const file = f.files && f.files[0];
      if (!file) return;
      try {
        const obj = JSON.parse(await file.text());
        send({ type: 'qt:setConfig', patch: obj }, (res) => {
          if (res && res.ok) {
            fillSettings(res.config);
            tip('已导入 ✓');
          } else tip('导入失败');
        });
      } catch (e) {
        tip('导入失败：JSON 格式不正确');
      }
      f.value = '';
    });
  }

  function openSettings() {
    ensureHost();
    hideBubble();
    hidePanelOnly();
    refreshRawConfig(() => {
      bindImport();
      hideAllPanelsExcept(settings);
      placeAtAnchor(settings);
      state.dragged = false;
      const sel = sEl('[data-k="targetLang"]');
      if (sel) sel.value = state.target;
      updatePermState();
      // 打开即把焦点送进第一个输入框：焦点若留在页面上，站点的单键快捷键
      // （GitHub 的 s、知乎/B站的 /）仍会因为「当前没在输入」而抢走焦点
      focusFirstField(true);
    });
  }

  /** 把焦点放进设置面板的第一个文本输入框 */
  function focusFirstField(arm) {
    if (!settings || settings.classList.contains('qt-hidden')) return;
    const inps = [...settings.querySelectorAll('input,textarea')]
      .filter((n) => n.type !== 'file' && n.type !== 'checkbox' && n.type !== 'radio' && n.getClientRects().length);
    const el = inps[0];
    if (!el) return;
    try {
      el.focus({ preventScroll: true });
    } catch (e) {
      el.focus();
    }
    if (arm) armFocusGuard(el);
  }

  function refreshRawConfig(cb) {
    send({ type: 'qt:getConfigRaw' }, (res) => {
      if (res && res.ok && res.config) fillSettings(res.config);
      else fillSettings(cfg);
      cb && cb();
    });
  }

  function hideSettings() {
    if (settings) settings.classList.add('qt-hidden');
    disarmFocusGuard();
  }

  function hideAllPanelsExcept(keep) {
    [bubble, panel, settings].forEach((el) => {
      if (el && el !== keep) el.classList.add('qt-hidden');
    });
  }

  /* ============ 定位 ============ */
  /**
   * @param ax,ay 锚点（鼠标位置 / 选区左上角）
   * @param opt.absolute 拖动时直接给定左上角
   * @param opt.above 是否放在锚点上方（默认 true）
   * @param opt.gap 与锚点的间距
   */
  function place(el, ax, ay, opt) {
    opt = opt || {};
    el.classList.remove('qt-hidden');
    const r = el.getBoundingClientRect(); // 先显示再量尺寸
    const w = r.width;
    const h = r.height;
    const pad = 8;
    const gap = opt.gap == null ? 14 : opt.gap;
    let left;
    let top;

    if (opt.absolute) {
      left = ax;
      top = ay;
    } else {
      left = ax + gap;
      if (left + w > window.innerWidth - pad) left = ax - w - gap; // 右侧放不下 → 翻到锚点左侧
      top = opt.above === false ? ay + gap : ay - h - 10;
      if (top < pad) top = ay + 18; // 上方放不下 → 翻到下方
    }

    left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
    top = Math.max(pad, Math.min(top, window.innerHeight - h - pad));
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
  }

  function placeAtAnchor(el, fromScroll) {
    if (state.dragged && el === panel) return; // 手动拖动过就保持不动
    // 首次弹出：以鼠标位置为准（右上角）；滚动时：跟随选中的文本块
    if (fromScroll && state.range) {
      const r = state.range.getBoundingClientRect();
      if (r && (r.width || r.height) && r.bottom > 0 && r.top < window.innerHeight) {
        place(el, r.right, r.top, { above: true, gap: 6 });
        avoidSelection(el);
        return;
      }
    }
    place(el, state.anchor.x, state.anchor.y, { above: true });
    avoidSelection(el);
  }

  /* 浮窗压住选中文字时，让到选区上方（上方不够则下方） */
  function avoidSelection(el) {
    if (!state.range || state.dragged) return;
    const sr = state.range.getBoundingClientRect();
    if (!sr || (!sr.width && !sr.height)) return;
    const er = el.getBoundingClientRect();
    const overlap = !(er.right < sr.left || er.left > sr.right || er.bottom < sr.top || er.top > sr.bottom);
    if (!overlap) return;

    const pad = 8;
    let top = sr.top - er.height - pad;
    if (top < pad) top = sr.bottom + pad;
    if (top + er.height > window.innerHeight - pad) return; // 上下都放不下，保持原位置
    el.style.top = Math.round(top) + 'px';
    const left = Math.max(pad, Math.min(er.left, window.innerWidth - er.width - pad));
    el.style.left = Math.round(left) + 'px';
  }

  /* ============ 显隐 ============ */
  function hideAll() {
    if (bubble) bubble.classList.add('qt-hidden');
    if (panel) panel.classList.add('qt-hidden');
    if (settings) settings.classList.add('qt-hidden');
    state.result = '';
    disarmFocusGuard();
  }

  function hideBubble() {
    if (bubble) bubble.classList.add('qt-hidden');
  }

  /* ============ 暂停（临时不再弹出） ============ */
  function buildToast() {
    const el = document.createElement('div');
    el.className = 'qt-toast qt-hidden';
    el.innerHTML = `
      <span data-role="toast-text"></span>
      <button class="qt-toast-btn" data-act="resume">${ICON.play}恢复</button>
      <button class="qt-icon-btn" data-act="toast-close" title="关闭提示">${ICON.close}</button>
    `;
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.act === 'resume') resumePopup();
      else hideToast();
    });
    return el;
  }

  function showToast(text) {
    if (!toast) return;
    toast.querySelector('[data-role="toast-text"]').textContent = text;
    toast.classList.remove('qt-hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 9000);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    if (toast) toast.classList.add('qt-hidden');
  }

  function pausePopup() {
    cfg.paused = true;
    hideAll();
    send({ type: 'qt:setConfig', patch: { paused: true } });
    showToast('划词浮窗已暂停，选中文字不再弹出');
  }

  function resumePopup() {
    cfg.paused = false;
    send({ type: 'qt:setConfig', patch: { paused: false } });
    hideAll();
    showToast('划词浮窗已恢复，选中文字会再次弹出');
  }

  function showBubble(text, x, y) {
    ensureHost();
    state.text = text;
    state.anchor = { x, y };
    state.dragged = false;
    state.follow = true;
    state.result = '';
    const range = currentRange();
    state.range = range ? range.cloneRange() : null;

    const label = bubble.querySelector('[data-role="label"]');
    label.textContent = '翻译为 ' + langName(state.target);
    const sel = bubble.querySelector('[data-role="lang"]');
    if (sel) sel.value = state.target;

    hidePanelOnly();
    placeAtAnchor(bubble);
  }

  function hidePanelOnly() {
    if (panel) panel.classList.add('qt-hidden');
  }

  /* ============ 翻译流程 ============ */
  function setStatus(text, loading) {
    const s = panel.querySelector('[data-role="status"]');
    const t = panel.querySelector('[data-role="status-text"]');
    const dot = s.querySelector('.qt-dot');
    s.classList.remove('qt-hidden');
    t.textContent = text;
    dot.style.display = loading ? '' : 'none';
  }

  function openPanel() {
    ensureHost();
    panel.querySelector('[data-role="result"]').classList.add('qt-hidden');
    panel.querySelector('[data-role="err"]').classList.add('qt-hidden');
    panel.querySelector('[data-role="src"]').textContent = state.text;
    panel.querySelector('[data-role="srcLen"]').textContent = String(state.text.length);
    panel.querySelector('[data-role="title"]').textContent = '译文 · ' + langName(state.target);
    const sel = panel.querySelector('[data-role="lang"]');
    if (sel) sel.value = state.target;
    hideBubble();
    placeAtAnchor(panel);
  }

  function startTranslate(force) {
    if (!state.text) return;
    if (state.busy) return;
    state.busy = true;
    openPanel();
    setStatus('翻译中…', true);
    panel.querySelector('[data-role="meta"]').textContent = '';

    const payload = {
      type: 'qt:translate',
      text: state.text,
      target: state.target,
      source: cfg.sourceLang || 'auto',
      force: !!force
    };
    send(payload, (res) => {
      state.busy = false;
      if (!res) {
        showError('扩展未响应，请刷新页面后重试。');
        return;
      }
      if (res.ok) {
        state.result = res.text;
        setStatus('', false);
        panel.querySelector('[data-role="status"]').classList.add('qt-hidden');
        const box = panel.querySelector('[data-role="result"]');
        box.textContent = res.text;
        box.classList.remove('qt-hidden');
        const bits = [];
        if (res.provider) bits.push(providerLabel(res.provider));
        if (res.model) bits.push(res.model);
        if (res.ms) bits.push(res.ms + 'ms');
        if (res.cached) bits.push('缓存');
        if (state.text.length > (Number(cfg.maxChars) || 4000)) bits.push('原文已截断');
        panel.querySelector('[data-role="meta"]').textContent = bits.join(' · ');
        if (cfg.autoCopy) copyResult(null, true);
      } else if (res.needPermission) {
        showPermissionError(res.origin);
      } else {
        showError(res.error || '翻译失败');
      }
    });
  }

  function providerLabel(p) {
    return { local: '本地服务', openai: 'OpenAI 兼容', deepl: 'DeepL', google: 'Google', custom: '自定义' }[p] || p;
  }

  function showError(msg) {
    setStatus('', false);
    panel.querySelector('[data-role="status"]').classList.add('qt-hidden');
    const err = panel.querySelector('[data-role="err"]');
    err.innerHTML = '';
    const pre = document.createElement('div');
    pre.textContent = '翻译失败：' + msg;
    err.appendChild(pre);
    const btn = document.createElement('button');
    btn.className = 'qt-link';
    btn.textContent = '打开设置检查配置 →';
    btn.addEventListener('click', () => openSettings());
    err.appendChild(btn);
    err.classList.remove('qt-hidden');
  }

  function showPermissionError(origin) {
    setStatus('', false);
    panel.querySelector('[data-role="status"]').classList.add('qt-hidden');
    const err = panel.querySelector('[data-role="err"]');
    err.innerHTML = '';
    const pre = document.createElement('div');
    pre.textContent = '需要授权访问 ' + origin + ' 才能调用该接口。';
    err.appendChild(pre);
    const btn = document.createElement('button');
    btn.className = 'qt-link';
    btn.textContent = '点击授权';
    btn.addEventListener('click', () => {
      let target = origin;
      try {
        target = new URL(origin).origin + '/*';
      } catch (e) {}
      btn.textContent = '授权中…';
      send({ type: 'qt:requestOrigin', origin: target }, (r) => {
        if (r && r.ok) {
          startTranslate(true);
          return;
        }
        // 内容脚本里往往拿不到用户手势，无法调起权限弹窗 → 就地展开设置面板，让用户在那里授权
        btn.textContent = '在浮窗设置里授权该接口域名 →';
        openSettings();
        setTimeout(() => switchTab('api'), 0);
      });
    });
    err.appendChild(btn);
    err.classList.remove('qt-hidden');
  }

  function copyResult(btn, silent) {
    const text = state.result || '';
    if (!text) return;
    const done = () => {
      if (!btn || !btn.dataset) return;
      const old = btn.innerHTML;
      btn.innerHTML = ICON.check;
      setTimeout(() => (btn.innerHTML = old), 1200);
    };
    try {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } catch (e) {
      fallback();
    }
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        done();
      } catch (e2) {}
      ta.remove();
    }
  }

  /* ============ 选区 ============ */
  function isInside(e) {
    if (!host) return false;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (path.indexOf(host) !== -1) return true;
    return e.target === host || (e.target && host.contains(e.target));
  }

  /**
   * 键盘隔离：插件浮层盖在页面上，但事件仍会走到宿主页面。
   * GitHub 的 s、/ 是单键快捷键，一旦被它们的 document 监听器收到就会把焦点抢到搜索框，
   * 浮窗还在却打不了字。
   *
   * 实测结论（必须记住）：捕获阶段 document 的监听器**先于** Shadow DOM 内部元素执行，
   * 所以只在面板内部 stopPropagation 是无效的。必须在 window 捕获阶段抢先拦，
   * 用 composedPath() 穿透 shadow 判断事件源是否在浮窗内。
   */
  function isolateKeys(e) {
    if (e.key === 'Escape') return; // 交给全局 onKeyDown 处理：关设置 / 关面板
    if (!isInside(e)) return; // 页面自己的键盘输入不干预
    e.stopPropagation();
    // 隔离拦不住「注册更早」的页面监听器，补一道焦点守卫：
    // 用户在这个输入框里打字期间，焦点被抢走就抢回来
    if (e.type === 'keydown') armFocusGuard(realTarget(e));
  }

  /**
   * 取事件的真实目标。
   * Shadow DOM 对外做 retargeting，e.target 会被替换成宿主 host（DIV），
   * 所以判断「是不是在输入框里打字」必须看 composedPath()[0]，不能看 e.target。
   * 实测：浮窗输入框里敲键，e.target 是 DIV，composedPath()[0] 才是 INPUT。
   */
  function realTarget(e) {
    if (typeof e.composedPath === 'function') {
      const p = e.composedPath();
      if (p && p.length) return p[0];
    }
    return e.target;
  }

  /**
   * 焦点守卫：window 捕获阶段拦不住「注册更早」的页面监听器。
   *
   * 实测证据（CDP + 真实扩展，Edge）：
   *   页面若在插件之前注册 window 捕获 keydown，插件的 isolateKeys 排在它后面，
   *   事件已经被页面拿去 focus 到它自己的搜索框 —— stopPropagation 只是「拦后面的人」，救不了前面。
   *   实测 earlyCount=1、who=EARLY-WIN-CAP-FOCUSED，确认隔离失效。
   *
   * 因此补一道兜底：浮窗可见且用户正在里面打字时，一旦焦点被页面抢走，立刻抢回，
   * 并清掉抢焦点那个输入框（如 GitHub 搜索框）里刚被塞进去的字符。
   */
  let guardInput = null;   // 被守卫的输入框
  let guarding = false;
  let guardTimer = 0;

  function isTypingField(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
  }

  function restoreFocus() {
    if (!guardInput || !guardInput.isConnected) return;
    const sr = host && host.shadowRoot;
    if (sr && sr.activeElement === guardInput) return; // 已经回来了
    try {
      guardInput.focus({ preventScroll: true });
    } catch (e) {
      guardInput.focus();
    }
  }

  function onFocusStolen(e) {
    if (!guarding || !guardInput || !guardInput.isConnected) return;
    const t = e.target;
    // 焦点还在浮窗内 → 正常
    if (t === host || (host && host.contains(t))) return;
    if (host && host.shadowRoot && host.shadowRoot.contains(t)) return;
    // 焦点跑到页面上了：清掉页面输入框里可能被塞进去的字符
    if (isTypingField(t) && t !== guardInput) {
      clearStolenField(t);
    }
    // 下一拍抢回，避免和页面自己的 focus 逻辑打架
    clearTimeout(guardTimer);
    guardTimer = setTimeout(() => {
      restoreFocus();
      // 抢回后再清一次：字符可能在 focus 之后才被写进页面输入框
      if (isTypingField(t) && t !== guardInput) clearStolenField(t);
    }, 0);
  }

  /** 清掉被抢焦点那个输入框里刚被塞进去的字符（只清短的，避免误删用户真实内容） */
  function clearStolenField(el) {
    try {
      const v = el.value;
      if (typeof v === 'string' && v.length > 0 && v.length <= 8) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (err) {}
  }

  /** 用户开始在某输入框打字时启动守卫 */
  function armFocusGuard(el) {
    if (!el || el === guardInput) return;
    guardInput = el;
    if (guarding) return;
    guarding = true;
    document.addEventListener('focusin', onFocusStolen, true);
  }

  function disarmFocusGuard() {
    guardInput = null;
    if (!guarding) return;
    guarding = false;
    document.removeEventListener('focusin', onFocusStolen, true);
    clearTimeout(guardTimer);
  }

  function selectedText() {
    const el = document.activeElement;
    if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && typeof el.value === 'string'))) {
      const v = el.value.substring(el.selectionStart || 0, el.selectionEnd || 0);
      if (v && v.trim()) return v.trim();
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return '';
    return (sel.toString() || '').trim();
  }

  function currentRange() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    return sel.getRangeAt(0);
  }

  function onMouseUp(e) {
    if (!cfg.enabled) return;
    if (cfg.paused) {
      hideBubble();
      return;
    }
    if (e.button !== 0) return;
    if (isInside(e)) return;
    setTimeout(() => {
      const text = selectedText();
      if (!text || text.length < 1) {
        hideBubble();
        return;
      }
      if (!cfg.showBubble) return;
      showBubble(text, e.clientX, e.clientY);
    }, 12);
  }

  function onKeyDown(e) {
    // 焦点在插件浮窗内：只处理 Esc（关设置 / 关面板），
    // 其余快捷键已由 isolateKeys 挡在浮层里，不在此重复处理
    if (isInside(e) && e.key !== 'Escape') return;
    if (e.key === 'Escape') {
      if (settings && !settings.classList.contains('qt-hidden')) {
        hideSettings();
        e.stopPropagation();
        return;
      }
      if (panel && !panel.classList.contains('qt-hidden')) {
        hideAll();
        e.stopPropagation();
      } else {
        hideBubble();
      }
      return;
    }
    // Alt + T：直接翻译当前选中
    if (e.altKey && (e.key === 't' || e.key === 'T')) {
      if (!cfg.enabled) return;
      const text = selectedText();
      if (!text) return;
      e.preventDefault();
      const r = currentRange();
      const rect = r ? r.getBoundingClientRect() : null;
      state.text = text;
      state.range = r ? r.cloneRange() : null;
      state.anchor = rect ? { x: rect.right, y: rect.bottom } : { x: window.innerWidth / 2, y: 120 };
      startTranslate(true);
    }
  }

  function onExternalDown(e) {
    if (isInside(e)) return;
    hideBubble(); // 面板保留，方便继续阅读/复制
  }

  function onScrollOrResize() {
    if (!host) return;
    if (!state.follow) return;
    const bVisible = bubble && !bubble.classList.contains('qt-hidden');
    const pVisible = panel && !panel.classList.contains('qt-hidden');
    const sVisible = settings && !settings.classList.contains('qt-hidden');
    if (bVisible) placeAtAnchor(bubble, true);
    if (pVisible) placeAtAnchor(panel, true);
    if (sVisible) placeAtAnchor(settings, true);
  }

  /* ============ 通信 ============ */
  function send(msg, cb) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) {
        cb && cb(null);
        return;
      }
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          cb && cb(null);
          return;
        }
        cb && cb(res);
      });
    } catch (e) {
      cb && cb(null);
    }
  }

  async function setTarget(code) {
    state.target = code;
    try {
      const data = await chrome.storage.local.get('qt_config');
      const next = Object.assign({}, data.qt_config || {}, { targetLang: code });
      await chrome.storage.local.set({ qt_config: next });
    } catch (e) {}
  }

  function refreshConfig(cb) {
    send({ type: 'qt:getConfig' }, (res) => {
      if (res && res.ok && res.config) {
        cfg = Object.assign({}, cfg, res.config);
        state.target = cfg.targetLang || state.target;
        const label = bubble && bubble.querySelector('[data-role="label"]');
        if (label) label.textContent = '翻译为 ' + langName(state.target);
      }
      cb && cb();
    });
  }

  /* ============ 启动 ============ */
  function bindEvents() {
    if (bindEvents.done) return;
    bindEvents.done = true;
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('mousedown', onExternalDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    // 键盘隔离必须在 window 捕获阶段：它比页面 document 的捕获监听器更早，
    // 否则 GitHub 的 s、/ 单键快捷键会先把焦点抢走（实测结论，勿随意挪位置）
    window.addEventListener('keydown', isolateKeys, true);
    window.addEventListener('keypress', isolateKeys, true);
    window.addEventListener('keyup', isolateKeys, true);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
  }

  bindEvents(); // 始终绑定，是否生效由 cfg.enabled 在回调里判断
  refreshConfig();
  window.__QT_LOADED__ = true;

  chrome.storage &&
    chrome.storage.onChanged &&
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.qt_config) {
        const wasPaused = cfg.paused;
        cfg = Object.assign({}, cfg, changes.qt_config.newValue || {});
        if (cfg.targetLang) state.target = cfg.targetLang;
        // 在别的标签页/弹窗里暂停了，本页也立即收起浮窗
        if (cfg.paused && !wasPaused) hideAll();
      }
    });

  chrome.runtime &&
    chrome.runtime.onMessage &&
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return;
      // 供 popup 探测本页是否已注入
      if (msg.type === 'qt:ping') {
        sendResponse({ ok: true, loaded: true });
        return true;
      }
      if (msg.type === 'qt:menu-translate') {
        const text = selectedText();
        if (!text) return;
        const r = currentRange();
        const rect = r ? r.getBoundingClientRect() : null;
        state.text = text;
        state.range = r ? r.cloneRange() : null;
        state.anchor = rect ? { x: rect.right, y: rect.bottom } : { x: window.innerWidth / 2, y: 120 };
        startTranslate(true);
      } else if (msg.type === 'qt:openSettings') {
        // 来自工具栏弹窗：在当前页面里就地展开设置面板
        state.text = state.text || '';
        if (!state.anchor || (!state.anchor.x && !state.anchor.y)) {
          const sel = window.getSelection();
          const r = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
          state.anchor = r && r.width
            ? { x: r.right, y: r.top }
            : { x: Math.round(window.innerWidth / 2), y: 120 };
        }
        openSettings();
        sendResponse({ ok: true });
        return true;
      } else if (msg.type === 'qt:reload-config') {
        refreshConfig();
      }
    });
})();

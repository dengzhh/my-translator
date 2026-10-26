/**
 * 端到端测试：用真实 Edge（headless，无窗口）加载扩展，
 * 真实鼠标拖选 → 断言浮窗出现在鼠标右上方 → 真实点击「翻译」→ 断言译文渲染。
 * 为了免去自动化里无法点击权限弹窗的问题，测试副本的 manifest 会额外声明本地端点 host_permissions。
 *
 * 运行: node test/e2e.mjs
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 加载 playwright-core。
 * 解析顺序：环境变量 PLAYWRIGHT_NODE_PATH（照 Node 的 NODE_PATH 约定，可含多个）→ 项目内 node_modules。
 * 换台机器跑测试时只需 `npm i -D playwright-core`，不必改代码。
 */
function loadPlaywright() {
  const bases = [];
  for (const p of String(process.env.PLAYWRIGHT_NODE_PATH || '').split(path.delimiter)) {
    if (p.trim()) bases.push(p.trim());
  }
  bases.push(ROOT);
  bases.push(import.meta.url);
  for (const base of bases) {
    try {
      return createRequire(path.join(base, 'noop.js'))('playwright-core');
    } catch (e) {
      void e;
    }
  }
  throw new Error(
    '找不到 playwright-core：请在本目录执行 npm i -D playwright-core，' +
      '或设置 PLAYWRIGHT_NODE_PATH 指向已安装它的 node_modules 目录'
  );
}

const { chromium } = loadPlaywright();
const LOGF = path.join(ROOT, 'test', 'e2e.log');
fs.writeFileSync(LOGF, '');
const rawLog = console.log;
console.log = (...a) => {
  const line = a.join(' ');
  rawLog(line);
  fs.appendFileSync(LOGF, line + '\n');
};
const ART = path.join(ROOT, 'test', 'artifacts');
const TMP_PROFILE = path.join(ROOT, 'test', '.tmp-profile');
/** 探测本机 Edge（可用环境变量 EDGE_PATH 覆盖） */
function findEdge() {
  if (process.env.EDGE_PATH && fs.existsSync(process.env.EDGE_PATH)) return process.env.EDGE_PATH;
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return cands[0];
}
const EDGE = findEdge();

const EXPECTED = '这是测试译文。';
const requests = [];
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

/* ---------- 本地假翻译接口 + 测试页 ---------- */
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/v1/chat/completions')) {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            requests.push(JSON.parse(body || '{}'));
          } catch (e) {
            requests.push({ raw: body });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: EXPECTED } }] }));
        });
        return;
      }
      const name = req.url === '/' ? 'fixture.html' : req.url.replace(/^\//, '').split('?')[0];
      const file = path.join(ROOT, 'test', name);
      if (!fs.existsSync(file)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/* ---------- 读取浮窗状态 ---------- */

async function readBubble(page) {
  return page.evaluate(() => {
    const host = document.getElementById('quick-translate-host');
    if (!host || !host.shadowRoot) return null;
    const sr = host.shadowRoot;
    const b = sr.querySelector('.qt-bubble');
    const p = sr.querySelector('.qt-panel');
    const t = sr.querySelector('.qt-toast');
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    };
    return {
      bubbleVisible: !!b && !b.classList.contains('qt-hidden'),
      bubbleRect: rect(b),
      bubbleLabel: b ? b.querySelector('[data-role="label"]').textContent : '',
      toastVisible: !!t && !t.classList.contains('qt-hidden'),
      toastText: t ? t.querySelector('[data-role="toast-text"]').textContent : '',
      panelVisible: !!p && !p.classList.contains('qt-hidden'),
      resultText: p ? p.querySelector('[data-role="result"]').textContent : '',
      resultVisible: p ? !p.querySelector('[data-role="result"]').classList.contains('qt-hidden') : false,
      errText: p ? p.querySelector('[data-role="err"]').textContent : '',
      meta: p ? p.querySelector('[data-role="meta"]').textContent : ''
    };
  });
}

async function waitFor(fn, timeout = 12000, interval = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}

(async () => {
  fs.mkdirSync(ART, { recursive: true });
  const server = await startServer();
  const port = server.address().port;
  console.log(`\n本地接口 http://127.0.0.1:${port}/v1/chat/completions`);

  fs.rmSync(TMP_PROFILE, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(TMP_PROFILE, {
    executablePath: EDGE,
    headless: false, // 配合 --headless=new：无窗口但仍支持扩展
    viewport: { width: 1000, height: 700 },
    args: [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`
    ]
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;
  console.log('扩展已加载，id=' + extId + '\n');

  /* 1. 写入配置 */
  console.log('[1] 扩展配置');
  const opt = await context.newPage();
  await opt.goto(`chrome-extension://${extId}/options/options.html`);
  await opt.evaluate(
    async (cfg) => {
      await chrome.storage.local.set({ qt_config: cfg });
      await chrome.storage.local.remove('qt_cache');
    },
    {
      enabled: true,
      provider: 'openai',
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      apiKey: 'test-key',
      model: 'test-model',
      targetLang: 'zh-CN',
      sourceLang: 'auto',
      temperature: 0,
      showBubble: true,
      autoCopy: false,
      cacheEnabled: true,
      maxChars: 4000
    }
  );
  const optTitle = await opt.title();
  ok(optTitle.includes('我的翻译'), '设置页正常渲染：' + optTitle);
  await opt.screenshot({ path: path.join(ART, '05-options.png'), fullPage: true });

  /* 打开设置的行为：就地展开浮窗设置面板，绝不能把用户的网页导航走 */
  console.log('\n[1b] 打开设置：在浮窗内展开，不导航网页');
  const host = await context.newPage();
  await host.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await host.bringToFront();
  await host.waitForTimeout(400);
  const urlBefore = host.url();

  // 走真实链路：先让后台对该标签页注入内容脚本（免刷新注入），再发打开设置的消息
  const inj = await opt.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    let target = null;
    for (const t of tabs) {
      if (t.url && t.url.startsWith('http://127.0.0.1')) {
        target = t;
        break;
      }
    }
    if (!target) return { err: 'no 127.0.0.1 tab' };
    return await new Promise((r) =>
      chrome.runtime.sendMessage({ type: 'qt:injectTab', tabId: target.id }, (x) => r(x || null))
    );
  });
  ok(inj && inj.ok === true, '测试页已注入内容脚本', inj && inj.err);

  const openedRes = await opt.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    let target = null;
    for (const t of tabs) {
      if (t.url && t.url.startsWith('http://127.0.0.1')) {
        target = t;
        break;
      }
    }
    if (!target) return null;
    return await new Promise((r) =>
      chrome.tabs.sendMessage(target.id, { type: 'qt:openSettings' }, (x) => {
        void chrome.runtime.lastError;
        r(x || null);
      })
    );
  });
  await host.waitForTimeout(400);
  ok(!!(openedRes && openedRes.ok), '内容脚本响应了“打开设置”（不导航网页）');

  const setBox = await host.evaluate(() => {
    const h = document.getElementById('quick-translate-host');
    const sr = h && h.shadowRoot;
    const el = sr && sr.querySelector('.qt-settings');
    if (!el) return null;
    const vis = !el.classList.contains('qt-hidden') && el.getBoundingClientRect().width > 0;
    return { vis, width: Math.round(el.getBoundingClientRect().width) };
  });
  ok(!!setBox && setBox.vis, '设置面板已在页面内展开（宽度=' + (setBox ? setBox.width : '无') + 'px）');
  ok(host.url() === urlBefore, '用户的网页没有被导航走，仍在 ' + host.url());
  ok(!host.url().includes('options.html'), '没有跳到设置页 URL');
  const hasKeyField = await host.evaluate(() => {
    const sr = document.getElementById('quick-translate-host').shadowRoot;
    return !!sr.querySelector('[data-k="apiKey"]');
  });
  ok(hasKeyField, '面板内带接口/密钥等配置项');

  // 面板里不允许存在任何会把网页导航走的入口（曾经的「完整设置页」已删除）
  const navEntries = await host.evaluate(() => {
    const sr = document.getElementById('quick-translate-host').shadowRoot;
    return {
      full: !!sr.querySelector('[data-act="openFull"]'),
      links: [...sr.querySelectorAll('.qt-settings a[href]')].map((a) => a.getAttribute('href')),
      text: (sr.querySelector('.qt-settings').textContent || '').includes('完整设置页')
    };
  });
  ok(!navEntries.full, '设置面板里没有「完整设置页」按钮');
  ok(!navEntries.text, '设置面板里不再出现「完整设置页」字样');
  ok(navEntries.links.length === 0, '设置面板里没有任何外链（实际=' + JSON.stringify(navEntries.links) + '）');
  await host.screenshot({ path: path.join(ART, '09-settings-inline.png') });

  // Esc 关闭设置面板，页面依然停在原处
  await host.keyboard.press('Escape');
  await host.waitForTimeout(250);
  const closed = await host.evaluate(() => {
    const sr = document.getElementById('quick-translate-host').shadowRoot;
    return sr.querySelector('.qt-settings').classList.contains('qt-hidden');
  });
  ok(closed, 'Esc 可关闭浮窗设置面板');
  ok(host.url() === urlBefore, '关闭后仍在原网页，实际=' + host.url());

  // 右键菜单 / 图标兜底也走「就地展开」，同样不导航
  const menuRes = await opt.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    let target = null;
    for (const t of tabs) {
      if (t.url && t.url.startsWith('http://127.0.0.1')) {
        target = t;
        break;
      }
    }
    if (!target) return { err: 'no tab' };
    // 直接调用后台的同名逻辑（保证与右键菜单、图标点击共用一条代码路径）
    return await new Promise((r) =>
      chrome.runtime.sendMessage({ type: 'qt:openSettingsInlineProbe', tabId: target.id }, (x) => {
        void chrome.runtime.lastError;
        r(x || null);
      })
    );
  });
  if (menuRes && menuRes.supported) {
    ok(menuRes.mode === 'inline', '右键菜单/图标兜底也是就地展开（mode=' + menuRes.mode + '）');
    ok(host.url() === urlBefore, '兜底入口也没有导航网页，实际=' + host.url());
  }
  await host.close();

  // 工具栏弹窗：暂停开关的初始文案
  const pop = await context.newPage();
  await pop.goto(`chrome-extension://${extId}/popup/popup.html`);
  await pop.waitForTimeout(300);
  const popPause = await pop.locator('#pauseState').textContent();
  const popBtn = await pop.locator('#btnPause').textContent();
  ok(/开启/.test(popPause || '') && popBtn.trim() === '暂停', `弹窗显示浮窗可用（${popPause} / ${popBtn}）`);
  await pop.screenshot({ path: path.join(ART, '08-popup.png') });
  await pop.close();

  /* 2. 打开测试页并拖选 */
  console.log('\n[2] 选区与浮窗');
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await page.waitForTimeout(400);

  const box = await page.locator('#para').boundingBox();
  const startX = box.x + 6;
  const startY = box.y + 6;
  const endX = box.x + box.width - 6;
  const endY = box.y + 30; // 只选第一行，保证选区高度小

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 12 });
  await page.mouse.up();

  const bubble = await waitFor(async () => {
    const s = await readBubble(page);
    return s && s.bubbleVisible ? s : null;
  });
  ok(!!bubble, '选中文本后浮窗自动出现');
  if (bubble) {
    ok(bubble.bubbleRect.h > 0 && bubble.bubbleRect.w > 0, '浮窗有实际尺寸（未被样式压成 0）',
      JSON.stringify(bubble.bubbleRect));
    ok(bubble.bubbleLabel.includes('简体中文'), '浮窗提示目标语言：' + bubble.bubbleLabel);
    // 鼠标右上角：浮窗底部紧贴鼠标上方，水平方向紧邻（右侧放不下时自动翻到左侧）
    const mouseY = endY;
    const mouseX = endX;
    const rb = bubble.bubbleRect;
    ok(rb.bottom <= mouseY + 2, `浮窗位于鼠标上方 (bottom=${Math.round(rb.bottom)} ≤ mouseY=${Math.round(mouseY)})`);
    ok(mouseY - rb.bottom <= 60, `垂直紧邻鼠标 (间距=${Math.round(mouseY - rb.bottom)}px ≤ 60)`);
    ok(rb.right >= mouseX - 25 && rb.x <= mouseX + 40,
      `水平紧邻鼠标 (浮窗 ${Math.round(rb.x)}~${Math.round(rb.right)}, 鼠标 x=${Math.round(mouseX)})`);
    ok(rb.x + rb.w <= 1000 && rb.y >= 0, '未溢出视口');
    await page.screenshot({ path: path.join(ART, '01-bubble.png') });
  }

  /* 2.5 点气泡上的「暂停」→ 临时不再弹出，再从提示条恢复 */
  console.log('\n[2.5] 暂停划词浮窗 → 不再自动弹出 → 恢复');
  await page.locator('.qt-bubble [data-act="pause"]').click();
  const afterPause = await waitFor(async () => {
    const s = await readBubble(page);
    return s && !s.bubbleVisible && s.toastVisible ? s : null;
  });
  ok(!!afterPause, '点击暂停后气泡收起并出现提示条');
  ok(afterPause && /已暂停/.test(afterPause.toastText), '提示条说明已暂停：' + (afterPause && afterPause.toastText));
  await page.screenshot({ path: path.join(ART, '07-paused.png') });

  // 图标徽章要能体现暂停状态
  await page.waitForTimeout(200);
  const badge = await sw.evaluate(() => chrome.action.getBadgeText({})).catch(() => null);
  ok(badge === '❚❚', '扩展图标显示暂停徽章：' + JSON.stringify(badge));

  // 暂停期间重新划词，气泡不应出现
  await page.mouse.click(500, 650); // 先清掉旧选区
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const stillPaused = await readBubble(page);
  ok(!!stillPaused && stillPaused.bubbleVisible === false, '暂停期间选中文字不再弹出浮窗');

  // 点提示条上的「恢复」
  await page.locator('.qt-toast [data-act="resume"]').click();
  const afterResume = await waitFor(async () => {
    const s = await readBubble(page);
    return s && /恢复/.test(s.toastText) ? s : null;
  });
  ok(!!afterResume, '点击恢复后提示条更新');
  const badge2 = await sw.evaluate(() => chrome.action.getBadgeText({})).catch(() => null);
  ok(badge2 === '', '恢复后徽章清除：' + JSON.stringify(badge2));

  // 恢复后重新划词，气泡应再次弹出
  await page.mouse.click(500, 650);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 8 });
  await page.mouse.up();
  const bubbleAgain = await waitFor(async () => {
    const s = await readBubble(page);
    return s && s.bubbleVisible ? s : null;
  });
  ok(!!bubbleAgain, '恢复后重新划词，气泡能再次弹出');

  /* 3. 点击翻译 */
  console.log('\n[3] 点击翻译 → 展示译文');
  await page.locator('.qt-main').click();
  const done = await waitFor(async () => {
    const s = await readBubble(page);
    return s && s.resultVisible && s.resultText ? s : null;
  });
  ok(!!done, '译文渲染成功');
  if (done) {
    ok(done.resultText === EXPECTED, '译文内容正确：' + JSON.stringify(done.resultText));
    ok(done.panelVisible, '面板已展开');
    ok(done.meta.includes('test-model'), '底部显示模型信息：' + done.meta);
    await page.screenshot({ path: path.join(ART, '02-translated.png') });
  }
  ok(requests.length === 1, '接口收到 1 次请求，实际=' + requests.length);
  if (requests[0]) {
    const r = requests[0];
    ok(r.model === 'test-model', '请求 model 正确');
    ok(r.messages && r.messages[1].content.includes('Good tools'), '请求携带了选中的原文');
  }

  /* 4. 点击浮窗外不会误关面板 */
  console.log('\n[4] 交互细节');
  await page.mouse.click(20, 650);
  await page.waitForTimeout(250);
  const afterOutside = await readBubble(page);
  ok(afterOutside.bubbleVisible === false, '点击页面空白处气泡收起');
  ok(afterOutside.panelVisible === true, '已展开的译文面板保留');

  /* 5. 切换目标语言会重新翻译 */
  console.log('\n[5] 面板内切换语言');
  await page.locator('.qt-panel [data-role="lang"]').selectOption('ja');
  await page.waitForTimeout(1200);
  const afterLang = await readBubble(page);
  ok(afterLang.panelVisible === true, '切换语言后面板仍在');
  ok(requests.length >= 2, '切换语言触发了新请求，累计=' + requests.length);
  const last = requests[requests.length - 1];
  ok(last && last.messages[0].content.includes('日语'), '新请求的目标语言为日语');
  await page.screenshot({ path: path.join(ART, '03-lang-switch.png') });

  /* 6. Esc 关闭 */
  console.log('\n[6] Esc 关闭');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const afterEsc = await readBubble(page);
  ok(afterEsc.panelVisible === false, 'Esc 关闭面板');

  /* 7. 浅色/深色主题截图对照 */
  console.log('\n[7] 深色主题');
  const ctxDark = await context.newPage();
  await ctxDark.emulateMedia({ colorScheme: 'dark' });
  await ctxDark.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await ctxDark.bringToFront();
  await ctxDark.waitForTimeout(400);
  const box2 = await ctxDark.locator('#para').boundingBox();
  await ctxDark.mouse.move(box2.x + 6, box2.y + 6);
  await ctxDark.mouse.down();
  await ctxDark.mouse.move(box2.x + box2.width - 6, box2.y + 30, { steps: 10 });
  await ctxDark.mouse.up();
  const darkBubble = await waitFor(async () => {
    const s = await readBubble(ctxDark);
    return s && s.bubbleVisible ? s : null;
  });
  ok(!!darkBubble, '深色模式下浮窗同样可用');
  if (darkBubble) {
    await ctxDark.locator('.qt-main').click();
    await waitFor(async () => {
      const s = await readBubble(ctxDark);
      return s && s.resultVisible ? s : null;
    }, 8000);
    const diag = await ctxDark.evaluate(() => {
      const host = document.getElementById('quick-translate-host');
      const p = host.shadowRoot.querySelector('.qt-panel');
      const cs = getComputedStyle(p);
      return {
        bg: cs.backgroundColor,
        color: cs.color,
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
        sheets: host.shadowRoot.adoptedStyleSheets ? host.shadowRoot.adoptedStyleSheets.length : -1,
        opacity: cs.opacity,
        anim: cs.animationName + '/' + cs.animationDuration,
        anims: p.getAnimations().map((a) => a.playState + ':' + a.currentTime)
      };
    });
    console.log('  [诊断] ' + JSON.stringify(diag));
    // 深色下必须是深底浅字
    ok(!diag.dark || diag.bg !== 'rgba(0, 0, 0, 0)', '深色模式面板有不透明背景：' + diag.bg);
    ok(Number(diag.opacity) > 0.95, '面板完全不透明（入场动画不会卡住）：opacity=' + diag.opacity);
    await ctxDark.screenshot({ path: path.join(ART, '04-dark.png') });
    ok(true, '深色模式译文截图已保存');
  }

  /* 8. 免刷新注入：可重复注入且不产生第二个浮窗 */
  console.log('\n[8] 免刷新注入');
  await page.bringToFront();
  const info = await opt.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    let target = null;
    for (const t of tabs) {
      if (t.url && t.url.startsWith('http://127.0.0.1')) {
        target = t;
        break;
      }
    }
    if (!target) return { err: 'no 127.0.0.1 tab' };
    const ask = (fn) => new Promise((r) => fn(r));
    const ping = await ask((r) => chrome.tabs.sendMessage(target.id, { type: 'qt:ping' }, (x) => r(x)));
    const inject = await ask((r) => chrome.runtime.sendMessage({ type: 'qt:injectTab', tabId: target.id }, r));
    const ping2 = await ask((r) => chrome.tabs.sendMessage(target.id, { type: 'qt:ping' }, (x) => r(x)));
    return { ping, inject, ping2 };
  });
  ok(!info.err, '能定位到测试页标签', info.err);
  ok(info.ping && info.ping.ok === true, 'ping 确认页面已注入脚本');
  ok(info.inject && info.inject.ok === true, '可对已打开的页面再次注入（免刷新）');
  ok(info.ping2 && info.ping2.ok === true, '再次注入后页面仍然健康');
  const hostCount = await page.evaluate(() => document.querySelectorAll('#quick-translate-host').length);
  ok(hostCount === 1, '重复注入不会产生第二个浮窗容器，实际=' + hostCount);

  // 重复注入后功能依然可用
  const box3 = await page.locator('#para').boundingBox();
  await page.mouse.move(box3.x + 6, box3.y + 6);
  await page.mouse.down();
  await page.mouse.move(box3.x + box3.width - 6, box3.y + 30, { steps: 10 });
  await page.mouse.up();
  const bubble2 = await waitFor(async () => {
    const s = await readBubble(page);
    return s && s.bubbleVisible ? s : null;
  });
  ok(!!bubble2, '重复注入后仍能正常弹出浮窗');

  await context.close();
  server.close();
  try {
    fs.rmSync(TMP_PROFILE, { recursive: true, force: true });
  } catch (e) {}

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  console.log('截图目录: test/artifacts/\n');
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  fs.appendFileSync(LOGF, '\n测试异常：' + (e && e.stack ? e.stack : e) + '\n');
  console.error('\n测试异常：', e);
  process.exit(2);
});

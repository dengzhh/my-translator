/**
 * 真机端到端（依赖本机 127.0.0.1:8090 翻译服务）：
 * 全新浏览器 profile + 插件默认配置（本地服务），真实拖选 → 点击翻译 → 看译文。
 * 服务未启动会提示并退出 0。
 *
 * 运行: node test/local-e2e.check.mjs
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 加载 playwright-core：环境变量 PLAYWRIGHT_NODE_PATH → 项目内 node_modules */
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
  throw new Error('找不到 playwright-core：请在本目录执行 npm i -D playwright-core');
}
const { chromium } = loadPlaywright();

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
const LOGF = path.join(ROOT, 'test', 'local-e2e.log');
const ART = path.join(ROOT, 'test', 'artifacts');
const PROFILE = path.join(ROOT, 'test', '.tmp-profile-local');
const EDGE = findEdge();
fs.writeFileSync(LOGF, '');
const rawLog = console.log;
console.log = (...a) => {
  const line = a.join(' ');
  rawLog(line);
  fs.appendFileSync(LOGF, line + '\n');
};

// 服务探测
let alive = false;
try {
  alive = (await fetch('http://127.0.0.1:8090/api/v1/translate/engines')).ok;
} catch (e) {}
if (!alive) {
  console.log('未检测到 127.0.0.1:8090 服务，跳过真机端到端。');
  process.exit(0);
}

const server = http.createServer((req, res) => {
  const name = req.url === '/' ? 'fixture.html' : req.url.replace(/^\//, '').split('?')[0];
  const file = path.join(ROOT, 'test', name);
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
console.log(`测试页 http://127.0.0.1:${port}，插件使用默认配置（本地翻译服务）\n`);

fs.rmSync(PROFILE, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(PROFILE, {
  executablePath: EDGE,
  headless: false,
  viewport: { width: 1000, height: 700 },
  args: [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`
  ]
});

let pass = 0;
let fail = 0;
const ok = (c, n, extra) => {
  if (c) {
    pass++;
    console.log('  ✓ ' + n);
  } else {
    fail++;
    console.log('  ✗ ' + n + (extra ? '  → ' + extra : ''));
  }
};

const readPanel = (page) =>
  page.evaluate(() => {
    const host = document.getElementById('quick-translate-host');
    if (!host || !host.shadowRoot) return null;
    const sr = host.shadowRoot;
    const b = sr.querySelector('.qt-bubble');
    const p = sr.querySelector('.qt-panel');
    return {
      bubbleVisible: !!b && !b.classList.contains('qt-hidden'),
      panelVisible: !!p && !p.classList.contains('qt-hidden'),
      resultText: p ? p.querySelector('[data-role="result"]').textContent : '',
      resultVisible: p ? !p.querySelector('[data-role="result"]').classList.contains('qt-hidden') : false,
      errText: p ? p.querySelector('[data-role="err"]').textContent : '',
      meta: p ? p.querySelector('[data-role="meta"]').textContent : ''
    };
  });

async function waitFor(fn, timeout = 30000, interval = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}

try {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  const box = await page.locator('#para').boundingBox();
  const sx = box.x + 6;
  const sy = box.y + 6;
  const ex = box.x + box.width - 6;
  const ey = box.y + 30;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(ex, ey, { steps: 12 });
  await page.mouse.up();

  const bubble = await waitFor(async () => {
    const s = await readPanel(page);
    return s && s.bubbleVisible ? s : null;
  }, 10000);
  ok(!!bubble, '默认配置下选中文本仍会弹出浮窗');

  await page.locator('.qt-main').click();
  const done = await waitFor(async () => {
    const s = await readPanel(page);
    return s && (s.resultVisible || s.errText) ? s : null;
  });
  if (done && done.resultVisible) {
    ok(true, '本地服务返回译文：' + done.resultText);
    ok(/[\u4e00-\u9fa5]/.test(done.resultText), '译文确为中文（目标语言=简体中文生效）');
    ok(done.meta.includes('本地服务'), '底部标注来源：' + done.meta);
  } else {
    ok(false, '翻译失败', done ? done.errText.slice(0, 200) : '超时');
  }
  await page.screenshot({ path: path.join(ART, '06-local-service.png') });
  console.log('  截图: test/artifacts/06-local-service.png');
} catch (e) {
  fail++;
  console.log('  ✗ 异常: ' + (e && e.stack ? e.stack : e));
}

await context.close();
server.close();
fs.rmSync(PROFILE, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);

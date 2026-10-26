# 插件设置界面规范：就地浮层 + 分 Tab

> 一句话铁律：**设置永远不离开用户正在看的页面。**
>
> 首个参考实现：`quick-translate/content/content.js`（设置面板部分）。
> 这份文档把其中验证过的做法抽出来，新插件直接照抄骨架，别再走弯路。

---

## 1. 为什么必须这样

浏览器扩展的"标准"设置入口有两个，本工作区**全部禁用**：

| 做法 | 后果 |
|---|---|
| `chrome.runtime.openOptionsPage()` | 跳到 `edge://extensions/?options=<id>`，用户网页被顶掉 |
| `chrome.tabs.update(tabId, { url })` | 把用户当前标签页**替换**成设置页，等于丢页面 |
| 浮层里放「完整设置页」按钮 | 用户随手误点就丢页面，已确认是多余入口 |

用户的判断标准很直接：**我点设置的时候，正在看的东西不能消失。**

`open_in_new_tab: false`、`chrome.tabs.create` 也只是"少丢一点"，都不能替代就地展开。
`tabs.create` 只保留一条用途：当前页面**根本注入不进去**（`edge://`、扩展页等）时的逃生口。

---

## 2. 结构骨架

```
host (div#<x>-host，position:fixed, z-index 极高)
└─ shadowRoot
   ├─ adoptedStyleSheets  ← 用 CSSStyleSheet 注入，绕开页面 CSP 对 <style> 的拦截
   ├─ bubble   （选中文字后的气泡）
   ├─ panel    （译文面板）
   └─ settings （设置浮层，本次新增）
       ├─ .x-drag     拖动头
       ├─ .x-tabs     ┬ .x-tab[data-tab="api"]
       │              ├ .x-tab[data-tab="lang"]
       │              └ .x-tab[data-tab="test"]
       ├─ .x-pane[data-pane="api"]   .on 表示可见
       ├─ .x-pane[data-pane="lang"]
       ├─ .x-pane[data-pane="test"]
       └─ .x-foot     保存按钮 + tip 提示（不放任何导航链接）
```

关键点：

- **只在需要时才创建 host**（懒创建），页面干净时不污染 DOM。
- **用 Shadow DOM**，样式与页面完全隔离，双向都不会串。
- **`adoptedStyleSheets`** 而不是 `<style>`。很多站点 CSP 会拦内联样式。
- 三个浮层（bubble / panel / settings）**互斥显示**，切换前先 `hideAll()` / `hideAllPanelsExcept(keep)`。

---

## 3. Tab 怎么切

不要用路由、不要用 iframe。就是最朴素的"切 class"：

```js
function switchTab(name) {
  const root = host.shadowRoot;
  root.querySelectorAll('.qt-tab').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === name);
  });
  root.querySelectorAll('.qt-pane').forEach((p) => {
    p.classList.toggle('on', p.dataset.pane === name);
  });
}
```

事件走**统一委托**（一处 `click` 监听，靠 `closest('[data-act], [data-tab]')` 分发），
不要在循环里给几十个按钮各绑一个监听器。

### Tab 怎么划分

按"用户来干什么"分，不按"有哪些字段"分。已验证好用的三分法：

| Tab | 内容 |
|---|---|
| **接口 / 连接** | provider 下拉、预设、地址、Key、模型、温度、高级参数；该域名的**授权状态 + 授权按钮** |
| **行为 / 偏好** | 目标语言、源语言、长度上限、各种开关（启用 / 自动 / 暂停 / 自动复制 / 缓存） |
| **测试 / 数据** | 输入测试内容 → 跑一次真实请求（结果绿✓红✗）、清缓存、导出配置、导入配置 |

字段少的时候（比如只有 3 个）面板自然就矮，这是正常的，不要去拉高凑数。

---

## 4. 配置读写

```
浮层 ──qt:getConfigRaw──▶ service worker ──▶ chrome.storage.local（含 API Key）
浮层 ──qt:setConfig────▶ service worker ──▶ 写入 + 广播
浮层 ──qt:hasPermission▶ service worker ──▶ chrome.permissions.contains
浮层 ──qt:exportConfig ▶ service worker ──▶ JSON 字符串
```

四条纪律：

1. **打开面板时重读一次原始配置**（`refreshRawConfig`），不要信内存里那份，多标签页会不同步。
2. 字段统一用 `[data-k="..."]` 标记，`collectSettings()` / `fillSettings()` 各一个函数扫一遍，
   加字段只需要改这两处 + 一个 `field()` 模板。
3. **`chrome.permissions.request` 必须在用户手势有效期内发起** —— 先 `await` 权限请求，
   再去 `send({type:'qt:setConfig'})`。反过来写（先 await 一次消息再请求权限）会被浏览器拒绝。
4. 保存成功给一句轻提示（`tip('已保存')`，2 秒淡出），不要 alert、不要跳转。

---

## 5. 从别处唤出设置

工具栏 popup、右键菜单、图标点击**都要收敛到同一条路**：

```
先 ping 页面 → 没有内容脚本就 executeScript 免刷新注入 → 再发 qt:openSettings
```

后台辅助函数（`quick-translate/background/service-worker.js` 的 `openSettingsInline()`）：

```js
// 1) ping 内容脚本
// 2) 没响应 → chrome.scripting.executeScript({ files: [...] }) 注入一次
// 3) 注入成功 → chrome.tabs.sendMessage(tabId, { type: 'qt:openSettings' })
// 4) 注入失败（edge:// 等）→ 唯一允许的 fallback：chrome.tabs.create 新标签
```

`openSettings()` 内部顺序也有讲究：先 `hideBubble()` + `hidePanelOnly()`，
再 `refreshRawConfig()`，最后 `placeAtAnchor()` 定位到选区附近（无选区则视口中央）。

`window.__QT_LOADED__` 做幂等保护，重复注入不会挂两套 UI。

---

## 6. 请求权限时的特殊处理

内容脚本里通常**拿不到用户手势**，`chrome.permissions.request` 会静默失败。
所以不要在内容脚本里弹权限框，而是：

```
授权失败 → 就地把设置面板展开并跳到「接口」Tab → 按钮文案改成
「在浮窗设置里授权该接口域名 →」→ 用户点这个按钮时手势有效，权限框才能弹出
```

---

## 7. 必须附带的交互细节

| 细节 | 做法 |
|---|---|
| 拖动 | 设置面板顶栏可拖动，记住位置，别挡文字 |
| Esc | 优先关设置面板（如果开着），否则关译文面板 |
| 点外面 | 面板自动收起，但在面板**内部**点击不能收起 |
| 滚动 / 缩放 | 跟随锚点重新定位；`requestAnimationFrame` 节流 |
| 位置越界 | 左右夹在视口内，下面放不下就翻到上方 |
| 高度 | `max-height: min(560px, calc(100vh - 32px))`，内容超出自己滚 |

---

## 8. 自检清单

新插件交付前逐条过：

- [ ] 全局搜 `openOptionsPage`，结果 **0**
- [ ] 全局搜 `tabs.update`，结果 **0**（注释里说明为什么不用可以）
- [ ] 界面上没有任何「完整设置页 / 在新标签打开设置」之类入口
- [ ] 点设置后 `location.href` 不变（写成 e2e 断言，不靠肉眼）
- [ ] 设置里所有功能都能在浮层内完成（没有"这个得去设置页改"的遗漏）
- [ ] 设置项 ≥ 6 个时已经分了 Tab
- [ ] Esc 能关掉，关掉后网页仍原样
- [ ] `edge://` 页面上点设置不会丢页面（走 `tabs.create`）

对应的 e2e 断言（quick-translate 里已落地，可直接抄）：

```js
ok(urlBefore === page.url(), '用户的网页没有被导航走');
ok(!page.url().includes('options.html'), '没有跳到设置页 URL');
ok(setBox.width > 0, '设置面板已在页面内展开');
ok(!shadowText.includes('完整设置页'), '设置面板里不再出现「完整设置页」字样');
ok(externalLinks.length === 0, '设置面板里没有任何外链');
```

---

## 9. 五个 provider 的字段参考

`quick-translate` 的「接口」Tab 用 `[data-group="local|openai|deepl|google|custom"]` 分组，
切换 provider 时只显示对应组：

| provider | 字段 |
|---|---|
| `local` | 地址（默认 `http://127.0.0.1:8090/translate`） |
| `openai` | 地址、API Key、模型、温度、系统提示词 |
| `deepl` | 地址、API Key |
| `google` | 地址、API Key（可选） |
| `custom` | 地址、API Key、请求方法、请求体模板 |

新插件照这个模式加自己的 provider 即可，不要为每种接口做一套 UI。

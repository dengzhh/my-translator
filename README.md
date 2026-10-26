# 我的翻译（My Translator）

浏览器翻译插件（Manifest V3）。选中网页文字 → 鼠标右上角弹出浮窗 → 点一下就在原地看到译文。
翻译走你自己的 API Key，不经过任何中间服务器。

> GitHub: <https://github.com/dengzhh/my-translator>

## 安装

1. 打开 `chrome://extensions/`（Edge 为 `edge://extensions/`）
2. 打开右上角 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择 **本目录** —— 也就是这个 README 所在的文件夹
4. 装好先随便打开一个网页，点扩展图标 → **设置**，设置面板会**直接在网页里展开**（不会把你的页面导航走）

> 设置在浮窗内部就地打开，当前看的网页不会被替换。面板里**没有任何会跳走网页的入口**，全部配置（接口、语言、测试、导入导出）都在浮窗内完成。
>
> 设计说明见 [docs/SETTINGS-INLINE-PATTERN.md](./docs/SETTINGS-INLINE-PATTERN.md)，新插件的设置一律照此实现。

## 配置

**默认已经预设好本机翻译服务，装完就能用，不需要填任何 Key** —— 只要 `http://127.0.0.1:8090` 那个服务在跑：

- 接口地址：`http://127.0.0.1:8090/api/v1/translate`
- 请求：`POST` JSON `{ q, from, to, engine, detail }`
- 响应：取返回里的 `translation` 字段
- 引擎：默认 `baidu`（该服务当前只提供这一个引擎）
- 语言代码由插件自动转换：`zh-CN→zh`、`zh-TW→cht`、`ja→jp`、`ko→kor`、`fr→fra`、`es→spa`……

服务没启动、或想换成云端接口时，点气泡上的 ⚙，设置面板会**在当前网页里就地展开**，切到「接口」标签换类型即可。

也可以换成这些（有免费额度）：

| 服务商 | 接口地址 | 模型 | 密钥申请 |
|---|---|---|---|
| 本机服务 | `http://127.0.0.1:8090/api/v1/translate` | 引擎 `baidu` | 无需密钥 |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | `glm-4-flash` | open.bigmodel.cn |
| DeepSeek | `https://api.deepseek.com/v1/chat/completions` | `deepseek-chat` | platform.deepseek.com |
| 硅基流动 | `https://api.siliconflow.cn/v1/chat/completions` | `Qwen/Qwen2.5-7B-Instruct` | cloud.siliconflow.cn |
| 本地 Ollama | `http://localhost:11434/v1/chat/completions` | `qwen2.5:7b` | 无需密钥 |

选完预设会自动填好地址和模型，只需再填 API Key，然后点 **测试翻译** 确认能通。

支持的接口类型：

- **本地翻译服务（Web To OpenAPI）** —— `POST /api/v1/translate`，语言代码映射与 `translation` 取值都在插件内完成
- **OpenAI 兼容** —— 上面这些，以及任何 `/v1/chat/completions` 风格的网关
- **DeepL** —— Free / Pro 均可
- **Google 翻译** —— Cloud Translation API Key
- **自定义 HTTP** —— 自己写请求头、请求体模板和取值路径

## 使用

| 操作 | 效果 |
|---|---|
| 选中文本 | 鼠标右上角弹出浮窗「翻译为 简体中文」 |
| 点击浮窗按钮 | 展开译文面板 |
| 点击气泡右侧 ❚❚ | **暂停划词浮窗**：选中文字不再自动弹出，右下角提示条可一键恢复 |
| `Alt` + `T` | 直接翻译当前选中文本（跳过浮窗） |
| 右键 → 用「我的翻译」翻译选中文本 | 同上 |
| 面板内切换语言 | 立刻重译 |
| `Esc` | 关闭浮窗 |
| 点气泡上的 ⚙ / 面板底部「设置」 | **在当前网页里就地展开设置面板**，网页不会被导航走 |
| 点扩展图标 → 设置 | 同上，同样在当前网页里展开 |
| 右键菜单 → 打开设置 | 同上，同样在当前网页里展开 |
| 拖动面板标题栏 | 移到不挡文字的位置 |

浮窗细节：会自动避让选中的文字（压到就移到选区上方）；页面滚动时跟随文本；点击页面空白处收起气泡但保留译文面板；译文可一键复制。

### 临时关闭（暂停划词浮窗）

不想被浮窗打扰时，点气泡右侧的 **❚❚**：立刻收起浮窗，并在页面右下角弹出提示条「划词浮窗已暂停」+ **恢复** 按钮（9 秒后自动消失）。

暂停期间：

- 选中文字**不再弹出**浮窗（状态会同步到所有已打开的标签页）
- `Alt` + `T`、右键菜单**仍然可用**——想翻的时候不用先恢复
- 扩展图标显示 `❚❚` 徽章，鼠标悬停提示「划词浮窗已暂停，点我恢复」，不会让你忘了自己关过

三种恢复方式：提示条上的「恢复」、点扩展图标面板里的「恢复」、设置页取消勾选「暂停自动弹出」。

## 文件结构

```
manifest.json              MV3 清单
background/service-worker.js  翻译引擎（请求、缓存、权限、右键菜单）
content/content.js        选区监听 + Shadow DOM 浮窗（含浮窗内设置面板）
lib/langs.js              语言表（content / options / popup 共用）
options/                  完整设置页（备用，平时用不到）
popup/                    点图标弹出的小面板（开关、目标语言）
docs/                     设置界面设计规范
tools/gen-icons.mjs       图标生成脚本（纯 Node，无依赖）
test/engine.test.mjs      引擎单测（vm + mock chrome/fetch，63 项）
test/e2e.mjs              端到端测试（真实 Edge 无窗口 + 真实鼠标拖选，52 项，自带假接口）
test/local-api.check.mjs  真机校验：直连 8090 验证 5 种语言
test/local-e2e.check.mjs  真机校验：默认配置下完整走一遍
test/artifacts/           测试截图（跑测试时自动生成，不入库）
```

## 测试

```bash
npm install                      # 只装 playwright-core（跑浏览器测试用）
npm test                         # 单测 + 端到端全跑

# 或分开跑
npm run test:unit                # 引擎逻辑：请求构造/解析/缓存/权限/脱敏/语言映射
npm run test:e2e                 # 真实浏览器：选区→浮窗→翻译→切语言→Esc（自包含）
npm run test:local               # 真机：直连 127.0.0.1:8090（服务没起会自动跳过）
```

`e2e.mjs` 与两个真机脚本都用本机 Edge 的 `--headless=new`（无窗口，不抢焦点），截图输出到 `test/artifacts/`（该目录不入库）。
两个 `local-*` 脚本会在检测不到 8090 服务时自动跳过。

非 Windows 或 Edge 装在别处时，可用环境变量覆盖：

```bash
EDGE_PATH="/path/to/chrome-or-edge" npm test
PLAYWRIGHT_NODE_PATH="/path/to/node_modules" npm test   # playwright-core 装在别处时
```

当前基线：`engine.test.mjs` **63 项全过**，`e2e.mjs` **52 项全过**（含「打开设置只在浮窗内展开、网页 URL 不变」的回归用例）。

## 浮窗没出现？按顺序自查

**1. 先看插件图标**：点一下工具栏的蓝色「译」字图标，面板顶部会直接告诉你当前页面状态

| 显示 | 含义 | 怎么办 |
|---|---|---|
| ✓ 本页已就绪，可直接划词 | 正常 | 在正文段落上拖选试试 |
| ✗ 本页未加载脚本（装插件前打开的页面） | 这个页面比你装插件更早打开 | 点面板上的「注入本页」，或 F5 刷新 |
| 当前是浏览器内置页面，扩展无法注入 | `chrome://` 设置页、新标签页、PDF | 换普通网页，浏览器不允许扩展注入这些页面 |

**2. 确认加载的是子目录**：必须是 `…\浏览器插件\quick-translate`。选到根目录会报「清单文件缺失」，扩展在管理页显示「错误」。

**3. 看是否勾选了启用**：面板右上角的「启用」开关要打开。

**4. 换一段普通正文试试**：PDF、图片里的文字、`chrome://` 页面、网页内嵌框架（iframe）里的文字都不支持。

安装或更新扩展后，插件会**自动把脚本补进所有已打开的网页标签**，正常情况下不用手动刷新。

## 几点说明

- **默认走本机服务**：需要 `http://127.0.0.1:8090` 正在运行。服务没起时浮窗会显示错误并提供「打开设置」入口，切到其他接口类型即可。
- **安装/更新后一般无需刷新**：插件启动时会主动注入到已打开的 http(s) 标签页；浏览器内置页与 PDF 不支持。
- **iframe 内不生效**：内容脚本只注入顶层页面（`all_frames: false`）。若要支持内嵌框架，改 manifest 里为 `true`。
- **PDF / 浏览器内置页面**不支持（浏览器不允许扩展注入）。
- **API Key 存放**：存在 `chrome.storage.local`，不会同步到云端，也不会下发给网页侧（内容脚本拿到的配置已剔除密钥）。
- **译文缓存**：相同原文 + 相同目标语言会命中缓存，默认最多 300 条，可在设置页清除。
- 主机权限为 `<all_urls>`：因为接口地址由你自己填，扩展无法预先知道域名。安装时提示与"注入所有页面"一致。

# Typora 引擎(horseMD 自研编辑内核)

horseMD 现在有两个编辑器内核,可在 设置 › 编辑器 › 编辑引擎 切换:

- **Typora 引擎**(默认)— 按 Typora 1.9.5 真实架构全新实现的自研内核。
  DOM/类名/CSS 变量三个契约与 Typora 对齐,**Typora 主题 .css 直接可用**。
- **Milkdown**(ProseMirror/Crepe)— 原内核,功能最全的兜底。

切换后所有已挂载的编辑器按新内核重挂载(key 含引擎名),设置持久化在
`settings.editorEngine`(`settings.js`)。

## 架构(为何"非常接近 Typora")

Typora 的实时预览**不是**"CodeMirror 隐藏语法"方案,而是 contenteditable
所见即所得:块级模型是唯一事实源,打字时对焦点块做 re-tokenize + 局部 DOM
替换,语法字符留在 DOM 里按光标位置显隐。本引擎按同一机制全新实现
(不复制 Typora 任何代码;契约知识来自对 Typora 安装目录的只读静态分析):

```
markdown 文件
   │ parseMarkdown(parser.js)          块级解析(块树 + cid)
   ▼
Block 树(model.js)                    每个叶子块的 text = 该块的 md 源文本
   │ blockToDOM(render.js)            契约 DOM: h1.md-heading / p.md-p /
   ▼                                  pre.md-fences / figure>table.md-table /
#write (contenteditable)              .md-task-list-item>input …
   │ 打字: input → brushBlock         焦点块重新 tokenize + 替换 DOM,
   │                                  光标按字符偏移恢复(brush 机制)
   │ 结构操作: Enter/Backspace/Tab/    keydown 层结构化操作(Typora 同款
   │        粘贴/命令                  pressReturn 机制),改模型后整树渲染
   │ 内联语法字符: span.md-meta /      默认 display:none,光标进入所在
   │        span.md-content           [md-inline] 时加 .md-expand 显示
   ▼
保存: docToMarkdown(serialize.js)      序列化回 markdown(含 spans 偏移映射)
```

**核心不变式**:块 DOM 的 `textContent === 该块内联 markdown 源文本`。
由此实时预览 = 重 tokenize;取回源码 = 读 textContent;光标 = 字符偏移。

## 模块清单(`src/renderer/src/typora-engine/`)

| 文件 | 职责 |
|---|---|
| `model.js` | Block 树节点(容器/叶子、cid、prev/nextSibling) |
| `parser.js` | markdown → 块树(YAML/ATX+Setext/围栏/公式/引用+alert/列表嵌套/表格/TOC/脚注定义/HTML 块) |
| `inline.js` | 内联 tokenizer + 契约 DOM 生成(语法字符进 `.md-meta`/`.md-content`) |
| `render.js` | 块树 → 契约 DOM(每块带 `cid` + `mdtype` + `.md-end-block`) |
| `serialize.js` | 块树 → markdown;Writer + spans(叶子文本区域绝对偏移,见下) |
| `offsets.js` | 光标 ↔ markdown 偏移双向映射(文档位置记忆/恢复) |
| `highlight.js` | 零依赖代码高亮,输出 `.cm-s-inner .cm-*` 契约类名 |
| `editor.js` | 编辑器主体:beforeinput 拦截 + keydown 结构化操作 + brush + 命令 + undo + readOnly/destroy |

宿主:`src/renderer/src/components/TyporaEditor.jsx`,通过与 `Editor.jsx`
(Milkdown)相同的 `onReady(api)` 契约注册进 `editorApiRegistry`。
契约样式:`src/renderer/src/styles/typora-base.css`(全部 `:where()` 零权重,
主题永赢)与 `typora-theme-default.css`(GitHub 风格内置默认主题)。

## 主题兼容(Typora 主题直用的原理)

- 引擎 DOM 挂 `id="write"` + md-* 运行时类,主题选择器直接命中。
- 契约 CSS 全部 `:where(.hm-typora-engine)` 零权重:主题按注入顺序
  (head 尾部)覆盖;主题里更弱的单元素选择器(`h2 { … }`)也因后加载而胜出。
- CSS 变量面与 Typora base 一致(`--bg-color/--text-color/--md-char-color/
  --monospace/…`),主题 `:root` 变量按加载顺序覆盖默认值。
- 有自定义主题时(`body.hm-has-custom-theme`),编辑区背景/文字色取主题
  变量面,版式(字号/行高)由主题的 html/body 规则继承接管;无主题时
  跟随 horseMD 的字号/行高/页宽设置。
- 代码高亮锚点 `.cm-s-inner .cm-*`:主题无需改动即可定制配色。

验证:`scripts-typora/theme-check.mjs <theme.css路径>` 注入真实主题
(github.css / night.css 已实测)并截图。

## onReady api 契约(与 Editor.jsx 对齐)

| 方法 | typora 引擎实现 |
|---|---|
| `getMarkdown` / `flushMarkdown` / `flushMarkdownSettled` | 引擎序列化(保留载入时的 BOM/CRLF) |
| `replaceMarkdown` | 整树重解析(源码模式切回/查找替换) |
| `restoreMarkdownOffset` / `markdownOffsetFromSelection` / `markdownOffsetFromViewportTop` | offsets.js 精确映射(顶层块精确;表格 `\|` 转义线性近似) |
| `setBlock` | 按 cid 的块级转换(标题/段落/引用/列表/围栏/公式) |
| `getExportSource` / `getPdfSource` | `{ html, headings, images }`(与 PDF 导出管线同形状;公式暂为 TeX 源文本) |
| `getRecoveryMarkdown` / `getSyncReport` / `getView` | 序列化 / null / null(调用方安全降级) |
| `toggleHighlight` / `applyReviewMarkup` | false(暂不支持,明确无操作) |
| `replaceFindRanges` | 查找替换按块文本偏移直接替换(typora 分支) |
| `insertAtSelection` | 图片管线粘贴 URL |

`onChange(md, isInitial)` 与 Milkdown 相同语义:isInitial=true 不采纳,
用户编辑防抖 200ms 后提交。

## 能力矩阵(typora 引擎 vs Milkdown)

**已支持**:标题(含 `# ` 打字转换)/ 段落 / 有序·无序·任务列表(真实
checkbox)/ 引用(+GFM alert)/ 围栏代码块(高亮 + 语言标头)/ 表格
(Tab 导航、末格回车加行)/ 行内样式(**粗**、*斜*、`码`、~~删~~、==亮==、
<u>下划线</u>、上下标按设置开关)/ 链接 / 图片 / 水平线 / YAML / TOC /
脚注与引用定义 / 硬换行(Shift+Enter)/ 复制(纯文本含标记)/ 粘贴
(markdown 按块解析并入)/ 撤销重做 / 只读模式 / 文档位置记忆 /
查找(CSS Custom Highlight,无 DOM 污染)+ 替换 / 大纲面板 /
自动保存与原文保真保存(BOM/CRLF 还原)。

**暂不支持(调用方安全降级,可后续补)**:LaTeX 公式渲染(源码直显)、
Mermaid、CriticMarkup 审阅、高亮涂色、分屏滚动联动、源码↔富文本切换
位置保持、块右键菜单、大文档 chunked 加载(`.hm-cv` 虚拟化跳过)、
移动端编辑实测。这些场景可在设置里切回 Milkdown。

## 测试

```bash
npm run build                                   # 先构建(harness 跑的是 out/)
node scripts-typora/smoke-typora.mjs            # 契约 DOM/md-expand/打字转换/Ctrl+B/undo
node scripts-typora/integration-checks.mjs      # 大纲/查找/保存 round-trip/主题覆盖
node scripts-typora/hardening-checks.mjs        # 复制/粘贴/表格导航/硬换行
node scripts-typora/theme-check.mjs <theme.css> # 真实 Typora 主题注入 + 截图
node scripts-typora/roundtrip-test.mjs          # parse↔serialize 互逆性(node 无需构建)
node scripts-typora/spans-test.mjs              # serialize spans 偏移正确性
node scripts-typora/serialize-snapshot.mjs out.json  # 序列化输出快照(diff 用)
```

CDP harness 复用 `scripts/lib/electron-test-app.mjs`(后台模式)。
注意:多个隐藏标签都挂载 `id="write"`(主题 CSS 需要命中每个 pane),
脚本取可见 pane 时用 `offsetParent` 过滤;CDP 按键 `modifiers` 位掩码为
Alt=1 / Ctrl=2 / Shift=8;产生文本输入的按键需 `keyDown` 类型(或由引擎
的 keydown 层处理 —— Enter/Tab 已在 keydown 层,与 Typora 机制一致)。

## 已知实现细节

- 序列化 Writer 会记录每个叶子文本块的 md 区域(spans),quote 内含
  `> ` 前缀、列表续行含缩进;改序列化逻辑时先跑
  `serialize-snapshot.mjs` 对比基线(`snapshot-before.json`)再提交。
- 引擎 undo 为整文档快照(400ms 合并),粒度比 Milkdown 粗但稳定。
- 多块粘贴:首段并入当前块、末段承接光标后文本,中间按块插入。
- `id="write"` 在多个挂载 pane 上重复(与 Typora 主题契约的取舍,
  `document.getElementById` 只会拿到第一个 —— 宿主代码用 class 查询)。

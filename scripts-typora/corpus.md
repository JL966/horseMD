---
title: 测试文档
tags: [a, b]
---

# 一级标题

普通段落,包含 **加粗**、*斜体*、`code`、~~删除~~、==高亮==、[链接](https://example.com "标题")、![图片](img.png) 和 <u>下划线</u>。

转义 \* \_ \ 与实体 &amp; &#65; 还有裸 URL https://example.com/path?x=1 以及 www.example.com。

软换行行1
软换行行2  
硬换行后

## 二级标题 setext
===

### 三级

Setext 二级
---

> 引用第一段
> 继续行
>
> 引用第二段

> [!NOTE]
> 提示内容

- 无序列表项 1
- 无序列表项 2
  - 嵌套项 A
  - 嵌套项 B
- 列表项 3

1. 有序 1
2. 有序 2
   1. 嵌套有序
3. 有序 3

- [ ] 未完成任务
- [x] 已完成任务

```js
const a = 1;
function f() { return a; }
```

~~~text
tilde fence
~~~

    缩进代码? 这其实是段落中的行(4空格)

$$
E = mc^2
\frac{a}{b}
$$

$E=mc^2$ 行内公式

------

| 左列 | 中列 | 右列 |
|:----|:---:|----:|
| a | b | c |
| 长一点的 | 内容 | x |

[TOC]

[ref]: https://example.com "引用定义"

[^1]: 脚注内容

脚注引用[^1]结尾。

<div>html block</div>

结尾段落。
%%%
# Single

One paragraph only.
%%%
- a

- b

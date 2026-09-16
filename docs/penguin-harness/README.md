# Penguin Harness 实践文章与配图

[阅读全文](article.md) · [配图清单](images.md) · [飞书文档](https://prismshadow.feishu.cn/wiki/PguOw7uFvi7PjjkVscFc8W2QnPc)

本目录归档《用 Penguin Harness 快速开发并优化产线巡检 Agent 应用》的正文、25 张配图和 3 张流程图的 SVG 源文件。正文及图片来自飞书版本 1586，导出时间和图片 SHA-256 校验值见 [images.json](images.json)。

- `article.md`：正文，图片使用仓库内的相对链接。
- `images/`：文档中实际使用的图片，包含裁剪和红框标注。
- `diagrams/`：图 1、图 2、图 21 的可编辑 SVG 源文件。
- `scripts/render-diagrams.mjs`：使用 Playwright 将 SVG 渲染为 PNG。

## 重新渲染流程图

在本目录运行（Node.js 20 或更高版本）：

```bash
npm ci
npx playwright install chromium
npm run render
```

生成文件保存在 `rendered/`，不会覆盖正文使用的图片。SVG 使用系统中文字体；不同系统上的字形可能略有差异。截图保留的是当时的操作界面，渲染脚本只负责三个流程图。

文章中用于复现应用的链接固定在原有提交上；本目录的归档不改变应用、案例数据或 `line-recovery-starter` 的初始材料。

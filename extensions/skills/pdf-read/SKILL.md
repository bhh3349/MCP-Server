---
name: pdf-read
description: 读取 PDF 文件内容
when: 用户需要读取 PDF 时
---
# PDF 读取技能

1. 先用 `exec` 跑 `pdftotext <file> -` 提取文本；
2. 如果没有 pdftotext，用 Python 的 pypdf 库；
3. 超过 50 页先问用户要读哪几页。

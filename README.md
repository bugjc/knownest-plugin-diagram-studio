# Knownest 插件：画图工坊（diagram-studio）

> 结构化画图：四类图型差异化渲染（形状/颜色/自动布局），插件页画布手绘（撤销重做/样式面板/PNG 导出）+ agent 对话直操作画图 API，图真源存知识库文档（diagram-json 方言），节点可挂链知识文档、图可确定性出题入库（零 LLM）、可默画复习（主动回忆，SM-2 随文档调度），可导出 mermaid。

Knownest 官方插件的**社区分发仓**（消费型样板）——本仓内容为主仓 plugins/diagram-studio/ 的同步快照，tag 与市场版本一致（当前 v0.7.1）。

## 安装（插件市场 · 社区通道）

- Knownest → 插件市场 → **社区**：搜索「画图工坊」一键安装（GitHub topic `knownest-plugin` 自动收录）；
- 或在插件市场「更多安装方式」粘贴仓库地址：`https://github.com/bugjc/knownest-plugin-diagram-studio.git`。

## 仓库即样板

本仓即一份完整可运行的插件源：plugin.json（清单 + 权限 + i18n 词典）、index.js 入口、lib/ 实现（部分插件另带 golden-cases.json 黄金用例）。**Fork 本仓、改清单 id 与实现，即可发布你自己的 Knownest 插件。**

- 插件开发正典：https://github.com/bugjc/knownest/blob/main/docs/PLUGIN-AUTHORING.md
- License：https://github.com/bugjc/knownest/blob/main/LICENSE

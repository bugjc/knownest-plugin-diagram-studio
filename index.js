// ============================================================
// Knownest - 画图工坊（diagram-studio，M2 画布+API 2026-10-11；B1 入向主干道 2026-10-16；
//             B3 图→题确定性出题 2026-10-16；B4 默画复习 2026-10-17）
//
// 管什么：结构化图（diagram-json 真源）的完整生命周期——
//         ① 插件页画布：列表 → detail 下钻 openDiagram → 内核 DiagramCanvas 编辑
//            → saveDiagram 写回 .diagram（frontmatter dialect: diagram-json）；
//            布局/mermaid 域计算经 diagramLayout/diagramMermaid invoke 回本插件走 stdlib 单源；
//         ② agent 画图 API：operate_diagram 多路操作（list/create/get/add_node/
//            update_node/remove_node/add_edge/remove_edge/export_mermaid/import_mermaid/
//            make_questions/start_recall/validate），用户对话直操作同一份真源；
//         ③ generate_diagram：读文档 → LLM 生成结构化图 → 校验落盘 → 人续画；
//         ④ importMermaid（B1 T1.2）：读源文档 mermaid 块 → stdlib mermaidToDiagramJson
//            转换 → 校验落盘《base-图》.diagram——MarkdownPreview「转画布」按钮与
//            op=import_mermaid 共用此通道（mermaid 块入画布唯一入口，bidirectional 出向=export_mermaid）。
//         ⑤ make_questions（B3 T3.2/T3.3）：图结构确定性出题（零 LLM）——排序（拓扑序）/
//            填空（度降序抠 label）经 quiz-maker/questions 资产写门逐题入库，承载文档=
//            .diagram 本身（sourceSnippet=diagramjson 围栏，原文预览即渲染图）；
//            纯函数在 lib/questions.js（同输入必同输出红线）。
//         ⑥ 默画复习（B4 T4.1/T4.2）：图挖空补全的主动回忆——startRecall 投影挖空集
//            （lib/recall.js blanksFor：度降序 30%，确定性零 LLM）、checkRecall 逐点 trim
//            判分 +「标记正确」人工改判；判分回流走宿主 practice:recordAttempt 文档锚点
//            即时轨（D6：快照无题库 id → 题库轨自然跳过，practice_attempts + doc_review
//            SM-2 落 .diagram 文档——文档到期即图到期，体系树 ⏰ 与托盘催办免费获得调度，
//            零新调度基建；默画不入题库，§7 边界）。入口=插件页行动作「默画复习」
//            （rowAction → navigate 深链 ?detail=&recall=1）+ 画布详情工具栏同款按钮。
// 不管什么：画布渲染与交互（内核 Deck detail 分支 + DiagramCanvas 承担）、
//          mermaid 渲染（MarkdownPreview 承担）、语法校验实现（stdlib diagram-core，
//          本文件只消费）、题库表与 SM-2 调度（quiz-maker 自持店表；默画作答落库经宿主
//          practice IPC 写面由渲染层执行——插件 store 前缀钳制禁跨店写，本文件不碰题域表）。
// 被谁调用：白泽 agent（两工具）、nav.entry 页（pageDiagrams/openDiagram/
//          createDiagram/saveDiagram/startRecall/checkRecall 经 plugin:invoke）、
//          E2E 探针（executeTool 直调面）。
// 消费契约：knownest.stdlib['diagram-core'] 消费点探测（能力协商），缺面显式报错
//          DIAGRAM_CORE_STDLIB_MISSING，禁自持副本（翻译双轨同款纪律）；
//          quiz-maker/questions 写门经 ctx.invokeAsset（plugin.json consumes 声明即授权，
//          optional=true——提供方未激活如实拒 PROVIDER_INACTIVE 降级文案）。
// 真源契约：.diagram = frontmatter(type/dialect/schemaVersion/title) + ```diagramjson
//          JSON 代码块；结构变更须同步 stdlib diagram-json 方言与内核画布。
// 方案：docs/iteration-plans/2026-10-15-diagram-knowledge-loop-plan.md §B3/§B4。
// ============================================================

const PLUGIN_ID = 'diagram-studio'
const DOC_SUFFIX = '.diagram'
const DIAGRAM_DIR = '画图'
/** 本插件 nav.entry 页路由（B4 默画 rowAction 深链拼用；key=plugin.json contributions[0].key） */
const NAV_KEY = 'diagram-studio'
const { join } = require('path')
const diagramQuestions = require('./lib/questions')
const diagramRecall = require('./lib/recall')

let context = null

// 平台共享内核（能力协商消费示范：消费点探测，缺面=null 由消费点显式报错；禁自持副本）
function getDiagramCore() {
  const std = typeof knownest !== 'undefined' ? knownest.stdlib : null
  return (std && std['diagram-core']) || null
}

// ---------- 纯函数（供单测） ----------

/** 图类型注册表：generate_diagram 的 kind 参数 → 结构引导（shape/color/dashed 为 v2 可选装饰字段） */
const KINDS = {
  flowchart: { label: '流程图', instruction: '业务/操作流程：节点为步骤（shape：起点/终点用 round，判定分支用 diamond，普通步骤 rect 可省略），边为流转方向，分支处加条件 label。' },
  architecture: { label: '架构图', instruction: '组件/系统架构：节点为模块（id 用英文），按层给 color（blue/green/orange/purple/cyan/gold/red/gray），边标注调用或数据方向，异步/弱依赖可用 dashed: true。' },
  mindmap: { label: '思维导图', instruction: '知识结构：以文档主题为中心的树（edges 从中心到分支），每节点 ≤12 字，按主分支给 color（blue/green/orange/purple/cyan/gold/red/gray）。' },
  sequence: { label: '协作图', instruction: '参与者协作：节点为参与者（shape: round），边为消息（label=消息名），覆盖主流程与关键分支，回应/异步消息用 dashed: true。' },
}

/** 文件名净化（Windows 非法字符与首尾空白） */
function sanitizeFileName(title) {
  return String(title || '未命名')
    .replace(/[\\/:*?"<>|]/g, '-')
    .trim() || '未命名'
}

/** 图文档路径判定（本插件落盘命名契约：.diagram 后缀） */
function isDiagramDocPath(filePath) {
  return String(filePath || '').endsWith(DOC_SUFFIX)
}

/** 解析图文档 body → { title, diagram }；非法返回 null（围栏容错） */
function parseDiagramDoc(body) {
  const s = String(body || '')
  const fmTitle = (s.match(/^title: (.+)$/m) || [])[1]
  const fence = s.match(/```diagramjson\r?\n([\s\S]*?)```/)
  if (!fence) return null
  try {
    const diagram = JSON.parse(fence[1].trim())
    if (!Array.isArray(diagram.nodes) || !Array.isArray(diagram.edges)) return null
    return { title: fmTitle ? fmTitle.trim() : '', diagram }
  } catch {
    return null
  }
}

/** 提取 diagramjson 围栏原文（B3 出题 sourceSnippet=摘录段：逐字接地 + 原文预览即渲染图） */
function diagramFenceOf(body) {
  const m = String(body || '').match(/```diagramjson\r?\n[\s\S]*?```/)
  return m ? m[0] : ''
}

/** 构建图文档 body（frontmatter 资产标注 + diagramjson 围栏） */
function buildDiagramDoc(title, diagram, opts) {
  const generatedAt = (opts && opts.generatedAt) || new Date().toISOString()
  const generatedBy = (opts && opts.generatedBy) || PLUGIN_ID
  return [
    '---',
    'type: diagram',
    'dialect: diagram-json',
    'schemaVersion: 1',
    `title: ${title}`,
    `generated-at: ${generatedAt}`,
    `generated-by: ${generatedBy}`,
    '---',
    '',
    '```diagramjson',
    JSON.stringify(diagram),
    '```',
    '',
  ].join('\n')
}

/** 图文档匹配：路径精确优先，退化标题包含（不区分大小写） */
function matchDiagramDoc(diagramDocs, keyword) {
  const kw = String(keyword || '').trim()
  if (!kw) return null
  const lower = kw.toLowerCase()
  return (
    diagramDocs.find((d) => String(d.filePath).toLowerCase() === lower) ||
    diagramDocs.find((d) => String(d.title || '').toLowerCase() === lower) ||
    diagramDocs.find((d) => String(d.title || d.filePath).toLowerCase().includes(lower)) ||
    null
  )
}

/** 生成落盘路径：原文档同目录 + 《base-图类型》.diagram */
function generatedDocPath(sourceFilePath, kindLabel) {
  const dir = String(sourceFilePath || '').replace(/[\\/][^/\\]*$/, '')
  const base = String(sourceFilePath || '').split(/[\\/]/).pop()?.replace(/\.(md|diagram)$/i, '') || '未命名'
  return join(dir, `${sanitizeFileName(base)}-${kindLabel}${DOC_SUFFIX}`)
}

/** 导入落盘路径（B1 T1.2 契约）：源文档同目录《base-图》.diagram；
 *  多块文档按块序消歧为《base-图N》（N=1 起，确定性命名防二次导入撞名）；
 *  单块文档严格《base-图》（计划 §T1.2 命名契约，同名冲突由 ALREADY_EXISTS 兜底） */
function importTargetPath(sourceFilePath, blockCount, blockIndex) {
  const dir = String(sourceFilePath || '').replace(/[\\/][^/\\]*$/, '')
  const base = String(sourceFilePath || '').split(/[\\/]/).pop()?.replace(/\.(md|diagram)$/i, '') || '未命名'
  const suffix = (Number(blockCount) > 1 && Number.isFinite(Number(blockIndex))) ? `图${Number(blockIndex) + 1}` : '图'
  return join(dir, `${sanitizeFileName(base)}-${suffix}${DOC_SUFFIX}`)
}

/** LLM 生成系统提示词：结构化图 JSON 契约（操作粒度与画布同源；v2 装饰字段可选） */
function buildGenerateSystemPrompt(kindKey) {
  const kind = KINDS[kindKey]
  return [
    '你是图表结构生成器。只输出一个 JSON 对象，不要任何解释或围栏。',
    'JSON 契约：{"nodes":[{"id":"英文小写id","label":"中文文字","shape":"rect|round|diamond|circle 可选","color":"blue|green|orange|red|purple|cyan|gold|gray 可选"}],"edges":[{"from":"id","to":"id","label":"可选边文字","dashed":true 可选}]}。',
    '纪律：节点总数 ≤25；id 全局唯一且用英文；label 简洁中文；不要位置坐标（系统自动布局）；shape/color/dashed 是可选装饰，只在语义明确时使用，拿不准就省略。',
    `本图要求：${kind ? kind.instruction : '按内容选择最合适的图结构。'}`,
  ].join('\n')
}

/** 缺面降级玩家话术（错误码 + 下一步动作） */
function stdlibMissingResult() {
  return {
    error: 'DIAGRAM_CORE_STDLIB_MISSING',
    output: '平台画图校验内核缺失（应用版本过旧）。请升级 Knownest 到最新版后重试；本插件不会在无校验的情况下读写图。',
  }
}

/** v2/v3 装饰与挂链字段提取（add_node/update_node 共用）：白名单消费 stdlib，非法显式报错不静默丢；
 *  docRef（B2 v3 挂链锚）只透传非空字符串并 trim，空串=清除语义（存在性不校验——
 *  跨仓解析归消费方，fragment-link「产物指针逐仓解析」同款纪律） */
function extractNodeDecorations(core, args) {
  const out = {}
  if (args.shape !== undefined && args.shape !== '') {
    const shapes = Array.isArray(core.DIAGRAM_NODE_SHAPES) ? core.DIAGRAM_NODE_SHAPES : []
    const shape = String(args.shape)
    if (!shapes.includes(shape)) return { error: `形状「${shape}」不支持。可用：${shapes.join('/')}。` }
    if (shape !== 'rect') out.shape = shape
  }
  if (args.color !== undefined) {
    const color = String(args.color).trim()
    if (color && typeof core.isValidDiagramColor === 'function' && !core.isValidDiagramColor(color)) {
      return { error: `颜色「${color}」不合法。可用 hex（如 #e6f4ff）或调色板键（blue/green/orange/red/purple/cyan/gold/gray）；清色传空串。` }
    }
    if (color) out.color = color
  }
  if (args.docRef !== undefined && String(args.docRef).trim() !== '') {
    out.docRef = String(args.docRef).trim()
  }
  return { value: out }
}

// ---------- 数据层（读写 .diagram；写前必过 stdlib 校验） ----------

async function listDiagramDocs() {
  const repos = (await context.listRepositories()) || []
  const out = []
  for (const repo of repos) {
    for (const d of (await context.getDocuments(repo.id)) || []) {
      // id 随行（B3）：出题入库的 documentId=承载文档（.diagram）行 id
      if (isDiagramDocPath(d.filePath)) out.push({ id: d.id, title: d.title || d.filePath, repo: repo.name || repo.id, filePath: d.filePath })
    }
  }
  return out
}

async function readDiagramDoc(filePath) {
  const body = (await context.readFile(filePath)) || ''
  const parsed = parseDiagramDoc(body)
  if (!parsed) return null
  const core = getDiagramCore()
  if (!core) return null
  const verdict = await core.parse('diagram-json', JSON.stringify(parsed.diagram))
  if (!verdict.ok) return null
  return { title: parsed.title, diagram: core.normalizeDiagramData(parsed.diagram) }
}

/** 写图文档：stdlib 规范化 + 校验闸（fail-closed，非法不落盘）→ 写盘。
 *  保存后禁做 reindexRepository 全仓重索引：context.writeFile→fileService.writeFile 已 emit
 *  doc-changed，宿主写漏斗自动完成单文档索引与本体归位；全仓扫描（真实库 1160 篇，秒级同步
 *  阻塞）是画布保存场景主进程「未响应」的根因（2026-10-16 漂移实测），且其所需 db:write 未
 *  声明、调用被权限闸拒绝后被 catch 静默吞掉——两态都是坏的，正确解=删调用靠漏斗，而非补权限。 */
async function writeDiagramDoc(filePath, title, rawDiagram) {
  const core = getDiagramCore()
  if (!core) return { error: 'DIAGRAM_CORE_STDLIB_MISSING' }
  const verdict = await core.parse('diagram-json', JSON.stringify(rawDiagram))
  if (!verdict.ok) return { error: 'DIAGRAM_INVALID', issues: verdict.issues }
  const diagram = core.normalizeDiagramData(rawDiagram)
  await context.writeFile(filePath, buildDiagramDoc(title, diagram))
  return { diagram }
}

async function resolveDocOrError(args) {
  const docs = await listDiagramDocs()
  if (docs.length === 0) return { error: { error: 'NO_DIAGRAM', output: '还没有任何图。先 operate_diagram op=create 建一张，或在画图工坊页新建。' } }
  const doc = matchDiagramDoc(docs, args.path || args.title || '')
  if (!doc) return { error: { error: 'NO_DIAGRAM_MATCH', output: `没有找到匹配「${args.path || args.title || '(空)'}」的图。可用：\n${docs.map((d) => `- ${d.title}（${d.filePath}）`).join('\n')}` } }
  const loaded = await readDiagramDoc(doc.filePath)
  if (!loaded) return { error: { error: 'DIAGRAM_DOC_INVALID', output: `图文档「${doc.title}」损坏或语法非法（可能被手工改坏）。让白泽用 op=create 重建一张。` } }
  return { doc: { ...doc, ...loaded } }
}

// ---------- 工具执行器 ----------

async function runOperate(args) {
  const op = String(args.op || '')
  const core = getDiagramCore()
  if (!core || typeof core.parse !== 'function') return stdlibMissingResult()

  // ---- 不依赖已有图的操作 ----
  if (op === 'list') {
    const docs = await listDiagramDocs()
    if (docs.length === 0) return { output: '还没有任何图。op=create 建一张，或在画图工坊页新建。' }
    return { output: `共 ${docs.length} 张图：\n${docs.map((d) => `- ${d.title}（${d.filePath}）`).join('\n')}` }
  }
  if (op === 'validate') {
    const r = await core.parse('diagram-json', String(args.json ?? args.code ?? ''))
    if (r.ok) return { output: '✅ 图结构校验通过。' }
    return { error: 'DIAGRAM_INVALID', output: `❌ 校验未通过：\n${r.issues.map((i) => `- ${i.code}: ${i.message}`).join('\n')}` }
  }
  if (op === 'create') {
    const title = sanitizeFileName(String(args.title || '').replace(/\.diagram$/i, ''))
    if (!args.title || !title) return { error: 'MISSING_TITLE', output: '请给图起个名字（title 参数），例如「登录流程」。' }
    const repo = (await context.listRepositories() || [])[0]
    if (!repo) return { error: 'NO_REPO', output: '没有可用仓库：请先在「仓库管理」添加至少一个仓库，图需要落盘为知识库文档。' }
    const filePath = join(String(repo.localPath).replace(/[\\/]+$/, ''), DIAGRAM_DIR, `${title}${DOC_SUFFIX}`)
    const existing = (await context.readFile(filePath))
    if (existing) return { error: 'ALREADY_EXISTS', output: `图「${title}」已存在（${filePath}），直接 op=get 取用或换个名字。` }
    const r = await writeDiagramDoc(filePath, title, { nodes: [], edges: [] })
    if (r.error) return stdlibMissingResult()
    return { output: `✅ 已创建空图「${title}」：${filePath}。接着用 add_node/add_edge 搭结构，或让用户在画图工坊页点开手画。` }
  }

  if (op === 'import_mermaid') {
    const src = String(args.source || args.path || args.document || '').trim()
    if (!src) return { error: 'MISSING_SOURCE', output: '请给源文档（source 参数：路径或文档标题关键词），例如「设计笔记」或「docs/宏观/资产.md」。' }
    // 定位源文档：路径精确优先 → 标题精确 → 标题包含（generate_diagram 同款口径）
    const norm = (p) => String(p || '').replace(/[\\/]+/g, '/').toLowerCase()
    const docs = (await context.getDocuments()) || []
    const kw = src.toLowerCase()
    const source =
      docs.find((d) => norm(d.filePath) === norm(src)) ||
      docs.find((d) => String(d.title || '').toLowerCase() === kw) ||
      (kw ? docs.find((d) => String(d.title || '').toLowerCase().includes(kw)) : null) ||
      null
    if (!source || !source.filePath) return { error: 'NO_SOURCE_DOC', output: `没有找到匹配「${src}」的文档。请给出更完整的文档标题或路径。` }
    // agent 口径 block=第几块（1 起）；页方法口径=0 起序号或块源文本（内部换算）
    const n = Number(args.block)
    const block = args.block !== undefined && args.block !== '' && Number.isFinite(n) ? n - 1 : args.block
    return runImportMermaid(source.filePath, block)
  }

  // ---- 依赖已有图的操作 ----
  if (['get', 'add_node', 'update_node', 'remove_node', 'add_edge', 'remove_edge', 'export_mermaid', 'make_questions', 'start_recall'].includes(op)) {
    const resolved = await resolveDocOrError(args)
    if (resolved.error) return resolved.error
    const doc = resolved.doc
    const diagram = doc.diagram

    if (op === 'get') {
      return { output: `「${doc.title}」结构：\n节点：${diagram.nodes.map((n) => `${n.id}(${n.label})${n.docRef ? `[挂:${n.docRef}]` : ''}`).join('、') || '（空）'}\n边：${diagram.edges.map((e) => `${e.from}->${e.to}${e.label ? `(${e.label})` : ''}`).join('、') || '（无）'}\n路径：${doc.filePath}` }
    }
    if (op === 'make_questions') {
      return runMakeQuestions(doc)
    }
    if (op === 'start_recall') {
      // B4 T4.2 agent 口径：只发起会话与回执挖空规模，绝不回显挖空答案（用户接着要凭记忆
      // 补全，答案泄在对话里默画就失效）；投影/判分口径与页方法同走 lib/recall.js 单源
      const r = diagramRecall.blanksFor(diagram)
      if (!r.ok) return { error: r.code, output: `图「${doc.title}」暂不可默画：${r.message}` }
      return {
        output: `✅ 已为图「${doc.title}」发起默画复习：挖空 ${r.blankCount}/${r.totalNodes} 个节点（${r.strategy === 'degree' ? '按连接度' : '按 id 序'}降序 ${Math.round(r.ratio * 100)}%）。请在画图工坊打开该图完成默画（挖空位置已在画布标出），填写后交卷，判分与 SM-2 复习调度自动回流到承载文档${r.skipped.length ? `；${r.skipped.length} 个空 label 节点未参与挖空` : ''}。`,
      }
    }
    if (op === 'add_node') {
      const label = String(args.label || '').trim()
      if (!label) return { error: 'MISSING_LABEL', output: '请给节点文字（label 参数），例如「网关」。' }
      let id = String(args.id || '').trim()
      if (id && diagram.nodes.some((n) => n.id === id)) return { error: 'NODE_ID_DUPLICATE', output: `节点 id「${id}」已存在。换一个 id，或不传 id 由系统自动分配。` }
      if (!id) {
        let i = diagram.nodes.length + 1
        while (diagram.nodes.some((n) => n.id === `n${i}`)) i++
        id = `n${i}`
      }
      const deco = extractNodeDecorations(core, args)
      if (deco.error) return { error: 'NODE_FIELD_INVALID', output: deco.error }
      diagram.nodes.push({ id, label, ...deco.value })
      const r = await writeDiagramDoc(doc.filePath, doc.title, diagram)
      if (r.error) return { error: r.error, output: `保存未通过校验：\n${(r.issues || []).map((i) => `- ${i.code}: ${i.message}`).join('\n')}` }
      const decoNote = `${deco.value.shape ? `（形状 ${deco.value.shape}）` : ''}${deco.value.color ? `（颜色 ${deco.value.color}）` : ''}${deco.value.docRef ? `（挂链 ${deco.value.docRef}）` : ''}`
      return { output: `✅ 已加节点 ${id}(${label})${decoNote} 到「${doc.title}」。继续 add_edge 连线或 add_node 加点。` }
    }
    if (op === 'update_node') {
      const n = diagram.nodes.find((x) => x.id === String(args.id || ''))
      if (!n) return { error: 'NODE_NOT_FOUND', output: `节点「${args.id}」不存在。op=get 先看结构。` }
      if (args.label !== undefined) n.label = String(args.label).trim() || n.label
      const deco = extractNodeDecorations(core, args)
      if (deco.error) return { error: 'NODE_FIELD_INVALID', output: deco.error }
      // rect/空串=清除语义（rect 是缺省形状，等价无形状；docRef 空串=解链，D4 显式动作）
      if (args.shape === 'rect') delete n.shape
      if (args.color === '') delete n.color
      if (args.docRef !== undefined && String(args.docRef).trim() === '') delete n.docRef
      Object.assign(n, deco.value)
      const r = await writeDiagramDoc(doc.filePath, doc.title, diagram)
      if (r.error) return { error: r.error, output: '保存未通过校验。' }
      return { output: `✅ 已更新节点 ${n.id}(${n.label})。` }
    }
    if (op === 'remove_node') {
      const id = String(args.id || '')
      const n = diagram.nodes.find((x) => x.id === id)
      if (!n) return { error: 'NODE_NOT_FOUND', output: `节点「${id}」不存在。` }
      diagram.nodes = diagram.nodes.filter((x) => x.id !== id)
      const before = diagram.edges.length
      diagram.edges = diagram.edges.filter((e) => e.from !== id && e.to !== id)
      const r = await writeDiagramDoc(doc.filePath, doc.title, diagram)
      if (r.error) return { error: r.error, output: '保存未通过校验。' }
      return { output: `✅ 已删节点 ${id}(${n.label}) 及其 ${before - diagram.edges.length} 条关联边。` }
    }
    if (op === 'add_edge') {
      const from = String(args.from || '')
      const to = String(args.to || '')
      if (!diagram.nodes.some((n) => n.id === from) || !diagram.nodes.some((n) => n.id === to)) {
        return { error: 'EDGE_ENDPOINT_MISSING', output: `端点不存在：先确认 ${from}/${to} 都是已有节点 id（op=get 查看）。` }
      }
      if (from === to) return { error: 'SELF_EDGE', output: '不支持自环边（from === to）。' }
      if (diagram.edges.some((e) => e.from === from && e.to === to)) return { error: 'EDGE_EXISTS', output: `${from}->${to} 已有边，用 update 语义改 label 或先 remove_edge。` }
      diagram.edges.push({ from, to, ...(args.label ? { label: String(args.label) } : {}), ...(args.dashed === true ? { dashed: true } : {}) })
      const r = await writeDiagramDoc(doc.filePath, doc.title, diagram)
      if (r.error) return { error: r.error, output: '保存未通过校验。' }
      return { output: `✅ 已连边 ${from}->${to}${args.label ? `（${args.label}）` : ''}。` }
    }
    if (op === 'remove_edge') {
      const before = diagram.edges.length
      diagram.edges = diagram.edges.filter((e) => !(e.from === args.from && e.to === args.to))
      if (diagram.edges.length === before) return { error: 'EDGE_NOT_FOUND', output: `边 ${args.from}->${args.to} 不存在。` }
      const r = await writeDiagramDoc(doc.filePath, doc.title, diagram)
      if (r.error) return { error: r.error, output: '保存未通过校验。' }
      return { output: `✅ 已删边 ${args.from}->${args.to}。` }
    }
    if (op === 'export_mermaid') {
      const mermaid = core.diagramToMermaid(diagram)
      return { output: `「${doc.title}」的 mermaid 导出（可直接嵌入任意文档的 mermaid 代码块渲染）：\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`` }
    }
  }

  return {
    error: 'UNKNOWN_OP',
    output: `未知操作「${op}」。可用：list/create/get/add_node/update_node/remove_node/add_edge/remove_edge/export_mermaid/import_mermaid/make_questions/start_recall/validate。`,
  }
}

async function runGenerate(args) {
  const kindKey = String(args.kind || 'flowchart')
  const kind = KINDS[kindKey]
  if (!kind) {
    return {
      error: 'UNKNOWN_KIND',
      output: `不支持的图类型「${kindKey}」。可用：${Object.keys(KINDS).join('/')}（流程图/架构图/思维导图/协作图）。`,
    }
  }
  const core = getDiagramCore()
  if (!core || typeof core.parse !== 'function') return stdlibMissingResult()

  const docs = (await context.getDocuments()) || []
  const kw = String(args.document || '').trim().toLowerCase()
  const source =
    docs.find((d) => (d.title || '').toLowerCase() === kw) ||
    docs.find((d) => (d.title || '').toLowerCase().includes(kw) && kw) ||
    null
  if (!source || !source.filePath) {
    return { error: 'NO_DOC_MATCH', output: `没有找到匹配「${args.document || '(空)'}」的文档。请给出更完整的文档标题。` }
  }
  if (!context.llm || typeof context.llm.complete !== 'function') {
    return { error: 'LLM_UNAVAILABLE', output: '当前没有可用的模型服务，无法自动生成图。可先建空图手画（op=create）。' }
  }

  const content = (await context.readFile(source.filePath)) || ''
  if (!content.trim()) return { error: 'EMPTY_DOC', output: `文档「${source.title}」内容为空，无从画图。` }

  const userPrompt = `请把以下文档整理成「${kind.label}」的图结构。\n\n【文档：${source.title}】\n${content.slice(0, 12000)}`
  const askLlm = async (repairFeedback) => {
    const messages = [
      { role: 'system', content: buildGenerateSystemPrompt(kindKey) },
      { role: 'user', content: repairFeedback ? `${userPrompt}\n\n上次输出未通过校验：\n${repairFeedback}\n请修正后重新只输出 JSON。` : userPrompt },
    ]
    return context.llm.complete({ messages, json: true, timeoutMs: 120000 })
  }

  const extractIssues = (v) => (v && v.issues ? v.issues.map((i) => `- ${i.code}: ${i.message}`).join('\n') : '')
  let raw = await askLlm()
  let verdict = await core.parse('diagram-json', typeof raw === 'string' ? raw : JSON.stringify(raw))
  if (!verdict.ok) {
    raw = await askLlm(extractIssues(verdict))
    verdict = await core.parse('diagram-json', typeof raw === 'string' ? raw : JSON.stringify(raw))
  }
  if (!verdict.ok) {
    return {
      error: 'DIAGRAM_INVALID',
      output: `「${source.title}」的${kind.label}两次生成均未通过结构校验，已放弃落盘。可换个图类型重试，或让白泽先用文字梳理结构。`,
    }
  }

  // 生成即排版：stdlib 布局面按 kind 排版（旧版应用无此能力时退回网格位置，不阻断）；
  // kind 显式落盘供画布按类型差异化渲染与一键重排
  const normalized = core.normalizeDiagramData(typeof raw === 'string' ? JSON.parse(raw) : raw)
  const laid =
    typeof core.layoutDiagramData === 'function'
      ? core.layoutDiagramData({ ...normalized, kind: kindKey }, { kind: kindKey })
      : normalized
  const diagram = { ...laid, kind: kindKey }
  const filePath = generatedDocPath(source.filePath, kind.label)
  const title = source.title || filePath
  const r = await writeDiagramDoc(filePath, title, diagram)
  if (r.error) return stdlibMissingResult()
  return {
    output: `✅ 已生成「${title}」的${kind.label}（${diagram.nodes.length} 节点 / ${diagram.edges.length} 边）并通过校验，落盘：${filePath}。画图工坊页点开即可继续手画；不理想可换个图类型再生成。`,
  }
}

// ---------- mermaid 块导入（B1 T1.2：mermaid 块→可编辑画布图，入向主干道） ----------

/** 导入执行核心：读源文档 → stdlib 抽块定位 → mermaidToDiagramJson 转换 → 校验闸落盘
 *  《base-图》.diagram 同目录（多块按序消歧 -图2/-图3）→ 重索引。
 *  block：number=块序号（0 起）/ string=块源文本（UI 通道精确匹配首个——渲染器无索引语义）/
 *  undefined=单块文档自动（多块缺省报错列出块数，绝不静默猜块）。
 *  返回 {ok,title,filePath,output} | {error,output,issues?} */
async function runImportMermaid(sourceDocPath, block) {
  const core = getDiagramCore()
  if (!core || typeof core.parse !== 'function' || typeof core.mermaidToDiagramJson !== 'function') {
    return stdlibMissingResult()
  }
  const srcPath = String(sourceDocPath || '').trim()
  if (!srcPath) return { error: 'MISSING_SOURCE', output: '请给源文档路径（含 mermaid 块的 .md 文档）。' }
  const body = (await context.readFile(srcPath)) || ''
  if (!body.trim()) return { error: 'NO_SOURCE_DOC', output: `源文档不存在或为空：${srcPath}。请确认路径后重试。` }
  const blocks = typeof core.extract === 'function' ? core.extract(body) : []
  if (blocks.length === 0) return { error: 'NO_MERMAID_BLOCK', output: `文档「${srcPath}」中没有 mermaid 代码块，无从转换。` }
  let idx = -1
  if (typeof block === 'string' && block.trim()) {
    const wanted = block.trim()
    // UI 通道源来自渲染端（remark 规范化 LF + 列表缩进去除），文档原文常为 CRLF+缩进——
    // 精确比对必失配（真机验收 2026-10-16 实证）；按行归一化后匹配（行尾 \r 与行首缩进不敏感）
    const norm = (s) => String(s || '').replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).join('\n').trim()
    idx = blocks.findIndex((b) => norm(b.code) === norm(wanted))
    if (idx < 0) return { error: 'NO_MERMAID_BLOCK', output: `图块内容与文档当前不一致（文档可能已改动）。请重新打开文档后再试。` }
  } else if (Number.isFinite(Number(block)) && block !== undefined && block !== null && `${block}`.trim() !== '') {
    idx = Number(block)
    if (idx < 0 || idx >= blocks.length) return { error: 'BLOCK_OUT_OF_RANGE', output: `块序号 ${idx} 超出范围：该文档共 ${blocks.length} 个 mermaid 块（序号 0~${blocks.length - 1}）。` }
  } else {
    if (blocks.length > 1) return { error: 'BLOCK_AMBIGUOUS', output: `该文档有 ${blocks.length} 个 mermaid 块，请指定块序号（block=0~${blocks.length - 1}）。` }
    idx = 0
  }
  const verdict = core.mermaidToDiagramJson(blocks[idx].code)
  if (!verdict.ok) {
    return {
      error: 'MERMAID_INVALID',
      issues: verdict.issues,
      output: `❌ 第 ${idx + 1} 块 mermaid 未转换（非法或不支持的构造，原块保留可继续渲染）：\n${verdict.issues.map((i) => `- ${i.code}: ${i.message}`).join('\n')}`,
    }
  }
  // 生成即排版（与 generate_diagram 同款）：stdlib 布局面按 flowchart 分层排版后落盘
  const normalized = core.normalizeDiagramData(verdict.diagram)
  const laid = typeof core.layoutDiagramData === 'function'
    ? core.layoutDiagramData({ ...normalized, kind: 'flowchart' }, { kind: 'flowchart' })
    : normalized
  const diagram = { ...laid, kind: 'flowchart' }
  const filePath = importTargetPath(srcPath, blocks.length, idx)
  const existing = await context.readFile(filePath)
  // ALREADY_EXISTS 带 filePath（幂等打开语义，2026-10-18）：渲染端据此直接打开既有画布而非报错
  if (existing) return { error: 'ALREADY_EXISTS', filePath, output: `画布图已存在：${filePath}。直接在画图工坊打开编辑，或删除后重试。` }
  const title = `${String(srcPath).split(/[\\/]/).pop()?.replace(/\.(md|diagram)$/i, '') || '未命名'}-图`
  const r = await writeDiagramDoc(filePath, title, diagram)
  if (r.error === 'DIAGRAM_CORE_STDLIB_MISSING') return stdlibMissingResult()
  if (r.error) return { error: r.error, issues: r.issues, output: `保存未通过校验：\n${(r.issues || []).map((i) => `- ${i.code}: ${i.message}`).join('\n')}` }
  return {
    ok: true,
    title,
    filePath,
    output: `✅ 已把第 ${idx + 1} 块 mermaid 转成画布图「${title}」（${diagram.nodes.length} 节点 / ${diagram.edges.length} 边），落盘：${filePath}。可在画图工坊继续编辑。`,
  }
}

/** 页方法（MarkdownPreview「转画布」按钮消费）：block 支持 0 起序号或块源文本。
 *  页面契约（与 createDiagram 同款）：{error,message} 失败 / {message,title,filePath} 成功；
 *  ALREADY_EXISTS 半成功：携带 filePath 透传（渲染端转「已转换过，直接打开」幂等语义，不当失败报） */
async function importMermaid(sourcePath, block) {
  const r = await runImportMermaid(String(sourcePath || ''), block)
  if (r.error) {
    return {
      error: r.error,
      message: r.output || r.error,
      issues: r.issues,
      ...(r.error === 'ALREADY_EXISTS' && r.filePath ? { filePath: r.filePath } : {}),
    }
  }
  return { message: r.output, title: r.title, filePath: r.filePath }
}

// ---------- 图→题确定性出题（B3 T3.2/T3.3：零 LLM，写门入库，回执对账） ----------

/** 排序/填空的认知分层（计划 T3.2：排序=应用、填空=记忆；quiz-maker 健康度分层度量消费） */
const QUESTION_COGNITIVE_BY_KIND = { ordering: '应用', blank: '记忆' }
const QUESTION_TYPE_LABEL = { ordering: '排序·应用', blank: '填空·记忆' }

/** 出题执行核心：lib/questions 确定性变换 → quiz-maker/questions 资产写门逐题入库
 *  → 回执清单（题干+答案+判分口径+入库结果逐条对账）。
 *  承载文档=.diagram 本身（ADR-102 sourceSnippet 强制；snippet=diagramjson 围栏摘录段，
 *  逐字摘自原文过接地校验；做题卡「解读/原文预览」走 SourcePreviewModal 通道即渲染图——
 *  D5，QuestionCard 零改动）。generator=diagram-studio（分享扩散排除口径自动生效）。
 *  写门未激活如实拒（PROVIDER_INACTIVE 降级文案；先例 listening-drill 已随 2026-10-26 插件裁撤退役）。
 *  返回 {output} | {error,output} */
async function runMakeQuestions(doc) {
  const made = diagramQuestions.makeDiagramQuestions(doc.diagram)
  const skipLines = made.skipped.map((s) => `- [${s.kind}] ${s.code ? `${s.code}：` : ''}${s.message}`)
  // 结构门槛全不满足：零写入，明示原因与可行动路径（环/过小/重复 label…）
  if (made.questions.length === 0) {
    return {
      error: 'DIAGRAM_NOT_ELIGIBLE',
      output: `图「${doc.title}」暂不可出题（确定性出题不猜不凑，结构门槛明示）：\n${skipLines.join('\n') || '- 图为空'}\n可先在画布补结构（≥4 个连通节点、有向无环、label 不重复）再试。`,
    }
  }
  if (!doc.id) {
    return { error: 'NO_DOC_INDEX', output: `图文档「${doc.filePath}」不在文档索引中（可能刚落盘尚未索引）——稍后重试，或先在知识库打开一次该文档。` }
  }
  const body = (await context.readFile(doc.filePath)) || ''
  const fence = diagramFenceOf(body)
  if (!fence) return { error: 'DIAGRAM_DOC_INVALID', output: `图文档「${doc.title}」读取异常（diagramjson 围栏缺失），暂不可出题。` }
  // 接地预检（偏斜守卫同款：stdlib 缺面跳过不阻断——写门侧 ADR-102 校验仍兜底）
  const grounding = (typeof knownest !== 'undefined' && knownest.stdlib && knownest.stdlib['quiz-grounding']) || null
  if (grounding && typeof grounding.isGroundedIn === 'function' && !grounding.isGroundedIn(fence, body)) {
    return { error: 'GROUNDING_FAILED', output: `出题中止：题面引用片段与图文档原文不一致（接地校验未过）。图文档可能被改动，请重新打开确认后再试。` }
  }
  // 写门逐题入库（invokeAsset 消费声明即授权；单题失败不拖垮整批——逐题如实回执）
  const results = []
  let inactiveReason = null
  for (const q of made.questions) {
    let r
    try {
      r = await context.invokeAsset('quiz-maker/questions', 'insertQuestion', [
        {
          documentId: doc.id,
          type: q.type,
          question: q.question,
          ...(Array.isArray(q.options) ? { options: q.options } : {}),
          answer: q.answer,
          explanation: `图「${doc.title}」确定性出题（零模型调用）。${q.gradingNote}。`,
          sourceSnippet: fence,
          pluginId: PLUGIN_ID,
          generator: PLUGIN_ID,
          cognitiveLevel: QUESTION_COGNITIVE_BY_KIND[q.kind] || '',
        },
      ])
    } catch (err) {
      const msg = String((err && err.message) || err)
      if (msg.includes('PROVIDER_INACTIVE')) {
        inactiveReason = msg
        break
      }
      r = { created: false, duplicate: false, reason: msg }
    }
    results.push({ q, r })
  }
  // 写门未激活如实拒（P3 先例降级文案）：已入库的题如实披露（不谎报零残留）
  if (inactiveReason) {
    const done = results.filter((x) => x.r && (x.r.created || x.r.duplicate)).length
    return {
      error: 'PROVIDER_INACTIVE',
      output: `题目入库未完成：练习（quiz-maker）未激活，题库写门不可用。请在「插件」页启用「练习」后重试；本次已入库 ${done} 题、其余未写入。`,
    }
  }
  // 回执清单（T3.3）：题干+答案+判分口径+入库结果逐条对账
  const lines = []
  let created = 0
  let dup = 0
  let failed = 0
  results.forEach(({ q, r }, i) => {
    const status = r && r.created
      ? `已入库（id: ${r.id}）`
      : r && r.duplicate
        ? '重复跳过（同文档同题干已入库，未翻倍）'
        : `入库失败：${(r && r.reason) || '未知原因'}`
    if (r && r.created) created++
    else if (r && r.duplicate) dup++
    else failed++
    lines.push(`${i + 1}. [${QUESTION_TYPE_LABEL[q.kind] || q.kind}] ${q.question}\n   答案：${q.answerDisplay} ｜ 判分：${q.gradingNote}\n   → ${status}`)
  })
  const head = `✅ 已从图「${doc.title}」确定性出题 ${made.questions.length} 道（零模型调用），经练习题库写门入库：新增 ${created} · 重复 ${dup} · 失败 ${failed}`
  const tail = [
    `承载文档：${doc.filePath}（做题卡「解读/原文预览」即渲染图；作答自动推进 SM-2 复习）`,
    made.skipped.length > 0 ? `未出题项（明示）：\n${skipLines.join('\n')}` : null,
    '质量兜底=做题卡差评三态反馈（bad_question 退回可清理，不污染题库）',
  ].filter(Boolean)
  return { output: [head, ...lines, ...tail].join('\n') }
}

/** 页面方法（plugin:invoke 预留）与 op=make_questions 共用核心 */
async function makeQuestionsFromDiagram(filePath) {
  const loaded = await readDiagramDoc(String(filePath || ''))
  if (!loaded) return { error: 'DIAGRAM_DOC_INVALID', message: '图文档缺失或已损坏，暂不可出题。' }
  const docs = await listDiagramDocs()
  const hit = docs.find((d) => d.filePath === String(filePath || ''))
  return runMakeQuestions({ ...loaded, id: hit?.id, filePath: String(filePath || ''), title: loaded.title || String(filePath || '') })
}

// ---------- 默画复习（B4 T4.1/T4.2：零 LLM 确定性投影 + 逐点判分，即时轨回流） ----------

/** 默画会话（页方法）：lib/recall.blanksFor 确定性投影 → 画布挖空渲染载荷。
 *  双消费形态：① rowAction「默画复习」（applyActionResult 通道）→ ui=navigate 深链
 *  ?detail=<enc>&recall=1 落详情画布自动开默画（入口=插件页行动作，计划 T4.2）；
 *  ② 画布详情工具栏（deck-cards 经 detail.recallMethod invoke）→ 只消费 recall 载荷。
 *  documentId 随行：判分回流的 recordAttempt 文档锚点必需（.diagram 文档行 id）。
 *  失败契约：{ error: <用户可读原因> }（applyActionResult/画布各自 toast，不静默）。 */
async function startRecall(filePath, opts) {
  const loaded = await readDiagramDoc(String(filePath || ''))
  if (!loaded) return { error: '图文档缺失或已损坏，暂不可默画。' }
  const title = loaded.title || String(filePath || '')
  const r = diagramRecall.blanksFor(loaded.diagram, opts)
  if (!r.ok) return { error: `图「${title}」暂不可默画：${r.message}` }
  const docs = await listDiagramDocs()
  const hit = docs.find((d) => d.filePath === String(filePath || ''))
  return {
    message: `已为「${title}」开始默画：挖空 ${r.blankCount}/${r.totalNodes} 个节点（${r.strategy === 'degree' ? '按连接度' : '按 id 序'}降序 ${Math.round(r.ratio * 100)}%），凭记忆填写后交卷。`,
    recall: {
      filePath: String(filePath || ''),
      documentId: hit?.id || null,
      title,
      ratio: r.ratio,
      strategy: r.strategy,
      blankCount: r.blankCount,
      totalNodes: r.totalNodes,
      // 画布只消费 id 列表渲染挖空位；label=答案（判分回显用，交卷前不展示）
      blanks: r.blanks.map((b) => ({ id: b.id, label: b.label })),
    },
    ui: {
      intent: 'navigate',
      // 深链落 PackPage ?detail= 既有通道；recall=1 由宿主捕获后自动开默画会话
      path: `/pack/${PLUGIN_ID}/${NAV_KEY}?detail=${encodeURIComponent(String(filePath || ''))}&recall=1`,
    },
  }
}

/** 默画判分（页方法）：确定性投影重现（同输入必同输出——画布无需回传会话态，只交答案）
 *  → lib/recall.gradeRecall 逐点 trim 判分（overrides=「标记正确」人工改判，自评调分语义）
 *  → 自包含即时题快照交渲染层走宿主 practice:recordAttempt 文档锚点即时轨落库。
 *  D6 红线：快照无题库 id → recordAttempt 题库轨自然跳过（不入题库，§7 边界），
 *  practice_attempts 流水 + doc_review SM-2 落 .diagram 文档——文档到期即图到期。
 *  documentId 缺失（文档未索引）时如实降级：判分回显照常、落库跳过并附 note（不谎报）。 */
async function checkRecall(filePath, answers, overrides) {
  const loaded = await readDiagramDoc(String(filePath || ''))
  if (!loaded) return { error: '图文档缺失或已损坏，无法判分。' }
  const title = loaded.title || String(filePath || '')
  const r = diagramRecall.blanksFor(loaded.diagram)
  if (!r.ok) return { error: `图「${title}」暂不可默画：${r.message}` }
  const g = diagramRecall.gradeRecall(r.blanks, answers || {}, overrides || {})
  const docs = await listDiagramDocs()
  const hit = docs.find((d) => d.filePath === String(filePath || ''))
  const documentId = hit?.id || null
  let fence = ''
  try { fence = diagramFenceOf((await context.readFile(String(filePath || ''))) || '') } catch { fence = '' }
  const wrong = g.verdicts.filter((v) => !v.correct)
  const regradedList = g.verdicts.filter((v) => v.regraded)
  const snapshot = {
    documentId,
    // 即时轨题型语义：挖空默画（快照仅作复盘/归因展示；判分已由本方法确定性给出，
    // 渲染层不传 selectedOption → 宿主自动判分不生效，quality 按本方法结果落库）
    type: 'fill_blank',
    question: `图「${title}」默画复习（挖空 ${g.total} 个节点，度降序 ${Math.round(r.ratio * 100)}%）`,
    answer: r.blanks.map((b) => b.label).join('、'),
    explanation: `默画判分口径：逐点 trim 后精确相等；对 ${g.correctCount}/${g.total}，SM-2 quality=${g.quality}。${wrong.length > 0 ? `错判 ${wrong.length} 处（可「标记正确」人工改判）：${wrong.map((v) => `应为「${v.expected}」`).join('、')}` : '全对'}${regradedList.length > 0 ? `；人工改判 ${regradedList.length} 处（标记正确，应为：${regradedList.map((v) => `「${v.expected}」`).join('、')}）` : ''}`,
    ...(fence ? { sourceSnippet: fence } : {}),
    pluginId: PLUGIN_ID,
  }
  return {
    result: {
      verdicts: g.verdicts,
      correctCount: g.correctCount,
      total: g.total,
      quality: g.quality,
      // 快照仅在有文档锚点时下发（渲染层据此走 recordAttempt）；缺失=未索引降级，如实披露
      ...(documentId
        ? { snapshot }
        : { snapshot: null, note: '图文档尚未索引（documentId 缺失），本次判分仅回显、未推进复习调度——稍后在知识库打开一次该文档即可恢复记账' }),
    },
  }
}

// ---------- 页面方法（plugin:invoke） ----------

/** 列表 + 新建表单 + detail 下钻声明（行点击 → openDiagram → 内核画布） */
async function pageDiagrams() {
  let rows = []
  try {
    rows = (await listDiagramDocs()).map((d) => ({ 标题: d.title, 仓库: d.repo, filePath: d.filePath }))
  } catch {
    /* 查询失败按空表呈现（页面空态可用，不抛错） */
  }
  rows.sort((a, b) => String(b.标题).localeCompare(String(a.标题), 'zh'))
  return {
    cards: [
      {
        type: 'form',
        title: '新建图',
        submitMethod: 'createDiagram',
        fields: [
          { key: 'title', label: '图名称', placeholder: '如：登录流程' },
          { key: 'kind', label: '图类型', type: 'select', placeholder: '默认流程图', options: Object.entries(KINDS).map(([value, k]) => ({ value, label: k.label })) },
        ],
      },
      {
        type: 'table',
        title: rows.length > 0 ? '我的图（点行进入画布编辑）' : '暂无图。在上方新建，或对白泽说「画一张部署图」。',
        detail: { method: 'openDiagram', paramKey: 'filePath' },
        // 行动作「默画复习」（B4 T4.2 入口）：startRecall 回执 ui=navigate 深链自动开默画
        rowAction: { label: '默画复习', method: 'startRecall', paramKey: 'filePath' },
        columns: [
          { key: '标题', title: '标题' },
          { key: '仓库', title: '仓库' },
        ],
        rows,
      },
    ],
  }
}

/** detail 下钻：返回 diagram 形态详情态（内核 Deck 渲染交互画布）。
 *  layoutMethod/mermaidMethod（v0.3.0）：画布自动布局与 mermaid 复制经 invoke 回本插件
 *  走 stdlib 单源（渲染器禁直载 electron/shared CJS——dev 直出不转换）；
 *  recallMethod/recallCheckMethod（B4 T4.2）：画布「默画复习」工具栏与判分提交的
 *  声明式回插件通道（同 layoutMethod 先例；deck-cards 消费并承接宿主 practice 写面）
 *  三态 fallback 机器码（2026-10-18 转画布假警报批）：读空≠损坏——doc-missing（不存在或
 *  尚未就绪）/core-missing（画图内核缺失）/doc-invalid（围栏缺失或语法非法）各自返回原因码，
 *  文案由内核词典出词（deck-cards DIAGRAM_DETAIL_FALLBACK 单源）——方法返回 markdown 属
 *  翻译链不可达位（i18n 统一 B4 已登记机制缺口），插件侧硬编码撞冻结计数门禁且 en 面永不可译。
 *  读空附一拍延迟重读兜底残余竞态（旧宿主/非本插件写入路径），重试仍空才判缺。 */
async function openDiagram(filePath) {
  const p = String(filePath || '')
  let body = await context.readFile(p)
  if (!body || !body.trim()) {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    body = await context.readFile(p)
  }
  if (!body || !body.trim()) return { title: p, markdown: '', type: 'text', fallback: 'doc-missing' }
  const core = getDiagramCore()
  if (!core) return { title: p, markdown: '', type: 'text', fallback: 'core-missing' }
  const parsed = parseDiagramDoc(body)
  const verdict = parsed ? await core.parse('diagram-json', JSON.stringify(parsed.diagram)) : null
  if (!parsed || !verdict || !verdict.ok) return { title: p, markdown: '', type: 'text', fallback: 'doc-invalid' }
  return {
    type: 'diagram',
    title: parsed.title || p,
    markdown: '',
    diagram: core.normalizeDiagramData(parsed.diagram),
    filePath: p,
    saveMethod: 'saveDiagram',
    layoutMethod: 'diagramLayout',
    mermaidMethod: 'diagramMermaid',
    recallMethod: 'startRecall',
    recallCheckMethod: 'checkRecall',
  }
}

/** 画布一键布局（v0.3.0）：stdlib layoutDiagramData 按 kind 排版，只回位置不改结构 */
async function diagramLayout(diagram) {
  const core = getDiagramCore()
  if (!core || typeof core.layoutDiagramData !== 'function') return { error: 'LAYOUT_UNAVAILABLE' }
  const laid = core.layoutDiagramData(diagram || {}, { kind: diagram?.kind })
  return { diagram: { ...laid, kind: diagram?.kind || laid.kind } }
}

/** 画布 mermaid 复制（v0.3.0）：stdlib diagramToMermaid 随 v2 形状/虚线导出 */
async function diagramMermaid(diagram) {
  const core = getDiagramCore()
  if (!core) return { error: 'DIAGRAM_CORE_STDLIB_MISSING' }
  return { mermaid: core.diagramToMermaid(diagram || {}) }
}

/** 画布保存回写（DiagramCanvas 保存按钮 → ctx.invoke(saveMethod, [filePath, diagram])） */
async function saveDiagram(filePath, diagram) {
  const core = getDiagramCore()
  if (!core) return { error: 'DIAGRAM_CORE_STDLIB_MISSING' }
  const prev = await readDiagramDoc(String(filePath || ''))
  const title = prev?.title || String(filePath || '').split(/[\\/]/).pop()?.replace(DOC_SUFFIX, '') || '未命名'
  const r = await writeDiagramDoc(String(filePath || ''), title, diagram)
  if (r.error === 'DIAGRAM_INVALID') {
    return { error: 'DIAGRAM_INVALID', message: `保存未通过校验：${(r.issues || []).map((i) => i.message).join('；')}` }
  }
  if (r.error) return { error: r.error }
  return { message: '已保存' }
}

/** 新建图（页头表单卡提交）：默认落第一个仓库的 画图/ 目录；图类型随建落盘（v2 kind） */
async function createDiagram(values) {
  const title = sanitizeFileName(String((values && values.title) || '').replace(/\.diagram$/i, ''))
  if (!values || !values.title || !title) return { error: 'MISSING_TITLE' }
  const kindKey = values.kind && KINDS[values.kind] ? String(values.kind) : undefined
  const repo = ((await context.listRepositories()) || [])[0]
  if (!repo) return { error: 'NO_REPO', message: '没有可用仓库：请先在「仓库管理」添加仓库。' }
  // 路径统一原生 join（与 create op 同款）：字符串拼 `/` 曾产混分隔符路径，文档索引按字符串记重致列表重复
  const filePath = join(String(repo.localPath).replace(/[\\/]+$/, ''), DIAGRAM_DIR, `${title}${DOC_SUFFIX}`)
  const r = await writeDiagramDoc(filePath, title, { ...(kindKey ? { kind: kindKey } : {}), nodes: [], edges: [] })
  if (r.error === 'DIAGRAM_CORE_STDLIB_MISSING') return { error: r.error, message: '平台画图校验内核缺失，请升级应用。' }
  return { message: `已创建「${title}」${kindKey ? `（${KINDS[kindKey].label}）` : ''}，点列表行进入画布。`, refresh: true }
}

// ---------- 插件接口 ----------

module.exports = {
  id: PLUGIN_ID,
  name: '画图工坊',
  version: '0.7.1',
  description: '结构化画图：四类图型差异化渲染（形状/颜色/自动布局），插件页画布手绘（撤销重做/样式面板/PNG 导出）+ agent 对话直操作画图 API，图真源存知识库文档（diagram-json 方言），节点可挂链知识文档、图可确定性出题入库（零 LLM）、可默画复习（主动回忆，SM-2 随文档调度），可导出 mermaid',

  // 供单测的纯函数面
  KINDS,
  sanitizeFileName,
  isDiagramDocPath,
  parseDiagramDoc,
  diagramFenceOf,
  buildDiagramDoc,
  matchDiagramDoc,
  generatedDocPath,
  importTargetPath,
  buildGenerateSystemPrompt,
  extractNodeDecorations,
  topologicalOrder: diagramQuestions.topologicalOrder,
  makeDiagramQuestions: diagramQuestions.makeDiagramQuestions,
  blanksFor: diagramRecall.blanksFor,
  gradeRecall: diagramRecall.gradeRecall,
  qualityOf: diagramRecall.qualityOf,

  // nav.entry 页数据入口与页方法（plugin:invoke 通道；模块级 context）
  pageDiagrams,
  openDiagram,
  createDiagram,
  saveDiagram,
  diagramLayout,
  diagramMermaid,
  importMermaid,
  makeQuestionsFromDiagram,
  startRecall,
  checkRecall,

  // 工具直调面（与 baize 同款形态）：E2E 探针/桥接消费
  async executeTool(name, args) {
    const executors = { operate_diagram: runOperate, generate_diagram: runGenerate }
    const fn = executors[name]
    if (!fn) return { error: 'UNKNOWN_TOOL', output: `未知工具「${String(name)}」。可用：operate_diagram/generate_diagram。` }
    return fn(args || {})
  },

  async activate(ctx) {
    context = ctx

      context.registerAgentTool(
      {
        name: 'operate_diagram',
        description:
          '画图工坊画图 API：对结构化图做细粒度操作（建图/查结构/加节点/改节点/删节点/连线/删边/导出 mermaid/把文档里的 mermaid 块转成画布图/从图确定性出题/发起默画复习/校验），节点支持形状颜色装饰（shape/color）与挂链知识文档（docRef），边支持虚线（dashed）。用户在对话里描述要画的图（如「画个部署图：前端→网关→后端→数据库」）时，拆解为多次调用：先 op=create 建图，再逐个 add_node/add_edge；改图诉求（「把节点 X 改成 Y」「删掉那条边」）对应 update_node/remove_node/remove_edge；用户说「把这篇文档里的图转成画布图/在画图工坊打开」时用 op=import_mermaid；用户说「用这张图出题/拿图练习」时用 op=make_questions（本地确定性变换生成排序/填空题并入库进复习闭环，零模型调用；图太小/有环/节点重名时回执会明示不可出原因）；用户说「默画这张图/我想凭记忆补全这张图/复习一下这张图」时用 op=start_recall 发起默画（画布按连接度挖空部分节点，用户凭记忆填写，交卷后判分与 SM-2 复习调度自动回流承载文档；回执只报挖空规模，不泄露答案）。图落盘为知识库文档，用户可在画图工坊页继续手画。',
        parameters: {
          type: 'object',
          properties: {
            op: { type: 'string', description: '操作：list/create/get/add_node/update_node/remove_node/add_edge/remove_edge/export_mermaid/import_mermaid/make_questions/start_recall/validate' },
            title: { type: 'string', description: 'create：图名称；其余 op 可用图名称或路径定位图' },
            path: { type: 'string', description: '目标图文档路径（或用 title 定位）；import_mermaid 时为源文档路径' },
            source: { type: 'string', description: 'import_mermaid：源文档路径或文档标题关键词（含 mermaid 块的 .md 文档）' },
            block: { type: 'string', description: 'import_mermaid 可选：导入第几块（1 起，多块文档建议指定）；单块文档可省略' },
            label: { type: 'string', description: 'add_node：节点文字' },
            id: { type: 'string', description: '节点 id（add_node 可省略自动分配；update_node/remove_node 必填）' },
            shape: { type: 'string', description: 'add_node/update_node 可选：节点形状 rect/round/diamond/circle（update 传 rect 清除形状）' },
            color: { type: 'string', description: 'add_node/update_node 可选：节点颜色 hex 或 blue/green/orange/red/purple/cyan/gold/gray（清色传空串）' },
            docRef: { type: 'string', description: 'add_node/update_node 可选：节点挂链的知识库文档（仓库相对路径，如 docs/笔记.md）；空串清除挂链' },
            dashed: { type: 'boolean', description: 'add_edge 可选：true 为虚线边（异步/弱依赖/回应消息）' },
            from: { type: 'string', description: 'add_edge/remove_edge：起点节点 id' },
            to: { type: 'string', description: 'add_edge/remove_edge：终点节点 id' },
            json: { type: 'string', description: 'validate：待校验的图 JSON' },
          },
          required: ['op'],
        },
      },
      async (args) => {
        try {
          return await runOperate(args || {})
        } catch (err) {
          return { error: 'OPERATE_FAILED', output: `画图操作失败：${(err && err.message) || err}。可重试一次；持续失败请检查模型与仓库配置。` }
        }
      }
    )

    context.registerAgentTool(
      {
        name: 'generate_diagram',
        description:
          '把知识库文档整体生成一张结构化图（流程图/架构图/思维导图/协作图），LLM 读取文档产出节点与边，校验后落盘为可继续手画的画布图文档。用户说「把这篇画成架构图/思维导图」「根据这篇文档生成流程图」时使用；增量改图用 operate_diagram。',
        parameters: {
          type: 'object',
          properties: {
            document: { type: 'string', description: '文档标题（或标题关键词）' },
            kind: { type: 'string', description: '图类型：flowchart/architecture/mindmap/sequence，默认 flowchart' },
          },
          required: ['document'],
        },
      },
      async (args) => {
        try {
          return await runGenerate(args || {})
        } catch (err) {
          return { error: 'GENERATE_FAILED', output: `生成失败：${(err && err.message) || err}。可重试一次；持续失败请检查模型配置。` }
        }
      }
    )

    context.log('diagram-studio 已激活')
  },

  async deactivate() {
    if (context) {
      context.unregisterAgentTool('operate_diagram')
      context.unregisterAgentTool('generate_diagram')
    }
    context = null
  },
}

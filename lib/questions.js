// ============================================================
// diagram-studio - 图→题确定性出题纯函数（B3 T3.1，2026-10-16）
//
// 管什么：把结构化图（diagram-json）确定性变换成题库题——
//         排序题：连通节点的拓扑序列（Kahn，同层 id 字典序决胜；DAG 且连通节点 ≥4
//                 且 >10 明示不可出；环图/孤立节点边界显式披露）；
//         填空题：按节点度降序抠 label（度=入+出；同度 id 字典序 tie-break；无随机，
//                 守「同输入必同输出」红线）。
// 不管什么：题库写入（归 quiz-maker/questions 资产写门，index.js 消费）、判分与 SM-2
//          （core/knowledge/question-types 判分唯一权威 + quiz-maker 镜像，本文件零判分逻辑）。
// 被谁引用：plugins/diagram-studio/index.js（op=make_questions）；
//          tests/diagram-studio.test.js（纯函数单测）。
// 红线：零 LLM——本模块是纯确定性变换，任何输入不触模型调用（计划 §1.3 护栏②）。
// 质量门槛（§5「出垃圾题」风险应对）：结构阈值 + 判分可行性双闸，全部以结构化错误码
//       明示而非静默丢（同 mermaid 转换器纪律）。
// ============================================================

/** 排序题节点数下限（计划 T3.1：DAG 且节点 ≥4 才可出，过小明示） */
const MIN_ORDER_NODES = 4
/** 排序题节点数上限（>10 的全图排序不可作答——§5 垃圾题风险闸，明示跳过） */
const MAX_ORDER_NODES = 10
/** 填空题缺省张数（度最高的前 N 个节点） */
const DEFAULT_BLANK_COUNT = 2

/** label 内的判分破坏字符：fill_blank 判分对 answer 做 JSON.parse/分隔符兜底切分，
 *  含这些字符的 label 作填空答案必判错——候选直接排除（判分可行性闸） */
const LABEL_SEPARATOR_RE = /[,，、;；\n]/

/** 节点度（入+出）：只统计两端都在节点集内的边（stdlib 校验闸已拒悬空端点，此处兜底） */
function degreeMap(diagram) {
  const ids = new Set((diagram?.nodes || []).map((n) => n.id))
  const deg = new Map((diagram?.nodes || []).map((n) => [n.id, 0]))
  for (const e of diagram?.edges || []) {
    if (deg.has(e.from)) deg.set(e.from, deg.get(e.from) + 1)
    if (deg.has(e.to)) deg.set(e.to, deg.get(e.to) + 1)
  }
  return { deg, ids }
}

/** 确定性字典序比较（id tie-break 唯一口径：逐码元 < / >，与 locale 无关——跨环境同输出） */
function byId(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 拓扑排序（Kahn 算法，同层 id 字典序决胜）。
 * 只排连通节点（度 ≥1）；孤立节点无序约束，进排序题=位次判分不公平（用户任何位置都"对"）
 * ——显式排除并在回执披露，剩余连通节点不足 MIN_ORDER_NODES 时整题明示不可出。
 * @returns { ok:true, order:string[], excludedIds:string[] }
 *         | { ok:false, code:'DIAGRAM_TOO_SMALL'|'DIAGRAM_CYCLIC'|'ORDER_TOO_LARGE', message }
 */
function topologicalOrder(diagram) {
  const nodes = (diagram?.nodes || []).map((n) => ({ id: String(n?.id ?? ''), label: String(n?.label ?? '') }))
  const { deg, ids } = degreeMap(diagram)
  const connected = nodes.filter((n) => (deg.get(n.id) || 0) > 0)
  const excludedIds = nodes.filter((n) => (deg.get(n.id) || 0) === 0).map((n) => n.id)
  if (connected.length < MIN_ORDER_NODES) {
    return {
      ok: false,
      code: 'DIAGRAM_TOO_SMALL',
      message: `连通节点 ${connected.length} 个（要求 ≥${MIN_ORDER_NODES}；孤立节点不计入——无序约束的节点位次判分不公平）`,
    }
  }
  if (connected.length > MAX_ORDER_NODES) {
    return {
      ok: false,
      code: 'ORDER_TOO_LARGE',
      message: `连通节点 ${connected.length} 个（> ${MAX_ORDER_NODES} 的全图排序不可作答，明示跳过）`,
    }
  }
  const connIds = new Set(connected.map((n) => n.id))
  const inDeg = new Map(connected.map((n) => [n.id, 0]))
  const outs = new Map(connected.map((n) => [n.id, []]))
  for (const e of diagram?.edges || []) {
    if (connIds.has(e.from) && connIds.has(e.to)) {
      inDeg.set(e.to, inDeg.get(e.to) + 1)
      outs.get(e.from).push(e.to)
    }
  }
  // 就绪队列恒按 id 字典序出队（确定性：同一张图任何一次运行同一条序列）
  let ready = connected.map((n) => n.id).filter((id) => inDeg.get(id) === 0).sort(byId)
  const order = []
  while (ready.length > 0) {
    const id = ready.shift()
    order.push(id)
    const nextReady = []
    for (const to of outs.get(id) || []) {
      inDeg.set(to, inDeg.get(to) - 1)
      if (inDeg.get(to) === 0) nextReady.push(to)
    }
    if (nextReady.length > 0) {
      ready = [...ready, ...nextReady].sort(byId)
    }
  }
  if (order.length < connected.length) {
    return { ok: false, code: 'DIAGRAM_CYCLIC', message: `图含环（${connected.length - order.length} 个节点无法定序）——拓扑顺序不存在，排序题明示不可出` }
  }
  return { ok: true, order, excludedIds }
}

/** label 重复检测（排序/填空判分都按文本比对——重复 label 的位次与定位答案均不唯一） */
function duplicateLabelIds(diagram) {
  const byLabel = new Map()
  for (const n of diagram?.nodes || []) {
    const key = String(n?.label ?? '').trim()
    if (!key) continue
    byLabel.set(key, [...(byLabel.get(key) || []), String(n.id)])
  }
  return new Set([...byLabel.values()].filter((ids) => ids.length > 1).flat())
}

/**
 * 全量出题（图→题清单，纯确定性）：排序题（可出时 1 道）+ 填空题（度降序前 N）。
 * 题型字段与 quiz-maker/questions 写门 insertQuestion 对齐：
 *   ordering: options=正确序 labels（做题卡展示时打乱），answer=JSON 数组串（判分契约）；
 *   fill_blank: answer=label 原文（判分精确匹配）。
 * @param {object} diagram normalizeDiagramData 产物（nodes/edges）
 * @param {{blankCount?: number}} [opts]
 * @returns {{ ok:true, questions:Array, skipped:Array<{kind,code?,message}> , diagramMeta }}
 *          questions 恒按 [排序, 填空…] 序；每项含 kind/type/question/options?/answer/
 *          answerDisplay/gradingNote/cognitiveLevel（cognitiveLevel 归 index.js 按题型落标） */
function makeDiagramQuestions(diagram, opts) {
  const blankCount = Math.min(Math.max(Number(opts?.blankCount) || DEFAULT_BLANK_COUNT, 0), 5)
  const nodes = (diagram?.nodes || []).map((n) => ({ id: String(n?.id ?? ''), label: String(n?.label ?? '') }))
  const labelById = new Map(nodes.map((n) => [n.id, n.label]))
  const { deg } = degreeMap(diagram)
  const dupIds = duplicateLabelIds(diagram)
  const questions = []
  const skipped = []

  // ---- 排序题：拓扑序（环/过小/过大/重复 label 明示不可出）----
  const topo = topologicalOrder(diagram)
  if (topo.ok) {
    const dupInOrder = topo.order.filter((id) => dupIds.has(id))
    if (dupInOrder.length > 0) {
      skipped.push({ kind: 'ordering', code: 'AMBIGUOUS_LABELS', message: `重复 label（${dupInOrder.map((id) => labelById.get(id)).join('、')}）——位次判分不唯一，排序题明示不可出` })
    } else {
      const labels = topo.order.map((id) => labelById.get(id))
      questions.push({
        kind: 'ordering',
        type: 'ordering',
        question: '以下节点取自一张关系图，请按箭头方向（从源头到末端的先后顺序）排列：',
        options: labels, // 契约：options 即正确顺序（做题卡展示时打乱防送分）
        answer: JSON.stringify(labels),
        answerDisplay: labels.join(' → '),
        gradingNote: '排序题按位次正确比例给部分分（0-5）',
      })
    }
  } else {
    skipped.push({ kind: 'ordering', code: topo.code, message: topo.message })
  }

  // ---- 填空题：度降序抠 label（同度 id 字典序 tie-break，无随机）----
  const candidates = nodes
    .filter((n) => (deg.get(n.id) || 0) > 0) // 度 0 的孤立节点无结构上下文，填空不可答
    .filter((n) => !LABEL_SEPARATOR_RE.test(n.label)) // 含分隔符的 label 作精确匹配答案必判错
    .filter((n) => !dupIds.has(n.id)) // 重复 label 的定位答案不唯一
    .sort((a, b) => ((deg.get(b.id) || 0) - (deg.get(a.id) || 0)) || byId(a.id, b.id))
  if (candidates.length < blankCount) {
    // 可答候选不足不硬凑（宁缺毋滥——§5 垃圾题闸）
    skipped.push({
      kind: 'blank',
      code: candidates.length === 0 ? 'NO_BLANK_CANDIDATE' : 'BLANK_CANDIDATE_SHORT',
      message: candidates.length === 0
        ? '没有结构上下文足够的填空候选（孤立节点/重复 label/含分隔符 label 均排除）'
        : `可答候选仅 ${candidates.length} 个（要求 ${blankCount}）——按实际候选出题`,
    })
  }
  const edgeList = diagram?.edges || []
  for (const c of candidates.slice(0, blankCount)) {
    const inEdges = edgeList.filter((e) => e.to === c.id)
    const outEdges = edgeList.filter((e) => e.from === c.id)
    const upstream = inEdges.map((e) => labelById.get(e.from))
    const downstream = outEdges.map((e) => labelById.get(e.to))
    const parts = []
    if (upstream.length > 0) parts.push(`图中「${upstream.join('」「')}」连向它`)
    if (downstream.length > 0) parts.push(`它连向「${downstream.join('」「')}」`)
    questions.push({
      kind: 'blank',
      type: 'fill_blank',
      question: `图结构填空：${parts.join('，')}。这个节点的名称是？`,
      answer: c.label,
      answerDisplay: c.label,
      gradingNote: '填空题精确匹配（去空白、大小写与全半角括号归一后比对）',
      context: { id: c.id, degree: deg.get(c.id) || 0, upstreamIds: inEdges.map((e) => e.from), downstreamIds: outEdges.map((e) => e.to) },
    })
  }
  return { ok: true, questions, skipped, diagramMeta: { nodeCount: nodes.length, edgeCount: edgeList.length } }
}

module.exports = {
  MIN_ORDER_NODES,
  MAX_ORDER_NODES,
  DEFAULT_BLANK_COUNT,
  LABEL_SEPARATOR_RE,
  degreeMap,
  topologicalOrder,
  duplicateLabelIds,
  makeDiagramQuestions,
}

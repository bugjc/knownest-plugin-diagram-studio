// ============================================================
// diagram-studio - 默画复习纯函数（B4 T4.1，2026-10-17）
//
// 管什么：把结构化图（diagram-json）确定性投影成「挖空默画」练习并判分——
//         挖空投影 blanksFor：按节点度降序挖 ratio（缺省 30%，≥1 个）；
//         逐点判分 gradeRecall：trim 后精确相等 + 「标记正确」人工改判（自评调分语义，
//         宁松勿冤——§5「挖空判分争议（同义 label 判错）」的既定应对）；
//         SM-2 质量映射 qualityOf：round(对/总 × 5)，确定性可解释。
// 不管什么：默画会话与判分回执（归 index.js startRecall/checkRecall 消费）、
//          作答落库与调度（渲染层经宿主 practice:recordAttempt 文档锚点即时轨——
//          D6：不入题库，SM-2 落 .diagram 文档）、画布挖空渲染（归内核 DiagramCanvas）。
// 被谁引用：plugins/diagram-studio/index.js（startRecall/checkRecall/op=start_recall）；
//          tests/diagram-studio.test.js（投影确定性/判分口径/改判/降级单测）。
// 红线：零 LLM——本模块是纯确定性变换，任何输入不触模型调用（计划 §1.3 护栏②）；
//       同输入必同输出（度降序 + id 字典序 tie-break，无随机，与 lib/questions 同口径）。
// ============================================================

const { degreeMap } = require('./questions')

/** 缺省挖空比例（计划 T4.1：默认按节点度降序挖 30%） */
const DEFAULT_RATIO = 0.3

/** 挖空数下限（≥1 个——再小的图也至少挖一处，否则会话无意义） */
const MIN_BLANKS = 1

/** 合法挖空策略：degree=按节点度降序（缺省）；id=按 id 字典序（最朴素的确定性备选） */
const RECALL_STRATEGIES = ['degree', 'id']

/** 确定性字典序比较（id tie-break 唯一口径：逐码元 < / >，与 locale 无关——跨环境同输出；
 *  与 lib/questions byId 同式，本模块自持一份保持零耦合） */
function byId(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 挖空投影（图 → 默画会话挖空集，纯确定性）。
 * 候选=有非空 label 的节点（label 为空的节点无从回忆，显式披露跳过；不设重复 label 排除——
 * 默画逐点对照本节点 label 判分，重复 label 不产生歧义，比题库出题宽松是即时轨的定位差异）。
 * @param {object} diagram normalizeDiagramData 产物（nodes/edges）
 * @param {{ratio?: number, strategy?: 'degree'|'id'}} [opts]
 * @returns {{ ok:true, blanks:Array<{id,label,degree}>, blankCount:number, totalNodes:number,
 *            ratio:number, strategy:string, skipped:Array<{id,reason}> }}
 *          | { ok:false, code:'DIAGRAM_EMPTY'|'NO_BLANK_CANDIDATE'|'RECALL_STRATEGY_UNKNOWN', message }
 */
function blanksFor(diagram, opts) {
  const nodes = (diagram?.nodes || []).map((n) => ({ id: String(n?.id ?? ''), label: String(n?.label ?? '') }))
  if (nodes.length === 0) {
    return { ok: false, code: 'DIAGRAM_EMPTY', message: '图为空（0 节点）——先在画布上搭结构再默画' }
  }
  const strategy = opts?.strategy === undefined || opts?.strategy === null || opts?.strategy === ''
    ? 'degree'
    : String(opts.strategy)
  if (!RECALL_STRATEGIES.includes(strategy)) {
    return { ok: false, code: 'RECALL_STRATEGY_UNKNOWN', message: `挖空策略「${strategy}」不支持。可用：${RECALL_STRATEGIES.join('/')}` }
  }
  const rawRatio = Number(opts?.ratio)
  const ratio = Number.isFinite(rawRatio) && rawRatio > 0 && rawRatio <= 1 ? rawRatio : DEFAULT_RATIO
  const { deg } = degreeMap(diagram)
  const candidates = nodes.filter((n) => n.label.trim() !== '')
  const skipped = nodes
    .filter((n) => n.label.trim() === '')
    .map((n) => ({ id: n.id, reason: 'label 为空，无从回忆' }))
  if (candidates.length === 0) {
    return { ok: false, code: 'NO_BLANK_CANDIDATE', message: '所有节点 label 均为空，无可挖空项' }
  }
  // ratio → 张数：≥1 保底、不超候选数；round 而非 floor（3 节点 × 0.3 = 0.9 → 1，不会归零）
  const blankCount = Math.min(candidates.length, Math.max(MIN_BLANKS, Math.round(candidates.length * ratio)))
  const sorted = strategy === 'id'
    ? [...candidates].sort((a, b) => byId(a.id, b.id))
    : [...candidates].sort((a, b) => ((deg.get(b.id) || 0) - (deg.get(a.id) || 0)) || byId(a.id, b.id))
  const blanks = sorted.slice(0, blankCount).map((n) => ({ id: n.id, label: n.label, degree: deg.get(n.id) || 0 }))
  return { ok: true, blanks, blankCount, totalNodes: nodes.length, ratio, strategy, skipped }
}

/**
 * 默画判分（逐点，纯确定性）：口径=trim 后精确相等（计划 T4.2 原文口径；同义 label 判错的
 * 争议由「标记正确」人工改判兜底，宁松勿冤）。
 * @param {Array<{id,label}>} blanks blanksFor 产出的挖空集
 * @param {Record<string,string>} answers nodeId → 用户作答
 * @param {Record<string,boolean>} [overrides] 人工改判：{ [nodeId]: true } 强制判对
 * @returns {{ verdicts:Array<{id,correct,expected,response,regraded}>, correctCount:number,
 *            total:number, quality:number }}
 */
function gradeRecall(blanks, answers, overrides) {
  const list = Array.isArray(blanks) ? blanks : []
  const ans = answers && typeof answers === 'object' ? answers : {}
  const ov = overrides && typeof overrides === 'object' ? overrides : {}
  const verdicts = list.map((b) => {
    const id = String(b?.id ?? '')
    // 归一化比对：存量图 label 可能带 mermaid 转义（`1\.`），用户作答的是可见形态（`1.`）——
    // 白名单解包后比对（与 diagram-core unescapeMermaidLabel 同口径），否则含编号节点必判错
    const unesc = (v) => String(v ?? '').replace(/\\([.,:;()\[\]{}#"])/g, '$1').trim()
    const expected = String(b?.label ?? '')
    const response = String(ans[id] ?? '')
    const literal = unesc(response) === unesc(expected)
    const forced = ov[id] === true
    return {
      id,
      correct: literal || forced,
      expected,
      response,
      // 改判标记：本点原本判错、经人工标记转对（判分回执可解释性的依据）
      regraded: forced && !literal,
    }
  })
  const total = verdicts.length
  const correctCount = verdicts.filter((v) => v.correct).length
  return { verdicts, correctCount, total, quality: qualityOf(correctCount, total) }
}

/**
 * SM-2 质量映射（确定性可解释）：round(对/总 × 5)——全对 5、全错 0、部分对按比例取整。
 * 空集防御返回 0（不会出现在真实会话里：blanksFor 保底 ≥1）。
 */
function qualityOf(correctCount, total) {
  if (!total || total <= 0) return 0
  return Math.round((correctCount / total) * 5)
}

module.exports = {
  DEFAULT_RATIO,
  MIN_BLANKS,
  RECALL_STRATEGIES,
  degreeMap,
  blanksFor,
  gradeRecall,
  qualityOf,
}

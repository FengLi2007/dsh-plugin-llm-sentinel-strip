/**
 * 冒烟测试：不连模型、不开 dsh，纯本地喂分片。
 *
 * 跑法：node smoke.mjs
 * 任何一条断言失败就非 0 退出，方便在改完插件后立刻自查。
 *
 * 注意：所有 DSML 样本都在运行时用 ｜ 拼出来，不在源码里写「全角竖线 + DSML」
 * 的字面量 —— 那种字面量经过上游 tokenizer 会被换成占位符，测试会假失败。
 */

import assert from 'node:assert/strict'
import { apply, decideContinue, sanitizeText, SentinelFilter } from './index.js'

/** 全角竖线 U+FF5C。 */
const BAR = '｜'
/** 控制令牌里的方言名，拆开写避免被当成特殊 token。 */
const WORD = 'DSML'

/** `<｜｜DSML｜｜ name>`。 */
const openTag = (attrs) => `<${BAR}${WORD}${BAR} ${attrs}>`
/** `</｜｜DSML｜｜ name>`。 */
const closeTag = (name) => `</${BAR}${WORD}${BAR} ${name}>`
/** 带参数的完整标签。 */
const paramTag = (name, value) => `${openTag(`parameter name="${name}" string="true"`)}${value}${closeTag('parameter')}`

/** 真实会话里出现过的最短形态（ASCII 竖线）。 */
const SAFETY = '|<ds_safety>[用户未成年]否\n[分类]其他\n[判定]纯技术问题。\n[规则]无</ds_safety>|>'

/** 实测泄漏的 DSML 形态：单根全角竖线 + 空格。 */
const DSML = [
  openTag('calls'),
  openTag('invoke name="pwsh"'),
  paramTag('command', 'Select-String -Path user\\src\\*.c'),
  paramTag('description', '找调用点'),
  closeTag('invoke'),
  closeTag('calls'),
].join('\n')

/** 续跑定时器缩短到固定 20ms，测试不用等 1~2 秒。 */
process.env.DSH_SENTINEL_CONTINUE_DELAY_MS = '20'

const cases = []

function test(label, fn) {
  cases.push({ label, fn })
}

/** 用假 ctx 抓住两个监听器。apply 需要 effect/on/agents/logger。 */
function harness() {
  const listeners = new Map()
  const calls = []
  apply({
    on: (event, fn) => listeners.set(event, fn),
    effect: (fn) => {
      fn()
    },
    agents: { get: () => ({ followup: (message) => calls.push(message) }) },
    logger: { info() {}, warn() {}, error() {} },
  })
  assert.equal(typeof listeners.get('llm/stream'), 'function', 'apply 应当注册 llm/stream')
  assert.equal(typeof listeners.get('session/event'), 'function', 'apply 应当注册 session/event')
  listeners.calls = calls
  return listeners
}

/** 把一段文本切成每片 size 个字符，模拟 token 流。 */
function* deltas(text, size, type = 'reasoning-delta') {
  for (let i = 0; i < text.length; i += size) yield { type, index: 0, text: text.slice(i, i + size) }
}

/** 跑完整条链路，返回拼起来的指定通道文本。 */
async function run(text, { size = 999, provider = 'aliyun', type = 'reasoning-delta' } = {}) {
  const listeners = harness()
  const stream = listeners.get('llm/stream')({ provider, model: 'deepseek-v4.1-flash' }, () => deltas(text, size, type))
  let out = ''
  for await (const chunk of stream) if (chunk.type === type) out += chunk.text
  return out
}

test('普通文本原样通过（含 markdown 表格竖线）', async () => {
  const text = '| 轮次 | 改动 |\n|---|---|\n| 12 | A_DECEL 1.31 |\n'
  assert.equal(await run(text), text)
  assert.equal(await run(text, { size: 1 }), text)
})

test('ds_safety 整块删掉，前后正文保留', async () => {
  const text = 'let me redo the call.\n</calls> ' + SAFETY + 'Since the previous message was malformed, re-read it.'
  // 裸 XML 标签（`</calls>`）也在剥离范围内，属于同一族的残留
  const want = 'let me redo the call.\n Since the previous message was malformed, re-read it.'
  assert.equal(await run(text), want)
})

test('DSML 工具调用块整段删掉', async () => {
  const text = '先看一眼现状。\n\n' + DSML + '\n\n现在写补丁。'
  const want = '先看一眼现状。\n\n\n\n现在写补丁。'
  assert.equal(await run(text), want)
})

test('DSML 逐字符分片与整段结果一致', async () => {
  const text = '前' + DSML + '后'
  const whole = await run(text)
  const split = await run(text, { size: 1 })
  assert.equal(split, whole)
  assert.equal(whole, '前后')
})

test('落单的 DSML 标签只删自己，周围的字不动', async () => {
  assert.equal(sanitizeText(`前${closeTag('invoke')}后`), '前后')
  assert.equal(sanitizeText(`前${openTag('parameter name="x"')}后`), '前后')
})

test('多根竖线与 ASCII 竖线写法也认', async () => {
  const two = `${BAR}${BAR}${WORD}${BAR}${BAR}`
  assert.equal(sanitizeText(`前<${two} calls>后`), '前后')
  const ascii = `|${WORD}|`
  assert.equal(sanitizeText(`前<${ascii} invoke name="x">后`), '前后')
})

test('正文里的普通尖括号不被误伤', async () => {
  const text = 'if (a < b && c > d) { 用 <stdio.h> 里的 printf }'
  assert.equal(await run(text), text)
  assert.equal(await run(text, { size: 1 }), text)
})

test('|tool_request|> 标记本身被删掉', async () => {
  assert.equal(sanitizeText('前|tool_request|>{"path":"x"}后'), '前{"path":"x"}后')
})

test('没闭合的令牌：丢开标签、保留正文', async () => {
  assert.equal(sanitizeText('前|<ds_safety>[分类]其他 后'), '前[分类]其他 后')
})

test('开标签写坏的畸形块整段删掉（真实会话形态）', async () => {
  const text = '前<parameter name="x">y</parameter></ invoke>\n</ calls> [用户未成年]否\n[分类]其他\n<规则>无</ds_safety>|>后'
  // 裸 XML 标签与畸形安全块都在剥离范围内，只剩中间的 y 和标签之间的空白
  const want = '前y\n 后'
  assert.equal(sanitizeText(text), want)
  const filter = new SentinelFilter()
  let streamed = ''
  for (const char of text) streamed += filter.push(char)
  streamed += filter.flush()
  assert.equal(streamed, want)
})

test('落单的结束符只删它自己', async () => {
  assert.equal(sanitizeText('前</ds_safety>|>后'), '前后')
})

test('block-end 的完整块也要清洗（assembler 用它覆盖 delta）', async () => {
  const listeners = harness()
  const block = { type: 'reasoning', text: '前' + DSML + '后' }
  async function* source() {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    for (const chunk of deltas(block.text, 5)) yield chunk
    yield { type: 'block-end', index: 0, block }
    yield { type: 'finish', reason: 'stop' }
  }
  const stream = listeners.get('llm/stream')({ provider: 'aliyun', model: 'deepseek-v4.1-flash' }, source)
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  const end = chunks.find((chunk) => chunk.type === 'block-end')
  assert.equal(end.block.text, '前后')
})

test('非 aliyun 路由不碰内容', async () => {
  const text = 'a' + DSML + 'b'
  assert.equal(await run(text, { provider: 'deepseek-official' }), text)
})

test('流被取消时扣住的尾巴会补发，不丢字', async () => {
  const listeners = harness()
  async function* source() {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: '尾巴<' }
  }
  const stream = listeners.get('llm/stream')({ provider: 'aliyun', model: 'deepseek-v4.1-flash' }, source)
  let out = ''
  for await (const chunk of stream) if (chunk.type === 'reasoning-delta') out += chunk.text
  assert.equal(out, '尾巴<')
})

test('少了尖括号的 DSML 残片也删掉（真实会话形态）', async () => {
  const bare = `${BAR}${WORD}${BAR} invoke>`
  const text = `得马上确认。\n\n${bare}\n\n让我列出目录。`
  const want = '得马上确认。\n\n\n\n让我列出目录。'
  assert.equal(await run(text), want)
  assert.equal(await run(text, { size: 1 }), want)
})

test('收尾时半截的 DSML 标记当残渣丢掉', async () => {
  assert.equal(sanitizeText(`正文<${BAR}${WORD}${BAR} inv`), '正文')
})

test('其它特殊 token（如 begin_of_sentence）也删掉', async () => {
  // `▁` 是 tokenizer 的分词符 U+2581，运行时拼出来避免源码里出现特殊 token
  const bos = `<${BAR}begin${String.fromCharCode(0x2581)}of${String.fromCharCode(0x2581)}sentence${BAR}>`
  const text = `前${bos}后`
  assert.equal(await run(text), '前后')
  assert.equal(await run(text, { size: 1 }), '前后')
})

test('|compact]]> 上下文预算标记连同闭合标签一起删', async () => {
  const text = '前|compact]]></custom-content></budget:token_budget>{"path":"x"}后'
  assert.equal(await run(text), '前{"path":"x"}后')
})

test('|compact]]> 跨分片时与整段清洗一致', async () => {
  const text = '前|compact]]></custom-content></budget:token_budget>后'
  const whole = await run(text)
  const split = await run(text, { size: 5 })
  assert.equal(split, whole)
  assert.equal(whole, '前后')
})

test('丢了竖线的裸 </invoke> 也删掉', async () => {
  assert.equal(await run('前</invoke>后'), '前后')
  assert.equal(await run('<invoke name="x">y</invoke>', { size: 1 }), 'y')
})

test('block-end 才暴露的泄漏也会触发续跑', async () => {
  const listeners = harness()
  const unclosed = `前言<${BAR}${WORD}${BAR} calls>`
  async function* source() {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: unclosed } }
    yield { type: 'finish', reason: 'stop' }
  }
  const stream = listeners.get('llm/stream')({ provider: 'aliyun', model: 'x', sessionId: 'S' }, source)
  for await (const _ of stream) {
    // 消费完
  }
  listeners.get('session/event')({ id: 'S' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(listeners.calls.length, 1, '未闭合令牌在 block-end 被删，应当补一次「继续」')
})

test('辅助请求（purpose）不污染续跑状态', async () => {
  const listeners = harness()
  const unclosed = `前言<${BAR}${WORD}${BAR} calls>`
  async function* source() {
    yield { type: 'reasoning-delta', index: 0, text: unclosed }
  }
  const stream = listeners.get('llm/stream')({ provider: 'aliyun', model: 'x', sessionId: 'S', purpose: 'session-title' }, source)
  for await (const _ of stream) {
    // 消费完
  }
  listeners.get('session/event')({ id: 'S' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(listeners.calls.length, 0, '标题/压缩这类辅助请求不该触发续跑')
})

test('续跑判据：只有「完成 + 泄漏 + 零产出」才续', async () => {
  const leak = { leak: true, hadOutput: false }
  assert.equal(decideContinue({ kind: 'completed' }, leak).retry, true)
  assert.equal(decideContinue({ kind: 'completed' }, { leak: true, hadOutput: true }).retry, false)
  assert.equal(decideContinue({ kind: 'completed' }, { leak: false, hadOutput: false }).retry, false)
  assert.equal(decideContinue({ kind: 'aborted' }, leak).retry, false)
  assert.equal(decideContinue({ kind: 'error', error: { code: 'QUOTA' } }, leak).retry, false)
  assert.equal(decideContinue({ kind: 'completed' }, leak, 3, 3).retry, false)
})

let failed = 0
for (const { label, fn } of cases) {
  try {
    await fn()
    console.log('ok   ' + label)
  } catch (error) {
    failed++
    console.error('FAIL ' + label + '\n     ' + (error?.message ?? error))
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`)
process.exit(failed === 0 ? 0 : 1)
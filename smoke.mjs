/**
 * 冒烟测试：不连模型、不开 dsh，纯本地喂分片。
 *
 * 跑法：node smoke.mjs
 * 任何一条断言失败就非 0 退出，方便在改完插件后立刻自查。
 */

import assert from 'node:assert/strict'
import { apply, decideContinue, sanitizeText, SentinelFilter } from './index.js'

/** 真实会话里出现过的最短形态（ASCII 竖线）。 */
const SAFETY = '|<ds_safety>[用户未成年]否\n[分类]其他\n[判定]纯技术问题。\n[规则]无</ds_safety>|>'

/** 实测泄漏的 DSML 形态：单根全角竖线（U+FF5C）+ 空格。 */
const DSML = [
  '<｜｜DSML｜｜ calls>',
  '<｜｜DSML｜｜ invoke name="pwsh">',
  '<｜｜DSML｜｜ parameter name="command" string="true">Select-String -Path user\\src\\*.c</｜｜DSML｜｜ parameter>',
  '<｜｜DSML｜｜ parameter name="description" string="true">找调用点</｜｜DSML｜｜ parameter>',
  '</｜｜DSML｜｜ invoke>',
  '</｜｜DSML｜｜ calls>',
].join('\n')

const cases = []

function test(label, fn) {
  cases.push({ label, fn })
}

/** 用假 ctx 抓住两个监听器。apply 需要 effect/on/agents/logger。 */
function harness() {
  const listeners = new Map()
  apply({
    on: (event, fn) => listeners.set(event, fn),
    effect: (fn) => {
      fn()
    },
    agents: { get: () => undefined },
    logger: { info() {}, warn() {}, error() {} },
  })
  assert.equal(typeof listeners.get('llm/stream'), 'function', 'apply 应当注册 llm/stream')
  assert.equal(typeof listeners.get('session/event'), 'function', 'apply 应当注册 session/event')
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
  const want = 'let me redo the call.\n</calls> Since the previous message was malformed, re-read it.'
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
  assert.equal(sanitizeText('前</｜｜DSML｜｜ invoke>后'), '前后')
  assert.equal(sanitizeText('前<｜｜DSML｜｜ parameter name="x">后'), '前后')
})

test('双竖线与 ASCII 竖线写法也认', async () => {
  assert.equal(sanitizeText('前<｜｜｜DSML｜｜｜ calls>后'), '前后')
  assert.equal(sanitizeText('前<｜DSML｜ invoke name="x">后'), '前后')
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
  const want = '前<parameter name="x">y</parameter></ invoke>\n</ calls> 后'
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
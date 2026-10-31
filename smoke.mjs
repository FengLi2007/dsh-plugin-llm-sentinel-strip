/**
 * 冒烟测试：不连模型、不开 dsh，纯本地喂分片。
 *
 * 跑法：node smoke.mjs
 * 任何一条断言失败就非 0 退出，方便在改完插件后立刻自查。
 */

import assert from 'node:assert/strict'
import { apply, sanitizeText, SentinelFilter } from './index.js'

/** 抓一个真实 session 里出现过的最短形态，用来做样本。 */
const SAFETY = '|<ds_safety>[用户未成年]否\n[分类]其他\n[判定]纯技术问题。\n[规则]无</ds_safety>|>'

const cases = []

function test(label, fn) {
  cases.push({ label, fn })
}

/** 用假 ctx 抓住 waterfall 监听器。 */
function harness() {
  let listener
  apply({ on: (_event, fn) => { listener = fn } })
  assert.equal(typeof listener, 'function', 'apply 应当注册 llm/stream 监听器')
  return listener
}

/** 把一段文本切成每片 size 个字符，模拟 token 流。 */
function* deltas(text, size) {
  for (let i = 0; i < text.length; i += size) yield { type: 'reasoning-delta', index: 0, text: text.slice(i, i + size) }
}

/** 跑完整条链路，返回拼起来的 reasoning 文本。 */
async function run(text, { size = 999, provider = 'aliyun' } = {}) {
  const listener = harness()
  const stream = listener({ provider, model: 'deepseek-v4.1-flash' }, () => deltas(text, size))
  let out = ''
  for await (const chunk of stream) if (chunk.type === 'reasoning-delta') out += chunk.text
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

test('逐字符分片与整段分片结果一致', async () => {
  const text = 'a' + SAFETY + 'b|tool_request|>{"path":"x"}c'
  const whole = await run(text)
  const split = await run(text, { size: 1 })
  assert.equal(split, whole)
  // 只删标记本身：`|tool_request|>` 后面那段是没执行过的幽灵调用，当普通正文留着，
  // 盲删 JSON 会伤到真正的工具参数
  assert.equal(whole, 'ab{"path":"x"}c')
})

test('|tool_request|> 标记本身被删掉', async () => {
  assert.equal(sanitizeText('前|tool_request|>{"path":"x"}后'), '前{"path":"x"}后')
})

test('没闭合的令牌：丢开标签、保留正文', async () => {
  assert.equal(sanitizeText('前|<ds_safety>[分类]其他 后'), '前[分类]其他 后')
})

test('开标签写坏的畸形块整段删掉（真实 turn32/step2 形态）', async () => {
  const text = '前<parameter name="x">y</parameter></ invoke>\n</ calls> [用户未成年]否\n[分类]其他\n<规则>无</ds_safety>|>后'
  const want = '前<parameter name="x">y</parameter></ invoke>\n</ calls> 后'
  assert.equal(sanitizeText(text), want)
  // 逐字符分片也要得到同一结果
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
  const listener = harness()
  const block = { type: 'reasoning', text: '前' + SAFETY + '后' }
  async function* source() {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: '前' }
    yield { type: 'reasoning-delta', index: 0, text: SAFETY }
    yield { type: 'reasoning-delta', index: 0, text: '后' }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'finish', reason: 'stop' }
  }
  const stream = listener({ provider: 'aliyun', model: 'deepseek-v4.1-flash' }, source)
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  const end = chunks.find((chunk) => chunk.type === 'block-end')
  assert.equal(end.block.text, '前后')
})

test('非 aliyun 路由不碰内容', async () => {
  const text = 'a' + SAFETY + 'b'
  assert.equal(await run(text, { provider: 'deepseek-official' }), text)
})

test('流被取消时扣住的尾巴会补发，不丢字', async () => {
  const listener = harness()
  async function* source() {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: '尾巴|' }
  }
  const stream = listener({ provider: 'aliyun', model: 'deepseek-v4.1-flash' }, source)
  let out = ''
  for await (const chunk of stream) if (chunk.type === 'reasoning-delta') out += chunk.text
  assert.equal(out, '尾巴|')
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
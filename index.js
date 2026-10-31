/**
 * llm-sentinel-strip —— 剥掉模型内部控制令牌，别让它们进会话历史；空回合自动补「继续」。
 *
 * 现象（2026-10-31 实测）：
 * 百炼的 anthropic-messages 路由上，DeepSeek-V4.1-Flash 会把**工具调用写成 DSML 文本**，
 * 形如
 *
 *     <｜｜DSML｜｜ calls>
 *     <｜｜DSML｜ invoke name="pwsh">
 *     <｜｜DSML｜ parameter name="command" string="true">Select-String …</｜ parameter>
 *     </｜ invoke>
 *     </｜ calls>
 *
 * 官方适配器认得这套方言并转成真调用；pi-ai 的 anthropic 适配器不认，于是它原样留在
 * reasoning 里，模型等不到工具结果就把同一段重写一遍 —— 实测单步思考 37,655 字符、
 * 同一行重复 167 次、整轮零产出。同一路由还会漏 `|<ds_safety>…</ds_safety>|>` 这类
 * 审查标记。官方 deepseek-official 路由 331 条消息 0 个 DSML、375 次调用 0 丢失。
 *
 * 两件事分开做：
 *   ① 剥离：DSML 标记 + 安全/工具标记，text 与 reasoning 两条通道都清；
 *   ② 续跑：只在「这一轮确实什么都没产出」且是上游抖动时，补一条「继续」。
 *
 * 为什么必须挂在 `llm/stream` waterfall 上：agent loop 是拿到分片之后才写 session log
 * 的，所以在这里改过的分片才会成为历史；改 UI 或改回放都不算数。
 *
 * 为什么 delta 和 block-end 都要改：`BlockAssembler` 收到 block-end 时用 `chunk.block`
 * 覆盖掉逐片累加的结果（dsh-llm/lib/index.js 的 `case "block-end"`），只改 delta 的话
 * 完整内容里照样带着令牌，下一轮又被喂回上游。
 *
 * 竖线写法实测：单根全角竖线 `｜`（U+FF5C）为主，也见过双根和 ASCII `|`，
 * 三种都认；不认就会像 @goodandready 那个插件一样对着真实流量一个字都不动。
 *
 * 不在范围内：`|compact]]></custom-content></budget:token_budget>` 这类不带标签结构的
 * 泄漏（实测只有 2 处），以及工具参数 JSON 里的令牌。
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'llm-sentinel-strip'

/** 续跑需要向会话里投递消息，所以要等 agents 服务就绪。 */
export const inject = ['agents', 'llm']

/** 只有这些 provider 路由会被清洗/续跑；逗号分隔，`*` 表示全部。 */
const DEFAULT_PROVIDERS = 'aliyun'

// ── 安全 / 工具标记（竖线写法：ASCII）─────────────────────────────────────
const TOOL_REQUEST = '|tool_request|>'
const ALT_OPEN = '[用户未成年]'
const ALT_CLOSE = '</ds_safety>|>'
const OPEN_RE = /\|<[a-z_]{1,20}>/
const CLOSE_RE = /<\/([a-z_]{1,20})>\|>/

// ── DSML 标记（竖线写法：全角 ｜ / ASCII |，根数不定）──────────────────────
// 实测见到单根、也见到过连着的三根（模型把分隔符写重复了），所以不假设 1~2 根。
const DSML_BARS = '(?:[\\uFF5C]+|\\|+)'
const DSML_NAMES = 'tool_calls|tool-calls|toolcalls|invoke|parameter|calls|tool'
/** 只有这几种参与「块」的深度配对；parameter 在块内部，不改变深度。 */
const DSML_DEPTH_NAMES = new Set(['tool_calls', 'tool-calls', 'toolcalls', 'invoke', 'calls'])
const DSML_TAG_SOURCE = `<\\s*(/)?\\s*${DSML_BARS}\\s*DSML\\s*${DSML_BARS}\\s*(${DSML_NAMES})\\b[^>]*>`
const DSML_TAG_AT = new RegExp(DSML_TAG_SOURCE, 'iy')
const DSML_START = new RegExp(`<\\s*/?\\s*${DSML_BARS}\\s*DSML`, 'i')
/**
 * 少了 `<` 的残片：模型把开头截掉，只剩 `｜DSML｜ invoke>` 这种。
 * 实测来源（会话 7bfd12c0）：一行里只有 `｜DSML｜ invoke>`，前面既没有 `<` 也没有 `/`，
 * 但它照样会被模型当成「上一段没闭合」的证据，必须一并删掉。
 */
const DSML_BARE_SOURCE = `${DSML_BARS}\\s*DSML\\s*${DSML_BARS}\\s*(${DSML_NAMES})\\s*>`
const DSML_BARE = new RegExp(DSML_BARE_SOURCE, 'i')
/**
 * 兜底：任何 `<｜…｜>` 形状的特殊 token，不限于 DSML 的名字清单。
 *
 * 实测来源（会话 31ea8e33）：模型在正文中间吐出 `<｜begin▁of▁sentence｜>` —— 这是
 * tokenizer 的 BOS/EOS 标记，不是工具调用，但同样会被下一拍当成「没闭合」的证据。
 * 名字清单永远追不上 tokenizer 的词表，所以再加一条形状规则。
 */
const SPECIAL_SOURCE = `<\\s*(?:[\\uFF5C]{1,4}|\\|{1,4})[^<>\\uFF5C|]{1,40}(?:[\\uFF5C]{1,4}|\\|{1,4})[^<>]{0,40}>`
const SPECIAL_TOKEN = new RegExp(SPECIAL_SOURCE, 'i')

/** `|compact]]>` 这一族上下文预算标记（实测 2 处），连同它的两个闭合标签一起删。 */
const COMPACT_SOURCE = '\\|compact\\]\\]>(?:</custom-content></budget:token_budget>)?'
const COMPACT_TOKEN = new RegExp(COMPACT_SOURCE, 'i')

/** 扣住末尾多少个字符，等一个可能还没拼完的令牌（DSML 带属性可能超过 40）。 */
const HOLD_MAX = 160

/** 一个令牌块最多允许多长。超过就当它没闭合、只丢开标签。 */
const SENTINEL_MAX = 4000

/** 续跑默认值。 */
const CONTINUE_TEXT = '继续'
const MAX_CONSECUTIVE = 3
const PLUGIN_SOURCE_KIND = 'plugin:llm-sentinel-strip'

/**
 * 当前请求要不要处理。
 *
 * @param options - 这次 `llm.stream()` 的 GenerateOptions。
 * @returns 是否处理这条请求。
 */
function providerAllowed(options) {
  const raw = process.env.DSH_SENTINEL_STRIP_PROVIDERS ?? DEFAULT_PROVIDERS
  const list = raw.split(',').map((part) => part.trim()).filter(Boolean)
  if (list.includes('*')) return true
  const provider = options?.provider
  return typeof provider === 'string' && list.includes(provider)
}

/** 在 `from` 处尝试解析一颗完整的 DSML 标签。 */
function dsmlTagAt(text, from) {
  DSML_TAG_AT.lastIndex = from
  return DSML_TAG_AT.exec(text)
}

/** 从 `from` 起找「少了 `<` 的 DSML 残片」；落在完整标签内部的匹配要跳过。 */
function findBareAt(text, from = 0) {
  let cursor = from
  for (;;) {
    const rel = text.slice(cursor).search(DSML_BARE)
    if (rel < 0) return -1
    const at = cursor + rel
    if (at === 0 || text[at - 1] !== '<') return at
    cursor = at + 1
  }
}

/** 从 opener 起点向后找配对的块尾；找不到返回 -1。 */
function findDsmlBlockEnd(text, start) {
  const walk = new RegExp(DSML_TAG_SOURCE, 'gi')
  walk.lastIndex = start
  let depth = 0
  let match
  while ((match = walk.exec(text)) !== null) {
    const tagName = match[2].toLowerCase()
    if (!DSML_DEPTH_NAMES.has(tagName)) continue
    depth += match[1] === '/' ? -1 : 1
    if (depth === 0) return match.index + match[0].length
  }
  return -1
}

/**
 * 找出末尾必须扣住、暂不输出的起点。
 *
 * 分片按 token 切，一个令牌可能横跨好几个 delta；逐片直接输出会让屏幕上闪过半截
 * `<｜DSM`。只检查最后 HOLD_MAX 个字符，且只认以 `|`、`<`、`[` 开头的候选前缀。
 *
 * @param text - 当前待处理文本。
 * @returns 可以安全输出的长度。
 */
function holdBackStart(text) {
  const limit = Math.min(text.length, HOLD_MAX)
  for (let k = limit; k >= 1; k--) {
    const suffix = text.slice(text.length - k)
    const head = suffix[0]

    if (head === '|') {
      if (TOOL_REQUEST.startsWith(suffix)) return text.length - k
      if ('|compact]]>'.startsWith(suffix)) return text.length - k
      if (/^\|(<[a-z_]{0,19})?$/.test(suffix)) return text.length - k
      // 少了尖括号的残片：`|DSML| invoke>` 还没写完
      if (!suffix.includes('>') && /^\|+D/i.test(suffix)) return text.length - k
      continue
    }
    if (head === '｜') {
      if (!suffix.includes('>') && (suffix.length <= 8 || /^｜+D/i.test(suffix))) return text.length - k
      continue
    }
    if (head === '[') {
      if (ALT_OPEN.startsWith(suffix)) return text.length - k
      continue
    }
    if (head !== '<') continue

    // DSML 半截：`<`、`</`、`<｜`、`<｜DSM`、`<｜｜DSML｜ parameter name="x"` …
    if (!suffix.includes('>')) {
      if (k <= 3) return text.length - k
      if (suffix.includes('｜') || suffix.includes('|')) return text.length - k
    }
    // 裸闭合符前缀：`</`、`</ds_safety>|` …
    if (/^<\/([a-z_]{0,19})?(>(\|(>)?)?)?$/.test(suffix)) return text.length - k
  }
  return text.length
}

/**
 * 逐块累积并剥离控制令牌的流式过滤器。
 *
 * 一个内容块一个实例：不同 index 的 delta 是交错的，共用缓冲会把两段文本拼到一起。
 */
export class SentinelFilter {
  /** 还没决定要不要输出的尾巴。 */
  #pending = ''

  /** 这个块是否出现过被剥掉的令牌（供续跑判据使用）。 */
  #leak = false

  /** @returns 是否剥掉过令牌。 */
  get leak() {
    return this.#leak
  }

  /**
   * 喂一段新文本进来。
   *
   * @param text - 新到的 delta 文本。
   * @returns 可以立即输出的干净文本（可能是空串）。
   */
  push(text) {
    if (!text) return ''
    this.#pending += text
    return this.#drain(false)
  }

  /**
   * 内容块结束（或流提前结束）时调用：把还扣着的尾巴无条件放出去。
   *
   * @returns 剩余的可输出文本。
   */
  flush() {
    return this.#drain(true)
  }

  /**
   * 把缓冲区里能确定的令牌全部剥掉。
   *
   * 候选按出现位置先后来处理：DSML 标签/块、`|<tag>…</tag>|>`、畸形安全块、
   * `|tool_request|>`、落单的 `</tag>|>`。
   *
   * @param done - true 表示不再等后续分片。
   * @returns 本轮可输出的文本。
   */
  #drain(done) {
    let out = ''
    let rest = this.#pending

    for (;;) {
      const dsmlAt = rest.search(DSML_START)
      const bareAt = findBareAt(rest)
      const openAt = rest.search(OPEN_RE)
      const altAt = rest.indexOf(ALT_OPEN)
      const toolAt = rest.indexOf(TOOL_REQUEST)
      const closeAt = rest.search(CLOSE_RE)
      const specialAt = rest.search(SPECIAL_TOKEN)
      const compactAt = rest.search(COMPACT_TOKEN)

      let at = -1
      let kind = ''
      for (const [candidateAt, candidateKind] of [
        [dsmlAt, 'dsml'],
        [bareAt, 'bare'],
        [openAt, 'open'],
        [altAt, 'alt'],
        [toolAt, 'tool'],
        [closeAt, 'close'],
        [specialAt, 'special'],
        [compactAt, 'compact'],
      ]) {
        if (candidateAt < 0) continue
        if (at < 0 || candidateAt < at) {
          at = candidateAt
          kind = candidateKind
        }
      }
      if (at < 0) break

      out += rest.slice(0, at)

      if (kind === 'dsml') {
        const tag = dsmlTagAt(rest, at)
        if (tag === null) {
          // 半截标签：扣住等下一片；收尾时还半截就当残渣丢掉
          if (!done) {
            this.#pending = rest.slice(at)
            return out
          }
          this.#leak = true
          // 收尾还是半截：有 `>` 就丢到它为止，没有就把剩下的当残渣
          const gt = rest.indexOf('>', at)
          rest = rest.slice(gt >= 0 ? gt + 1 : rest.length)
          continue
        }
        const closing = tag[1] === '/'
        const tagName = tag[2].toLowerCase()
        if (!closing && DSML_DEPTH_NAMES.has(tagName)) {
          const end = findDsmlBlockEnd(rest, at)
          if (end < 0) {
            if (!done) {
              this.#pending = rest.slice(at)
              return out
            }
            this.#leak = true
            rest = rest.slice(at + tag[0].length)
            continue
          }
          this.#leak = true
          rest = rest.slice(end)
          continue
        }
        // 单颗标签（parameter / 落单闭合符 / 光头标记）：只丢它自己
        this.#leak = true
        rest = rest.slice(at + tag[0].length)
        continue
      }

      if (kind === 'bare') {
        // 少了 `<` 的残片：整颗标签删掉
        const match = DSML_BARE.exec(rest.slice(at))
        this.#leak = true
        rest = rest.slice(at + match[0].length)
        continue
      }
      if (kind === 'special') {
        // `<｜…｜>` 形状的任何特殊 token（如 `<｜begin_of_sentence｜>`）
        const match = SPECIAL_TOKEN.exec(rest.slice(at))
        this.#leak = true
        rest = rest.slice(at + match[0].length)
        continue
      }
      if (kind === 'compact') {
        const match = COMPACT_TOKEN.exec(rest.slice(at))
        this.#leak = true
        rest = rest.slice(at + match[0].length)
        continue
      }
      if (kind === 'tool') {
        this.#leak = true
        rest = rest.slice(at + TOOL_REQUEST.length)
        continue
      }
      if (kind === 'close') {
        const match = CLOSE_RE.exec(rest.slice(at))
        this.#leak = true
        rest = rest.slice(at + match[0].length)
        continue
      }
      if (kind === 'alt') {
        const closerAt = rest.indexOf(ALT_CLOSE, at + ALT_OPEN.length)
        if (closerAt >= 0) {
          this.#leak = true
          rest = rest.slice(closerAt + ALT_CLOSE.length)
          continue
        }
        if (done || rest.length - at > SENTINEL_MAX) {
          this.#leak = true
          rest = rest.slice(at + ALT_OPEN.length)
          continue
        }
        this.#pending = rest.slice(at)
        return out
      }

      // kind === 'open'：`|<tag>…</tag>|>`
      const openEnd = rest.indexOf('>', at)
      const openTag = rest.slice(at + 2, openEnd)
      const closeTag = `</${openTag}>|>`
      const closerAt = rest.indexOf(closeTag, openEnd + 1)
      if (closerAt >= 0) {
        this.#leak = true
        rest = rest.slice(closerAt + closeTag.length)
        continue
      }
      if (done || rest.length - at > SENTINEL_MAX) {
        this.#leak = true
        rest = rest.slice(openEnd + 1)
        continue
      }
      this.#pending = rest.slice(at)
      return out
    }

    if (done) {
      this.#pending = ''
      return out + rest
    }
    const keep = holdBackStart(rest)
    this.#pending = rest.slice(keep)
    return out + rest.slice(0, keep)
  }
}

/**
 * 一次性清洗整段文本（用于 block-end 里的完整块与测试）。
 *
 * @param text - 完整的块文本。
 * @returns 剥掉令牌后的文本。
 */
export function sanitizeText(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  if (!text.includes('|') && !text.includes('｜') && !text.includes('[用户未成年]')) return text
  const filter = new SentinelFilter()
  return filter.push(text) + filter.flush()
}

/**
 * 这一轮该不该补一条「继续」。
 *
 * 只有「正常结束 + 漏过令牌 + 什么都没产出」才续；用户取消、额度/鉴权/上下文超限
 * 这类发继续也照样报错的一律不动。
 *
 * @param reason - `turn/end` 的 reason 对象。
 * @param state - 本轮累计：{ leak, hadOutput }。
 * @param limit - 连续续跑上限。
 * @param consecutive - 已经连续续跑过几次。
 * @returns {{ retry: boolean, why: string }}
 */
export function decideContinue(reason, state, limit = MAX_CONSECUTIVE, consecutive = 0) {
  const kind = reason?.kind
  if (kind === 'aborted' || kind === 'interrupted') {
    return { retry: false, why: '这一轮被取消/打断，不替用户续' }
  }
  if (kind !== 'completed') {
    return { retry: false, why: `turn/end 不是 completed（${kind ?? '未知'}）` }
  }
  if (state?.leak !== true) return { retry: false, why: '没漏令牌，正常结束' }
  if (state?.hadOutput === true) return { retry: false, why: '漏了令牌但这一轮有产出' }
  if (consecutive >= limit) return { retry: false, why: `连续续跑已达上限 ${limit}` }
  return { retry: true, why: 'DSML 把调用写进思考、这一轮零产出' }
}

/**
 * 内联构造一条插件来源的用户消息：v4 准入要求 source.kind 是生产者自己的，
 * 裸 `plugin` 会被拒（`format v4 message requires a producer-owned source kind`）。
 */
function createFollowupMessage(text) {
  return Object.freeze({
    role: 'user',
    id: globalThis.crypto.randomUUID(),
    content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze({ kind: PLUGIN_SOURCE_KIND }),
  })
}

/**
 * 包一层分片流：清洗 text / reasoning，并统计这一轮的产出与泄漏。
 *
 * @param stream - 下游适配器的分片流。
 * @param state - 本轮累计状态，清洗器会把 leak 写进去。
 * @returns 清洗后的分片流。
 */
function stripStream(stream, state) {
  return (async function* () {
    const filters = new Map()
    const blockTypes = new Map()

    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'block-start': {
          blockTypes.set(chunk.index, chunk.blockType)
          yield chunk
          break
        }
        case 'text-delta':
        case 'reasoning-delta': {
          let filter = filters.get(chunk.index)
          if (filter === undefined) {
            filter = new SentinelFilter()
            filters.set(chunk.index, filter)
          }
          const text = filter.push(chunk.text)
          if (filter.leak) state.leak = true
          if (chunk.type === 'text-delta' && /\S/.test(text)) state.hadOutput = true
          if (text === chunk.text) {
            yield chunk
            break
          }
          // 整片都被令牌吃掉时也要吐一个空片，否则下游看到的块顺序会断档
          yield { ...chunk, text }
          break
        }
        case 'tool-call-delta': {
          state.hadOutput = true
          yield chunk
          break
        }
        case 'block-end': {
          const filter = filters.get(chunk.index)
          if (filter?.leak) state.leak = true
          filters.delete(chunk.index)
          blockTypes.delete(chunk.index)
          const block = chunk.block
          if ((block?.type === 'text' || block?.type === 'reasoning') && typeof block.text === 'string') {
            const clean = sanitizeText(block.text)
            if (block.type === 'text' && /\S/.test(clean)) state.hadOutput = true
            if (clean !== block.text) {
              yield { ...chunk, block: { ...block, text: clean } }
              break
            }
          }
          yield chunk
          break
        }
        default:
          yield chunk
          break
      }
    }

    // 流没走到 block-end 就结束了（取消、报错）：把扣住的尾巴补上，别丢字
    for (const [index, filter] of filters) {
      if (filter.leak) state.leak = true
      const tail = filter.flush()
      if (tail === '') continue
      const blockType = blockTypes.get(index)
      yield blockType === 'reasoning'
        ? { type: 'reasoning-delta', index, text: tail }
        : { type: 'text-delta', index, text: tail }
    }
  })()
}

/**
 * 挂到 `llm/stream` 与 `session/event` 上。
 *
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  const sessions = new Map()

  const stateOf = (sessionId) => {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = { leak: false, hadOutput: false, consecutive: 0, timer: null }
      sessions.set(sessionId, state)
    }
    return state
  }

  const resetTurn = (state) => {
    state.leak = false
    state.hadOutput = false
  }

  ctx.effect(() =>
    ctx.on('llm/stream', (options, next) => {
      const stream = next()
      if (!providerAllowed(options)) return stream
      const sessionId = options?.sessionId
      if (sessionId === undefined) return stripStream(stream, { leak: false, hadOutput: false })
      return stripStream(stream, stateOf(sessionId))
    }),
  )

  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      const sessionId = session?.id ?? session?.sessionId
      if (sessionId === undefined) return
      const state = stateOf(sessionId)

      if (event.type === 'user/message') {
        if (event.data?.source?.kind === PLUGIN_SOURCE_KIND) return
        if (state.timer !== null) {
          clearTimeout(state.timer)
          state.timer = null
        }
        state.consecutive = 0
        return
      }

      if (event.type !== 'turn/end') return
      const verdict = decideContinue(event.data?.reason, state, MAX_CONSECUTIVE, state.consecutive)
      if (!verdict.retry) {
        if (event.data?.reason?.kind === 'completed') state.consecutive = 0
        resetTurn(state)
        return
      }

      state.consecutive += 1
      const attempt = state.consecutive
      const delay = 1000 + Math.floor(Math.random() * 1000)
      ctx.logger?.info?.(`llm-sentinel-strip: ${sessionId} 第 ${attempt}/${MAX_CONSECUTIVE} 次续跑（${verdict.why}）`)

      state.timer = setTimeout(() => {
        state.timer = null
        try {
          const agent = ctx.agents.get(sessionId)
          if (agent === undefined || agent === null) {
            ctx.logger?.warn?.(`llm-sentinel-strip: 会话 ${sessionId} 已无 agent，跳过续跑`)
            return
          }
          agent.followup(createFollowupMessage(CONTINUE_TEXT))
          resetTurn(state)
          ctx.logger?.info?.(`llm-sentinel-strip: 已向 ${sessionId} 补发「${CONTINUE_TEXT}」`)
        } catch (error) {
          ctx.logger?.error?.(`llm-sentinel-strip: 补发失败 ${String(error?.message ?? error)}`)
        }
      }, delay)
    }),
  )

  ctx.effect(() => () => {
    for (const state of sessions.values()) {
      if (state.timer !== null) clearTimeout(state.timer)
    }
    sessions.clear()
  })
}
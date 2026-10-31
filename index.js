/**
 * llm-sentinel-strip —— 剥掉模型内部控制令牌，别让它们进会话历史。
 *
 * 现象（2026-10-31 实测，见当天的百炼路由会话日志）：
 * 百炼的 anthropic-messages 路由会把 DeepSeek 的内部标记原样漏进可见的思考流，
 * 形如
 *
 *     </calls> |<ds_safety>[用户未成年]否
 *     [分类]其他
 *     [判定]…
 *     [规则]无</ds_safety>|>Since the previous message was malformed, …
 *
 * 同一条思考里还会漏出 `|tool_request|>{...}`。这些标记一旦被记录进历史，
 * 模型下一拍会把它当成「上一段没闭合」的分隔符，于是把同一段工具调用重写一遍
 * —— 单步思考滚到 97,269 字符、同句重复 167 次。官方 deepseek-official 路由
 * 331 条消息里一次都没漏过，只有百炼这条中招。
 *
 * 为什么必须挂在 `llm/stream` waterfall 上：agent loop 是在拿到分片之后才写
 * session log 的，所以在这里改过的分片才会成为历史；改 UI 或改回放都不算数。
 *
 * 为什么 delta 和 block-end 都要改：`BlockAssembler` 在收到 block-end 时用
 * `chunk.block` 覆盖掉逐片累加的结果（dsh-llm/lib/index.js:991），只改 delta
 * 的话完整内容里照样带着令牌。
 *
 * 实测命中率：真实 session 的 72 个思考块里有 22 个带令牌，共剥掉 50,523 字符；
 * 其中 1 个是模型把开标签写坏的畸形块（只剩 `[用户未成年]…</ds_safety>|>`），
 * 由 ALT_OPEN 那条规则兜住。
 *
 * 不在本插件范围内：`|compact]]></custom-content></budget:token_budget>` 这类
 * 不带 `|<tag>` 结构的泄漏（实测只有 2 处），以及工具参数里出现的令牌 ——
 * 后者是 JSON，盲删会破坏工具调用。
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'llm-sentinel-strip'

/** 只有这些 provider 路由会被清洗；逗号分隔，`*` 表示全部。 */
const DEFAULT_PROVIDERS = 'aliyun'

/** 自闭合的控制标记，出现在文本里就整段删掉。 */
const TOOL_REQUEST = '|tool_request|>'

/** 正常形态的开标签：`<tag>` 名字只允许小写字母和下划线。 */
const OPEN_RE = /\|<[a-z_]{1,20}>/

/**
 * 畸形形态的开标签：模型把 `|<ds_safety>` 写坏成 `</ invoke>` 之类，
 * 正文却还在，最后仍以 `</ds_safety>|>` 收尾。
 * 这一段审查正文固定以 `[用户未成年]` 开头（实测 526 段里 522 段如此）。
 */
const ALT_OPEN = '[用户未成年]'

/** 畸形形态的结束符。 */
const ALT_CLOSE = '</ds_safety>|>'

/** 单独出现的结束符（开标签已被吃掉或写坏），见到就丢掉它自己。 */
const CLOSE_RE = /<\/([a-z_]{1,20})>\|>/

/** 扣住末尾多少个字符，等一个可能还没拼完的令牌。 */
const HOLD_MAX = 40

/**
 * 一个令牌块最多允许多长。超过就当它没闭合、只丢掉开标签：
 * 否则一段没有 `</tag>|>` 的异常输出会让后面的正文一直卡在缓冲里不显示。
 */
const SENTINEL_MAX = 4000

/**
 * 当前请求要不要清洗。
 *
 * 默认只清 `aliyun`：官方路由从没漏过令牌，没必要动它；真要全量清洗，
 * 把 DSH_SENTINEL_STRIP_PROVIDERS 设成 `*`。
 *
 * @param options - 这次 `llm.stream()` 的 GenerateOptions。
 * @returns 是否清洗这条请求。
 */
function providerAllowed(options) {
  const raw = process.env.DSH_SENTINEL_STRIP_PROVIDERS ?? DEFAULT_PROVIDERS
  const list = raw.split(',').map((part) => part.trim()).filter(Boolean)
  if (list.includes('*')) return true
  const provider = options?.provider
  return typeof provider === 'string' && list.includes(provider)
}

/** 找到最早的 `|<tag>` 起点。 */
function findOpenAt(text) {
  return text.search(OPEN_RE)
}

/** 找到最早的 `</tag>|>` 起点。 */
function findCloseAt(text) {
  return text.search(CLOSE_RE)
}

/**
 * 找出末尾必须扣住、暂不输出的起点。
 *
 * 分片是按 token 切的，一个令牌可能横跨三四个 delta；如果逐片直接输出，
 * UI 上会先闪 `|<ds_sa` 再闪 `fety>` —— 扣住这一小段等它拼完即可。
 * 只检查最后 HOLD_MAX 个字符，且只认以 `|`、`<`、`[` 开头的候选前缀，
 * 所以正文里的普通竖线（markdown 表格、命令行管道）最多被延迟一个分片，不会丢。
 *
 * @param text - 当前待处理文本。
 * @returns 可以安全输出的长度。
 */
function holdBackStart(text) {
  const limit = Math.min(text.length, HOLD_MAX)
  for (let k = limit; k >= 1; k--) {
    const suffix = text.slice(text.length - k)
    const head = suffix[0]
    if (head !== '|' && head !== '<' && head !== '[') continue
    // `|t`、`|tool_requ` … 可能是 TOOL_REQUEST 的前缀
    if (TOOL_REQUEST.startsWith(suffix)) return text.length - k
    // `|`、`|<`、`|<ds_saf` … 可能是 `|<tag>` 的前缀
    if (/^\|(<[a-z_]{0,19})?$/.test(suffix)) return text.length - k
    // `[`、`[用` … 可能是 ALT_OPEN 的前缀
    if (ALT_OPEN.startsWith(suffix)) return text.length - k
    // `</`、`</ds_safety>|` … 可能是结束符的前缀
    if (/^<\/([a-z_]{0,19})?(>(\|(>)?)?)?$/.test(suffix)) return text.length - k
  }
  return text.length
}

/**
 * 逐块累积并剥离控制令牌的流式过滤器。
 *
 * 一个内容块一个实例：不同 index 的 delta 是交错的，共用缓冲会把两段文本
 * 拼到一起。
 */
export class SentinelFilter {
  /** 还没决定要不要输出的尾巴。 */
  #pending = ''

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
   * 四种形态按出现位置先后来处理，保证不会把正常正文当令牌吞掉：
   *   1. `|<tag>…</tag>|>` —— 配对成功才整段丢；
   *   2. `[用户未成年]…</ds_safety>|>` —— 开标签写坏的畸形块；
   *   3. `|tool_request|>` —— 自闭合标记，只丢标记本身；
   *   4. `</tag>|>` —— 落单的结束符，只丢它自己。
   *
   * @param done - true 表示不再等后续分片，扣住的部分直接吐出来。
   * @returns 本轮可输出的文本。
   */
  #drain(done) {
    let out = ''
    let rest = this.#pending

    for (;;) {
      const openAt = findOpenAt(rest)
      const altAt = rest.indexOf(ALT_OPEN)
      const toolAt = rest.indexOf(TOOL_REQUEST)
      const closeAt = findCloseAt(rest)

      // 取最早的候选；同一起点优先当作开标签，避免把 `|<x>` 当落单结束符
      let at = -1
      let kind = ''
      for (const [candidateAt, candidateKind] of [
        [openAt, 'open'],
        [altAt, 'alt'],
        [toolAt, 'tool'],
        [closeAt, 'close'],
      ]) {
        if (candidateAt < 0) continue
        if (at < 0 || candidateAt < at) {
          at = candidateAt
          kind = candidateKind
        }
      }
      if (at < 0) break

      out += rest.slice(0, at)

      switch (kind) {
        case 'tool': {
          rest = rest.slice(at + TOOL_REQUEST.length)
          continue
        }
        case 'close': {
          const match = CLOSE_RE.exec(rest.slice(at))
          rest = rest.slice(at + match[0].length)
          continue
        }
        case 'alt': {
          const closerAt = rest.indexOf(ALT_CLOSE, at + ALT_OPEN.length)
          if (closerAt >= 0) {
            rest = rest.slice(closerAt + ALT_CLOSE.length)
            continue
          }
          if (done || rest.length - at > SENTINEL_MAX) {
            rest = rest.slice(at + ALT_OPEN.length)
            continue
          }
          this.#pending = rest.slice(at)
          return out
        }
        default: {
          const openEnd = rest.indexOf('>', at)
          const tag = rest.slice(at + 2, openEnd)
          const close = `</${tag}>|>`
          const closerAt = rest.indexOf(close, openEnd + 1)
          if (closerAt >= 0) {
            rest = rest.slice(closerAt + close.length)
            continue
          }
          if (done || rest.length - at > SENTINEL_MAX) {
            // 没闭合：只丢开标签，后面的正文保留，避免把正常内容一起吞掉
            rest = rest.slice(openEnd + 1)
            continue
          }
          // 半截令牌：扣住，等下一个分片
          this.#pending = rest.slice(at)
          return out
        }
      }
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
 * 一次性清洗整段文本（用于 block-end 里的完整块）。
 *
 * @param text - 完整的块文本。
 * @returns 剥掉令牌后的文本。
 */
export function sanitizeText(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  if (!text.includes('|') && !text.includes('[用户未成年]')) return text
  const filter = new SentinelFilter()
  return filter.push(text) + filter.flush()
}

/**
 * 包一层分片流：改写 text-delta / reasoning-delta，以及 block-end 的完整块。
 *
 * @param stream - 下游适配器的分片流。
 * @returns 清洗后的分片流。
 */
function stripStream(stream) {
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
          if (text === chunk.text) {
            yield chunk
            break
          }
          // 整片都被令牌吃掉时也要吐一个空片，否则下游看到的块顺序会断档
          yield text === '' ? { ...chunk, text: '' } : { ...chunk, text }
          break
        }
        case 'block-end': {
          filters.delete(chunk.index)
          blockTypes.delete(chunk.index)
          const block = chunk.block
          if ((block?.type === 'text' || block?.type === 'reasoning') && typeof block.text === 'string') {
            const clean = sanitizeText(block.text)
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
 * 挂到 `llm/stream` waterfall 上。
 *
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  ctx.on('llm/stream', (options, next) => {
    const stream = next()
    return providerAllowed(options) ? stripStream(stream) : stream
  })
}
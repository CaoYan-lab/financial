import { getActiveArkModel, getActiveLlmModelOption } from './llmRuntimeConfigService.js'
import { durationMs, errorMessage, logger } from '../utils/logger.js'
import type { LlmModelOption } from '../../shared/types.js'

const DEFAULT_ARK_REQUEST_TIMEOUT_MS = 300_000

export function extractOutputText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>
  if (typeof record.output_text === 'string') return record.output_text
  if (typeof record.text === 'string') return record.text
  const choices = record.choices
  if (Array.isArray(choices)) {
    const texts = choices.flatMap((choice) => {
      if (!choice || typeof choice !== 'object') return []
      const message = (choice as Record<string, unknown>).message
      if (!message || typeof message !== 'object') return []
      const content = (message as Record<string, unknown>).content
      return typeof content === 'string' ? [content] : []
    })
    if (texts.length) return texts.join('\n')
  }
  const output = record.output
  if (Array.isArray(output)) {
    const texts = output.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const content = (item as Record<string, unknown>).content
      if (!Array.isArray(content)) return []
      return content
        .map((part) => {
          if (!part || typeof part !== 'object') return ''
          const partRecord = part as Record<string, unknown>
          return typeof partRecord.text === 'string' ? partRecord.text : ''
        })
        .filter(Boolean)
    })
    if (texts.length) return texts.join('\n')
  }
  return JSON.stringify(payload)
}

export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined
  const direct = safeJson(text)
  if (direct) return direct
  const match = text.match(/\{[\s\S]*\}/)
  return match ? safeJson(match[0]) : undefined
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export async function callArkResponses(input: Array<{ role: string; content: string }>, options: { model?: string; modelOption?: LlmModelOption } = {}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const model = options.model ?? getActiveArkModel()
  const modelOption = options.modelOption ?? getActiveLlmModelOption()
  const apiKey = resolveApiKey(modelOption)
  const url = resolveResponseUrl(modelOption)
  const startedAt = performance.now()
  const timeoutMs = resolveArkRequestTimeoutMs()
  logger.info({ event: 'llm.ark.request.started', model, url, inputMessageCount: input.length, timeoutMs }, 'Ark request started')
  if (!apiKey) {
    const error = `${modelOption.apiKeyEnv ?? 'ARK_API_KEY'} missing`
    logger.error({ event: 'llm.ark.request.failed', model, durationMs: durationMs(startedAt), error }, 'Ark request failed')
    return { ok: false, error }
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody(model, input, modelOption.requestProtocol)),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const payload = await response.json().catch(() => undefined)
    if (!response.ok) {
      const error = typeof payload === 'object' ? JSON.stringify(payload) : response.statusText
      logger.error(
        {
          event: 'llm.ark.request.failed',
          model,
          statusCode: response.status,
          durationMs: durationMs(startedAt),
          error,
        },
        'Ark request failed',
      )
      return { ok: false, error }
    }
    const text = extractOutputText(payload)
    logger.info({ event: 'llm.ark.request.succeeded', model, durationMs: durationMs(startedAt), outputLength: text.length }, 'Ark request succeeded')
    return { ok: true, text }
  } catch (error) {
    logger.error({ event: 'llm.ark.request.errored', model, durationMs: durationMs(startedAt), error: errorMessage(error) }, 'Ark request errored')
    return { ok: false, error: error instanceof Error ? error.message : 'unknown Ark response error' }
  }
}

function resolveArkRequestTimeoutMs(): number {
  const configured = Number(process.env.ARK_REQUEST_TIMEOUT_MS ?? process.env.LLM_REQUEST_TIMEOUT_MS)
  if (Number.isFinite(configured) && configured >= 30_000) return Math.floor(configured)
  return DEFAULT_ARK_REQUEST_TIMEOUT_MS
}

function resolveApiKey(modelOption: ReturnType<typeof getActiveLlmModelOption>): string | undefined {
  if (modelOption.apiKeyEnv === 'GLM_API_KEY') return process.env.GLM_API_KEY
  if (modelOption.apiKeyEnv && process.env[modelOption.apiKeyEnv]) return process.env[modelOption.apiKeyEnv]
  return process.env.ARK_API_KEY || process.env.DEEPSEEK_API_KEY
}

function resolveResponseUrl(modelOption: ReturnType<typeof getActiveLlmModelOption>): string {
  if (modelOption.urlEnv && process.env[modelOption.urlEnv]) return process.env[modelOption.urlEnv]!
  return modelOption.defaultUrl || process.env.ARK_RESPONSES_URL || 'https://ark.cn-beijing.volces.com/api/v3/responses'
}

function requestBody(model: string, input: Array<{ role: string; content: string }>, protocol: ReturnType<typeof getActiveLlmModelOption>['requestProtocol']) {
  if (protocol === 'chat_completions') {
    return {
      model,
      temperature: 0,
      messages: input,
    }
  }
  return {
    model,
    temperature: 0,
    input,
  }
}

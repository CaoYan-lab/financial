import type { ModelProviderProtocol } from './postgresModelProviderConfigRepository.js'

export type ModelHttpConfig = {
  protocol: ModelProviderProtocol
  endpoint: string
  model: string
  apiKey: string
}

export function textFromModelResponse(
  protocol: ModelProviderProtocol,
  payload: unknown,
): string {
  if (!payload || typeof payload !== 'object') throw new Error('MODEL_RESPONSE_INVALID')
  const record = payload as Record<string, unknown>
  if (protocol === 'OPENAI_CHAT_COMPLETIONS') {
    const choices = record.choices
    const first = Array.isArray(choices) ? choices[0] : null
    const message = first && typeof first === 'object'
      ? (first as Record<string, unknown>).message
      : null
    const content = message && typeof message === 'object'
      ? (message as Record<string, unknown>).content
      : null
    if (typeof content === 'string') return content
    throw new Error('MODEL_RESPONSE_INVALID')
  }
  if (typeof record.output_text === 'string') return record.output_text
  const output = record.output
  if (!Array.isArray(output)) throw new Error('MODEL_RESPONSE_INVALID')
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const content = (item as Record<string, unknown>).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const text = (part as Record<string, unknown>).text
      if (typeof text === 'string') return text
    }
  }
  throw new Error('MODEL_RESPONSE_INVALID')
}

export async function requestModelText(input: {
  config: ModelHttpConfig
  system?: string
  user: string
  temperature?: number
  timeoutMs: number
  maxResponseBytes?: number
  signal?: AbortSignal
}): Promise<string> {
  const body = input.config.protocol === 'OPENAI_CHAT_COMPLETIONS'
    ? {
        model: input.config.model,
        temperature: input.temperature ?? 0,
        messages: [
          ...(input.system ? [{ role: 'system', content: input.system }] : []),
          { role: 'user', content: input.user },
        ],
      }
    : {
        model: input.config.model,
        temperature: input.temperature ?? 0,
        input: [
          ...(input.system ? [{
            role: 'system',
            content: [{ type: 'input_text', text: input.system }],
          }] : []),
          {
            role: 'user',
            content: [{ type: 'input_text', text: input.user }],
          },
        ],
      }
  const signals = [AbortSignal.timeout(input.timeoutMs)]
  if (input.signal) signals.unshift(input.signal)
  const response = await fetch(input.config.endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${input.config.apiKey}`,
      'content-type': 'application/json',
    },
    signal: AbortSignal.any(signals),
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`MODEL_HTTP_${response.status}`)
  const maxBytes = input.maxResponseBytes ?? 4 * 1024 * 1024
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maxBytes) throw new Error('MODEL_RESPONSE_TOO_LARGE')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > maxBytes) throw new Error('MODEL_RESPONSE_TOO_LARGE')
  const payload = JSON.parse(bytes.toString('utf8')) as unknown
  return textFromModelResponse(input.config.protocol, payload)
}

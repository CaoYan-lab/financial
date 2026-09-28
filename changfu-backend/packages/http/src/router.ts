import type { IncomingMessage } from 'node:http'

export type RouteMatch = {
  params: Record<string, string>
}

export function matchRoute(
  request: IncomingMessage,
  method: string,
  pattern: RegExp,
): RouteMatch | null {
  if (request.method !== method) return null
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  const match = pathname.match(pattern)
  if (!match) return null
  return { params: match.groups ?? {} }
}

export async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (declared > maxBytes) throw new Error('REQUEST_TOO_LARGE')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxBytes) throw new Error('REQUEST_TOO_LARGE')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

export function parseObject(body: Buffer): Record<string, unknown> {
  const parsed = JSON.parse(body.toString('utf8')) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('REQUEST_INVALID')
  }
  return parsed as Record<string, unknown>
}

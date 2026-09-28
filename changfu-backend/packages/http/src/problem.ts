import type { ServerResponse } from 'node:http'

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

export function sendProblem(
  response: ServerResponse,
  status: number,
  code: string,
  requestId: string,
): void {
  sendJson(response, status, {
    type: `https://changfu.local/problems/${code.toLowerCase()}`,
    title: '请求未完成',
    status,
    code,
    requestId,
  })
}

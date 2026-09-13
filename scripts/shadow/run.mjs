import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseEnv } from 'dotenv'
import { hash, suiteVersion } from './promptSuite.mjs'
import { evaluate, parseResponse, summarize } from './evaluate.mjs'
import { bindRequest } from './compactContract.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const inputPath = resolve(option('--input', '.data/shadow-trading/frozen/dataset.json'))
const out = resolve(option('--out', '.data/shadow-trading/run-1'))
const repeats = Number(option('--repeats', '1'))
const concurrency = Number(option('--concurrency', '4'))
const maxOutputTokens = Number(option('--max-output-tokens', '8192'))
if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1024 || maxOutputTokens > 16384) throw new Error('Invalid output budget')
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Invalid bounds')
const dataset = JSON.parse(readFileSync(inputPath, 'utf8'))
if (!dataset.synthetic || dataset.suiteVersion !== suiteVersion) throw new Error('Only synthetic frozen datasets allowed')
mkdirSync(out, { recursive: true })
const rowsPath = resolve(out, 'responses.jsonl')
const manifestPath = resolve(out, 'manifest.json')
const envPath = resolve(option('--env-file', '.env.local'))
const env = existsSync(envPath) ? parseEnv(readFileSync(envPath)) : {}
const model = process.env.ARK_MODEL || env.ARK_MODEL
const url = process.env.ARK_RESPONSES_URL || env.ARK_RESPONSES_URL
const key = process.env.ARK_API_KEY || env.ARK_API_KEY
const endpoint = new URL(url || 'https://invalid.invalid')
if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'ark.cn-beijing.volces.com' ||
  !['/api/v3/responses', '/api/v3/chat/completions'].includes(endpoint.pathname)) throw new Error('Only existing Ark inference endpoint allowed')
for (const request of dataset.requests) if (hash(request.messages) !== request.promptHash) throw new Error('Frozen prompt hash mismatch')
const meta = { suiteVersion, datasetHash: hash(dataset), model, endpoint: endpoint.href, temperature: 0, maxOutputTokens, repeats, concurrency, timeoutMs: 120000, structuredOutput: 'local-schema-only', synthetic: true, ordersEnabled: false }
if (existsSync(manifestPath) && JSON.stringify(JSON.parse(readFileSync(manifestPath, 'utf8'))) !== JSON.stringify(meta)) throw new Error('Run manifest mismatch; choose a new output directory')
writeFileSync(manifestPath, JSON.stringify(meta))
const existing = existsSync(rowsPath) ? readFileSync(rowsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
for (const row of existing) {
  if (dataset.requests.find(r => r.id === row.id && r.arm === row.arm)?.promptHash !== row.promptHash) throw new Error('Resume request mismatch')
}
const completed = new Set(existing.map(r => r.requestKey))
const selected = dataset.requests.filter(r => !args.includes('--cases') || option('--cases', '').split(',').some(s => r.id.endsWith(s)))
const jobs = Array.from({ length: repeats }, (_, repeat) => selected.map(r => ({ ...r, repeat }))).flat()
// Seeded shuffle balances arm order; each request is independent and never includes oracle labels.
let seed = 260912
for (let i = jobs.length - 1; i > 0; i--) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  const j = seed % (i + 1)
  ;[jobs[i], jobs[j]] = [jobs[j], jobs[i]]
}
const pending = jobs.filter(j => !completed.has(`${j.id}:${j.arm}:${j.repeat}`))
if (!args.includes('--execute')) {
  console.log(JSON.stringify({ mode: 'dry-run', requests: pending.length, model, endpoint: endpoint.href, credentialsAvailable: Boolean(key), ordersEnabled: false }))
  process.exit(0)
}
if (!key || !model) throw new Error('Model credentials unavailable; no calls made')
const rows = [...existing]
let next = 0
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < pending.length) {
    const job = pending[next++]
    const start = Date.now()
    let text = '', error = null, usage = null, responseModel = null
    let headersMs = null, httpStatus = null, providerRequestId = null, responseId = null
    try {
      const body = endpoint.pathname.endsWith('/responses')
        ? { model, temperature: 0, input: job.messages, max_output_tokens: maxOutputTokens }
        : { model, temperature: 0, messages: job.messages, max_tokens: maxOutputTokens }
      const response = await fetch(endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
      })
      headersMs = Date.now() - start
      httpStatus = response.status
      providerRequestId = response.headers.get('x-request-id') ?? response.headers.get('x-tt-logid')
      if (!response.ok) {
        // Never persist provider error bodies; they may contain sensitive request data.
        error = `HTTP_${response.status}`
      } else {
        const data = await response.json()
        responseId = data.id ?? null
        usage = data.usage ?? null
        responseModel = data.model ?? null
        text = data.output_text ?? data.choices?.[0]?.message?.content ??
          data.output?.flatMap(item => item.content ?? []).filter(c => c.type === 'output_text' || c.type === 'text').map(c => c.text ?? '').join('\n') ?? ''
        if (!text) error = 'EMPTY_OUTPUT'
        if (data.status === 'incomplete' || data.choices?.[0]?.finish_reason === 'length') error = 'TRUNCATED_OUTPUT'
      }
    } catch (e) { error = e?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_OR_PARSE_ERROR' }
    const scenario = dataset.scenarios.find(s => s.id === job.id)
    const output = parseResponse(text)
    const row = {
      requestKey: `${job.id}:${job.arm}:${job.repeat}`, id: job.id, broker: job.broker, role: job.role,
      category: scenario.category, arm: job.arm, repeat: job.repeat, promptHash: job.promptHash,
      responseModel, usage, durationMs: Date.now() - start, headersMs, httpStatus, providerRequestId, responseId,
      error, text, output, binding: bindRequest(job, scenario.facts),
      evaluation: evaluate(scenario, output, job.arm),
    }
    appendFileSync(rowsPath, `${JSON.stringify(row)}\n`)
    rows.push(row)
    console.log(JSON.stringify({ completed: rows.length, id: row.id, arm: row.arm, error, evaluable: row.evaluation.evaluable }))
  }
}))
const summary = summarize(rows)
writeFileSync(resolve(out, 'summary.json'), JSON.stringify({ ...meta, completed: rows.length, summary }, null, 2))
const header = '| 券商 | 组别 | 请求 | 有效输出 | 接口失败 | 格式失败 | 阻断场景中的无效建议 | 对照机会未选择 | 挂单错误 |\n|---|---|---:|---:|---:|---:|---:|---:|---:|'
const table = summary.map(s => `| ${s.broker} | ${s.arm} | ${s.attempted} | ${s.evaluable} | ${s.transportFailures} | ${s.invalidOutputs} | ${s.invalidTradeCases}/${s.blockedCases} | ${s.missedControls}/${s.controls} | ${s.managedErrors}/${s.managedCases} |`).join('\n')
const pairs = []
for (const broker of ['longbridge', 'futu']) {
  for (const baseline of ['legacy', 'legacy_enriched']) {
    const eligible = dataset.scenarios.filter(s => s.broker === broker && s.category === 'blocked' && s.role !== 'managed')
    let count = 0, improved = 0, worsened = 0
    for (const s of eligible) for (let repeat = 0; repeat < repeats; repeat++) {
      const a = rows.find(r => r.id === s.id && r.repeat === repeat && r.arm === baseline)
      const b = rows.find(r => r.id === s.id && r.repeat === repeat && r.arm === 'v2')
      if (!a || !b || a.error || b.error || !a.evaluation.evaluable || !b.evaluation.evaluable) continue
      count++
      improved += Number(a.evaluation.invalidTrade && !b.evaluation.invalidTrade)
      worsened += Number(!a.evaluation.invalidTrade && b.evaluation.invalidTrade)
    }
    pairs.push({ broker, baseline, pairedCases: count, improved, worsened })
  }
}
writeFileSync(resolve(out, 'paired.json'), JSON.stringify(pairs, null, 2))
writeFileSync(resolve(out, 'report.md'), `# 双券商合成影子测试\n\n模型：${model}。每场景重复 ${repeats} 次。数据摘要：${meta.datasetHash}。\n\n${header}\n${table}\n\n## 配对结果\n\n${pairs.map(p => `- ${p.broker}，${p.baseline} 对比新版：有效配对 ${p.pairedCases}，改善 ${p.improved}，恶化 ${p.worsened}。`).join('\n')}\n\n## 限制\n\n- 无真实下单；结果是模型建议，不是后端执行结果或实际收益。\n- 合成政策场景不是随机市场样本，无真实后续价格，不能计算收益或证明减少亏损交易。\n- “无效”由预先冻结的规则标签与数量预算定义，不以事后盈亏定义。\n- 有效开仓对照不代表模型必须交易；未选择率用于揭示过度观望，不等于客观错失盈利。\n- 接口失败、截断和不合法输出单独统计，不能算作成功 HOLD；新版完整契约校验更严格。\n- 配对指标仅使用两臂均可评估的样本；其余样本存在选择偏差，不得隐藏失败率。\n- legacy_enriched 与 v2 得到相同事实，但上下文组织和输出契约也变化，并非只测一句系统指令。\n- 富途使用合成的规范化风险准入，不假设与长桥原始等级等价；未实现生产风险字段接线。\n- 当前没有统计显著性或真实回测结论；不同重复共享同一场景，不是独立市场样本。\n`)
console.log(JSON.stringify({ out, summary, pairs }))

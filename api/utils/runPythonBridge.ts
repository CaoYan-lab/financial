import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export type PythonBridgeResult<T> = {
  ok: boolean
  data?: T
  error?: string
  stderr?: string
}

export async function runPythonBridge<T>(scriptName: string, payload: unknown): Promise<PythonBridgeResult<T>> {
  const pythonBin = process.env.FUTU_PYTHON_BIN || 'python3'
  const scriptPath = path.resolve(__dirname, '..', 'futu_bridge', scriptName)
  const projectRoot = path.resolve(__dirname, '..', '..')
  const bridgeHome = process.env.FUTU_BRIDGE_HOME || path.join(projectRoot, '.futu-home')
  // 云端/容器模式（CLOUD_PYTHON=1 或 PG_HISTORY_DRIVER=1）使用自带完整依赖的 python 环境，
  // 不再注入本机 macOS 专用 site-packages（避免 3.9 路径污染容器/venv 的 3.x 环境）。
  const cloudPython = process.env.CLOUD_PYTHON === '1' || process.env.PG_HISTORY_DRIVER === '1'
  const defaultUserSite = cloudPython ? '' : '/Users/bytedance/Library/Python/3.9/lib/python/site-packages'
  const pythonPath = [process.env.PYTHONPATH, defaultUserSite].filter(Boolean).join(':')
  // 云端模式下 HOME 不强制隔离（容器内 OpenD 连接不依赖本机 .futu-home 登录缓存）
  const bridgeHomeEnv = cloudPython ? (process.env.HOME || bridgeHome) : bridgeHome
  fs.mkdirSync(bridgeHome, { recursive: true })

  return new Promise((resolve) => {
    const child = spawn(pythonBin, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: bridgeHomeEnv, PYTHONPATH: pythonPath, PYTHONUNBUFFERED: '1' },
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      resolve({ ok: false, error: error.message, stderr })
    })
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: `Python bridge exited with code ${code}`, stderr })
        return
      }
      try {
        const jsonText = latestJsonObject(stdout)
        if (!jsonText) {
          throw new Error('Python bridge did not emit a JSON object.')
        }
        resolve({ ok: true, data: JSON.parse(jsonText) as T, stderr })
      } catch (error) {
        resolve({
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to parse Python bridge JSON output.',
          stderr,
        })
      }
    })

    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

function latestJsonObject(text: string): string | undefined {
  const candidates: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (char === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) candidates.push(text.slice(start, index + 1))
    }
  }
  return candidates.at(-1)
}

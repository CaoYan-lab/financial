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
  const defaultUserSite = '/Users/bytedance/Library/Python/3.9/lib/python/site-packages'
  const pythonPath = [process.env.PYTHONPATH, defaultUserSite].filter(Boolean).join(':')
  fs.mkdirSync(bridgeHome, { recursive: true })

  return new Promise((resolve) => {
    const child = spawn(pythonBin, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: bridgeHome, PYTHONPATH: pythonPath, PYTHONUNBUFFERED: '1' },
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

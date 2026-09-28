import type { ContextMetadata, ModelRunResult } from '../../domain/src/contracts.js'

export type ModelRunRecord = {
  userId: string
  metadata: ContextMetadata
  model: string
  promptVersion: string
  status: 'RUNNING' | 'COMPLETED' | 'REJECTED' | 'INTERRUPTED'
  result: ModelRunResult | null
  errorCode: string | null
}

/**
 * 此端口刻意不接受 ContextEnvelope，防止基础设施实现把原始上下文持久化。
 */
export interface ModelRunRepository {
  create(record: Omit<ModelRunRecord, 'result' | 'errorCode'>): Promise<void>
  finish(
    requestId: string,
    completion: Pick<ModelRunRecord, 'status' | 'result' | 'errorCode'>,
  ): Promise<void>
}

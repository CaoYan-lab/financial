export type AShareSession = 'RTH' | 'LUNCH_BREAK' | 'PRE_OPEN' | 'CLOSED' | 'WEEKEND'

export type AShareSessionDecision = {
  session: AShareSession
  shouldSkipLlm: boolean
  reason?: string
  checkedAt: string
}

const SHANGHAI_TZ = 'Asia/Shanghai'

export function currentAshareSession(now = new Date()): AShareSessionDecision {
  const checkedAt = now.toISOString()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  const weekday = value('weekday')
  const minutes = Number(value('hour')) * 60 + Number(value('minute'))
  if (weekday === 'Sat' || weekday === 'Sun') {
    return { session: 'WEEKEND', shouldSkipLlm: true, reason: 'A 股周末休市，本轮不评估。', checkedAt }
  }
  if (minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 30) {
    return { session: 'RTH', shouldSkipLlm: false, checkedAt }
  }
  if (minutes >= 13 * 60 && minutes <= 15 * 60) {
    return { session: 'RTH', shouldSkipLlm: false, checkedAt }
  }
  if (minutes > 11 * 60 + 30 && minutes < 13 * 60) {
    return { session: 'LUNCH_BREAK', shouldSkipLlm: true, reason: 'A 股午休时段，本轮不评估。', checkedAt }
  }
  if (minutes < 9 * 60 + 30) {
    return { session: 'PRE_OPEN', shouldSkipLlm: true, reason: 'A 股尚未进入连续竞价，本轮不评估。', checkedAt }
  }
  return { session: 'CLOSED', shouldSkipLlm: true, reason: 'A 股已收盘，本轮不评估。', checkedAt }
}

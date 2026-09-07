import { describe, expect, it } from 'vitest'
import { futuManagedStatus } from '../api/live/managedOrderBrokerAdapter'

describe('Futu managed order status mapping', () => {
  it.each([
    ['SUBMITTED', 'TRACKING'],
    ['FILLED_PART', 'PARTIALLY_FILLED'],
    ['FILLED_ALL', 'FILLED'],
    ['CANCELLED_ALL', 'CANCELED'],
    ['CANCELLED_PART', 'PARTIALLY_CANCELED'],
    ['FAILED', 'REJECTED'],
  ])('maps %s to %s', (brokerStatus, managedStatus) => {
    expect(futuManagedStatus(brokerStatus)).toBe(managedStatus)
  })
})

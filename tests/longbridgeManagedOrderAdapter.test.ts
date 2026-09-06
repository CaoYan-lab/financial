import { describe, expect, it } from 'vitest'
import { longbridgeManagedStatus } from '../api/live/managedOrderBrokerAdapter'

describe('Longbridge managed order status mapping', () => {
  it.each([
    [7, 'TRACKING'],
    [11, 'PARTIALLY_FILLED'],
    [5, 'FILLED'],
    [15, 'CANCELED'],
    [17, 'PARTIALLY_CANCELED'],
    [14, 'REJECTED'],
    [16, 'EXPIRED'],
  ])('maps %s to %s', (brokerStatus, managedStatus) => {
    expect(longbridgeManagedStatus(brokerStatus)).toBe(managedStatus)
  })
})

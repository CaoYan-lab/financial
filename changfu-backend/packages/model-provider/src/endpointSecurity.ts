import { isIP } from 'node:net'
import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'

type AddressLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>

const arkPrivateLinkHostname = 'ark.cn-beijing.volces.com'

function trustedArkPrivateLinkAddress(hostname: string, address: LookupAddress): boolean {
  if (hostname !== arkPrivateLinkHostname || address.family !== 4) return false
  const [first, second] = address.address.split('.').map(Number)
  return first === 10 && second === 20
}

function blockedIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  const first = parts[0] ?? -1
  const second = parts[1] ?? -1
  return (
    first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224
  )
}

function blockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase()
  return (
    normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
    || normalized.startsWith('ff')
    || normalized.startsWith('::ffff:')
  )
}

async function assertEndpoint(
  endpoint: string,
  allowArkPrivateLink: boolean,
  addressLookup: AddressLookup,
): Promise<URL> {
  try {
    const url = new URL(endpoint)
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.hostname === 'localhost'
      || url.hostname.endsWith('.localhost')
      || isIP(url.hostname) !== 0
    ) throw new Error('MODEL_ENDPOINT_NOT_ALLOWED')

    const addresses = await addressLookup(url.hostname, { all: true, verbatim: true })
    if (
      addresses.length === 0
      || addresses.some(item => (
        (item.family === 4 ? blockedIpv4(item.address) : blockedIpv6(item.address))
        && !(allowArkPrivateLink && trustedArkPrivateLinkAddress(url.hostname, item))
      ))
    ) throw new Error('MODEL_ENDPOINT_NOT_ALLOWED')
    return url
  } catch {
    throw new Error('MODEL_ENDPOINT_NOT_ALLOWED')
  }
}

export async function assertSafeModelEndpoint(
  endpoint: string,
  addressLookup: AddressLookup = lookup,
): Promise<URL> {
  return assertEndpoint(endpoint, false, addressLookup)
}

export async function assertSafeOfficialModelEndpoint(
  endpoint: string,
  addressLookup: AddressLookup = lookup,
): Promise<URL> {
  return assertEndpoint(endpoint, true, addressLookup)
}

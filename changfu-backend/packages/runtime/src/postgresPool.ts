import type { PoolConfig } from 'pg'

export type PostgresPoolDefaults = {
  max: number
  applicationName: string
}

function integerFromEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name}_INVALID`)
  }
  return parsed
}

export function postgresPoolConfig(
  connectionString: string,
  defaults: PostgresPoolDefaults,
  environment: NodeJS.ProcessEnv = process.env,
): PoolConfig {
  return {
    connectionString,
    application_name: defaults.applicationName,
    max: integerFromEnvironment(environment, 'CHANGFU_PG_POOL_MAX', defaults.max, 1, 100),
    connectionTimeoutMillis: integerFromEnvironment(
      environment,
      'CHANGFU_PG_CONNECTION_TIMEOUT_MS',
      5_000,
      100,
      120_000,
    ),
    idleTimeoutMillis: integerFromEnvironment(
      environment,
      'CHANGFU_PG_IDLE_TIMEOUT_MS',
      30_000,
      1_000,
      600_000,
    ),
  }
}

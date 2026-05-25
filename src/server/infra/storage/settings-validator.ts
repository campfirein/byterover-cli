import type {SettingDescriptor} from '../../core/domain/entities/settings.js'

import {findSettingDescriptor, SETTINGS_KEYS} from '../../core/domain/entities/settings.js'

export class UnknownSettingKeyError extends Error {
  public readonly key: string

  public constructor(key: string) {
    super(`Unknown settings key: '${key}'. Run 'brv settings list' to see available keys.`)
    this.name = 'UnknownSettingKeyError'
    this.key = key
  }
}

export class InvalidSettingValueError extends Error {
  public readonly key: string
  public readonly value: unknown

  public constructor(key: string, value: unknown, reason: string) {
    super(`Invalid value for setting '${key}': ${reason}.`)
    this.name = 'InvalidSettingValueError'
    this.key = key
    this.value = value
  }
}

export type PartitionedSettings = {
  readonly invalid: ReadonlyArray<{readonly key: string; readonly reason: string; readonly value: unknown}>
  readonly valid: Readonly<Record<string, number>>
}

export type CouplingViolation = {
  readonly keys: readonly string[]
  readonly reason: string
}

const COUPLING_REQUEST_TIMEOUT = SETTINGS_KEYS.LLM_REQUEST_TIMEOUT_MS
const COUPLING_ITERATION_BUDGET = SETTINGS_KEYS.LLM_ITERATION_BUDGET_MS

/**
 * Single source of truth for settings validation. Used by the store to gate
 * writes and by daemon startup to filter a raw on-disk record into the valid
 * subset that should be applied (plus a list of rejected entries for logging).
 *
 * Coupling rules (e.g. `requestTimeoutMs <= iterationBudgetMs`) plug in here
 * when M3 lands; the store and the transport handler do not need to change.
 */
export class SettingsValidator {
  /**
   * Splits a raw record (e.g. parsed from `settings.json`) into the valid
   * entries the daemon should apply and the invalid entries the daemon should
   * log a warning about.
   */
  public partition(record: Record<string, unknown>): PartitionedSettings {
    const valid: Record<string, number> = {}
    const invalid: Array<{key: string; reason: string; value: unknown}> = []

    for (const [key, value] of Object.entries(record)) {
      const descriptor = findSettingDescriptor(key)
      if (descriptor === undefined) {
        invalid.push({key, reason: 'unknown settings key', value})
        continue
      }

      try {
        valid[key] = this.validateAgainst(descriptor, value)
      } catch (error) {
        if (error instanceof InvalidSettingValueError) {
          invalid.push({key, reason: error.message, value: error.value})
          continue
        }

        throw error
      }
    }

    // Enforce coupling rules across the valid set. Per project AC,
    // a violation demotes every key participating in the rule back to
    // its registered default; surfaced via `invalid` so the daemon
    // startup loader can log one warning per demoted key.
    for (const violation of this.validateCoupling(valid)) {
      for (const key of violation.keys) {
        if (key in valid) {
          invalid.push({key, reason: violation.reason, value: valid[key]})
          delete valid[key]
        }
      }
    }

    return {invalid, valid}
  }

  /**
   * Validates a single key/value pair. Throws on unknown key or invalid value.
   * Returns the coerced numeric value on success.
   */
  public validate(key: string, value: unknown): number {
    const descriptor = this.validateKey(key)
    return this.validateAgainst(descriptor, value)
  }

  /**
   * Cross-key invariant checks (`llm.requestTimeoutMs <= llm.iterationBudgetMs`).
   * Missing keys in `values` are filled in from the registry defaults so the
   * check works on partial states (e.g. user has only overridden one side).
   * Returns an empty array when no rule is violated.
   */
  public validateCoupling(values: Readonly<Record<string, number>>): readonly CouplingViolation[] {
    const violations: CouplingViolation[] = []

    const requestTimeout = values[COUPLING_REQUEST_TIMEOUT] ?? findSettingDescriptor(COUPLING_REQUEST_TIMEOUT)?.default
    const iterationBudget = values[COUPLING_ITERATION_BUDGET] ?? findSettingDescriptor(COUPLING_ITERATION_BUDGET)?.default

    if (requestTimeout !== undefined && iterationBudget !== undefined && requestTimeout > iterationBudget) {
      violations.push({
        keys: [COUPLING_REQUEST_TIMEOUT, COUPLING_ITERATION_BUDGET],
        reason: `${COUPLING_REQUEST_TIMEOUT} (${requestTimeout}) must be <= ${COUPLING_ITERATION_BUDGET} (${iterationBudget})`,
      })
    }

    return violations
  }

  /**
   * Returns the descriptor for `key`. Throws `UnknownSettingKeyError` if the
   * key is not registered.
   */
  public validateKey(key: string): SettingDescriptor {
    const descriptor = findSettingDescriptor(key)
    if (descriptor === undefined) throw new UnknownSettingKeyError(key)
    return descriptor
  }

  private validateAgainst(descriptor: SettingDescriptor, value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new InvalidSettingValueError(
        descriptor.key,
        value,
        `expected integer, got ${describeType(value)}`,
      )
    }

    if (value < descriptor.min || value > descriptor.max) {
      throw new InvalidSettingValueError(
        descriptor.key,
        value,
        `value ${value} is outside allowed range [${descriptor.min}, ${descriptor.max}]`,
      )
    }

    return value
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number' && !Number.isInteger(value)) return 'non-integer number'
  return typeof value
}

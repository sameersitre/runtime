/**
 * Shared utilities for state store trackers (Zustand, Redux).
 * Handles per-key serialization with individual error isolation.
 */

import type { SerializedValue } from './types';
import { serializeValue } from './serializer';

/**
 * Serialize a record of state values individually.
 * Per-key try-catch ensures one bad value doesn't block the rest.
 */
export function serializeStoreState(
  state: Record<string, unknown>,
  logPrefix: string,
): Record<string, SerializedValue> {
  const serialized: Record<string, SerializedValue> = {};
  for (const [key, value] of Object.entries(state)) {
    try {
      serialized[key] = serializeValue(value);
    } catch (error) {
      console.error(`[FloTrace] Error serializing ${logPrefix} key "${key}":`, error);
      serialized[key] = { __type: 'error', value: 'Serialization failed' };
    }
  }
  return serialized;
}

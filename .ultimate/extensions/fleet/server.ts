import { defineExtension } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import type { ActionContext } from '../../../server/actions.ts'
import { fleetInventory, instanceSnapshot } from './data.ts'

export default defineExtension({ name: 'fleet' })

export const actions = {
  /** `{ origin? }` -> FleetSnapshot. Origin only selects browser-reachable addresses, never a fetch target. */
  async inventory(args: JsonValue, { host, signal }: ActionContext) {
    if (
      args !== null &&
      (typeof args !== 'object' ||
        Array.isArray(args) ||
        Object.keys(args).some((key) => key !== 'origin') ||
        (args.origin !== undefined && typeof args.origin !== 'string'))
    )
      throw new Error('Expected { origin?: string }')
    return fleetInventory(host, signal, args?.origin as string | undefined)
  },
  /** No arguments -> InstanceSnapshot: no conversation ids, titles, paths, or UI state. */
  async snapshot(args: JsonValue, { host, signal }: ActionContext) {
    if (args !== null) throw new Error('Expected null')
    return instanceSnapshot(host, signal)
  },
}

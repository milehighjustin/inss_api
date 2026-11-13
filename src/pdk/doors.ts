import { PdkError, pdkGet, pdkPost, pdkSystem, type PdkCloudNode } from './api.ts'
import { readSelectedSystem } from './store.ts'

/**
 * Doors, which PDK calls devices.
 *
 * A device has no state of its own: open, held open and forced are reported per
 * cloud node, so the list the app shows merges the two — devices from the
 * system, states from the node they hang off. A device whose node did not answer
 * still appears, with `state: null`, because a door missing from the list reads
 * as a door that does not exist rather than one that is unreachable.
 */

export interface PdkDevice {
  id: string
  name?: string
  type?: string
  publicIcon?: string
  port?: number
  /** Present when PDK was asked to include it. */
  cloudNode?: { id?: string; name?: string; serialNumber?: string } | string
  partition?: { id?: string; name?: string }[]
  [key: string]: unknown
}

export interface PdkDeviceState {
  id: string
  name?: string
  relayOpen?: boolean
  dpsOpen?: boolean
  forcedAlarmOn?: boolean
  propAlarmOn?: boolean
  communicationLost?: boolean
  controllerIssues?: boolean
  [key: string]: unknown
}

export interface Door extends PdkDevice {
  cloudNodeId: string | null
  cloudNodeName: string | null
  /** Null when the node did not report; `relayOpen` when it did. */
  state: PdkDeviceState | null
}

function nodeIdOf(value: PdkDevice['cloudNode']): string | null {
  if (!value) return null
  if (typeof value === 'string') return value
  return value.id ?? null
}

function nodeNameOf(value: PdkDevice['cloudNode']): string | null {
  if (!value || typeof value === 'string') return null
  return value.name ?? value.serialNumber ?? null
}

/** The chosen system, or a 409 that tells the app what to do about it. */
export async function selectedSystemId(): Promise<string> {
  const selected = await readSelectedSystem()
  if (!selected) {
    throw new PdkError('No PDK system is selected. Choose one in Integrations → PDK.', 'no_system')
  }
  return selected.systemId
}

/**
 * Every door on the chosen system, with its current state where the node
 * answered.
 *
 * `per_page=100` is PDK's maximum: a site with more doors than that needs
 * pagination, and the caller is told the total so it can say so rather than
 * quietly showing a hundred.
 */
export async function listDoors(): Promise<{ doors: Door[]; total: number | null }> {
  const systemId = await selectedSystemId()
  const devices = await pdkGet<PdkDevice[]>(systemId, '/devices?per_page=100&include=cloudNode')
  const rows = Array.isArray(devices.data) ? devices.data : []

  const states = new Map<string, PdkDeviceState[]>()
  const nodeIds = [...new Set(rows.map((row) => nodeIdOf(row.cloudNode)).filter(Boolean))] as string[]

  await Promise.all(
    nodeIds.map(async (nodeId) => {
      try {
        const reported = await pdkGet<PdkDeviceState[]>(
          systemId,
          `/cloud-nodes/${nodeId}/devices/states`,
        )
        states.set(nodeId, Array.isArray(reported.data) ? reported.data : [])
      } catch (cause) {
        // One unreachable node must not blank the whole board.
        console.error('[pdk] device states unavailable', {
          nodeId,
          message: cause instanceof Error ? cause.message : String(cause),
        })
      }
    }),
  )

  const doors = rows.map<Door>((device) => {
    const cloudNodeId = nodeIdOf(device.cloudNode)
    const state = cloudNodeId
      ? (states.get(cloudNodeId)?.find((row) => row.id === device.id) ?? null)
      : null

    return {
      ...device,
      cloudNodeId,
      cloudNodeName: nodeNameOf(device.cloudNode),
      state,
    }
  })

  return { doors, total: devices.total ?? rows.length }
}

/**
 * Open one door now.
 *
 * The node id comes from the device itself, never from the caller: the app knows
 * a door id, and a request must not be able to point PDK at another node's
 * device. PDK answers 204, which is the whole reply.
 */
export async function openDoor(deviceId: string): Promise<void> {
  const systemId = await selectedSystemId()
  const devices = await pdkGet<PdkDevice[]>(systemId, `/devices?ids=${encodeURIComponent(deviceId)}`)
  const device = (Array.isArray(devices.data) ? devices.data : []).find(
    (row) => row.id === deviceId,
  )

  if (!device) throw new PdkError('That door is not on the selected PDK system.', 'not_found')

  let cloudNodeId = nodeIdOf(device.cloudNode)
  if (!cloudNodeId) {
    // `include=cloudNode` was not requested on the lookup, so ask for the device
    // again with it rather than guessing which node to command.
    const detailed = await pdkGet<PdkDevice>(
      systemId,
      `/devices/${encodeURIComponent(deviceId)}?include=cloudNode`,
    )
    cloudNodeId = nodeIdOf(detailed.data.cloudNode)
    if (!cloudNodeId) throw new PdkError('That door is not attached to a cloud node.', 'unavailable')
  }

  await pdkPost(systemId, `/cloud-nodes/${cloudNodeId}/devices/${encodeURIComponent(deviceId)}/open`)
}

export type { PdkCloudNode }

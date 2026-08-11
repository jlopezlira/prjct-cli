/**
 * Notification / SubagentStop hooks — the desktop ping must be DEFERRED.
 *
 * `notifyDesktop` forks `osascript` (~50-200ms on macOS); it used to run
 * inside `build`, i.e. between stdin and the host-visible response. These
 * tests pin the contract: the hook emits its JSON line FIRST and schedules
 * the ping via `detachAfterEmit`, and the config.notify gate still applies.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HookIo } from '../../hooks/_runner'
import configManager from '../../infrastructure/config-manager'

type NotifyHook = typeof import('../../hooks/notification').runNotificationHook

const notifyCalls: Array<{ title: string; message: string }> = []

// Loaded in beforeAll: `mock.module` must replace utils/notify BEFORE the
// hook modules (which import it) are first resolved, and core's tsconfig
// forbids top-level await — so the whole dance lives in an async loader.
const hooksBox: { hooks?: { Notification: NotifyHook; SubagentStop: NotifyHook } } = {}

beforeAll(async () => {
  const realNotify = await import('../../utils/notify')
  mock.module('../../utils/notify', () => ({
    ...realNotify,
    notifyDesktop: async (title: string, message: string) => {
      notifyCalls.push({ title, message })
    },
  }))
  const notification = await import('../../hooks/notification')
  const subagentStop = await import('../../hooks/subagent-stop')
  hooksBox.hooks = {
    Notification: notification.runNotificationHook,
    SubagentStop: subagentStop.runSubagentStopHook,
  }
})

const fixture: { projectPath: string; projectId: string } = { projectPath: '', projectId: '' }

function mockIo(): { io: HookIo; emitted: string[]; detached: Array<() => Promise<void>> } {
  const emitted: string[] = []
  const detached: Array<() => Promise<void>> = []
  return {
    emitted,
    detached,
    io: {
      input: {},
      sink: (chunk: string) => {
        emitted.push(chunk)
      },
      detachAfterEmit: (fn: () => Promise<void>) => {
        detached.push(fn)
      },
    },
  }
}

async function freshProject(notifyMode?: 'on' | 'off'): Promise<void> {
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-notify-hook-test-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `test-${Math.random().toString(36).slice(2, 10)}`
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
    ...(notifyMode ? { notify: { mode: notifyMode } } : {}),
  } as Parameters<typeof configManager.writeConfig>[1])
}

beforeEach(() => {
  notifyCalls.length = 0
})

afterEach(async () => {
  if (fixture.projectPath) {
    await fs.rm(fixture.projectPath, { recursive: true, force: true })
    fixture.projectPath = ''
  }
})

describe.each([
  ['Notification'],
  ['SubagentStop'],
] as const)('%s hook — deferred desktop ping', (event) => {
  const run = (): NotifyHook => {
    const hooks = hooksBox.hooks
    if (!hooks) throw new Error('hooks not loaded')
    return hooks[event]
  }

  test('emits the host response before any notify work, ping runs detached', async () => {
    await freshProject('on')
    const { io, emitted, detached } = mockIo()
    await run()(fixture.projectPath, io)
    // Host-visible line went out without waiting on osascript…
    expect(emitted).toEqual(['{}\n'])
    expect(notifyCalls).toHaveLength(0)
    // …and the ping was scheduled via detachAfterEmit.
    expect(detached).toHaveLength(1)
    for (const fn of detached) await fn()
    expect(notifyCalls).toHaveLength(1)
  })

  test('config.notify off still gates the ping', async () => {
    await freshProject('off')
    const { io, emitted, detached } = mockIo()
    await run()(fixture.projectPath, io)
    expect(emitted).toEqual(['{}\n'])
    for (const fn of detached) await fn()
    expect(notifyCalls).toHaveLength(0)
  })

  test('no projectId → no ping', async () => {
    fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-notify-no-id-'))
    await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.projectPath, '.prjct', 'prjct.config.json'),
      JSON.stringify({ dataPath: '' })
    )
    const { io, emitted, detached } = mockIo()
    await run()(fixture.projectPath, io)
    expect(emitted).toEqual(['{}\n'])
    for (const fn of detached) await fn()
    expect(notifyCalls).toHaveLength(0)
  })
})

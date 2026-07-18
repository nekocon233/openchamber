import { describe, expect, it } from 'bun:test'

import {
  aggregateLiveSessions,
  aggregateLiveSessionStatuses,
  areStatusMapsEquivalent,
  findLiveSession,
  findLiveSessionStatus,
} from '../live-aggregate.ts'
import {
  deriveRecentSessions,
  RECENT_SESSION_MAX_AGE_MS,
  sortSessionsByActivity,
} from '../../components/session/sidebar/activitySections.ts'

const session = (id, directory, updated, extra = {}) => ({
  id,
  title: `${id}-title`,
  time: { created: updated - 1, updated, archived: undefined },
  directory,
  ...extra,
})

describe('live aggregate', () => {
  it('prefers the freshest live session snapshot across child stores', () => {
    const states = [
      {
        session: [session('ses-1', '/a', 10, { title: 'old' })],
        session_status: {},
      },
      {
        session: [session('ses-1', '/a', 25, { title: 'new' }), session('ses-2', '/b', 20)],
        session_status: {},
      },
    ]

    const sessions = aggregateLiveSessions(states)
    expect(sessions.map((item) => `${item.id}:${item.title}`)).toEqual(['ses-1:new', 'ses-2:ses-2-title'])
    expect(findLiveSession(states, 'ses-1')?.title).toBe('new')
  })

  it('prefers busy/retry statuses over stale idle snapshots', () => {
    const states = [
      {
        session: [],
        session_status: {
          'ses-1': { type: 'idle' },
          'ses-2': { type: 'idle' },
        },
      },
      {
        session: [],
        session_status: {
          'ses-1': { type: 'busy' },
          'ses-2': { type: 'retry', message: 'retrying' },
        },
      },
    ]

    const statuses = aggregateLiveSessionStatuses(states)
    expect(statuses['ses-1']?.type).toBe('busy')
    expect(statuses['ses-2']?.type).toBe('retry')
    expect(findLiveSessionStatus(states, 'ses-2')?.type).toBe('retry')
  })

  it('lets a fresher idle snapshot override a stale busy status', () => {
    const states = [
      {
        session: [session('ses-1', '/a', 10)],
        session_status: {
          'ses-1': { type: 'busy' },
        },
      },
      {
        session: [session('ses-1', '/a', 30)],
        session_status: {
          'ses-1': { type: 'idle' },
        },
      },
    ]

    const statuses = aggregateLiveSessionStatuses(states)
    expect(statuses['ses-1']?.type).toBe('idle')
    expect(findLiveSessionStatus(states, 'ses-1')?.type).toBe('idle')
  })

  it('detects retry metadata changes in status maps', () => {
    const retryStatus = { type: 'retry', message: 'retrying|server|message', attempt: 1, next: 100 }

    expect(areStatusMapsEquivalent(
      { 'ses-1': retryStatus },
      { 'ses-1': { ...retryStatus } },
    )).toBe(true)

    expect(areStatusMapsEquivalent(
      { 'ses-1': retryStatus },
      { 'ses-1': { ...retryStatus, attempt: 2, next: 200 } },
    )).toBe(false)
  })

  it('derives recent sessions from the 48h window, excluding archived/subtasks', () => {
    const now = 1_000_000_000
    const sessions = [
      session('ses-1', '/a', now - 1_000),
      session('ses-2', '/b', now - 500),
      session('ses-3', '/c', now - 10, { time: { created: now - 11, updated: now - 10, archived: now - 5 } }),
      session('ses-4', '/d', now - 200, { parentID: 'ses-parent' }),
      session('ses-5', '/e', now - RECENT_SESSION_MAX_AGE_MS - 1),
    ]

    const recent = deriveRecentSessions(sessions, now)

    // ses-3 archived, ses-4 subtask, ses-5 older than 48h -> excluded; rest newest-first
    expect(recent.map((item) => item.id)).toEqual(['ses-2', 'ses-1'])
  })

  it('orders recent sessions by latest message activity and admits replied older sessions', () => {
    const now = 1_000_000_000
    const sessions = [
      session('ses-metadata', '/a', now - 100),
      session('ses-sent', '/b', now - 1_000),
      session('ses-replied', '/c', now - RECENT_SESSION_MAX_AGE_MS - 1),
    ]
    const messageActivity = new Map([
      ['ses-sent', now - 20],
      ['ses-replied', now - 10],
    ])

    const recent = deriveRecentSessions(sessions, now, messageActivity)

    expect(recent.map((item) => item.id)).toEqual(['ses-replied', 'ses-sent', 'ses-metadata'])
  })

  it('uses the same message activity ordering for pinned group candidates without a cutoff', () => {
    const sessions = [
      session('ses-1', '/a', 100),
      session('ses-2', '/b', 200),
    ]

    const sorted = sortSessionsByActivity(sessions, new Map([['ses-1', 300]]))

    expect(sorted.map((item) => item.id)).toEqual(['ses-1', 'ses-2'])
  })

  it('uses session metadata only as a fallback when message activity is known', () => {
    const now = 1_000_000_000
    const sessions = [
      session('ses-known-old', '/a', now - 10),
      session('ses-fallback', '/b', now - 20),
    ]
    const oldMessageAt = now - RECENT_SESSION_MAX_AGE_MS - 1
    const messageActivity = new Map([['ses-known-old', oldMessageAt]])

    const recent = deriveRecentSessions(sessions, now, messageActivity)

    expect(recent.map((item) => item.id)).toEqual(['ses-fallback'])
  })
})

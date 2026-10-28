import { expect, test } from 'vitest'
import { arrivingState, homeProject, navigationUrl } from '../navigation.ts'
import type { FleetProject } from '../types.ts'

test('Fleet carries open and pin state across instances, then consumes it before a full reload', () => {
  const state = {
    open: false,
    pinned: true,
    homeUrl: 'https://home.example.test:4750/',
    homeName: 'ultimate',
    homeProjectId: 'home',
    homeMachine: 'studio',
    homePort: '4750',
  }
  const target = navigationUrl('https://project.example.test:4747/', state, state.homeUrl)
  const arrival = arrivingState(target)
  expect(arrival.state).toEqual(state)
  expect(arrival.cleanUrl).toBe('https://project.example.test:4747/')
  expect(arrivingState(arrival.cleanUrl).state).toBeUndefined()
})

test('home identity and awaiting count never fall through to the other current instance', () => {
  const current: FleetProject = {
    id: 'other',
    name: 'atlas',
    initials: 'at',
    current: true,
    inFlight: false,
    awaiting: 3,
    available: true,
    url: '/',
  }
  const original: FleetProject = {
    ...current,
    id: 'home',
    name: 'ultimate',
    current: false,
    awaiting: 1,
    url: 'https://home.example.test:4750/',
  }
  const state = {
    open: true,
    pinned: false,
    homeUrl: original.url!,
    homeName: 'ultimate',
    homeProjectId: 'home',
    homeMachine: 'studio',
    homePort: '4750',
  }
  const snapshot = {
    home: current,
    machines: [
      {
        id: 'studio',
        name: 'studio',
        shortName: 'ST',
        online: true,
        projects: [current, original],
      },
    ],
  }
  expect(homeProject(snapshot, state, 'https://other.example/')).toBe(original)
  // Opening through loopback and then navigating via the known published URL retains the same home instance.
  const published = { ...original, url: 'https://studio.example.test/ultimate/' }
  expect(
    homeProject(
      {
        ...snapshot,
        machines: [
          { ...snapshot.machines[0], id: 'tailscale:peer', projects: [current, published] },
        ],
      },
      { ...state, homeUrl: 'http://127.0.0.1:4750/' },
      'https://other.example/',
    ),
  ).toBe(published)
  expect(
    homeProject(
      snapshot,
      { ...state, homeProjectId: '', homeMachine: '' },
      'https://other.example/',
    ),
  ).toBe(current)
  const unavailable = homeProject({ home: current, machines: [] }, state, 'https://other.example/')
  expect(unavailable).toMatchObject({
    name: 'ultimate',
    port: '4750',
    awaiting: 0,
    available: false,
  })
})

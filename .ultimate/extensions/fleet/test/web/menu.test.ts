import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { FleetMenu } from '../../menu.tsx'
import type { FleetProject, FleetSnapshot } from '../../types.ts'

const project = (id: string, current: boolean, inFlight: boolean): FleetProject => ({
  id,
  name: id,
  initials: id.slice(0, 2),
  current,
  inFlight,
  awaiting: current ? 1 : 3,
  available: true,
  url: `https://${id}.example`,
})

test('one menu keeps current and offline projects non-actionable and marks only work in flight', () => {
  const current = project('ultimate', true, true)
  const snapshot: FleetSnapshot = {
    home: current,
    machines: [
      {
        id: 'studio',
        name: 'Studio',
        shortName: 'ST',
        online: true,
        projects: [current, project('docs', false, false)],
      },
      {
        id: 'air',
        name: 'Air',
        shortName: 'AIR',
        online: false,
        projects: [project('site', false, false)],
      },
    ],
  }
  for (const [open, pinned] of [
    [false, false],
    [true, false],
    [false, true],
  ]) {
    const markup = renderToStaticMarkup(
      createElement(FleetMenu, {
        snapshot,
        open,
        pinned,
        onToggleOpen: () => {},
        onTogglePin: () => {},
        onSelect: () => {},
      }),
    )
    expect(markup.match(/<nav\b/g)).toHaveLength(1)
    expect(markup).toContain(`data-expanded="${open || pinned}"`)
    expect(markup).toContain(`data-pinned="${pinned}"`)
    expect(markup.match(/class="in-flight"/g)).toHaveLength(1)
    expect(markup.match(/<button[^>]+class="project-row"/g)).toHaveLength(1)
    expect(markup).toContain('aria-current="page"')
    expect(markup).toContain('class="project-row offline"')
    expect(markup).toContain('class="count">1</span>')
    expect(markup.match(/<details[^>]+open=""/g)).toHaveLength(2)
  }
})

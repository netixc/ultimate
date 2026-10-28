import type { FleetProject, FleetSnapshot } from './types.ts'
import './fleet.css'

export interface FleetMenuProps {
  snapshot: FleetSnapshot
  open: boolean
  pinned: boolean
  onToggleOpen: () => void
  onTogglePin: () => void
  onSelect: (project: FleetProject) => void
}

export function FleetMenu({
  snapshot,
  open,
  pinned,
  onToggleOpen,
  onTogglePin,
  onSelect,
}: FleetMenuProps) {
  const expanded = open || pinned
  const nameCounts = new Map<string, number>()
  for (const machine of snapshot.machines) {
    for (const project of machine.projects) {
      nameCounts.set(project.name, (nameCounts.get(project.name) ?? 0) + 1)
    }
  }
  return (
    <div className="fleet-rail" data-expanded={expanded} data-pinned={pinned}>
      <nav className="fleet" aria-label="Fleet-projecten">
        <header className="fleet-head">
          <button
            type="button"
            className="fleet-toggle"
            title="Fleet openen of sluiten"
            aria-label="Fleet openen of sluiten"
            aria-expanded={expanded}
            onClick={onToggleOpen}
          >
            U
          </button>
          <span className="wordmark expanded">FLEET</span>
          <button
            type="button"
            className="pin expanded"
            title="Fleet vastzetten of losmaken"
            aria-label="Fleet vastzetten of losmaken"
            aria-pressed={pinned}
            onClick={onTogglePin}
          >
            {pinned ? 'unpin' : 'pin'}
          </button>
        </header>
        <div
          className="home-row"
          title={`${snapshot.home.name}${snapshot.home.port ? ` · :${snapshot.home.port}` : ''}`}
        >
          <span className="tile home-icon">⌂</span>
          <span className="home-copy expanded">
            {snapshot.home.name}
            {snapshot.home.port && <span className="port">:{snapshot.home.port}</span>}
          </span>
          {snapshot.home.awaiting > 0 && <span className="count">{snapshot.home.awaiting}</span>}
        </div>
        <div className="fleet-groups">
          {snapshot.machines.map((machine) => (
            <details className="machine" key={machine.id} open>
              <summary aria-label={`${machine.name}-projecten inklappen of uitklappen`}>
                <span className="compact">{machine.shortName}</span>
                <span className="machine-name">
                  <span className={`dot${machine.online === true ? '' : ' off'}`} />
                  {machine.name}
                  {machine.eye === true && <span className="eye" aria-hidden="true" />}
                </span>
                {machine.online === false && (
                  <span className="machine-status expanded">offline</span>
                )}
              </summary>
              {machine.projects.map((project) => {
                const available = machine.online !== false && project.available && !!project.url
                const className = `project-row${project.current ? ' current' : ''}${available ? '' : ' offline'}`
                const content = (
                  <>
                    <span className="tile">{project.initials}</span>
                    <span className="project-copy">
                      {project.name}
                      {project.port && (
                        <span className="port">
                          {(nameCounts.get(project.name) ?? 0) > 1 &&
                            `${machine.name.toLowerCase()} `}
                          :{project.port}
                        </span>
                      )}
                    </span>
                    {project.inFlight && <span className="in-flight" />}
                  </>
                )
                return available && !project.current ? (
                  <button
                    type="button"
                    className={className}
                    key={project.id}
                    title={`Kies ${project.name} op ${machine.name}`}
                    onClick={() => onSelect(project)}
                  >
                    {content}
                  </button>
                ) : (
                  <div
                    className={className}
                    key={project.id}
                    aria-current={project.current ? 'page' : undefined}
                    aria-disabled={!available || undefined}
                    title={
                      !available
                        ? machine.online === false
                          ? 'Machine offline — dit project is niet beschikbaar'
                          : 'Dit project is niet beschikbaar'
                        : `${project.name} · ${machine.name} · geselecteerd`
                    }
                  >
                    {content}
                  </div>
                )
              })}
            </details>
          ))}
        </div>
        <footer className="fleet-footer" aria-hidden="true" />
      </nav>
    </div>
  )
}

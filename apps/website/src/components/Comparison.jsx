import { useScrollAnimation } from '../hooks/useScrollAnimation'

const Check = () => (
  <span style={{
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 22, height: 22, borderRadius: '50%',
    background: 'rgba(22,160,90,0.12)',
    color: 'var(--green)', fontSize: '0.78rem', fontWeight: 700,
  }}>✓</span>
)

const Dash = () => (
  <span style={{
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 22, height: 22, borderRadius: '50%',
    background: 'rgba(28,26,22,0.04)',
    color: 'var(--subtle)', fontSize: '0.9rem', fontWeight: 700,
  }}>–</span>
)

const Note = ({ children }) => (
  <span style={{
    fontSize: '0.78rem', color: 'var(--muted)',
    fontStyle: 'italic', whiteSpace: 'nowrap',
  }}>{children}</span>
)

const TOOLS = [
  { name: 'Chromeflow', src: '/chromeflow.png', highlight: true, height: 41, blendMultiply: true, textBelow: true },
  { name: 'Playwright', src: '/playwright.png', height: 75, blendMultiply: true },
  { name: 'Browser Use', src: '/browseruse.png', height: 48, blendMultiply: true },
  { name: 'Computer Use', src: '/computeruse.webp', height: 36, textNext: true },
  { name: 'Stagehand', src: '/browserbase.svg', height: 24 },
]

// Order matches TOOLS above. Use 'check', 'dash', or a JSX-friendly note string.
const ROWS = [
  {
    label: 'Built for',
    cells: [
      'Real one-off setup work',
      'Test automation',
      'Autonomous AI tasks',
      'Generic computer control',
      'Autonomous AI tasks',
    ],
  },
  {
    label: 'Has your codebase context',
    cells: ['check', 'dash', 'dash', 'dash', 'dash'],
    sublabels: ['via Claude Code', null, null, null, null],
  },
  {
    label: 'Reads page DOM (not screenshots)',
    cells: ['check', 'check', 'dash', 'dash', 'dash'],
    sublabels: [null, null, 'token-heavy', 'token-heavy', 'token-heavy'],
  },
  {
    label: 'Runs in your real Chrome',
    cells: ['check', 'dash', 'dash', 'dash', 'dash'],
    sublabels: [null, 'headless', 'sandboxed', 'VM', 'cloud browser'],
  },
  {
    label: 'Uses your existing logins',
    cells: ['check', 'dash', 'dash', 'dash', 'dash'],
  },
  {
    label: 'Pauses for 2FA / passwords / payments',
    cells: ['check', 'dash', 'dash', 'dash', 'dash'],
  },
  {
    label: 'Writes API keys to .env',
    cells: ['check', 'dash', 'dash', 'dash', 'dash'],
  },
]

const renderCell = (cell, highlight) => {
  if (cell === 'check') return <Check />
  if (cell === 'dash') return <Dash />
  return (
    <span style={{
      fontSize: '0.82rem',
      color: highlight ? 'var(--amber)' : 'var(--muted)',
      fontWeight: highlight ? 600 : 500,
    }}>
      {cell}
    </span>
  )
}

export default function Comparison() {
  const ref = useScrollAnimation()

  return (
    <section ref={ref} style={{
      borderTop: '1px solid var(--border)',
      padding: '5rem 0',
      background: 'var(--surface-2)',
    }}>
      <div className="wrap">
        <p className="fade-up" style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '0.7rem', letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--amber)',
          marginBottom: '0.75rem',
        }}>
          Comparison
        </p>
        <h2 className="fade-up delay-1" style={{
          fontSize: 'clamp(1.9rem, 3.5vw, 2.8rem)',
          fontWeight: 700, letterSpacing: '-0.025em',
          marginBottom: '0.75rem',
        }}>
          How is this different from Playwright?
        </h2>
        <p className="fade-up delay-1" style={{
          fontSize: '1rem', color: 'var(--muted)',
          maxWidth: 720, marginBottom: '2.5rem', lineHeight: 1.6,
        }}>
          Most browser-automation tools were built to run tests or autonomous agents in a
          sandboxed browser. Chromeflow drives <em>your</em> browser, with your sessions,
          and pauses for the parts a human needs to do.
        </p>

        <div className="fade-up delay-2" style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow)',
          overflow: 'hidden',
        }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{
              width: '100%', borderCollapse: 'collapse',
              minWidth: 720,
            }}>
              <thead>
                <tr>
                  <th style={{
                    textAlign: 'left',
                    padding: '1.1rem 1.25rem',
                    fontSize: '0.7rem', letterSpacing: '0.1em',
                    textTransform: 'uppercase', color: 'var(--muted)',
                    fontWeight: 600,
                    borderBottom: '1px solid var(--border)',
                    background: 'var(--surface-2)',
                  }}>
                    Capability
                  </th>
                  {TOOLS.map((tool, i) => (
                    <th key={tool.name} style={{
                      textAlign: 'center',
                      padding: '1.1rem 1rem',
                      fontSize: '0.85rem',
                      fontWeight: 700,
                      letterSpacing: '-0.01em',
                      color: tool.highlight ? 'var(--amber)' : 'var(--text)',
                      borderBottom: tool.highlight
                        ? '2px solid var(--amber)'
                        : '1px solid var(--border)',
                      borderLeft: i === 0 ? '1px solid var(--border)' : 'none',
                      background: tool.highlight ? 'var(--amber-glow)' : 'var(--surface-2)',
                      whiteSpace: 'nowrap',
                      minWidth: 130,
                    }}>
                      <div style={{
                        display: 'flex',
                        flexDirection: tool.textBelow ? 'column' : 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: tool.textBelow ? '0.35rem' : '0.5rem',
                        minHeight: 72,
                      }}>
                        <img
                          src={tool.src}
                          alt={tool.name}
                          style={{
                            height: tool.height,
                            maxWidth: 160,
                            width: 'auto',
                            objectFit: 'contain',
                            display: 'block',
                            mixBlendMode: tool.blendMultiply ? 'multiply' : 'normal',
                          }}
                        />
                        {(tool.textNext || tool.textBelow) && (
                          <span style={{
                            fontSize: '0.95rem',
                            fontWeight: 700,
                            color: tool.highlight ? 'var(--amber)' : 'var(--text)',
                          }}>{tool.name}</span>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row, rIdx) => (
                  <tr key={row.label}>
                    <td style={{
                      padding: '0.9rem 1.25rem',
                      fontSize: '0.9rem',
                      color: 'var(--text)',
                      fontWeight: 500,
                      borderBottom: rIdx === ROWS.length - 1
                        ? 'none'
                        : '1px solid var(--border)',
                    }}>
                      {row.label}
                    </td>
                    {row.cells.map((cell, cIdx) => {
                      const tool = TOOLS[cIdx]
                      return (
                        <td key={cIdx} style={{
                          padding: '0.9rem 1rem',
                          textAlign: 'center',
                          verticalAlign: 'middle',
                          borderBottom: rIdx === ROWS.length - 1
                            ? 'none'
                            : '1px solid var(--border)',
                          borderLeft: cIdx === 0 ? '1px solid var(--border)' : 'none',
                          background: tool.highlight ? 'var(--amber-glow)' : 'transparent',
                        }}>
                          <div style={{
                            display: 'flex', flexDirection: 'column',
                            alignItems: 'center', gap: '0.2rem',
                          }}>
                            {renderCell(cell, tool.highlight)}
                            {row.sublabels && row.sublabels[cIdx] && (
                              <Note>{row.sublabels[cIdx]}</Note>
                            )}
                          </div>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p className="fade-up delay-3" style={{
          fontSize: '0.85rem', color: 'var(--muted)',
          marginTop: '1.5rem', lineHeight: 1.6,
          maxWidth: 720,
        }}>
          Playwright and Stagehand are great for what they're for — automated tests and
          autonomous cloud agents. Chromeflow is for the human-in-the-loop work in between:
          when you'd rather not paste a 12-step setup guide into Claude and tab-switch all
          afternoon.
        </p>
      </div>
    </section>
  )
}

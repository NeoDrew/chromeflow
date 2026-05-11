import { useState } from 'react'
import { useScrollAnimation } from '../hooks/useScrollAnimation'

const CMDS = [
  '/plugin marketplace add NeoDrew/chromeflow',
  '/plugin install chromeflow',
]

const CopyCommand = () => {
  const [copiedIdx, setCopiedIdx] = useState(-1)
  const [firstDone, setFirstDone] = useState(false)

  const copy = (idx) => {
    navigator.clipboard.writeText(CMDS[idx]).then(() => {
      setCopiedIdx(idx)
      if (idx === 0) setFirstDone(true)
      setTimeout(() => setCopiedIdx((curr) => (curr === idx ? -1 : curr)), 1500)
    })
  }

  const mono = 'JetBrains Mono, monospace'
  const dim = 'rgba(232,226,216,0.55)'

  return (
    <div style={{
      background: '#1a1814',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 10,
      fontFamily: mono,
      fontSize: '0.78rem',
      color: '#e8e2d8',
      lineHeight: 1.5,
      overflow: 'hidden',
    }}>
      {/* Claude Code header */}
      <div style={{
        display: 'flex', gap: '0.85rem', alignItems: 'flex-start',
        padding: '0.85rem 1rem 0.7rem 1rem',
      }}>
        <pre style={{
          margin: 0,
          color: 'var(--amber)',
          fontFamily: mono,
          fontSize: '0.78rem',
          lineHeight: 1.15,
          whiteSpace: 'pre',
        }}>{` ▐▛███▜▌\n▝▜█████▛▘\n  ▘▘ ▝▝`}</pre>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.05rem' }}>
          <span>Claude Code <span style={{ color: dim }}>v2.1.138</span></span>
          <span style={{ color: dim }}>Opus 4.7 (1M context) with high effort · Claude Max</span>
          <span style={{ color: dim }}>~/dev/chromeflow</span>
        </div>
      </div>

      {/* Prompt frame mimicking Claude Code's input box */}
      <div style={{
        borderTop: '1px solid rgba(255,255,255,0.1)',
        borderBottom: '1px solid rgba(255,255,255,0.1)',
        padding: '0.75rem 1rem',
        display: 'flex', flexDirection: 'column', gap: '0.4rem',
      }}>
        {CMDS.map((cmd, idx) => {
          const isCopied = copiedIdx === idx
          const dimmed = idx === 0 && firstDone && !isCopied
          const highlighted = idx === 1 && firstDone && !isCopied

          let bg = 'rgba(255,255,255,0.07)'
          let border = 'rgba(255,255,255,0.1)'
          let color = 'rgba(255,255,255,0.6)'
          let shadow = 'none'
          let weight = 400

          if (isCopied) {
            bg = 'rgba(22,160,90,0.18)'
            border = 'rgba(22,160,90,0.35)'
            color = '#28c840'
          } else if (highlighted) {
            bg = 'linear-gradient(135deg, var(--amber), var(--orange))'
            border = 'rgba(217,119,6,0)'
            color = '#fff'
            shadow = '0 2px 8px rgba(217,119,6,0.3)'
            weight = 700
          } else if (dimmed) {
            bg = 'rgba(255,255,255,0.03)'
            border = 'rgba(255,255,255,0.06)'
            color = 'rgba(255,255,255,0.3)'
          }

          return (
            <div key={cmd} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: '0.75rem',
            }}>
              <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ color: 'var(--amber)', marginRight: '0.6rem' }}>❯</span>
                <span>{cmd}</span>
              </div>
              <button
                onClick={() => copy(idx)}
                style={{
                  flexShrink: 0,
                  background: bg,
                  border: `1px solid ${border}`,
                  borderRadius: 6,
                  padding: '0.3rem 0.75rem',
                  fontFamily: mono,
                  fontSize: '0.7rem',
                  fontWeight: weight,
                  color,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  letterSpacing: '0.02em',
                  boxShadow: shadow,
                }}
              >
                {isCopied ? '✓ copied' : `copy ${idx === 0 ? 'first' : 'second'}`}
              </button>
            </div>
          )
        })}
      </div>

      {/* Status bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '1rem',
        padding: '0.5rem 1rem',
        fontSize: '0.7rem',
        color: dim,
      }}>
        <span>
          <span style={{ color: 'var(--amber)' }}>⏵⏵</span> bypass permissions on{' '}
          <span style={{ opacity: 0.7 }}>(shift+tab to cycle)</span>
        </span>
        <span>
          <span style={{ color: '#28c840' }}>●</span> high · /effort
        </span>
      </div>
    </div>
  )
}

const StepNum = ({ n }) => (
  <div style={{
    width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
    background: 'linear-gradient(135deg, var(--amber), var(--orange))',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'JetBrains Mono, monospace',
    fontWeight: 700, fontSize: '0.82rem', color: '#fff',
    boxShadow: '0 2px 8px rgba(217,119,6,0.25)',
  }}>
    {n}
  </div>
)

export default function Setup() {
  const ref = useScrollAnimation()

  return (
    <section ref={ref} id="setup" style={{
      borderTop: '1px solid var(--border)',
      borderBottom: '1px solid var(--border)',
      padding: '7.5rem 0',
      background: 'var(--surface-2)',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: 'url(/octoMinecraft.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          opacity: 0.32,
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
      <div className="wrap" style={{ position: 'relative', zIndex: 1 }}>
        <p className="fade-up" style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '0.7rem', letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--amber)',
          marginBottom: '0.75rem',
          width: 'fit-content',
          background: 'rgba(255,255,255,0.92)',
          padding: '0.45rem 0.85rem',
          borderRadius: '6px',
          boxShadow: '0 1px 6px rgba(0,0,0,0.06)',
        }}>Installation</p>
        <h2 className="fade-up" style={{
          fontSize: 'clamp(1.8rem, 3vw, 2.4rem)',
          fontWeight: 700, letterSpacing: '-0.025em',
          marginBottom: '2.5rem',
          width: 'fit-content',
          background: 'rgba(255,255,255,0.92)',
          padding: '0.5rem 1.1rem',
          borderRadius: '10px',
          boxShadow: '0 1px 8px rgba(0,0,0,0.08)',
          transitionDelay: '0.35s',
        }}>
          Two steps. That's it.
        </h2>

        <div className="cols-2" style={{ gap: '1.25rem' }}>

          {/* Step 1 */}
          <div className="fade-up" style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)', padding: '1.75rem',
            boxShadow: 'var(--shadow)',
            display: 'flex', flexDirection: 'column',
            transitionDelay: '0.75s',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
              <StepNum n="1" />
              <h3 style={{ fontWeight: 700, fontSize: '1.05rem', letterSpacing: '-0.01em' }}>
                Install the Claude Code plugin
              </h3>
            </div>
            <div style={{ marginTop: 'auto' }}>
              <CopyCommand />
            </div>
          </div>

          {/* Step 2 */}
          <div className="fade-up" style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)', padding: '1.75rem',
            boxShadow: 'var(--shadow)',
            display: 'flex', flexDirection: 'column',
            transitionDelay: '1.15s',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
              <StepNum n="2" />
              <h3 style={{ fontWeight: 700, fontSize: '1.05rem', letterSpacing: '-0.01em' }}>
                Install the Chrome extension
              </h3>
            </div>

            {/* Web-Store-style listing block */}
            <div style={{
              display: 'flex', gap: '1rem', alignItems: 'center',
              padding: '0.9rem',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              marginBottom: '0.9rem',
            }}>
              <img
                src="/chromeflow.png"
                alt="Chromeflow"
                width="64"
                height="64"
                style={{
                  flexShrink: 0,
                  borderRadius: 14,
                  boxShadow: '0 2px 10px rgba(0,0,0,0.08)',
                }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: '1.05rem', letterSpacing: '-0.01em' }}>Chromeflow</span>
                  <span style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: '0.7rem',
                    color: 'var(--muted)',
                  }}>v0.7.1</span>
                </div>
                <p style={{ fontSize: '0.83rem', color: 'var(--muted)', margin: '0.15rem 0 0.5rem', lineHeight: 1.4 }}>
                  Guided web assistance for Claude Code
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                  {['Free', 'Manifest V3', 'Open source'].map(chip => (
                    <span key={chip} style={{
                      fontSize: '0.66rem',
                      fontFamily: 'JetBrains Mono, monospace',
                      letterSpacing: '0.02em',
                      color: 'var(--amber)',
                      background: 'rgba(217,119,6,0.08)',
                      border: '1px solid rgba(217,119,6,0.2)',
                      borderRadius: 999,
                      padding: '0.15rem 0.5rem',
                    }}>{chip}</span>
                  ))}
                </div>
              </div>
            </div>

            {/* After-install preview */}
            <div style={{ marginBottom: '1rem' }}>
              <div style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '0.62rem',
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--muted)',
                marginBottom: '0.4rem',
              }}>
                After install — pinned in your toolbar
              </div>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.3rem',
                padding: '0.4rem 0.5rem',
                background: '#fff',
                border: '1px solid var(--border)',
                borderRadius: 10,
                boxShadow: 'inset 0 -1px 0 rgba(0,0,0,0.04)',
              }}>
                {['‹', '›', '↻'].map((g, i) => (
                  <span key={i} style={{
                    width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.85rem', color: 'rgba(0,0,0,0.45)',
                  }}>{g}</span>
                ))}
                <div style={{
                  flex: 1, minWidth: 0,
                  display: 'flex', alignItems: 'center', gap: '0.35rem',
                  padding: '0.25rem 0.6rem',
                  background: 'rgba(0,0,0,0.045)',
                  borderRadius: 999,
                  fontSize: '0.72rem',
                  color: 'rgba(0,0,0,0.55)',
                }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <rect x="4" y="11" width="16" height="10" rx="2" />
                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                  </svg>
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    google.com
                  </span>
                </div>
                {/* Extensions puzzle icon */}
                <span style={{
                  width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.95rem', color: 'rgba(0,0,0,0.4)',
                }}>⊞</span>
                {/* Pinned Chromeflow icon — pulses to draw the eye */}
                <div
                  className="cf-pin"
                  style={{
                    flexShrink: 0,
                    width: 26, height: 26, borderRadius: 7,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(217,119,6,0.1)',
                  }}
                >
                  <img src="/chromeflow.png" alt="" width="18" height="18" style={{ display: 'block' }} />
                </div>
                {/* Avatar */}
                <div style={{
                  flexShrink: 0,
                  width: 22, height: 22, borderRadius: '50%',
                  background: 'linear-gradient(135deg,#cbd5e1,#94a3b8)',
                  marginLeft: '0.15rem',
                }} />
              </div>
            </div>

            <a
              href="https://chromewebstore.google.com/detail/chromeflow/lkdchdgkbkodliefobkkhiegjdiidime"
              target="_blank"
              rel="noreferrer"
              style={{
                marginTop: 'auto',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.6rem',
                width: '100%', padding: '0.9rem 1.5rem',
                background: 'linear-gradient(135deg, var(--amber), var(--orange))',
                border: 'none',
                borderRadius: 'var(--radius)', color: '#fff',
                fontWeight: 700, fontSize: '1rem', textDecoration: 'none',
                boxShadow: '0 2px 12px rgba(217,119,6,0.35)',
                transition: 'opacity 0.15s, transform 0.15s',
                boxSizing: 'border-box',
              }}
              onMouseEnter={e => { e.currentTarget.style.opacity = '0.9'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
              onMouseLeave={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.transform = 'translateY(0)'; }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="4" fill="white"/>
                <path d="M12 2C10.07 2 8.28 2.61 6.82 3.64L10.18 9.5C10.74 9.19 11.35 9 12 9H21.93C21.44 5.05 17.08 2 12 2Z" fill="white"/>
                <path d="M2.46 8.5C1.54 9.55 1 10.91 1 12.39C1 15.57 3.14 18.26 6.09 19.24L9.45 13.38C9.17 12.96 9 12.5 9 12C9 11.37 9.22 10.79 9.59 10.32L2.46 8.5Z" fill="rgba(255,255,255,0.7)"/>
                <path d="M12 15C13.66 15 15 13.66 15 12C15 11.67 14.94 11.35 14.83 11.06L18.59 4.59C20.69 6.06 22 8.35 22 12C22 17.52 17.52 22 12 22C9.8 22 7.78 21.27 6.17 20.05L9.53 14.19C10.24 14.69 11.09 15 12 15Z" fill="rgba(255,255,255,0.85)"/>
              </svg>
              Add to Chrome
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}

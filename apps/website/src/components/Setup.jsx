import { useState } from 'react'
import { useScrollAnimation } from '../hooks/useScrollAnimation'

const CMD = 'npx chromeflow setup'

const CopyCommand = () => {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    navigator.clipboard.writeText(CMD).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '1rem',
      background: '#1a1814',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 10,
      padding: '0.85rem 1rem 0.85rem 1.2rem',
    }}>
      <span style={{
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: '0.92rem',
        color: '#e8e2d8',
        letterSpacing: '-0.01em',
      }}>
        <span style={{ color: 'var(--amber)', marginRight: '0.5rem' }}>$</span>
        {CMD}
      </span>
      <button
        onClick={copy}
        style={{
          flexShrink: 0,
          background: copied ? 'rgba(22,160,90,0.15)' : 'rgba(255,255,255,0.07)',
          border: `1px solid ${copied ? 'rgba(22,160,90,0.3)' : 'rgba(255,255,255,0.1)'}`,
          borderRadius: 6,
          padding: '0.35rem 0.75rem',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '0.72rem',
          color: copied ? '#28c840' : 'rgba(255,255,255,0.45)',
          cursor: 'pointer',
          transition: 'all 0.15s',
          letterSpacing: '0.02em',
        }}
      >
        {copied ? '✓ copied' : 'copy'}
      </button>
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
      padding: '5rem 0',
      background: 'var(--surface-2)',
    }}>
      <div className="wrap">
        <p className="fade-up" style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '0.7rem', letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--amber)',
          marginBottom: '0.75rem',
        }}>Installation</p>
        <h2 className="fade-up delay-1" style={{
          fontSize: 'clamp(1.8rem, 3vw, 2.4rem)',
          fontWeight: 700, letterSpacing: '-0.025em',
          marginBottom: '2.5rem',
        }}>
          Two steps. That's it.
        </h2>

        <div className="fade-up delay-2 cols-2" style={{ gap: '1.25rem' }}>

          {/* Step 1 */}
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)', padding: '1.75rem',
            boxShadow: 'var(--shadow)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
              <StepNum n="1" />
              <h3 style={{ fontWeight: 700, fontSize: '1.05rem', letterSpacing: '-0.01em' }}>
                Run this command
              </h3>
            </div>
            <p style={{ fontSize: '0.88rem', color: 'var(--muted)', marginBottom: '1.1rem', lineHeight: 1.6 }}>
              From your project directory. Registers the MCP server and writes Claude's instructions into your project.
            </p>
            <CopyCommand />
          </div>

          {/* Step 2 */}
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)', padding: '1.75rem',
            boxShadow: 'var(--shadow)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
              <StepNum n="2" />
              <h3 style={{ fontWeight: 700, fontSize: '1.05rem', letterSpacing: '-0.01em' }}>
                Install the Chrome extension
              </h3>
            </div>
            <p style={{ fontSize: '0.88rem', color: 'var(--muted)', marginBottom: '1.5rem', lineHeight: 1.6 }}>
              One time. Persists across Chrome restarts.
            </p>

            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <a
                href="https://chromewebstore.google.com/detail/chromeflow/lkdchdgkbkodliefobkkhiegjdiidime"
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.6rem',
                  width: '100%', padding: '0.9rem 1.5rem',
                  background: 'linear-gradient(135deg, var(--amber), var(--orange))',
                  border: 'none',
                  borderRadius: 'var(--radius)', color: '#fff',
                  fontWeight: 700, fontSize: '1rem', textDecoration: 'none',
                  boxShadow: '0 2px 12px rgba(217,119,6,0.35)',
                  transition: 'opacity 0.15s, transform 0.15s',
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
                Add to Chrome — It's Free
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

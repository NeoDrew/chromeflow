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

        <div className="fade-up delay-2" style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr',
          gap: '1.25rem',
        }}>

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

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {[
                ['Open', <><code>chrome://extensions</code> in Chrome</>],
                ['Enable', <><strong style={{ color: 'var(--text)' }}>Developer mode</strong> (top-right toggle)</>],
                ['Click', <><strong style={{ color: 'var(--text)' }}>Load unpacked</strong> and select the <code>extension/dist</code> path printed above</>],
              ].map(([verb, rest], i) => (
                <div key={i} style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
                  <div style={{
                    width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                    background: 'var(--amber-dim)', border: '1px solid rgba(217,119,6,0.2)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem',
                    color: 'var(--amber)', fontWeight: 700, marginTop: 2,
                  }}>
                    {i + 1}
                  </div>
                  <p style={{ fontSize: '0.88rem', color: 'var(--muted)', lineHeight: 1.55 }}>
                    <strong style={{ color: 'var(--amber)' }}>{verb}</strong> {rest}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

import { useScrollAnimation } from '../hooks/useScrollAnimation'

const TrafficLights = () => (
  <div style={{ display: 'flex', gap: '0.4rem' }}>
    <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#ff5f57' }} />
    <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#febc2e' }} />
    <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#28c840' }} />
  </div>
)

const TerminalWindow = ({ title = 'claude', children }) => (
  <div style={{
    borderRadius: 12, overflow: 'hidden',
    border: '1px solid rgba(0,0,0,0.22)',
    boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
  }}>
    <div style={{
      background: '#2d2d2d', padding: '0.55rem 1rem',
      display: 'flex', alignItems: 'center', gap: '0.75rem',
      borderBottom: '1px solid rgba(255,255,255,0.06)',
    }}>
      <TrafficLights />
      <span style={{
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: '0.68rem', color: '#888',
      }}>{title}</span>
    </div>
    <div style={{
      background: '#1a1a1a', padding: '1rem 1.2rem',
      fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem',
      lineHeight: 1.7, minHeight: 130,
    }}>
      {children}
    </div>
  </div>
)

const BrowserWindow = ({ url, children }) => (
  <div style={{
    borderRadius: 12, overflow: 'hidden',
    border: '1px solid rgba(0,0,0,0.1)',
    boxShadow: '0 8px 32px rgba(0,0,0,0.1)',
  }}>
    <div style={{
      background: '#f0ede9', padding: '0.55rem 1rem',
      display: 'flex', alignItems: 'center', gap: '0.75rem',
      borderBottom: '1px solid rgba(0,0,0,0.08)',
    }}>
      <TrafficLights />
      <div style={{
        flex: 1, background: '#fff', borderRadius: 6,
        padding: '0.2rem 0.7rem',
        fontSize: '0.68rem', color: '#888',
        fontFamily: 'JetBrains Mono, monospace',
        border: '1px solid rgba(0,0,0,0.08)',
      }}>
        {url}
      </div>
    </div>
    <div style={{ background: '#fff', padding: '1rem 1.2rem', minHeight: 130 }}>
      {children}
    </div>
  </div>
)

const Line = ({ color = '#555', children }) => (
  <div style={{ color }}>{children}</div>
)

const SwitchBadge = ({ label }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: '0.5rem',
    padding: '0.5rem 0',
  }}>
    <div style={{ flex: 1, height: 1, background: 'var(--red-border)' }} />
    <span style={{
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: '0.65rem', letterSpacing: '0.08em',
      color: 'var(--red-accent)', fontWeight: 600,
      textTransform: 'uppercase', whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
    <div style={{ flex: 1, height: 1, background: 'var(--red-border)' }} />
  </div>
)

const ControlsBadge = () => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: '0.5rem',
    padding: '0.5rem 0',
  }}>
    <div style={{ flex: 1, height: 1, background: 'var(--green-border)' }} />
    <span style={{
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: '0.65rem', letterSpacing: '0.08em',
      color: 'var(--green)', fontWeight: 600,
      textTransform: 'uppercase', whiteSpace: 'nowrap',
    }}>
      Claude controls Chrome ↓
    </span>
    <div style={{ flex: 1, height: 1, background: 'var(--green-border)' }} />
  </div>
)

export default function BeforeAfter() {
  const ref = useScrollAnimation()

  return (
    <section ref={ref} style={{
      borderTop: '1px solid var(--border)',
      padding: '5rem 0',
    }}>
      <div className="wrap">
        <p className="fade-up" style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '0.7rem', letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--amber)',
          marginBottom: '0.75rem',
        }}>
          The difference
        </p>
        <h2 className="fade-up delay-1" style={{
          fontSize: 'clamp(1.9rem, 3.5vw, 2.8rem)',
          fontWeight: 700, letterSpacing: '-0.025em',
          marginBottom: '2.5rem',
        }}>
          Before and after.
        </h2>

        <div className="fade-up delay-2" style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr',
          gap: '1.5rem',
        }}>

          {/* ── Before ── */}
          <div style={{
            background: 'var(--red-bg)',
            border: '1px solid var(--red-border)',
            borderRadius: 'var(--radius-lg)',
            padding: '1.75rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.25rem' }}>
              <span style={{ fontSize: '0.95rem' }}>😮‍💨</span>
              <span style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '0.7rem', letterSpacing: '0.1em',
                textTransform: 'uppercase', color: 'var(--red-accent)', fontWeight: 600,
              }}>Before</span>
            </div>

            <TerminalWindow>
              <Line color="#888"># you ask Claude</Line>
              <Line color="#e8e2d8">{'>'} set up Stripe for this project</Line>
              <div style={{ marginTop: '0.5rem' }}>
                <Line color="#aaa">Here are the steps to follow:</Line>
                <Line color="#777">1. Go to stripe.com/dashboard</Line>
                <Line color="#777">2. Click Products → Create product</Line>
                <Line color="#777">3. Copy the price ID</Line>
                <Line color="#777">4. Paste into .env manually</Line>
              </div>
            </TerminalWindow>

            <SwitchBadge label="⟷ switch to Chrome" />

            <BrowserWindow url="dashboard.stripe.com/products/create">
              <div style={{ fontSize: '0.8rem', color: '#333' }}>
                <div style={{ fontWeight: 600, marginBottom: '0.75rem', color: '#444' }}>Create a product</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.72rem', color: '#888', width: 60 }}>Name</span>
                    <div style={{ flex: 1, height: 26, border: '1px solid #ddd', borderRadius: 4, background: '#fafafa' }} />
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.72rem', color: '#888', width: 60 }}>Price</span>
                    <div style={{ flex: 1, height: 26, border: '1px solid #ddd', borderRadius: 4, background: '#fafafa' }} />
                  </div>
                  <div style={{ color: '#999', fontSize: '0.72rem', marginTop: '0.25rem', fontStyle: 'italic' }}>
                    wait, what was step 3 again?
                  </div>
                </div>
              </div>
            </BrowserWindow>

            <SwitchBadge label="⟷ switch back to Claude" />
            <SwitchBadge label="⟷ switch to Chrome again" />

            <div style={{
              marginTop: '0.75rem',
              display: 'flex', alignItems: 'center', gap: '0.5rem',
            }}>
              <span style={{ fontSize: '0.9rem' }}>⏱</span>
              <span style={{ fontSize: '0.82rem', color: 'var(--red-accent)', fontWeight: 600 }}>
                10–20 minutes of context-switching
              </span>
            </div>
          </div>

          {/* ── After ── */}
          <div style={{
            background: 'var(--green-bg)',
            border: '1px solid var(--green-border)',
            borderRadius: 'var(--radius-lg)',
            padding: '1.75rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.25rem' }}>
              <span style={{ fontSize: '0.95rem' }}>⚡</span>
              <span style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '0.7rem', letterSpacing: '0.1em',
                textTransform: 'uppercase', color: 'var(--green)', fontWeight: 600,
              }}>With Chromeflow</span>
            </div>

            <TerminalWindow>
              <Line color="#888"># you ask Claude</Line>
              <Line color="#e8e2d8">{'>'} set up Stripe for this project</Line>
              <div style={{ marginTop: '0.5rem' }}>
                <Line color="#d97706">● Opening stripe.com/products...</Line>
                <Line color="#d97706">● Clicking "Create product"</Line>
                <Line color="#d97706">● Filling in "Pro Plan", £29/mo</Line>
                <Line color="#28c840">✓ STRIPE_PRICE_ID written to .env</Line>
              </div>
            </TerminalWindow>

            <ControlsBadge />

            <BrowserWindow url="dashboard.stripe.com/products/create">
              <div style={{ fontSize: '0.8rem', color: '#333' }}>
                <div style={{ fontWeight: 600, marginBottom: '0.75rem', color: '#444' }}>Create a product</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.72rem', color: '#888', width: 60 }}>Name</span>
                    <div style={{
                      flex: 1, height: 26, border: '1px solid rgba(22,160,90,0.4)', borderRadius: 4,
                      background: 'rgba(22,160,90,0.05)',
                      display: 'flex', alignItems: 'center', paddingLeft: 8,
                      fontSize: '0.75rem', color: '#333',
                    }}>Pro Plan</div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.72rem', color: '#888', width: 60 }}>Price</span>
                    <div style={{
                      flex: 1, height: 26, border: '1px solid rgba(22,160,90,0.4)', borderRadius: 4,
                      background: 'rgba(22,160,90,0.05)',
                      display: 'flex', alignItems: 'center', paddingLeft: 8,
                      fontSize: '0.75rem', color: '#333',
                    }}>£29 / month</div>
                  </div>
                  <div style={{
                    marginTop: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.4rem',
                    color: '#16a05a', fontSize: '0.72rem', fontWeight: 600,
                  }}>
                    <span>✓</span> Saved — Claude read the price ID
                  </div>
                </div>
              </div>
            </BrowserWindow>

            <div style={{
              marginTop: '1.25rem',
              display: 'flex', alignItems: 'center', gap: '0.5rem',
            }}>
              <span style={{ fontSize: '0.9rem' }}>🎯</span>
              <span style={{ fontSize: '0.82rem', color: 'var(--green)', fontWeight: 600 }}>
                You approved one thing. Maybe.
              </span>
            </div>
          </div>

        </div>
      </div>
    </section>
  )
}

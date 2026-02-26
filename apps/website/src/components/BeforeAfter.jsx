import { useScrollAnimation } from '../hooks/useScrollAnimation'

const Switch = ({ label }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: '0.6rem',
    padding: '0.3rem 0',
  }}>
    <div style={{ flex: 1, height: 1, background: 'var(--red-border)' }} />
    <span style={{
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: '0.66rem', letterSpacing: '0.08em',
      color: 'var(--red-accent)', fontWeight: 600,
      textTransform: 'uppercase',
    }}>
      {label}
    </span>
    <div style={{ flex: 1, height: 1, background: 'var(--red-border)' }} />
  </div>
)

const Step = ({ icon, text, dim }) => (
  <div style={{
    display: 'flex', alignItems: 'flex-start', gap: '0.75rem',
    padding: '0.7rem 0.85rem',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    opacity: dim ? 0.45 : 1,
  }}>
    <span style={{ fontSize: '0.95rem', flexShrink: 0, marginTop: 1 }}>{icon}</span>
    <span style={{ fontSize: '0.85rem', color: 'var(--text)', lineHeight: 1.45 }}>{text}</span>
  </div>
)

const PipeStep = ({ icon, text, highlight }) => (
  <div style={{
    display: 'flex', alignItems: 'flex-start', gap: '0.75rem',
    padding: '0.7rem 0.85rem',
    background: highlight ? 'var(--green-bg)' : 'var(--surface)',
    border: `1px solid ${highlight ? 'var(--green-border)' : 'var(--border)'}`,
    borderRadius: 8,
  }}>
    <span style={{ fontSize: '0.95rem', flexShrink: 0, marginTop: 1 }}>{icon}</span>
    <span style={{ fontSize: '0.85rem', color: highlight ? 'var(--green)' : 'var(--text)', lineHeight: 1.45 }}>{text}</span>
  </div>
)

const Arrow = ({ color = 'var(--subtle)' }) => (
  <div style={{ display: 'flex', justifyContent: 'center', padding: '0.15rem 0' }}>
    <span style={{ color, fontSize: '0.8rem' }}>↓</span>
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
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '1.25rem',
        }}>

          {/* ── Before ── */}
          <div style={{
            background: 'var(--red-bg)',
            border: '1px solid var(--red-border)',
            borderRadius: 'var(--radius-lg)',
            padding: '1.75rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem' }}>
              <span style={{ fontSize: '0.95rem' }}>😮‍💨</span>
              <span style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '0.7rem', letterSpacing: '0.1em',
                textTransform: 'uppercase', color: 'var(--red-accent)',
                fontWeight: 600,
              }}>Before</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <Step icon="💬" text={<>Ask Claude: <em style={{ color: 'var(--muted)' }}>"Set up Stripe for this project"</em></>} />
              <Arrow />
              <Step icon="📖" text="Claude gives you a list of manual steps to follow" />
              <Switch label="⟷ switch to Chrome" />
              <Step icon="🌐" text="Navigate to stripe.com, find the right section..." />
              <Step icon="🖱️" text="Click around, scroll, try to remember what step you're on" />
              <Switch label="⟷ switch back to Claude" />
              <Step icon="😕" text={<>Read the instructions again. <em style={{ color: 'var(--muted)' }}>"Wait, what was step 3?"</em></>} />
              <Switch label="⟷ switch to Chrome again" />
              <Step icon="📋" text="Manually copy the API key, paste it into .env" dim />
              <Step icon="🔁" text="Repeat for every key, every step, every service" dim />
            </div>

            <div style={{
              marginTop: '1.5rem', paddingTop: '1.25rem',
              borderTop: '1px solid var(--red-border)',
              display: 'flex', alignItems: 'center', gap: '0.5rem',
            }}>
              <span style={{ fontSize: '0.9rem' }}>⏱</span>
              <span style={{ fontSize: '0.82rem', color: 'var(--red-accent)', fontWeight: 600 }}>
                10–20 minutes of context-switching per task
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem' }}>
              <span style={{ fontSize: '0.95rem' }}>⚡</span>
              <span style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '0.7rem', letterSpacing: '0.1em',
                textTransform: 'uppercase', color: 'var(--green)',
                fontWeight: 600,
              }}>With Chromeflow</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <PipeStep icon="💬" text={<>Ask Claude: <em style={{ color: 'var(--muted)' }}>"Set up Stripe for this project"</em></>} />
              <Arrow color="var(--green)" />

              {/* Chromeflow box */}
              <div style={{
                background: 'rgba(22,160,90,0.04)',
                border: '1px solid var(--green-border)',
                borderRadius: 10, padding: '1rem',
              }}>
                <p style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: '0.66rem', letterSpacing: '0.1em',
                  textTransform: 'uppercase', color: 'var(--amber)',
                  fontWeight: 600, marginBottom: '0.75rem',
                }}>
                  ● Chromeflow
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  {[
                    ['🌐', 'Navigates to stripe.com'],
                    ['🖱️', 'Clicks through the product creation UI'],
                    ['✏️', 'Fills in names, prices, and settings'],
                    ['🔑', 'Reads STRIPE_KEY from the page'],
                    ['📄', 'Writes it directly to your .env'],
                  ].map(([icon, text]) => (
                    <div key={text} style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
                      <span style={{ fontSize: '0.85rem', flexShrink: 0 }}>{icon}</span>
                      <span style={{ fontSize: '0.82rem', color: 'var(--muted)', lineHeight: 1.4 }}>{text}</span>
                    </div>
                  ))}
                </div>
              </div>

              <Arrow color="var(--green)" />
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: '0.6rem', padding: '0.8rem',
                background: 'rgba(22,160,90,0.08)',
                border: '1px solid var(--green-border)',
                borderRadius: 8,
              }}>
                <span style={{ fontSize: '1rem' }}>✅</span>
                <span style={{ fontWeight: 700, color: 'var(--green)', fontSize: '0.9rem' }}>
                  Done — keys are in your .env
                </span>
              </div>
            </div>

            <div style={{
              marginTop: '1.5rem', paddingTop: '1.25rem',
              borderTop: '1px solid var(--green-border)',
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

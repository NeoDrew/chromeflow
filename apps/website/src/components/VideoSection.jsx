import { useScrollAnimation } from '../hooks/useScrollAnimation'

export default function VideoSection() {
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
          See it in action
        </p>
        <h2 className="fade-up delay-1" style={{
          fontSize: 'clamp(1.8rem, 3vw, 2.4rem)',
          fontWeight: 700, letterSpacing: '-0.025em',
          marginBottom: '2rem',
        }}>
          Watch Claude handle a full Stripe setup.
        </h2>

        {/* Video placeholder */}
        <div className="fade-up delay-2" style={{
          position: 'relative',
          width: '100%', paddingBottom: '56.25%',
          background: 'var(--surface)',
          border: '1px solid var(--border-2)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
          boxShadow: 'var(--shadow-lg)',
        }}>
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: '1.25rem',
          }}>
            {/* Play button */}
            <div style={{
              width: 72, height: 72, borderRadius: '50%',
              background: 'linear-gradient(135deg, var(--amber), var(--orange))',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 24px rgba(217,119,6,0.3)',
              cursor: 'default',
            }}>
              <span style={{ fontSize: '1.6rem', marginLeft: 4 }}>▶</span>
            </div>
            <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
              Demo video coming soon
            </p>
          </div>

          {/* Corner label */}
          <div style={{
            position: 'absolute', top: '1rem', left: '1rem',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: '0.65rem', letterSpacing: '0.08em',
            color: 'var(--subtle)',
            textTransform: 'uppercase',
          }}>
            Chromeflow · Demo
          </div>
        </div>
      </div>
    </section>
  )
}

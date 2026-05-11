import { useScrollAnimation } from '../hooks/useScrollAnimation'

export default function Demo() {
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
          Demo
        </p>
        <h2 className="fade-up delay-1" style={{
          fontSize: 'clamp(1.9rem, 3.5vw, 2.8rem)',
          fontWeight: 700, letterSpacing: '-0.025em',
          marginBottom: '2.5rem',
        }}>
          See it in action.
        </h2>

        <div className="fade-up delay-2" style={{
          borderRadius: 12, overflow: 'hidden',
          border: '1px solid rgba(0,0,0,0.1)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
          background: '#000',
        }}>
          <video
            src="/chromeflowDemo.mp4"
            autoPlay
            loop
            muted
            playsInline
            controls
            style={{ width: '100%', display: 'block' }}
          />
        </div>
      </div>
    </section>
  )
}

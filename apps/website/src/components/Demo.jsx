import { useScrollAnimation } from '../hooks/useScrollAnimation'

export default function Demo() {
  const ref = useScrollAnimation()

  return (
    <section ref={ref} style={{
      borderTop: '1px solid var(--border)',
      padding: '5rem 0',
    }}>
      <div className="wrap">
        <div className="fade-up" style={{
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

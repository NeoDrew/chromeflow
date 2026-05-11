import { useEffect, useRef } from 'react'
import { useScrollAnimation } from '../hooks/useScrollAnimation'

export default function Demo() {
  const ref = useScrollAnimation()
  const videoRef = useRef(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          video.play().catch(() => { /* autoplay-with-muted should be allowed; ignore the rare reject */ })
        } else {
          video.pause()
        }
      },
      { threshold: 0.6 }
    )

    observer.observe(video)
    return () => observer.disconnect()
  }, [])

  return (
    <section ref={ref} style={{
      borderTop: '1px solid var(--border)',
      padding: '5rem 0',
    }}>
      <div className="wrap">
        <p className="fade-up" style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '1.05rem', letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--amber)',
          marginBottom: '1rem',
          textAlign: 'center',
        }}>
          Posting a tweet using Claude Code × Chromeflow
        </p>
        <div className="fade-up delay-1" style={{
          borderRadius: 12, overflow: 'hidden',
          border: '1px solid rgba(0,0,0,0.1)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
          background: '#000',
        }}>
          <video
            ref={videoRef}
            src="/chromeflowDemo.mp4"
            loop
            muted
            playsInline
            controls
            preload="metadata"
            style={{ width: '100%', display: 'block' }}
          />
        </div>
      </div>
    </section>
  )
}

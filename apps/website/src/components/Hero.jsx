import { useEffect, useState } from 'react'

const OCTO_COUNT = 18
const SIZE_PX = 44

function randomOcto() {
  return {
    x: Math.random() * 100,
    y: Math.random() * 100,
    flipped: Math.random() > 0.5,
  }
}

function HeroOctos() {
  const [octos, setOctos] = useState(() =>
    Array.from({ length: OCTO_COUNT }, () => randomOcto())
  )

  useEffect(() => {
    const timeouts = []
    const intervals = []
    for (let i = 0; i < OCTO_COUNT; i++) {
      const period = 2700 + Math.random() * 600 // 2.7–3.3s
      // Random 0–3s offset before this octo's first move, then keep moving on its
      // own ~3s cadence. Decouples each octo's phase from every other one so they
      // never sync up.
      const initialDelay = Math.random() * 3000

      const moveOne = () => {
        setOctos((prev) => {
          const next = prev.slice()
          next[i] = randomOcto()
          return next
        })
      }

      const timeoutId = setTimeout(() => {
        moveOne()
        const intervalId = setInterval(moveOne, period)
        intervals.push(intervalId)
      }, initialDelay)
      timeouts.push(timeoutId)
    }
    return () => {
      timeouts.forEach(clearTimeout)
      intervals.forEach(clearInterval)
    }
  }, [])

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
        zIndex: 0,
      }}
    >
      {octos.map((octo, i) => (
        <img
          key={i}
          src="/claudeOcto.png"
          alt=""
          style={{
            position: 'absolute',
            left: `${octo.x}%`,
            top: `${octo.y}%`,
            width: `${SIZE_PX}px`,
            height: 'auto',
            transform: `translate(-50%, -50%) scaleX(${octo.flipped ? -1 : 1})`,
            transition:
              'left 2.4s cubic-bezier(0.4, 0, 0.2, 1), top 2.4s cubic-bezier(0.4, 0, 0.2, 1), transform 0.6s ease',
            opacity: 0.144,
            willChange: 'left, top, transform',
          }}
        />
      ))}
    </div>
  )
}

export default function Hero() {
  return (
    <section className="section-hero" style={{ position: 'relative', overflow: 'hidden' }}>
      <HeroOctos />
      <div className="wrap" style={{ maxWidth: 700, position: 'relative', zIndex: 1 }}>
        <p className="hero-el" style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '0.72rem', letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--amber)',
          marginBottom: '1.5rem',
        }}>
          MCP server · Chrome extension
        </p>
        <h1 className="hero-el" style={{
          fontSize: 'clamp(3rem, 6.5vw, 5rem)',
          fontWeight: 700, lineHeight: 1.35,
          letterSpacing: '-0.035em',
        }}>
          The Best{' '}
          <img
            src="/claudecode.png"
            alt="Claude Code"
            style={{
              display: 'inline-block',
              height: '1.4em',
              width: 'auto',
              verticalAlign: '-0.35em',
              borderRadius: '0.15em',
              margin: '0 0.15em',
            }}
          />
          <br />
          Plugin for
          <br />
          <img
            src="/googlechrome.png"
            alt="Google Chrome"
            style={{
              display: 'inline-block',
              height: '1.2em',
              width: 'auto',
              verticalAlign: '-0.22em',
              margin: '0 0.1em',
            }}
          />
        </h1>
      </div>
    </section>
  )
}

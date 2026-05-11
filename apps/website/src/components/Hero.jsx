import { useEffect, useRef, useState } from 'react'

const OCTO_COUNT = 36
const SIZE_PX = 44
const NEAREST_COUNT = 7
const JUMP_INTERVAL_MS = 500
const JUMP_LERP = 0.55          // each jump covers ~55% of the gap to the cursor
const JUMP_TRANSITION_MS = 450  // fast snap when triggered by the mouse
const DRIFT_TRANSITION_MS = 2400 // slow drift between random spots
const JUMP_FRESH_MS = 1000      // window after a jump where we still use the fast transition

function randomOcto() {
  return {
    x: Math.random() * 100,
    y: Math.random() * 100,
    flipped: Math.random() > 0.5,
    jumpAt: 0,
  }
}

export default function Hero() {
  const heroRef = useRef(null)
  // Mouse position in % of the hero rect. null while the cursor is elsewhere.
  const mousePosRef = useRef(null)
  const [octos, setOctos] = useState(() =>
    Array.from({ length: OCTO_COUNT }, randomOcto)
  )

  // Slow random drift — every octo on its own ~3s cadence, phase-shifted on mount
  // so they never sync up.
  useEffect(() => {
    const timeouts = []
    const intervals = []
    for (let i = 0; i < OCTO_COUNT; i++) {
      const period = 2700 + Math.random() * 600
      const initialDelay = Math.random() * 3000

      const driftOne = () => {
        setOctos((prev) => {
          const next = prev.slice()
          next[i] = { ...randomOcto(), jumpAt: 0 }
          return next
        })
      }

      const tId = setTimeout(() => {
        driftOne()
        const iId = setInterval(driftOne, period)
        intervals.push(iId)
      }, initialDelay)
      timeouts.push(tId)
    }
    return () => {
      timeouts.forEach(clearTimeout)
      intervals.forEach(clearInterval)
    }
  }, [])

  // Mouse-jump: every 500ms while the cursor is over the hero, find the 7
  // nearest octos and pull them ~55% of the way toward the cursor.
  useEffect(() => {
    const el = heroRef.current
    if (!el) return

    let jumpId = null

    const tick = () => {
      const mouse = mousePosRef.current
      if (!mouse) return
      setOctos((prev) => {
        const dists = prev.map((o, i) => ({
          i,
          d: (o.x - mouse.x) ** 2 + (o.y - mouse.y) ** 2,
        }))
        dists.sort((a, b) => a.d - b.d)
        const targets = new Set(dists.slice(0, NEAREST_COUNT).map((d) => d.i))
        const now = Date.now()
        return prev.map((o, i) => {
          if (!targets.has(i)) return o
          return {
            ...o,
            x: o.x + (mouse.x - o.x) * JUMP_LERP,
            y: o.y + (mouse.y - o.y) * JUMP_LERP,
            flipped: mouse.x > o.x,
            jumpAt: now,
          }
        })
      })
    }

    const start = () => {
      if (jumpId) return
      jumpId = setInterval(tick, JUMP_INTERVAL_MS)
    }
    const stop = () => {
      if (jumpId) {
        clearInterval(jumpId)
        jumpId = null
      }
      mousePosRef.current = null
    }

    el.addEventListener('mouseenter', start)
    el.addEventListener('mouseleave', stop)
    return () => {
      stop()
      el.removeEventListener('mouseenter', start)
      el.removeEventListener('mouseleave', stop)
    }
  }, [])

  const onMouseMove = (e) => {
    const el = heroRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    mousePosRef.current = {
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100,
    }
  }

  const now = Date.now()

  return (
    <section
      ref={heroRef}
      className="section-hero"
      onMouseMove={onMouseMove}
      style={{ position: 'relative', overflow: 'hidden' }}
    >
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
        {octos.map((octo, i) => {
          const fresh = octo.jumpAt && now - octo.jumpAt < JUMP_FRESH_MS
          const t = fresh ? JUMP_TRANSITION_MS : DRIFT_TRANSITION_MS
          return (
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
                transition: `left ${t}ms cubic-bezier(0.4, 0, 0.2, 1), top ${t}ms cubic-bezier(0.4, 0, 0.2, 1), transform 0.4s ease`,
                opacity: 0.144,
                willChange: 'left, top, transform',
              }}
            />
          )
        })}
      </div>
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

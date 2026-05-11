import { useEffect, useState } from 'react'

// Decorative band of Claude octos arranged along a sine curve. Used as a
// visual divider between sections. Static — positions computed once at render.
// Density is responsive: count is recomputed from viewport width so each octo
// touches its neighbours end-to-end at any screen size.

const SIZE_PX = 32
const AMPLITUDE_PX = 34
const CYCLES = 3
const HEIGHT_PX = 140

export default function OctoWave() {
  const [count, setCount] = useState(40)

  useEffect(() => {
    const recompute = () => {
      // One octo per SIZE_PX of horizontal space, so consecutive centers are
      // exactly one octo-width apart — they kiss with no gap.
      const w = window.innerWidth
      setCount(Math.max(20, Math.min(120, Math.floor(w / SIZE_PX))))
    }
    recompute()
    window.addEventListener('resize', recompute)
    return () => window.removeEventListener('resize', recompute)
  }, [])

  const octos = Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1) // 0..1 across the strip
    const angle = t * CYCLES * Math.PI * 2
    return {
      x: t * 100, // percent of container width
      y: Math.sin(angle) * AMPLITUDE_PX, // px offset from center line
      flipped: Math.cos(angle) > 0, // face direction follows the wave slope
    }
  })

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'relative',
        height: HEIGHT_PX,
        width: '100%',
        overflow: 'hidden',
        pointerEvents: 'none',
        maskImage: 'linear-gradient(to right, transparent, black 5%, black 95%, transparent)',
        WebkitMaskImage: 'linear-gradient(to right, transparent, black 5%, black 95%, transparent)',
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
            top: `${HEIGHT_PX / 2 + octo.y}px`,
            width: `${SIZE_PX}px`,
            height: 'auto',
            transform: `translate(-50%, -50%) scaleX(${octo.flipped ? -1 : 1})`,
            opacity: 0.55,
          }}
        />
      ))}
    </div>
  )
}

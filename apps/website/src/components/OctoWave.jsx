// Decorative band of Claude octos arranged along a sine curve. Used as a
// visual divider between sections. Static — positions computed once at render.

const COUNT = 28
const CYCLES = 2.5
const SIZE_PX = 36
const AMPLITUDE_PX = 46
const HEIGHT_PX = 160

export default function OctoWave() {
  const octos = Array.from({ length: COUNT }, (_, i) => {
    const t = i / (COUNT - 1) // 0..1 across the strip
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
        // Fade the wave in/out at the page edges
        maskImage: 'linear-gradient(to right, transparent, black 6%, black 94%, transparent)',
        WebkitMaskImage: 'linear-gradient(to right, transparent, black 6%, black 94%, transparent)',
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

import Hero from './components/Hero'
import Setup from './components/Setup'
import Demo from './components/Demo'
import OctoWave from './components/OctoWave'
import BeforeAfter from './components/BeforeAfter'
import InfiniteTasks from './components/InfiniteTasks'
import Comparison from './components/Comparison'
import Privacy from './components/Privacy'

const path = window.location.pathname.replace(/\/$/, '')

export default function App() {
  if (path === '/privacy') return <Privacy />

  return (
    <main>
      <Hero />
      <Setup />
      <Demo />
      <OctoWave />
      <BeforeAfter />
      <InfiniteTasks />
      <Comparison />
    </main>
  )
}

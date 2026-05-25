import { Analytics } from '@vercel/analytics/react'
import Nav from './components/Nav'
import Hero from './components/Hero'
import Setup from './components/Setup'
import Demo from './components/Demo'
import OctoWave from './components/OctoWave'
import BeforeAfter from './components/BeforeAfter'
import InfiniteTasks from './components/InfiniteTasks'
import ValidatedPlatforms from './components/ValidatedPlatforms'
import Comparison from './components/Comparison'
import Privacy from './components/Privacy'

const path = window.location.pathname.replace(/\/$/, '')

export default function App() {
  if (path === '/privacy') return (
    <>
      <Privacy />
      <Analytics />
    </>
  )

  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Setup />
        <Demo />
        <OctoWave />
        <BeforeAfter />
        <InfiniteTasks />
        <ValidatedPlatforms />
        <Comparison />
      </main>
      <Analytics />
    </>
  )
}

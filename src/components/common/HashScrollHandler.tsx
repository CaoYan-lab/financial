import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

export default function HashScrollHandler() {
  const location = useLocation()

  useEffect(() => {
    if (!location.hash) {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
      return
    }

    const targetId = decodeURIComponent(location.hash.slice(1))
    let retryTimer: number | undefined

    const scrollToTarget = () => {
      const target = document.getElementById(targetId)
      if (target) {
        scrollWithHeaderOffset(target)
        return
      }
      retryTimer = window.setTimeout(() => {
        const retryTarget = document.getElementById(targetId)
        if (retryTarget) scrollWithHeaderOffset(retryTarget)
      }, 120)
    }

    const frame = window.requestAnimationFrame(scrollToTarget)
    return () => {
      window.cancelAnimationFrame(frame)
      if (retryTimer) window.clearTimeout(retryTimer)
    }
  }, [location.hash, location.pathname])

  return null
}

function scrollWithHeaderOffset(target: HTMLElement) {
  const headerHeight = document.querySelector('header')?.getBoundingClientRect().height ?? 0
  const top = target.getBoundingClientRect().top + window.scrollY - headerHeight - 16
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
}

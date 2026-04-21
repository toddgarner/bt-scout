import { useEffect, useRef, useState } from 'react'

/**
 * useState that syncs to localStorage.
 * Works with any JSON-serializable value.
 */
export function useLocalState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw != null ? JSON.parse(raw) : initial
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // quota full or storage disabled — silently ignore
    }
  }, [key, value])

  return [value, setValue]
}

/**
 * Browser notification helpers.
 * Returns: { status, request, send }
 *   status  — 'granted' | 'denied' | 'default' | 'unsupported'
 *   request — async () => prompts the user
 *   send    — (title, body, tag?) => fires a notification (no-op if not granted)
 */
export function useNotifications() {
  const [status, setStatus] = useState(() => {
    if (typeof Notification === 'undefined') return 'unsupported'
    return Notification.permission
  })

  const request = async () => {
    if (typeof Notification === 'undefined') return 'unsupported'
    const result = await Notification.requestPermission()
    setStatus(result)
    return result
  }

  const send = (title, body, tag) => {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return
    try {
      new Notification(title, {
        body,
        tag,           // same tag collapses repeat notifications
        icon: '/favicon.svg',
        badge: '/favicon.svg',
      })
    } catch {
      // some browsers throw if the page is closed / SW required
    }
  }

  return { status, request, send }
}

/**
 * Returns a ref that always holds the latest value of `val`.
 * Handy inside interval callbacks where a closure would otherwise go stale.
 */
export function useLatest(val) {
  const ref = useRef(val)
  useEffect(() => { ref.current = val }, [val])
  return ref
}

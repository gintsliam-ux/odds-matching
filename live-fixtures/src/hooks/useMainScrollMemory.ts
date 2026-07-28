import { useEffect } from 'react'

const PREFIX = 'lf:scroll:'

/**
 * Remembers where a list was scrolled to and puts you back there.
 *
 * The app scrolls Layout's `<main>`, not the document — the shell is
 * `h-screen overflow-hidden`. Browsers only restore scroll for the DOCUMENT
 * scroller, so every return from a drill or a fixture page dumped you at the
 * top of a several-hundred-row table and you had to find your place again.
 *
 * Restoring waits for the CONTENT, not the clock. Two earlier attempts failed
 * because they assumed the rows were there: a single layout effect clamped to 0
 * (nothing rendered yet), and a 2-second rAF deadline expired before the ~226
 * mapping rows finished arriving — the data load paginates first. A
 * ResizeObserver fires exactly when the content grows tall enough, however long
 * that takes.
 *
 * sessionStorage rather than a module Map so the position survives a reload and
 * can be inspected when something looks off.
 *
 * @param key      identity of the list (route + filters). Switching tabs must
 *                 change this, or one tab inherits another's offset.
 * @param enabled  false while a detail view is showing — that view gets its own
 *                 scroll position and must not overwrite the list's.
 */
export function useMainScrollMemory(key: string, enabled: boolean): void {
  useEffect(() => {
    const el = document.querySelector('main')
    if (!el) return
    const storeKey = PREFIX + key

    if (!enabled) {
      // Entering a detail view — start it at the top. Deliberately does NOT
      // clear the stored value, so the list keeps its place.
      el.scrollTop = 0
      return
    }

    const want = Number(sessionStorage.getItem(storeKey) ?? 0)
    let settled = want <= 0

    const tryRestore = () => {
      if (settled) return
      // Assigning before the content is tall enough clamps to 0, and we'd have
      // no way to tell that apart from a real scroll-to-top.
      if (el.scrollHeight - el.clientHeight < want) return
      el.scrollTop = want
      if (Math.abs(el.scrollTop - want) < 2) {
        settled = true
        ro.disconnect()
      }
    }

    // MutationObserver, not ResizeObserver-on-a-child. The first attempt
    // observed el.firstElementChild, but React swaps that node as the view goes
    // skeleton -> table, so we sat watching a DETACHED element while the real
    // container grew: the callback fired exactly once (attempts:1) and the
    // restore never happened. Watching the subtree catches the rows arriving
    // regardless of which element ends up holding them.
    const ro = new MutationObserver(tryRestore)
    ro.observe(el, { childList: true, subtree: true })
    // Give up after a while so we don't hold an observer on a page the user has
    // settled into without ever scrolling.
    const giveUp = setTimeout(() => {
      settled = true
      ro.disconnect()
    }, 15_000)
    tryRestore()

    // A real user scroll cancels a pending restore — never yank the viewport
    // out from under someone who has already started reading.
    const onUserScroll = () => {
      settled = true
      ro.disconnect()
    }
    el.addEventListener('wheel', onUserScroll, { passive: true })
    el.addEventListener('touchmove', onUserScroll, { passive: true })

    // Only record once the restore has settled: the browser emits scroll events
    // while the list is still short, and those would overwrite the stored
    // offset with a clamped value.
    const onScroll = () => {
      if (!settled) return
      sessionStorage.setItem(storeKey, String(el.scrollTop))
    }
    el.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      clearTimeout(giveUp)
      ro.disconnect()
      el.removeEventListener('wheel', onUserScroll)
      el.removeEventListener('touchmove', onUserScroll)
      el.removeEventListener('scroll', onScroll)
    }
  }, [key, enabled])
}

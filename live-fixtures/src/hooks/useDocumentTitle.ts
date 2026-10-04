import { useEffect } from 'react'

const BASE = 'Sport Events'

/** Updates `document.title` whenever the page title changes. Restores the base
 *  title on unmount so going back doesn't leave a stale tab name. */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    document.title = title ? `${title} · ${BASE}` : BASE
    return () => {
      document.title = BASE
    }
  }, [title])
}

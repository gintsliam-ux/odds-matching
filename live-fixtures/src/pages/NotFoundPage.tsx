import { Link, useLocation } from 'react-router-dom'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

/**
 * Unknown route.
 *
 * This used to redirect to the board. That hides the mistake: a mistyped or
 * expired link looked exactly like a fixture that had dropped off the feed, and
 * the URL you needed to fix was gone from the address bar by the time you
 * looked. Show it instead.
 */
export default function NotFoundPage() {
  const { pathname } = useLocation()
  useDocumentTitle('Not found')

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6">
      <div className="max-w-lg rounded-lg border border-[var(--line)] bg-[color:var(--panel)] px-6 py-7">
        <div className="text-[11px] font-medium tracking-wide text-[color:var(--muted-2)]">404</div>
        <h1 className="mt-1 text-[17px] font-semibold text-gray-100">No such page</h1>
        <p className="mt-2 text-[12.5px] leading-relaxed text-[color:var(--muted)]">
          Nothing is routed at{' '}
          <code className="rounded bg-black/[0.3] px-1.5 py-0.5 text-[11.5px] text-gray-300">{pathname}</code>.
          A fixture link needs its OPTIC id on the end, like{' '}
          <code className="rounded bg-black/[0.3] px-1.5 py-0.5 text-[11.5px] text-gray-300">
            /fixture/seattle-storm-v-chicago-sky-20260811F6448802
          </code>
          .
        </p>
        <div className="mt-5 flex gap-2">
          <Link
            to="/"
            className="rounded border border-[var(--line)] bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-gray-100 hover:bg-white/[0.08]"
          >
            Back to terminal
          </Link>
          <Link
            to="/mapping"
            className="rounded border border-[var(--line)] px-3 py-1.5 text-[12px] font-medium text-[color:var(--muted)] hover:text-gray-200"
          >
            Mapping
          </Link>
        </div>
      </div>
    </div>
  )
}

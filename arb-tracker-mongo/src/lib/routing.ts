import type { SportEvent } from './types';

/** URL-friendly slug of an event name, e.g. "Melbourne vs Geelong Cats". */
export function eventSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Canonical path for an event: /event/<name-slug>/<fixture-id>. */
export function eventPath(event: SportEvent): string {
  return `/event/${eventSlug(event.name)}/${encodeURIComponent(event.id)}`;
}

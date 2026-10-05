import type { SportEvent } from './types';

/**
 * URL-friendly slug of an event name, e.g. "Melbourne vs Geelong Cats".
 *
 * Accents are FOLDED, not stripped. Dropping them outright turned 105 of 1,632
 * board events into something unreadable — "Club Atlético Morelia" became
 * `club-atl-tico-morelia`, "Cancún FC v CD Tapatío" became
 * `canc-n-fc-v-cd-tapat-o` — because the character vanished and left its
 * separator behind. Normalising to NFD and discarding the combining marks first
 * gives `club-atletico-morelia`, which is what someone reading the URL expects.
 *
 * The slug is decorative: EventView resolves on the fixture id, so changing it
 * cannot break a link anyone already has.
 */
export function eventSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Canonical path for an event: /event/<name-slug>/<fixture-id>. */
export function eventPath(event: SportEvent): string {
  return `/event/${eventSlug(event.name)}/${encodeURIComponent(event.id)}`;
}

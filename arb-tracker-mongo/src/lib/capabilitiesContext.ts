import { createContext, useContext } from 'react';
import { FULL_CAPABILITIES, type Capabilities } from './db';

/**
 * Lives apart from the provider so that file exports only a component and Vite
 * can fast-refresh it.
 */
export const CapabilitiesContext = createContext<Capabilities>(FULL_CAPABILITIES);

/** What the running instance can serve — see server/lib/source.mjs. */
export const useCapabilities = () => useContext(CapabilitiesContext);

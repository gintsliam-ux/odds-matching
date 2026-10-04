import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import App from './App';
import EventView from './EventView';
import MappingPage from './pages/MappingPage';
import { CapabilitiesProvider } from './lib/capabilities';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CapabilitiesProvider>
      <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<EventView />} />
          <Route path="event/:slug/:fixtureId" element={<EventView />} />
        </Route>
        {/* Full-width: the mapping table has no use for the event rail. */}
        <Route path="/mapping" element={<MappingPage />} />
      </Routes>
      </BrowserRouter>
    </CapabilitiesProvider>
  </StrictMode>,
);

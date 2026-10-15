import { Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { HomePage } from './pages/HomePage';
import { SearchPage } from './pages/SearchPage';
import { SheetPage } from './pages/SheetPage';
import { SongAnalysisPage } from './pages/SongAnalysisPage';

/** Old chord features stay reachable with ?legacy=1 (or /legacy). */
const legacy = () => new URLSearchParams(location.search).get('legacy') === '1';

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={legacy() ? <HomePage /> : <SongAnalysisPage />} />
        <Route path="/legacy" element={<HomePage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/s/:id" element={<SheetPage />} />
        <Route path="/s/:id/edit" element={<SheetPage edit />} />
      </Routes>
    </Layout>
  );
}

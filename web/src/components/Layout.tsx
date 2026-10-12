import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <header className="site-header">
        <Link to="/" className="brand" style={{ textDecoration: 'none' }}>
          Chord AI
          <span>音訊留在瀏覽器 · MIT 開源</span>
        </Link>
        <nav className="nav-links">
          <Link to="/">辨識</Link>
          <Link to="/search">搜尋樂譜</Link>
        </nav>
      </header>
      {children}
    </div>
  );
}

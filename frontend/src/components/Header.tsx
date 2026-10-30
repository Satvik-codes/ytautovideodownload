import React from 'react';
import { DownloadCloud } from 'lucide-react';

interface HeaderProps {
  onReset: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onReset }) => {
  return (
    <header className="header-container">
      <div className="header-content">
        <div className="logo-section" onClick={onReset} style={{ cursor: 'pointer' }}>
          <div className="logo-icon-wrapper">
            <DownloadCloud className="logo-icon" size={26} />
          </div>
          <div className="brand-text">
            <span className="brand-name">
              You<span className="brand-accent">Down</span>
            </span>
            <span className="brand-tagline">Instant One-Click Video Downloader</span>
          </div>
        </div>
      </div>
    </header>
  );
};

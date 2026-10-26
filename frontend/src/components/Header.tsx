import React from 'react';
import { DownloadCloud, Sparkles } from 'lucide-react';
import type { BackendSettings } from '../types/video';

interface HeaderProps {
  settings: BackendSettings | null;
  onReset: () => void;
}

export const Header: React.FC<HeaderProps> = ({ settings, onReset }) => {
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

        {settings && (
          <div className="settings-pill" title="Uniform backend configuration from .env">
            <Sparkles size={14} className="sparkle-icon" />
            <span>
              Preset: <strong>{settings.format.toUpperCase()}</strong> ({settings.quality})
            </span>
          </div>
        )}
      </div>
    </header>
  );
};

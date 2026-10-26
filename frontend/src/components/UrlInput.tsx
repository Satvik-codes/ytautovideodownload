import React, { useState } from 'react';
import { Search, Clipboard, ArrowRight } from 'lucide-react';

interface UrlInputProps {
  onSearch: (input: string) => void;
  isLoading: boolean;
}

export const UrlInput: React.FC<UrlInputProps> = ({ onSearch, isLoading }) => {
  const [value, setValue] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (value.trim()) {
      onSearch(value.trim());
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setValue(text);
        onSearch(text);
      }
    } catch {
      // Clipboard permissions denied; user can paste manually with Ctrl+V
    }
  };

  return (
    <div className="search-section">
      <form onSubmit={handleSubmit} className="search-box">
        <div className="search-icon-wrapper">
          <Search size={20} className="search-icon" />
        </div>
        <input
          type="text"
          className="search-input"
          placeholder="Paste any YouTube URL or Video ID (e.g. youtube.com/watch?v=...)"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={isLoading}
        />
        <button
          type="button"
          onClick={handlePaste}
          className="paste-button"
          title="Paste from clipboard"
        >
          <Clipboard size={16} />
          <span>Paste</span>
        </button>
        <button
          type="submit"
          className="submit-button"
          disabled={isLoading || !value.trim()}
        >
          <span>{isLoading ? 'Processing...' : 'Download'}</span>
          <ArrowRight size={18} />
        </button>
      </form>
    </div>
  );
};

import React from 'react';
import { Sparkles, Zap, ShieldCheck, SlidersHorizontal } from 'lucide-react';

export const HowItWorks: React.FC = () => {
  return (
    <div className="how-it-works-section">
      <div className="section-header">
        <div className="section-pill">
          <Sparkles size={14} />
          <span>The Fastest Way to Download</span>
        </div>
        <h2 className="section-title">The URL Magic Trick</h2>
        <p className="section-desc">
          No copy-pasting required. Download any video directly from your browser's address bar.
        </p>
      </div>

      <div className="steps-grid">
        {/* Step 1 */}
        <div className="step-card">
          <div className="step-number">1</div>
          <div className="step-content">
            <h3 className="step-title">Watch Any Video on YouTube</h3>
            <p className="step-desc">Notice the URL in your browser address bar:</p>
            <div className="url-preview-box original">
              <span className="domain-muted">https://www.</span>
              <span className="domain-highlight-red">youtube</span>
              <span className="domain-muted">.com/watch?v=JYyzYnvad50</span>
            </div>
          </div>
        </div>

        {/* Step 2 */}
        <div className="step-card featured">
          <div className="step-number featured">2</div>
          <div className="step-content">
            <h3 className="step-title">Change "youtube" to "youdown"</h3>
            <p className="step-desc">Or delete "ube" from the URL and hit Enter:</p>
            <div className="url-preview-box modified">
              <span className="domain-muted">https://www.</span>
              <span className="domain-highlight-blue">youdown</span>
              <span className="domain-muted">.com/watch?v=JYyzYnvad50</span>
            </div>
          </div>
        </div>

        {/* Step 3 */}
        <div className="step-card">
          <div className="step-number">3</div>
          <div className="step-content">
            <h3 className="step-title">Instant Automatic Download</h3>
            <p className="step-desc">
              You land right here, and your file begins downloading automatically with zero clicks!
              Works for X posts too: <code>x.com/user/status/123</code> →{' '}
              <code>youdown.com/user/status/123</code>.
            </p>
            <div className="instant-badge">
              <Zap size={16} className="zap-icon" />
              <span>Direct Download Begins Instantly</span>
            </div>
          </div>
        </div>
      </div>

      {/* Feature Highlights */}
      <div className="features-row">
        <div className="feature-item">
          <Zap size={18} className="feature-icon" />
          <div>
            <strong>Zero Settings Needed</strong>
            <p>Uniform format and high quality applied automatically from server settings.</p>
          </div>
        </div>
        <div className="feature-item">
          <ShieldCheck size={18} className="feature-icon" />
          <div>
            <strong>Clean & Ad-Free</strong>
            <p>No popups, redirects, or spam. Just direct video downloads.</p>
          </div>
        </div>
        <div className="feature-item">
          <SlidersHorizontal size={18} className="feature-icon" />
          <div>
            <strong>High-Performance Muxing</strong>
            <p>Full 1080p and high-bitrate audio merged smoothly with FFmpeg.</p>
          </div>
        </div>
      </div>
    </div>
  );
};

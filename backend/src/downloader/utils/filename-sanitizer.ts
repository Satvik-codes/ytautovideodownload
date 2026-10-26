export interface SanitizedFilenameResult {
  asciiFallback: string;
  utf8Encoded: string;
  cleanBaseName: string;
}

export function sanitizeFilename(rawTitle: string, ext: string): SanitizedFilenameResult {
  const fileExt = ext.replace(/^\./, '').toLowerCase();

  // Strip control characters, quotes, and invalid filesystem characters
  const cleanBaseName =
    rawTitle
      .replace(/[\r\n\t]/g, ' ')
      .replace(/["\\/<>:|?*]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100) || 'video';

  // ASCII fallback for older clients (remove any non-printable ASCII)
  const asciiClean =
    cleanBaseName
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/["\\]/g, '')
      .trim() || 'video';

  const asciiFallback = `"${asciiClean}.${fileExt}"`;
  const utf8Encoded = `UTF-8''${encodeURIComponent(`${cleanBaseName}.${fileExt}`)}`;

  return {
    asciiFallback,
    utf8Encoded,
    cleanBaseName,
  };
}

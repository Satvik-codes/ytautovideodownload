export type WarpIpFamily = 'ipv4' | 'dual';

const FAMILY_KEYS = new Set(['Address', 'DNS', 'AllowedIPs']);

/**
 * Rewrites a wgcf WireGuard profile so the tunnel carries IPv4 only. WARP's
 * IPv6 egress addresses sit in a few ranges YouTube flags as bots, while its
 * IPv4 egress is shared with many consumer devices and is far less likely to
 * hit "Sign in to confirm you're not a bot". With no IPv6 address or route,
 * wireproxy reaches every host over IPv4.
 */
export function toIpv4OnlyProfile(profile: string): string {
  return profile
    .split('\n')
    .map((line) => {
      const match = /^(\s*)(\w+)(\s*=\s*)(.*)$/.exec(line);
      if (!match || !FAMILY_KEYS.has(match[2])) return line;
      const [, indent, key, separator, value] = match;
      const ipv4 = value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part && !part.includes(':'));
      return `${indent}${key}${separator}${ipv4.join(', ')}`;
    })
    .join('\n');
}

/**
 * Decodes WARP_PROFILE_B64 (base64 of a `wgcf generate` profile). A fixed
 * identity from the environment survives restarts, so the service never has
 * to register a WARP account itself; Cloudflare rate-limits registrations
 * (429) from shared egress IPs like Render's. Throws with the reason when the
 * value isn't a usable WireGuard profile.
 */
export function decodeProfileEnv(base64: string): string {
  const profile = Buffer.from(base64.replace(/\s+/g, ''), 'base64').toString('utf-8');
  const missing = ['[Interface]', 'PrivateKey', '[Peer]', 'Endpoint'].filter(
    (part) => !profile.includes(part),
  );
  if (missing.length) {
    throw new Error(`WARP_PROFILE_B64 is not a WireGuard profile (missing ${missing.join(', ')})`);
  }
  return profile;
}

export function parseWarpIpFamily(value: string | undefined): WarpIpFamily {
  return (value || 'ipv4').trim().toLowerCase() === 'dual' ? 'dual' : 'ipv4';
}

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

export function parseWarpIpFamily(value: string | undefined): WarpIpFamily {
  return (value || 'ipv4').trim().toLowerCase() === 'dual' ? 'dual' : 'ipv4';
}

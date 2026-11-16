import { describe, expect, it } from 'vitest';
import { parseWarpIpFamily, toIpv4OnlyProfile } from './warp-profile.js';

// Shape of a real `wgcf generate` profile (keys replaced)
const PROFILE = `[Interface]
PrivateKey = cHJpdmF0ZQ==
Address = 172.16.0.2/32, 2606:4700:110:8cff:d788:f099:f416:41c7/128
DNS = 1.1.1.1, 1.0.0.1, 2606:4700:4700::1111, 2606:4700:4700::1001
MTU = 1280
[Peer]
PublicKey = cHVibGlj
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = engage.cloudflareclient.com:2408
`;

describe('toIpv4OnlyProfile', () => {
  const result = toIpv4OnlyProfile(PROFILE);

  it('drops IPv6 addresses, DNS servers and routes', () => {
    expect(result).toContain('Address = 172.16.0.2/32\n');
    expect(result).toContain('DNS = 1.1.1.1, 1.0.0.1\n');
    expect(result).toContain('AllowedIPs = 0.0.0.0/0\n');
    expect(result).not.toMatch(/2606:|::\/0/);
  });

  it('leaves keys, the endpoint (host:port) and other settings untouched', () => {
    expect(result).toContain('PrivateKey = cHJpdmF0ZQ==');
    expect(result).toContain('PublicKey = cHVibGlj');
    expect(result).toContain('Endpoint = engage.cloudflareclient.com:2408');
    expect(result).toContain('MTU = 1280');
  });

  it('is idempotent', () => {
    expect(toIpv4OnlyProfile(result)).toBe(result);
  });
});

describe('parseWarpIpFamily', () => {
  it('defaults to ipv4 and accepts dual', () => {
    expect(parseWarpIpFamily(undefined)).toBe('ipv4');
    expect(parseWarpIpFamily('bogus')).toBe('ipv4');
    expect(parseWarpIpFamily(' DUAL ')).toBe('dual');
  });
});

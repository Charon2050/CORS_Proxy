import { BlockList, isIP } from 'node:net';

export function ipType(ip) {
  return isIP(ip) === 4 ? 'ipv4' : 'ipv6';
}

export function parseAllowlist(value = '') {
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return null;
  const list = new BlockList();
  for (const entry of entries) {
    const parts = entry.split('/');
    const [address, prefix] = parts;
    const version = isIP(address);
    if (!version || parts.length > 2 || (prefix !== undefined &&
        (!/^\d+$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)))) {
      throw new Error('ALLOWED_CLIENT_IPS contains an invalid IP or CIDR');
    }
    if (prefix === undefined) list.addAddress(address, ipType(address));
    else list.addSubnet(address, Number(prefix), ipType(address));
  }
  return list;
}

const nonPublic = parseAllowlist([
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
  '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
  '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
  '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
  '2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20',
].join(','));
const globalIPv6 = parseAllowlist('2000::/3');
const mappedIPv4 = parseAllowlist('::ffff:0:0/96');

export function isPublicIP(address) {
  const version = isIP(address);
  if (!version || address.includes('%')) return false;
  const type = ipType(address);
  // BlockList checks IPv4 rules against IPv4-mapped IPv6 addresses as well.
  if (nonPublic.check(address, type)) return false;
  return version === 4 || mappedIPv4.check(address, type) || globalIPv6.check(address, type);
}

export function clientIP(req, onVercel) {
  if (!onVercel) return req.socket.remoteAddress ?? '';
  // Only trust these headers when running behind Vercel's ingress.
  const value = req.headers['x-vercel-forwarded-for'] ?? req.headers['x-forwarded-for'];
  // Fail closed if a proxy chain or repeated header is supplied.
  return typeof value === 'string' && isIP(value.trim()) ? value.trim() : '';
}

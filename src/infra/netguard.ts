import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const privateRanges = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) privateRanges.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['::ffff:0:0', 96]] as const)
  privateRanges.addSubnet(net, prefix, 'ipv6');

export function isPrivateAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) return privateRanges.check(addr, 'ipv4');
  if (family === 6) return privateRanges.check(addr, 'ipv6');
  return true;
}

/** Throws if the URL's host is, or resolves to, a private/loopback/link-local address (SSRF guard). */
export async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`${url.hostname} resolves to a private address`);
  }
}

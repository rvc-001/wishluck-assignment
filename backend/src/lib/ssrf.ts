import dns from "dns/promises";
import net from "net";

/**
 * SSRF Protection — validates a URL is safe to fetch from the backend.
 * Covers Phase 1 targets 1.2a – 1.2f.
 */

const PRIVATE_CIDRS: Array<{ base: number; mask: number }> = [
  // 10.0.0.0/8
  { base: ip2int("10.0.0.0"), mask: 0xff000000 },
  // 172.16.0.0/12
  { base: ip2int("172.16.0.0"), mask: 0xfff00000 },
  // 192.168.0.0/16
  { base: ip2int("192.168.0.0"), mask: 0xffff0000 },
  // 127.0.0.0/8
  { base: ip2int("127.0.0.0"), mask: 0xff000000 },
  // 169.254.0.0/16 (link-local)
  { base: ip2int("169.254.0.0"), mask: 0xffff0000 },
  // 0.0.0.0/8
  { base: ip2int("0.0.0.0"), mask: 0xff000000 },
];

function ip2int(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  if (!net.isIPv4(ip)) return false;
  const n = ip2int(ip);
  return PRIVATE_CIDRS.some((c) => (n & c.mask) >>> 0 === c.base);
}

function isPrivateIPv6(ip: string): boolean {
  if (!net.isIPv6(ip)) return false;
  const normalized = ip.toLowerCase();
  // ::1 loopback
  if (normalized === "::1") return true;
  // fc00::/7 (ULA)
  if (/^fd[0-9a-f]{2}:/i.test(normalized) || /^fc[0-9a-f]{2}:/i.test(normalized)) return true;
  // fe80::/10 (link-local)
  if (/^fe[89ab][0-9a-f]:/i.test(normalized)) return true;
  return false;
}

export class SSRFError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SSRFError";
  }
}

/**
 * 1.2a — Only http/https
 * 1.2b — Resolve hostname via DNS first
 * 1.2c — Reject private/loopback addresses
 */
export async function validateUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SSRFError("Invalid URL format");
  }

  // 1.2a — protocol check
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new SSRFError(`Protocol not allowed: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname;

  // Reject already-IP addresses that are private
  if (net.isIPv4(hostname) && isPrivateIPv4(hostname)) {
    throw new SSRFError(`Private IPv4 address rejected: ${hostname}`);
  }
  if (net.isIPv6(hostname) && isPrivateIPv6(hostname)) {
    throw new SSRFError(`Private IPv6 address rejected: ${hostname}`);
  }

  // 1.2b — DNS resolve
  let addresses: string[];
  try {
    const result = await dns.lookup(hostname, { all: true });
    addresses = result.map((r) => r.address);
  } catch {
    throw new SSRFError(`DNS resolution failed for: ${hostname}`);
  }

  // 1.2c — check all resolved IPs
  for (const addr of addresses) {
    if (isPrivateIPv4(addr)) {
      throw new SSRFError(`Hostname resolves to private IPv4: ${addr}`);
    }
    if (isPrivateIPv6(addr)) {
      throw new SSRFError(`Hostname resolves to private IPv6: ${addr}`);
    }
  }

  return parsed;
}

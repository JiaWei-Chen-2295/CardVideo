// Which addresses can a phone on the same Wi-Fi actually reach?
//
// This is less obvious than it looks, and getting it wrong wastes a lot of time: the machine
// this was developed on reports five non-loopback IPv4 addresses, and the OS default route
// points at a VPN adapter that no phone can reach:
//
//   Meta (Clash-style proxy)      198.18.0.1     <- 198.18.0.0/15 is the benchmarking range
//   VMware Network Adapter VMnet1 192.168.254.1  <- host-only, invisible to the LAN
//   VMware Network Adapter VMnet8 192.168.80.1   <- NAT, invisible to the LAN
//   Ethernet                      192.168.0.2    <- the real one
//   vEthernet (Default Switch)    172.21.32.1    <- Hyper-V, invisible to the LAN
//
// Handing the user all five and letting them guess is a bug, not a feature. So virtual
// adapters are classified and demoted, and the banner says which address to use.

import { networkInterfaces } from "node:os";

/**
 * Address prefixes that are never a real LAN interface.
 *
 * 198.18.0.0/15 is reserved for benchmarking and is what Clash/mihomo-style proxies use for
 * their TUN interface. 172.16/12 covers both Docker and Hyper-V's default switch, and VMware's
 * host-only/NAT ranges sit in 192.168.x.
 */
const VIRTUAL_PATTERNS = [
  { test: /^198\.1[89]\./, reason: "proxy/VPN TUN adapter (benchmarking range)" },
  { test: /^169\.254\./, reason: "link-local (APIPA), not routable" },
  { test: /^172\.1[6-9]\.|^172\.2\d\.|^172\.3[01]\./, reason: "Hyper-V / Docker NAT" },
  { test: /^192\.168\.(?:254|80|64)\.1$/, reason: "VMware host-only or NAT" },
];

/** Interface names that give away a virtual adapter. */
const VIRTUAL_NAME = /vmware|virtualbox|hyper-v|vethernet|loopback|tailscale|zerotier|wsl|docker|meta|clash|tun|tap/i;

/**
 * Every candidate address, most-likely-first, with a reason for the ones to avoid.
 *
 * @returns {Array<{address: string, iface: string, virtual: boolean, reason?: string}>}
 */
export function lanCandidates() {
  const found = [];

  for (const [iface, entries] of Object.entries(networkInterfaces() ?? {})) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;

      const pattern = VIRTUAL_PATTERNS.find((p) => p.test.test(entry.address));
      const named = VIRTUAL_NAME.test(iface);
      const virtual = Boolean(pattern) || named;

      found.push({
        address: entry.address,
        iface,
        virtual,
        reason: pattern?.reason ?? (named ? "virtual adapter" : undefined),
      });
    }
  }

  // Real interfaces first, private ranges before anything unusual, then a stable sort by
  // address so the output does not shuffle between runs.
  const rank = (candidate) => {
    if (candidate.virtual) return 2;
    if (/^192\.168\./.test(candidate.address)) return 0;
    if (/^10\./.test(candidate.address)) return 0;
    return 1;
  };

  return found.sort(
    (a, b) => rank(a) - rank(b) || a.address.localeCompare(b.address)
  );
}

/** The single best address to hand to a phone, or null when there is none. */
export function preferredLanAddress() {
  return lanCandidates().find((candidate) => !candidate.virtual)?.address ?? null;
}

/** Addresses a certificate should be valid for: loopback plus every real LAN address. */
export function certAddresses() {
  const addresses = new Set(["127.0.0.1"]);
  for (const candidate of lanCandidates()) {
    if (!candidate.virtual) addresses.add(candidate.address);
  }
  return [...addresses];
}

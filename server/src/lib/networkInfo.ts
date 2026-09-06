import os from "node:os";

/**
 * Best-effort guess at the machine's LAN IPv4 address — the address the TV
 * (on the same WiFi/network) needs to reach this server. Falls back to
 * "localhost" if nothing usable is found (casting will not work in that case,
 * but local browsing still does).
 */
export function getLanIp(): string {
  const interfaces = os.networkInterfaces();
  const candidates: string[] = [];

  for (const name of Object.keys(interfaces)) {
    const addrs = interfaces[name] ?? [];
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        candidates.push(addr.address);
      }
    }
  }

  // Prefer typical home-network ranges (192.168.x.x, 10.x.x.x) over anything
  // exotic (VPN adapters, Docker bridges, etc.) when there's a choice.
  const preferred = candidates.find(
    (ip) => ip.startsWith("192.168.") || ip.startsWith("10.")
  );

  return preferred ?? candidates[0] ?? "localhost";
}

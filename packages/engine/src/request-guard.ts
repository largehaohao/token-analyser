/**
 * Loopback binding alone does not stop DNS rebinding: a remote page can resolve
 * its own hostname to 127.0.0.1 and become same-origin with this server. Only
 * an exact loopback Host is served. State-changing requests must also come
 * from a loopback Origin, or from a non-browser client that sends neither
 * Origin nor a cross-site Sec-Fetch-Site.
 */

function headerOne(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.find((item) => item.trim() !== "");
  return value;
}

function isPortSuffix(value: string): boolean {
  if (!/^:\d{1,5}$/.test(value)) return false;
  const port = Number(value.slice(1));
  return port >= 1 && port <= 65535;
}

/** Hostname only, after a single :port. Exact match; never a prefix. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const trimmed = host.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 255) return false;
  if (/[\s@/\\]/.test(trimmed)) return false;

  let hostname = trimmed;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end <= 1) return false;
    const rest = trimmed.slice(end + 1);
    if (rest !== "" && !isPortSuffix(rest)) return false;
    hostname = trimmed.slice(1, end);
  } else {
    const colon = trimmed.lastIndexOf(":");
    if (colon > 0 && isPortSuffix(trimmed.slice(colon))) {
      const candidate = trimmed.slice(0, colon);
      if (!candidate.includes(":")) hostname = candidate;
    }
  }

  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

export function isTrustedOrigin(origin: string | undefined): boolean {
  if (origin == null || origin === "") return false;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && isLoopbackHost(url.host);
  } catch {
    return false;
  }
}

export function isStateChangeAllowed(headers: {
  origin?: string | string[];
  "sec-fetch-site"?: string | string[];
}): boolean {
  const fetchSite = headerOne(headers["sec-fetch-site"])?.trim().toLowerCase();
  if (fetchSite === "cross-site") return false;
  const origin = headerOne(headers.origin);
  if (origin == null || origin === "") return true;
  return isTrustedOrigin(origin);
}

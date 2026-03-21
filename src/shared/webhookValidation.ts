/**
 * Webhook URL Validation
 * SSRF prevention for webhook URLs — shared between server handlers and embedded SDK
 */

/** Check if hostname is a localhost variant */
function isLocalhost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  );
}

/** Check if hostname is a blocked IPv4 address. Returns error message or null. */
function checkPrivateIpv4(hostname: string): string | null {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;

  const [, a, b] = m.map(Number);
  if (a === 10) return 'Webhook URL cannot point to private IP';
  if (a === 172 && b >= 16 && b <= 31) return 'Webhook URL cannot point to private IP';
  if (a === 192 && b === 168) return 'Webhook URL cannot point to private IP';
  if (a === 169 && b === 254) return 'Webhook URL cannot point to link-local IP';
  if (a === 0) return 'Webhook URL cannot point to unspecified IP';
  if (a === 127) return 'Webhook URL cannot point to loopback IP';
  return null;
}

/** Check if hostname is a cloud metadata endpoint */
function isCloudMetadata(hostname: string): boolean {
  return (
    hostname === '169.254.169.254' ||
    hostname === 'metadata.google.internal' ||
    hostname.endsWith('.internal')
  );
}

/** Validate webhook URL to prevent SSRF. Returns error message or null if valid. */
export function validateWebhookUrl(url: string): string | null {
  if (!url || url.length === 0) return 'Webhook URL is required';
  if (url.length > 2048) return 'Webhook URL too long (max 2048 characters)';

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL format';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Webhook URL must use http or https protocol';
  }

  const hostname = parsed.hostname.toLowerCase();

  if (isLocalhost(hostname)) return 'Webhook URL cannot point to localhost';

  const ipError = checkPrivateIpv4(hostname);
  if (ipError) return ipError;

  if (isCloudMetadata(hostname)) return 'Webhook URL cannot point to cloud metadata endpoints';

  return null;
}

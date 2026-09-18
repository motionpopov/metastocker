import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { Reader } from 'mmdb-lib';
const reader = new Reader(readFileSync(new URL(import.meta.resolve('@ip-location-db/geo-whois-asn-country-mmdb/geo-whois-asn-country.mmdb'))));
export function clientIp(req, trustProxy) {
  // The public Caddy overwrites this header; the private static proxy forwards it unchanged.
  const raw = String(trustProxy ? req.headers['x-forwarded-for'] || '' : req.socket.remoteAddress || '').split(',').at(-1).trim().replace(/^::ffff:/, '');
  return isIP(raw) ? raw : '';
}
export function countryForIp(ip) {
  try { const code = reader.get(ip)?.country_code; return /^[A-Z]{2}$/.test(code || '') ? code : 'ZZ'; } catch { return 'ZZ'; }
}
export function browserContext(ua = '') {
  return {
    device: /ipad|tablet/i.test(ua) ? 'tablet' : /mobile|iphone|android/i.test(ua) ? 'mobile' : 'desktop',
    browser: /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other'
  };
}

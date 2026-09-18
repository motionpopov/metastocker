import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
export const COOKIE = 'metastocker_owner';
const TTL = 8 * 60 * 60;
export async function createCredentials(password) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: (await derive(password, salt, 64)).toString('hex'), sessionKey: randomBytes(32).toString('hex') };
}
export function auth(config, secure = true) {
  if (!/^[a-f0-9]{32}$/.test(config.salt) || !/^[a-f0-9]{128}$/.test(config.hash) || !/^[a-f0-9]{64}$/.test(config.sessionKey)) throw new Error('Invalid owner credentials file');
  const sign = value => createHmac('sha256', config.sessionKey).update(value).digest('hex');
  const equal = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  return {
    async verify(password) { return typeof password === 'string' && password.length >= 12 && password.length <= 200 && equal((await derive(password, config.salt, 64)).toString('hex'), config.hash); },
    valid(cookie = '', now = Date.now()) {
      const value = cookie.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || '';
      const [expiry, nonce, signature, extra] = value.split('.');
      if (extra || !/^\d{10,13}$/.test(expiry || '') || !/^[a-f0-9]{32}$/.test(nonce || '') || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
      const remaining = Number(expiry) - Math.floor(now / 1000);
      return remaining > 0 && remaining <= TTL && equal(sign(expiry + '.' + nonce), signature);
    },
    cookie(clear = false, now = Date.now()) {
      const value = Math.floor(now / 1000) + TTL + '.' + randomBytes(16).toString('hex');
      return `${COOKIE}=${clear ? '' : value + '.' + sign(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : TTL}${secure ? '; Secure' : ''}`;
    }
  };
}

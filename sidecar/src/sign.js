// HMAC signatures for proxied URLs. The proxy only fetches URLs it handed out itself, so it can't
// be used to reach arbitrary hosts (it runs next to other services on the LAN).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function createSigner(secret = randomBytes(32)) {
  const mac = (stationId, url) => createHmac('sha256', secret).update(`${stationId}\n${url}`).digest('base64url');
  return {
    sign: mac,
    verify(stationId, url, signature) {
      if (typeof signature !== 'string') return false;
      const expected = Buffer.from(mac(stationId, url));
      const given = Buffer.from(signature);
      return expected.length === given.length && timingSafeEqual(expected, given);
    },
  };
}

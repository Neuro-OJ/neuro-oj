import { SECURITY_HEADERS } from '../utils/security-headers.ts';

export default defineEventHandler((event) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    setHeader(event, name, value);
  }
});

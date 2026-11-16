// What may be reopened after a browser restart. The worker remembers the selected tab's
// address so a restart continues where it left off, but a sign-in page is the one thing
// that must not come back: it is useless without the step that led to it, and sites that
// distrust automation (claude.ai among them) answer a cold hit on their login page with a
// verification they then keep re-asking for, in a window the owner did not open.
const AUTH_WORD =
  /(^|[/.?&=-])(login|log-in|signin|sign-in|signup|sign-up|signout|sign-out|logout|log-out|auth|authorize|authenticate|oauth|oauth2|openid|session|sso|saml|idp|mfa|2fa|otp|passcode|password|credentials|verify|verification|verifyemail|challenge|captcha|accounts|account-recovery|consent|device|token)(\b|[/_-])/i;

/** true when the address looks like a sign-in, consent or verification page. */
export function isAuthPage(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol)) return false;
  // Underscores read as word separators here, so /users/sign_in matches sign-in.
  return AUTH_WORD.test(`${u.host}${u.pathname}${u.search}`.replace(/_/g, "-"));
}

/** true when a remembered address may be reopened on the next start. */
export function mayRestore(url: string): boolean {
  return /^https?:\/\/\S+$/.test(url) && !isAuthPage(url);
}

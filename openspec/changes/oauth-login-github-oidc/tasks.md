## 1. Data model and configuration

- [x] 1.1 Add nullable local password support and the `oauth_accounts` table with foreign key, unique provider identity constraint, indexes, and Drizzle migration; verify migration and schema tests pass without modifying `_journal.json` manually
- [x] 1.2 Add GitHub/OIDC environment variables to core and development templates, production/config validation, and provider availability parsing; verify configured and incomplete provider cases with unit tests

## 2. OAuth provider and state services

- [x] 2.1 Implement normalized GitHub and generic OIDC provider adapters, including discovery, authorization URL construction, code exchange, verified email handling, and response validation; verify adapter unit tests cover success and provider failures
- [x] 2.2 Implement signed, short-lived, cookie-bound, single-use OAuth state creation/consumption for login and link intents; verify mismatch, expiry, provider mismatch, replay, and cleanup tests
- [x] 2.3 Implement OAuth identity resolution, unique-user provisioning, verified-email matching, JWT issuance, and safe conflict handling; verify service tests cover linked login, new user creation, repeated callbacks, and unverified email behavior

## 3. Core API and authentication integration

- [x] 3.1 Add provider discovery, authorization, callback, and password setup endpoints while preserving existing local login and TFA behavior; verify route tests cover redirects, callback errors, token redaction, and passwordless local-login rejection
- [x] 3.2 Add authenticated link/unlink APIs with password confirmation, transaction-safe ownership checks, conflict handling, and last-login-method protection; verify route/service tests cover wrong password, cross-user conflict, and safe unlinking
- [x] 3.3 Update public user/auth types and `/auth/me` to expose only `has_local_password` and safe linked-account metadata; verify existing auth tests remain green and secret fields never appear in responses

## 4. UI integration

- [x] 4.1 Extend the auth composable and login/register pages to load configured providers, start OAuth navigation, handle callback errors, and guide passwordless users to set a password; verify UI type-check/build succeeds and provider buttons are hidden when unavailable
- [x] 4.2 Add linked-account and password setup management to settings using Nuxt UI components and the existing API/error conventions; verify UI type-check/build succeeds and errors are rendered without secrets

## 5. End-to-end verification

- [x] 5.1 Add mocked-provider integration coverage for GitHub callback login, new-user provisioning, and state mismatch rejection; verify the callback response carries the normal auth cookies and no token is exposed in response bodies
- [x] 5.2 Run focused core/UI tests, migration validation, lint/type checks, and record the full OAuth-provider E2E suite as environment-dependent (mocked provider integration covers the deterministic callback path); confirm unrelated existing worktree changes remain untouched

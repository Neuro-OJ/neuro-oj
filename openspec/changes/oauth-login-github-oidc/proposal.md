## Why

Neuro OJ currently requires every user to register with a local username, email, and password, which adds friction for users who already have a trusted GitHub or organization identity. Issue #227 requests a standard third-party login path while preserving the existing JWT-cookie session model and protecting account linking from CSRF and accidental takeover.

## What Changes

- Add GitHub OAuth 2.0 and configurable generic OIDC providers, with authorization redirect and callback endpoints.
- Persist provider identities in an `oauth_accounts` table with a unique `(provider, provider_user_id)` constraint and a foreign key to users.
- Support callback outcomes for an already-linked account, a verified-email match to an existing account, and creation of a new passwordless local account.
- Generate and validate short-lived, single-use OAuth `state` values to prevent CSRF, including safe handling of callback errors and provider failures.
- Add provider configuration to environment templates and environment validation; expose only configured providers in the UI.
- Continue issuing the existing HTTP-only JWT cookie after successful OAuth login.
- Add authenticated account-linking and unlinking APIs with password confirmation where a local password exists, and prevent unlinking the last usable login method.
- Add a password setup flow for OAuth-created users, while retaining the existing password-change flow for users with a password.
- Add GitHub/OIDC buttons to login and registration pages and a linked-account management section to settings.
- Add unit/route tests and E2E coverage for callback login, new-user provisioning, state mismatch rejection, provider visibility, and configuration validation.

## Capabilities

### New Capabilities

- `oauth-authentication`: GitHub and generic OIDC authorization, callback, identity persistence, linking/unlinking, and password setup behavior.

### Modified Capabilities

- `user-auth`: Extend authentication and password requirements to support OAuth-created users and OAuth session issuance.
- `user-settings`: Add authenticated linked-account management behavior.

## Impact

- `noj-core`: auth routes/services, OAuth provider client and state handling, user/account schema, migration, environment validation, and tests.
- `noj-ui`: auth composable, login/register/settings pages, and OAuth callback UX.
- PostgreSQL: one new table and a nullable local password field for accounts created through OAuth.
- Runtime configuration: new GitHub and OIDC environment variables; no new third-party runtime dependency is required because provider calls use the existing fetch-based server runtime.

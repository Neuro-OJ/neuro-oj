## Context

See `proposal.md` for the motivation and `specs/` for the externally visible contract. The current core owns local authentication, JWT signing, and database migrations; the UI proxy owns the HTTP-only auth cookies. Redis is optional in degraded development mode, so OAuth state must not make the whole login path depend on Redis availability.

## Goals / Non-Goals

**Goals:**

- Keep provider secrets and exchanged tokens entirely in the core server.
- Normalize GitHub and generic OIDC identities behind one provider interface.
- Make callback state short-lived, browser-bound, single-use, and safe under retries.
- Reuse the current JWT signing and Nitro cookie interception behavior.
- Make account linking explicit and prevent the last usable login method from being removed.
- Preserve local-password login and existing TFA behavior.

**Non-Goals:**

- Supporting arbitrary OAuth providers beyond GitHub and one configured OIDC provider.
- Storing provider access/refresh tokens for API access or background synchronization.
- Automatic email-based account merging when the provider does not assert a verified email.
- Replacing the existing local registration, password reset, or TFA UX.

## Decisions

### 1. One provider adapter contract

Add a server-side provider registry with adapters for GitHub and OIDC. Each adapter exposes availability, authorization URL construction, code exchange, and normalized identity (`providerUserId`, display name, email, email verified). GitHub uses `/user` plus the verified primary email endpoint; OIDC discovers authorization, token, and userinfo endpoints from the issuer metadata and validates the returned issuer/subject and email claims.

The implementation uses the platform `fetch` API instead of a new OAuth package. This keeps Deno dependency and lockfile changes out of the feature and makes provider calls straightforward to mock in route tests. Provider responses are schema-checked before use and never returned to the browser.

### 2. Signed state plus HttpOnly cookie

Create a short-lived signed state payload containing a random nonce, provider, intent (`login` or `link`), issued-at/expiry, and (for linking) the authenticated user ID. Store the nonce in a separate HttpOnly SameSite=Lax cookie. The callback verifies the signature, cookie equality, provider and expiry, then atomically consumes the cookie before exchanging the code. A small in-process consumed-state cache with bounded TTL prevents same-process replay; the callback also clears the cookie on every terminal path.

This avoids making OAuth login unavailable when Redis is degraded. The cookie binding prevents a state copied from one browser from being accepted in another browser. A signed state is preferred over an unsigned opaque state because it does not require server-side state storage; a Redis-only state store was considered but rejected due to the project's documented degraded Redis mode.

### 3. Callback and UI proxy boundary

The browser starts OAuth through the existing `/api/v1` Nitro proxy. The core constructs callback URLs from the configured `APP_URL` (with a non-production request-origin fallback), exchanges the code, signs the normal JWT, and redirects back to the UI. The existing Nitro proxy recognizes the callback's final redirect only indirectly: the callback response sets an auth cookie through a dedicated callback response contract, or redirects through a same-origin proxy endpoint that preserves `Set-Cookie`. Tests must verify the final browser-visible response includes the token cookie and no token in the body.

For link flows, a password-confirmed POST creates the signed link state and returns an authorization URL; the UI navigates the browser to that URL. The callback carries the authenticated user ID in the signed state and refuses to link if the external identity is already linked to a different user.

### 4. Nullable local password

Change `users.password_hash` to nullable. Local registration, bootstrap users, and password reset continue to write a bcrypt hash. OAuth-created users write `NULL`, and local login treats NULL as an invalid password without invoking a comparison against attacker-controlled input. A new authenticated set-password endpoint is allowed only for NULL password rows and reuses the existing strength validator.

Using a random unusable hash was considered, but it cannot accurately expose password state and would make future migration/administration ambiguous. The nullable column has a forward-compatible migration and no data loss.

### 5. Account identity and automatic matching

Create `oauth_accounts` with a UUID/text primary key, provider, provider user ID, user ID, display metadata, timestamps, and unique `(provider, provider_user_id)`. On callback, resolve the exact provider identity first. Only a provider-asserted verified email can match an existing user; all other identities create a new user. Insert/link operations handle unique violations as a conflict rather than a 500, covering concurrent callbacks.

### 6. Password confirmation and login-method safety

The link/unlink API accepts a password confirmation for users with a local password. The service first verifies that password, then performs the identity mutation in a transaction. Unlinking checks both the local-password presence and remaining external identities in the same transaction; a passwordless user with one link cannot remove it. No provider credential is persisted.

## Risks / Trade-offs

- [Provider API or discovery changes] → Validate response shapes, use issuer metadata for OIDC, and return generic provider errors while logging only provider/status diagnostics.
- [OAuth callback replay] → Bind signed state to an HttpOnly cookie, enforce expiry, consume before exchange, and keep a bounded consumed nonce cache.
- [Verified-email semantics differ by provider] → Require explicit `email_verified`/GitHub verified-primary evidence; otherwise provision a separate user and require explicit linking.
- [Nullable password affects legacy assumptions] → Update all password comparisons and seed paths, add migration tests, and expose only a boolean password-state field.
- [Callback cookie handling through the proxy is easy to regress] → Add route tests for direct core responses and Nitro proxy integration tests that assert Cookie propagation and token redaction.
- [Concurrent first login] → Rely on the database unique constraint and convert conflict races into a safe retry/linked-user resolution.

## Migration Plan

1. Deploy the migration that makes `users.password_hash` nullable and creates `oauth_accounts`; existing rows remain unchanged.
2. Deploy core code and environment templates. Providers remain hidden until their complete credentials are configured.
3. Deploy the UI with feature detection through the providers endpoint.
4. Rollback code by disabling provider credentials. Rollback schema only after no OAuth-created users remain, or retain the additive table/nullable column for compatibility.

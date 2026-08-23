## Why

PR288 made `UserIdentity` probe the public avatar endpoint for every rendered user, including users whose API data already says they have no avatar. This adds one database-backed 404 request per identity in rankings, community feeds, chats, and other lists. The navigation bar still needs a narrowly scoped probe because the readable session cookie may omit the user's avatar state.

## What Changes

- Keep `UserIdentity`'s existing default behavior: users with no `avatar_url` render the local SVG placeholder without a network request.
- Add an opt-in prop for callers that need to probe an unknown avatar state.
- Enable that opt-in only for the authenticated user's navigation-menu avatar.
- Reset avatar-load fallback state when either the rendered user ID or avatar URL changes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `user-avatar`: Make probing an unknown avatar state an explicit opt-in while preserving the no-request default for known no-avatar users.

## Impact

- `noj-ui/components/shared/UserIdentity.vue`
- `noj-ui/components/layout/UserMenu.vue`
- No backend API or database changes.

# Privy locked API — verified from installed `.d.ts` (2026-09)

Verified against `@privy-io/react-auth@3.40.0` and `@privy-io/server-auth@1.32.5`
(`node_modules/@privy-io/*/dist/dts`). The plan was written against Privy 2.x
docs; reality is v3. Everything below was read from the actual type
declarations, not from memory or docs sites. Re-verify if bumping either
package.

## Client — `@privy-io/react-auth`

**Provider config** (`PrivyProvider`): `appId`, `loginMethods: LoginMethod[]`
(`'email' | 'google' | 'wallet' | …`), `embeddedWallets: { ethereum:
{ createOnLogin: 'users-without-wallets' | 'all-users' | 'off' }, showWalletUIs:
boolean }`. Note v3 nests `createOnLogin` under `embeddedWallets.ethereum`
(v2 docs show it flat — wrong for this version).

**Session** (`usePrivy()`): `{ ready, authenticated, user: User | null, error,
logout(), getAccessToken(options?): Promise<string | null>, … }`.

**Identity token**: module-level `getIdentityToken(): Promise<string | null>`
and a `useIdentityToken()` hook. The ID token is what carries the linked
accounts; the access token's claims do NOT (`AuthTokenClaims` = `{ appId,
issuer, issuedAt, expiration, sessionId, userId }`).

**Wallets** (`useWallets()`): `{ wallets: ConnectedWallet[], ready }`.
`ConnectedWallet`: `address`, `walletClientType`, `connectorType`,
`chainId` (CAIP-2, e.g. `"eip155:31337"`), `switchChain(chainId: 0x…|number)`,
`getEthereumProvider(): Promise<EIP1193Provider>`, `linked`, `loginOrLink`,
`unlink`.

**`EIP1193Provider`**: `{ request({ method, params }), on(event, listener),
removeListener(event, listener) }` — events include `accountsChanged`,
`chainChanged`, `connect`, `disconnect`.

**Headless logins** (all with flow-state unions on the hook):
- `useLoginWithEmail` → `sendCode({ email })` / `loginWithCode({ email, code })`.
- `useLoginWithOAuth` → `initOAuth({ provider, … })` — **redirect-based**;
  state resolves after returning to the app.
- `useLoginWithSiwe` → `generateSiweMessage({ address, chainId: 'eip155:<n>',
  disableSignup? })` / `loginWithSiwe({ signature, message, walletClientType?,
  connectorType? })`. Documented "to be used for a SIWE implementation without
  Privy UIs" — this is the sanctioned headless external-wallet path.

**What does NOT exist headlessly**: `useConnectWallet` / `connectWallet()` /
`login()` only open Privy's prebuilt modal. There is no public headless
external-wallet connect in the main entry (the internal `ConnectorManager`
`connect({ showPrompt })` is not exported for app use). Consequence: external
wallets connect **app-owned** — we request accounts from the injected
EIP-1193 provider ourselves, then authenticate via `useLoginWithSiwe`.
WalletConnect needs its own EIP-1193 provider; it ships behind the same seam
as a follow-up (the connect dialog hides the row without a project id).

**Provisioning**: `useCreateWallet()` → `{ createWallet(), … }` for embedded
wallets on demand.

## Server — `@privy-io/server-auth`

- `new PrivyClient(appId, appSecret)`.
- `verifyAuthToken(token, verificationKeyOverride?): Promise<AuthTokenClaims>`
  — pass `PRIVY_VERIFICATION_KEY` as the override for offline verification.
  Verified from `dist/esm/client.mjs`: it projects the **standard** JWT claims
  — `sub` → `userId`, `sid` → `sessionId`, `iat` → `issuedAt`, `exp` →
  `expiration` — and jose enforces `exp`. There are no custom claim names; a
  minted test token must carry `sub`/`sid`/`iat`/`exp` to verify (and to
  actually expire).
- `getUser({ idToken }): Promise<User>` — verifies the ID token and parses it
  into a `User`. Verified from the same source: `id` comes from `sub`, `cr`
  (epoch seconds) → `createdAt`, and `linked_accounts` rides as a JSON string
  in **snake_case** wire shape (`wallet_client_type`, `chain_type`, `lv`) that
  the parser converts to camelCase on the parsed `User` (`walletClientType`,
  `chainType`, `latestVerifiedAt`). `lv` is epoch seconds (`new Date(1000*lv)`).
  `User.wallet?: WalletWithMetadata` is "the user's most recently-linked wallet
  address" — under the 1 user = 1 wallet invariant this IS the wallet;
  `user.wallet` absent ⇒ no wallet account (422, embedded still provisioning).

## Server session protocol (locked design)

`POST /api/auth/session` and `GET /api/me` expect BOTH headers:
- `Authorization: Bearer <accessToken>` → `verifyAuthToken` → `{ userId, sessionId }`.
- `X-Privy-Id-Token: <idToken>` → `getUser({ idToken })` → resolve the address
  from `user.wallet` only. The request body is never trusted for identity.

## Headless hook signatures (re-verified 2026-09, Phase 5)

- `useLoginWithEmail()` → `sendCode({ email, disableSignup? })`,
  `loginWithCode({ code })` — the hook holds the email; max 5 code attempts.
- `useLoginWithOAuth()` → `initOAuth({ provider, disableSignup? })` — redirect
  via `window.assign`; state resumes on return.
- `useLoginWithSiwe()` → `generateSiweMessage({ address, chainId: \`eip155:${number}\`,
  disableSignup? }) => Promise<string>`; `loginWithSiwe({ signature, message,
  disableSignup?, walletClientType?, connectorType? }) => Promise<User>`.
- `useCreateWallet()` → `createWallet(options?)` — errors if a wallet already
  exists (safe to attempt for provisioning races).
- `usePrivy().getAccessToken()` takes NO options; it auto-refreshes expired
  tokens. Module-level `getIdentityToken(): Promise<string | null>`.
- `ConnectedWallet.switchChain(target: \`0x${string}\` | number): Promise<void>`.
- `PrivyClientConfig.embeddedWallets: { ethereum: { createOnLogin? },
  showWalletUIs? }` — `createOnLogin` defaults to `'off'`; the adapter sets
  `'users-without-wallets'` explicitly (the 1 user = 1 wallet switch).

/**
 * Privy client configuration — build-time, frozen like the rest of the
 * public env surface (restart the dev server to change values).
 *
 * The invariant switch lives here: Web2 logins (email/google) get an embedded
 * wallet provisioned only when the user has no wallet; Web3 logins keep their
 * external wallet and never receive one. `showWalletUIs: false` suppresses
 * Privy's own popups — this app's UI owns every auth state.
 */

import type { PrivyClientConfig } from "@privy-io/react-auth";
import { getActiveChain } from "@/data/web3/chains";

/** Build-time Privy app id. Empty ⇒ Privy disabled ⇒ demo mode. */
export const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

export const PRIVY_ENABLED = privyAppId !== "";

/** Login methods offered by the in-app connect dialog (never Privy's modal). */
export const PRIVY_LOGIN_METHODS = ["email", "google", "wallet"] as const;

/**
 * WalletConnect (as a Privy login surface) is hidden until a project id is
 * configured; the app-owned connect dialog reads this to drop the row.
 */
export const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

/**
 * The provider config handed to PrivyProvider. The invariant switch is
 * `createOnLogin: "users-without-wallets"`: Web2 logins get an embedded
 * wallet only when they have no wallet — which is exactly Web2 users, since
 * a Web3 login already carries its external wallet. `showWalletUIs: false`
 * keeps every auth and wallet state in this app's own surfaces.
 *
 * The chain pins matter as much: without them Privy's embedded wallets boot
 * on its own default (Ethereum mainnet) — the session then reads "unknown
 * network" — and `switchChain` throws for any chain outside `supportedChains`,
 * so the network strip's SWITCH could never land on the desk's chain.
 */
export const PRIVY_PROVIDER_CONFIG = {
  loginMethods: [...PRIVY_LOGIN_METHODS],
  supportedChains: [getActiveChain()],
  defaultChain: getActiveChain(),
  embeddedWallets: {
    ethereum: { createOnLogin: "users-without-wallets" },
    showWalletUIs: false,
  },
} satisfies PrivyClientConfig;

"use client";

/**
 * The bridge — the only React code in the auth adapter. It executes the
 * AuthPort's intents with Privy's headless hooks (email OTP, Google OAuth,
 * SIWE for app-connected external wallets), watches Privy's session state,
 * resolves THE wallet (external wins over embedded, latest linked first),
 * attaches its EIP-1193 provider to the port, and syncs the identity to the
 * backend boundary. Renders null — it is invisible wiring, not UI.
 *
 * Privy's prebuilt modal is never mounted; every login call passes an
 * explicit payload, so this app owns every auth state the user sees.
 */

import { useEffect, useRef } from "react";
import {
  getIdentityToken,
  useCreateWallet,
  useLoginWithEmail,
  useLoginWithOAuth,
  useLoginWithSiwe,
  usePrivy,
  useWallets,
  type EIP1193Provider,
  type User,
} from "@privy-io/react-auth";
import { getAddress, recoverMessageAddress, stringToHex } from "viem";
import { useServices } from "@/data/services";
import { getActiveChain } from "@/data/web3/chains";
import { isUserRejection, normalizeSignature } from "@/data/web3/wallet-client";
import type { PrivyAuthPort } from "./privy-auth-port";
import { PRODUCT_ERRORS } from "./privy-auth-port";
import { createAuthedFetch } from "./authed-fetch";
import { CLOSED_FLOW } from "./session-store";

const GENERIC_ERROR = "Connect failed. Try again in a moment.";

/**
 * ofetch's FetchError carries the parsed response body at `.data`; Privy's
 * HttpError shape carries it at `.responseData`. Neither shows in the error
 * message itself — read both so the console line says what the server said.
 */
function privyResponseBody(err: unknown): unknown {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { data?: unknown; responseData?: unknown };
  return e.data ?? e.responseData ?? null;
}

/** Wallet-client type recorded on the Privy user for the connected wallet. */
function walletClientTypeForId(walletId: string): string {
  if (walletId === "injected") return "unknown";
  return walletId;
}

/**
 * THE wallet from a verified Privy user: external wallets win over the
 * embedded one (Privy's email dedupe can land an external wallet on an
 * embedded user — the signer is still exactly one), most recently linked
 * first. Mirrors the server's resolution rule exactly. The account shape is
 * the parsed linked-account entry (verified against the wire parser).
 */
function resolveWalletAccount(user: User | null): {
  address: string;
  walletClientType: string | null;
} | null {
  const accounts = (user?.linkedAccounts ?? []) as unknown as Array<{
    type: string;
    address?: string;
    walletClientType?: string;
  }>;
  const walletAccounts = accounts.filter((a) => a.type === "wallet" && typeof a.address === "string");
  const external = walletAccounts.filter((a) => a.walletClientType !== "privy");
  const chosen = external.at(-1) ?? walletAccounts.at(-1);
  if (!chosen?.address) return null;
  return {
    address: chosen.address.toLowerCase(),
    walletClientType: chosen.walletClientType ?? null,
  };
}

export function PrivyBridge() {
  const services = useServices();
  const auth = services.auth as PrivyAuthPort;
  const { ready, authenticated, user, logout, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { sendCode, loginWithCode } = useLoginWithEmail();
  const { initOAuth } = useLoginWithOAuth();
  const { generateSiweMessage, loginWithSiwe } = useLoginWithSiwe();
  const { createWallet } = useCreateWallet();

  const authedFetch = useRef(
    createAuthedFetch({
      // Read through a ref so the fetcher survives the hook functions
      // rebinding across renders — it is created once, here.
      getAccessToken: () => tokenFns.current.getAccessToken(),
      getIdentityToken,
    }),
  ).current;
  const tokenFns = useRef({ getAccessToken });
  tokenFns.current = { getAccessToken };

  // -- intents --------------------------------------------------------------

  const handlers = useRef({
    sendCode,
    loginWithCode,
    initOAuth,
    generateSiweMessage,
    loginWithSiwe,
    logout,
    auth,
  });
  handlers.current = { sendCode, loginWithCode, initOAuth, generateSiweMessage, loginWithSiwe, logout, auth };

  useEffect(() => {
    return auth.onIntent((intent) => {
      const h = handlers.current;
      void (async () => {
        switch (intent.type) {
          case "email-code":
          case "email-resend": {
            try {
              await h.sendCode({ email: intent.email });
              h.auth.store.setFlow({ step: "email", email: intent.email, busy: false, error: null });
            } catch {
              h.auth.store.setFlow({
                step: "email",
                email: intent.email,
                busy: false,
                error: "The code didn't send. Check the address and try again.",
              });
            }
            return;
          }
          case "email-verify": {
            try {
              await h.loginWithCode({ code: intent.code });
              // Session effect closes the flow once the wallet resolves.
            } catch {
              const flow = h.auth.store.getFlow();
              if (flow.step === "email") {
                h.auth.store.setFlow({
                  step: "email",
                  email: flow.email,
                  busy: false,
                  error: "That code didn't match. Request a fresh one and try again.",
                });
              }
            }
            return;
          }
          case "google": {
            try {
              await h.initOAuth({ provider: "google" });
              // Redirect flow — the page leaves; state resumes on return.
            } catch {
              h.auth.store.setFlow({ step: "method", error: GENERIC_ERROR });
            }
            return;
          }
          case "siwe-sign": {
            try {
              const chain = getActiveChain();
              // Privy requires the EIP-55 checksummed address in the SIWE
              // message — a lowercase one (MetaMask's eth_accounts shape)
              // is rejected server-side with "Invalid SIWE message and/or
              // signature" before the signature is even checked. Session
              // state stays lowercase; only this message is checksummed.
              const checksummed = getAddress(intent.address as `0x${string}`);
              const message = await h.generateSiweMessage({
                address: checksummed,
                chainId: `eip155:${chain.id}`,
              });
              const raw = (await intent.provider.request({
                method: "personal_sign",
                params: [stringToHex(message), intent.address],
              })) as string;
              // Some wallets answer with the EIP-2098 compact form; Privy's
              // server rejects it. Expand before verifying or submitting.
              const signature = normalizeSignature(raw);
              // Privy's server does this exact ecrecover before accepting the
              // login — run it here first so a wallet signing with its active
              // account (or returning a nonstandard signature) fails with the
              // precise reason instead of a generic 422 downstream.
              let signer: `0x${string}`;
              try {
                signer = await recoverMessageAddress({
                  message,
                  signature: signature as `0x${string}`,
                });
              } catch (recoveryErr) {
                console.error(`[connect] ${intent.label} returned an unreadable signature:`, recoveryErr);
                h.auth.store.setFlow({
                  step: "signature",
                  walletLabel: intent.label,
                  error: PRODUCT_ERRORS.signatureFailed,
                });
                return;
              }
              if (signer.toLowerCase() !== intent.address.toLowerCase()) {
                console.error(
                  `[connect] ${intent.label} signed with ${signer}, not the connected account ${intent.address}`,
                );
                h.auth.store.setFlow({
                  step: "signature",
                  walletLabel: intent.label,
                  error: PRODUCT_ERRORS.signatureWrongAccount,
                });
                return;
              }
              await h.loginWithSiwe({
                signature,
                message,
                walletClientType: walletClientTypeForId(intent.walletId),
                connectorType: "injected",
              });
              // Session effect attaches the wallet and closes the flow.
            } catch (err) {
              // Same contract as the port's connect failure: raw reason to
              // the console, product voice to the amber box. The response
              // body is Privy's own verdict — print it beside the error.
              console.error(`[connect] SIWE login with ${intent.label} failed:`, err);
              const body = privyResponseBody(err);
              if (body) console.error("[connect] Privy response body:", body);
              h.auth.store.setFlow({
                step: "signature",
                walletLabel: intent.label,
                error: isUserRejection(err) ? PRODUCT_ERRORS.signatureDeclined : GENERIC_ERROR,
              });
            }
            return;
          }
          case "logout": {
            // The port already ended its own session; Privy's is the other half.
            try {
              await h.logout();
            } catch {
              // Session is already down on this side; Privy's leftovers clear
              // on the next load. No user-visible state depends on this.
            }
            return;
          }
        }
      })();
    });
  }, [auth]);

  // -- session orchestration ------------------------------------------------

  const provisionAttempted = useRef<string | null>(null);

  useEffect(() => {
    if (!ready) return; // pre-ready: the store's disconnected snapshot shows
    if (!authenticated || !user) {
      // User-initiated disconnect ends the session through the intent handler
      // before Privy's logout resolves — reaching this branch with a live
      // session means Privy ended it out-of-band (revocation, expiry). Close
      // ours to match; the UI voices it as an ended connection.
      if (auth.getSession().status !== "idle") auth.endSession("expired");
      return;
    }

    auth.setDid(user.id);

    const walletAccount = resolveWalletAccount(user);
    if (!walletAccount) {
      // Web2 login with no wallet yet: provision the embedded wallet. The
      // effect re-runs when useWallets surfaces it, and attachWallet closes
      // the flow.
      auth.store.setFlow({ step: "provisioning", error: null });
      if (provisionAttempted.current !== user.id) {
        provisionAttempted.current = user.id;
        createWallet().catch(() => {
          // Either Privy is already creating it (createOnLogin) or the user
          // has one linking next — both resolve through the wallets effect.
        });
      }
      return;
    }

    if (walletAccount.walletClientType === "privy") {
      // Embedded: Privy manages the wallet — take its provider as-is.
      const managed = wallets.find(
        (w) => w.address?.toLowerCase() === walletAccount.address && w.walletClientType === "privy",
      );
      if (!managed) return; // provisioning still in flight
      void managed.getEthereumProvider().then((provider: EIP1193Provider) => {
        auth.attachWallet({
          address: walletAccount.address,
          walletKind: "embedded",
          walletLabel: "Privy",
          provider,
          chainId: managed.chainId,
          switchManaged: (hex) => managed.switchChain(hex as `0x${string}`),
        });
        auth.store.setFlow(CLOSED_FLOW);
      });
      return;
    }

    // External: the connect attached our own provider during the SIWE flow.
    if (auth.hasAttached(walletAccount.address)) {
      auth.store.setFlow(CLOSED_FLOW);
      return;
    }
    // Otherwise this is a restored session (reload): re-attach silently.
    void auth.restoreExternal(walletAccount.address).then((wallet) => {
      if (wallet) {
        auth.attachWallet({
          address: walletAccount.address,
          walletKind: "external",
          walletLabel: wallet.label,
          provider: wallet.provider,
        });
        auth.store.setFlow(CLOSED_FLOW);
      } else {
        // The wallet that owns this account isn't in this browser anymore.
        // One user = one wallet: end the session, don't re-auth into it.
        auth.endSession("wallet-changed");
        void logout();
      }
    });
  }, [ready, authenticated, user, wallets, auth, logout, createWallet]);

  // -- identity sync ----------------------------------------------------------

  useEffect(() => {
    const sync = async () => {
      try {
        const res = await authedFetch("/api/auth/session", { method: "POST" });
        if (res.ok) auth.markSync("synced");
        else if (res.status === 401) auth.markSync("expired");
        else auth.markSync("failed");
      } catch {
        // Transport-level failure (offline, request aborted) — a failed
        // sync, not a crash. Reconnecting or reloading retries it.
        auth.markSync("failed");
      }
    };

    // The account store binds itself to the session in Web3Services; this
    // seam only keeps the server-side identity record in step.
    return auth.subscribeSession((session) => {
      if (session.status === "connected" && session.did && session.address) {
        if (session.syncState === "idle") void sync();
      }
    });
  }, [auth, authedFetch]);

  return null;
}

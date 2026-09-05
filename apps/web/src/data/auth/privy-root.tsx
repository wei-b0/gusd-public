"use client";

/**
 * PrivyRoot — mounts the Privy provider and the auth bridge around the app
 * when Privy is configured. Without NEXT_PUBLIC_PRIVY_APP_ID the app renders
 * unchanged (demo mode). The bridge renders null; it only wires the auth
 * port to Privy's hooks.
 */

import { PrivyProvider } from "@privy-io/react-auth";
import { PRIVY_ENABLED, PRIVY_PROVIDER_CONFIG, privyAppId } from "./privy-config";
import { PrivyBridge } from "./privy-bridge";

export function PrivyRoot({ children }: { children: React.ReactNode }) {
  if (!PRIVY_ENABLED) return <>{children}</>;
  return (
    <PrivyProvider appId={privyAppId} config={PRIVY_PROVIDER_CONFIG}>
      <PrivyBridge />
      {children}
    </PrivyProvider>
  );
}

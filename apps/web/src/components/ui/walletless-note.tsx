import { PRIVY_ENABLED } from "@/data/auth/privy-config";

/**
 * The build's one walletless confession — rendered by the desks when this
 * bundle carries no Privy app id and therefore no signer at all. The ports
 * behind the desks refuse to act; this note says why before the user tries,
 * instead of a silent dead button.
 */
export function WalletlessNote() {
  if (PRIVY_ENABLED) return null;
  return (
    <p className="border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber">
      This build runs without wallet support — nothing can sign here.
    </p>
  );
}

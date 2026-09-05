/**
 * The self-transfer — the one transaction shape this phase can run for real,
 * on Anvil, to prove the full lifecycle (sign → submit → pending → confirmed
 * / rejected / reverted / failed) end to end for both wallet kinds. It moves
 * a dust amount of the wallet's own ETH to itself: no protocol, no approvals,
 * nothing to undo. It is dev-gated at the UI surface and is never a product
 * action.
 */

import { parseEther, type WalletClient } from "viem";
import type { TxSpec } from "@/domain/types";

/** Self-transfer amount: deliberately small, visible in the wallet prompt. */
const SELF_TRANSFER_ETH = "0.00001";

export function selfTransferSpec(): TxSpec {
  return {
    origin: "dev",
    kind: "self-transfer",
    async execute(wallet: WalletClient) {
      const account = wallet.account?.address;
      if (!account) throw new Error("No signer on the session wallet.");
      const hash = await wallet.sendTransaction({
        account,
        // `to` = self; chain is bound by the client. Value is a dust ETH.
        to: account,
        value: parseEther(SELF_TRANSFER_ETH),
        // Provider wallets price it themselves; anvil does too.
        chain: null,
      });
      return { hash };
    },
  };
}

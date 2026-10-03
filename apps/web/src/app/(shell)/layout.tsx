import { ServicesProvider } from "@/data/services";
import { PrivyRoot } from "@/data/auth/privy-root";
import { SystemBar } from "@/components/shell/system-bar";
import { ConnectDialog } from "@/components/shell/connect-dialog";
import { NetworkStrip } from "@/components/shell/network-strip";
import { FnKeys } from "@/components/shell/fn-keys";
import { StatusLine } from "@/components/shell/status-line";
import { TxDevPanel } from "@/components/ui/tx-receipt";

/**
 * The persistent machine shell — sticky system bar, function-key rail, fixed
 * status line — wraps every product route; no route in this group ever
 * renders naked. The entry gate lives outside this group on purpose.
 */
export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <ServicesProvider>
      <PrivyRoot>
        <SystemBar />
        <NetworkStrip />
        <FnKeys />
        <main className="mx-auto w-full max-w-300 px-3 pt-5 pb-20 md:px-5">{children}</main>
        <TxDevPanel />
        <StatusLine />
        <ConnectDialog />
      </PrivyRoot>
    </ServicesProvider>
  );
}

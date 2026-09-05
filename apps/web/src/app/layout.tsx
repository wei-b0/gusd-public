import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import { ServicesProvider } from "@/data/services";
import { PrivyRoot } from "@/data/auth/privy-root";
import { SystemBar } from "@/components/shell/system-bar";
import { ConnectDialog } from "@/components/shell/connect-dialog";
import { NetworkStrip } from "@/components/shell/network-strip";
import { FnKeys } from "@/components/shell/fn-keys";
import { StatusLine } from "@/components/shell/status-line";
import { TxDevPanel } from "@/components/ui/tx-receipt";
import "./globals.css";

const jbMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700", "800"],
  variable: "--font-jb",
});

export const metadata: Metadata = {
  title: "gUSD — The GPU Assets Protocol",
  description:
    "The GPU Assets Protocol: a market for GPU assets quoted in gUSD, the protocol's settlement unit. Trade GPU markets at a premium or discount to the gUSD Index benchmarks.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={jbMono.variable}>
      <body>
        <ServicesProvider>
          <PrivyRoot>
            <SystemBar />
            <NetworkStrip />
            <FnKeys />
            <main className="mx-auto w-full max-w-360 px-3 pt-5 pb-20 md:px-5">{children}</main>
            <TxDevPanel />
            <StatusLine />
            <ConnectDialog />
          </PrivyRoot>
        </ServicesProvider>
      </body>
    </html>
  );
}

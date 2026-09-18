import Link from "next/link";
import { ASSET_IDS, pairName } from "@/domain/types";

/** In-world 404: the code resolved to nothing on this machine. */
export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center">
      <div className="w-full border border-rule-strong bg-panel">
        <div className="flex items-baseline justify-between border-b border-rule-strong px-3.5 py-2">
          <span className="num text-[12px] font-bold text-amber">404 · UNRECOGNIZED CODE</span>
          <span className="slug text-dim">gUSD terminal</span>
        </div>
        <div className="p-3.5">
          <p className="num text-[13px] leading-relaxed text-data">
            The command or route resolved to nothing on this machine. Markets lists every
            live market:
          </p>
          <p className="num mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] font-bold">
            {ASSET_IDS.map((id) => (
              <Link key={id} href={`/terminal/${id}`} className="whitespace-nowrap text-data underline decoration-rule-strong underline-offset-4 transition-colors hover:text-bright">
                {pairName(id)}
              </Link>
            ))}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/" className="rev slug px-4 py-2 text-rev-fg">
              BACK TO MARKETS
            </Link>
            <Link
              href="/oracle?tab=developers"
              className="slug border border-rule-strong px-4 py-2 text-[12px] text-data transition-colors hover:border-amber hover:text-amber"
            >
              INTERFACE CATALOG
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

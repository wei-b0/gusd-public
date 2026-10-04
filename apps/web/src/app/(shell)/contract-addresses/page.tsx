import type { Metadata } from "next";
import { TuiPanel } from "@/components/ui/panel";
import { AddressRow } from "@/components/contracts/address-row";
import { contractAddresses, type ProtocolAddresses } from "@/data/web3/contracts";
import {
  chainLabel,
  configuredRpcUrl,
  getActiveChain,
} from "@/data/web3/chains";
import { stablesFor, stableLabel } from "@/data/web3/stables";
import { Gusd, SGusd } from "@/components/ui/pair";

export const metadata: Metadata = {
  title: "Contract addresses — gUSD",
};

/**
 * Contract addresses — the deployment record as a page: the one chain this
 * build speaks to, every contract address it deployed, and the funding
 * assets whitelisted on its StableRouter. The record is the source of truth
 * (apps/contracts/deployments/<chainId>.json, generated into
 * abis/addresses.generated.ts) — the page renders it, never hard-codes it.
 * GPU token addresses are absent by design: GPUTokens resolve at runtime
 * via GPUIssuance.tokenOf.
 */

function LedgerRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-rule py-1.5 last:border-b-0 last:pb-0">
      <dt className="slug shrink-0 text-dim">{label}</dt>
      <dd className="num text-right text-[12.5px] text-data">{value}</dd>
    </div>
  );
}

export default function ContractAddressesPage() {
  const chain = getActiveChain();
  const label = chainLabel(chain.id) ?? chain.name;

  let record: ProtocolAddresses | null = null;
  try {
    record = contractAddresses();
  } catch {
    record = null; // the registry knows the chain; the monorepo hasn't deployed here
  }

  const rpc = configuredRpcUrl(chain.id);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-rule-strong pb-3">
        <h1 className="disp text-[22px] leading-none text-primary">Contract addresses</h1>
        <p className="slug text-dim">The deployment · {label}</p>
      </div>

      {/* 01 — the network the record lives on */}
      <TuiPanel no="01" title="Network" meta="the chain this build trades">
        <dl className="p-3.5 pb-2.5">
          <LedgerRow label="Network" value={label} />
          <LedgerRow label="Chain id" value={String(chain.id)} />
          <LedgerRow label="RPC" value={rpc ?? "—"} />
          <LedgerRow
            label="Deployment block"
            value={record ? record.startBlock.toLocaleString("en-US") : "—"}
          />
          <LedgerRow
            label="Oracle epoch"
            value={record?.oracleEpochLength != null ? `${record.oracleEpochLength}s grid` : "—"}
          />
          <LedgerRow
            label="Max observation age"
            value={record?.oracleMaxObservationAge != null ? `${record.oracleMaxObservationAge}s` : "—"}
          />
        </dl>
      </TuiPanel>

      {!record ? (
        <p
          role="status"
          className="mt-4 border border-amber/40 bg-amber/10 p-2.5 text-[11.5px] leading-relaxed text-amber"
        >
          No deployment record for this chain — the registry knows {label}, the
          monorepo has not deployed here. Addresses print when a record exists.
        </p>
      ) : (
        <>
          {/* 02 — capital & markets */}
          <div className="mt-5">
            <TuiPanel no="02" title="Capital & markets" meta="the unit and its desks">
              <dl className="p-3.5 pb-2.5">
                <AddressRow label={<Gusd />} address={record.gusd} />
                <AddressRow label={<SGusd />} address={record.sgusd} />
                <AddressRow label="GPUIssuance" address={record.issuance} />
                <AddressRow label="GPUMarketLiquidity" address={record.marketLiquidity} />
                <AddressRow label="RevenueLedger" address={record.ledger} />
                <AddressRow label="GpuPerpEngine" address={record.perpEngine} />
                <AddressRow label="StableRouter" address={record.stableRouter} />
              </dl>
              <p className="border-t border-rule px-3.5 py-2 text-[11.5px] leading-relaxed text-dim">
                GPU market addresses are absent by design — GPUTokens deploy
                per GPU class and resolve at runtime via GPUIssuance.tokenOf.
              </p>
            </TuiPanel>
          </div>

          {/* 03 — oracle & Uniswap v4 */}
          <div className="mt-5">
            <TuiPanel no="03" title="Oracle & Uniswap v4" meta="the wire and the pools">
              <dl className="p-3.5 pb-2.5">
                <AddressRow label="GpuOracle" address={record.oracle} />
                {record.oracleAttestor && (
                  <AddressRow
                    label="Oracle attestor"
                    note="signer"
                    address={record.oracleAttestor}
                  />
                )}
                <AddressRow label="GPUHook" address={record.hook} />
                <AddressRow label="GpuRouter" address={record.router} />
                <AddressRow label="GpuQuoter" address={record.gpuQuoter} />
                <AddressRow label="PoolManager" address={record.poolManager} />
                <AddressRow label="PositionManager" address={record.positionManager} />
                <AddressRow label="StateView" address={record.stateView} />
                <AddressRow label="Permit2" address={record.permit2} />
              </dl>
            </TuiPanel>
          </div>

          {/* 04 — funding assets */}
          <div className="mt-5">
            <TuiPanel no="04" title="Funding assets" meta="whitelisted on the StableRouter">
              <dl className="p-3.5 pb-2.5">
                {stablesFor(chain.id).map((stable) => (
                  <AddressRow
                    key={stable.address}
                    label={stableLabel(stable)}
                    address={stable.address}
                  />
                ))}
                <AddressRow label="WETH" address={record.weth} />
              </dl>
              <p className="border-t border-rule px-3.5 py-2 text-[11.5px] leading-relaxed text-dim">
                Identity comes from the deployment record, never from on-chain
                symbols — a lookalike at these addresses is not a funding asset.
              </p>
            </TuiPanel>
          </div>
        </>
      )}

      <p className="mt-4 max-w-prose text-[11.5px] leading-relaxed text-dim">
        Generated from the deployment record at deploy time — addresses are
        never literals in app code, and a redeploy rotates every one.
      </p>
    </div>
  );
}
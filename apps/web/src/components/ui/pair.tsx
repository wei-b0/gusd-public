/**
 * Canonical-casing nodes for the protocol's names. The slug voice sets
 * all-caps; the unit (gUSD, sGUSD) and the benchmark names keep their
 * product casing inside it, the way a wordmark does. Use the plain string
 * form (`pairName`) in .num contexts, which never transform case.
 */

import type { ReactNode } from "react";

/** The tradeable-market pair, `H100 / gUSD`, in slug (caps) copy. */
export function Pair({ id }: { id: string }): ReactNode {
  return (
    <>
      {id} / <span className="normal-case">gUSD</span>
    </>
  );
}

/** The settlement unit, canonical casing inside slug (caps) copy. */
export function Gusd(): ReactNode {
  return <span className="normal-case">gUSD</span>;
}

/** The earning unit, canonical casing inside slug (caps) copy. */
export function SGusd() {
  return <span className="normal-case">sGUSD</span>;
}

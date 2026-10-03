import { encodeFunctionData, decodeFunctionResult } from "viem";

/**
 * Boot-time posture cross-check against the DEPLOYED GpuOracle. The attestor
 * never broadcasts — but a wrong key, chain id, or epoch grid boots cleanly
 * and produces signatures the contract reverts on (InvalidSignature / epoch
 * mismatch), discovered only when the first trade consumes them. When an
 * ATTESTOR_RPC_URL is configured the poller refuses to start on any drift
 * between the configured posture and the oracle's own public state
 * (docs/mainnet-deploy.md §4); without an RPC the drift is only a warn.
 *
 * The reads are plain eth_call/eth_chainId over fetch — no chain object, no
 * wallet, nothing that could sign or send. GpuOracle exposes all three as
 * public state vars (src/oracle/GpuOracle.sol): signer, epochLength,
 * maxObservationAge.
 */

const ORACLE_ABI = [
  {
    name: "signer",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "epochLength",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
  },
  {
    name: "maxObservationAge",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
  },
] as const;

export interface OraclePostureInput {
  rpcUrl: string;
  oracleAddress: `0x${string}`;
  attestorAddress: `0x${string}`;
  chainId: number;
  epochLength: number;
  maxObservationAge: number;
  fetchImpl?: typeof fetch;
}

export interface OraclePostureReport {
  onchainChainId: string;
  onchainSigner: `0x${string}`;
  onchainEpochLength: number;
  onchainMaxObservationAge: number;
  /** Empty means the configured posture matches the deployed oracle exactly. */
  mismatches: string[];
}

async function ethCall(
  rpcUrl: string,
  to: string,
  data: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`eth_call to the deployed GpuOracle failed: HTTP ${res.status} from ${rpcUrl}`);
  }
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (body.error !== undefined || typeof body.result !== "string") {
    throw new Error(
      `eth_call to the deployed GpuOracle reverted at ${rpcUrl}: ${body.error?.message ?? "empty result"} — is ATTESTOR_ORACLE_ADDRESS a live GpuOracle on this RPC?`,
    );
  }
  return body.result;
}

async function ethChainId(rpcUrl: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`eth_chainId failed: HTTP ${res.status} from ${rpcUrl}`);
  }
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (body.error !== undefined || typeof body.result !== "string") {
    throw new Error(`eth_chainId failed at ${rpcUrl}: ${body.error?.message ?? "empty result"}`);
  }
  return body.result;
}

export async function checkOraclePosture(input: OraclePostureInput): Promise<OraclePostureReport> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const call = (name: (typeof ORACLE_ABI)[number]["name"]): Promise<string> =>
    ethCall(
      input.rpcUrl,
      input.oracleAddress,
      encodeFunctionData({ abi: ORACLE_ABI, functionName: name }),
      fetchImpl,
    );

  const [onchainChainId, signerRaw, epochRaw, ageRaw] = await Promise.all([
    ethChainId(input.rpcUrl, fetchImpl),
    call("signer"),
    call("epochLength"),
    call("maxObservationAge"),
  ]);

  const onchainSigner = decodeFunctionResult({
    abi: ORACLE_ABI,
    functionName: "signer",
    data: signerRaw as `0x${string}`,
  });
  const onchainEpochLength = Number(
    decodeFunctionResult({
      abi: ORACLE_ABI,
      functionName: "epochLength",
      data: epochRaw as `0x${string}`,
    }),
  );
  const onchainMaxObservationAge = Number(
    decodeFunctionResult({
      abi: ORACLE_ABI,
      functionName: "maxObservationAge",
      data: ageRaw as `0x${string}`,
    }),
  );

  const mismatches: string[] = [];
  if (Number(onchainChainId) !== input.chainId) {
    mismatches.push(
      `chain id ${Number(onchainChainId)} on the RPC != ATTESTOR_CHAIN_ID ${input.chainId} — the EIP-712 domain would not match the deployed oracle`,
    );
  }
  if (onchainSigner.toLowerCase() !== input.attestorAddress.toLowerCase()) {
    mismatches.push(
      `GpuOracle.signer() ${onchainSigner} != the configured ATTESTOR_PRIVATE_KEY address ${input.attestorAddress} — every signature would revert InvalidSignature on-chain`,
    );
  }
  if (onchainEpochLength !== input.epochLength) {
    mismatches.push(
      `GpuOracle.epochLength() ${onchainEpochLength} != ATTESTOR_EPOCH_LENGTH ${input.epochLength} — reports would target epochs the contract does not recognize`,
    );
  }
  if (onchainMaxObservationAge !== input.maxObservationAge) {
    mismatches.push(
      `GpuOracle.maxObservationAge() ${onchainMaxObservationAge} != ATTESTOR_MAX_OBSERVATION_AGE ${input.maxObservationAge}`,
    );
  }

  return {
    onchainChainId,
    onchainSigner,
    onchainEpochLength,
    onchainMaxObservationAge,
    mismatches,
  };
}
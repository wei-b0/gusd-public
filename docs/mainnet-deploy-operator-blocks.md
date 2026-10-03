# Mainnet redeploy — operator command blocks (Robinhood Chain 4663)

Run these in YOUR OWN terminal (this VM, or `ssh ubuntu@65.1.121.149`) —
private keys are typed nowhere near any chat/agent context. `<DEPLOY_KEY>`
and `<KEEPER_KEY>` are placeholders you fill inline.

Current state when this template was written: branch `plan/gpu-perps`
pushed at `b4091b7` (merge + regenerated dev record); all gates green
(forge 383/383, turbo 28/28); the 09-28 generation is live and attesting;
capital census found no third-party capital (≈2 gUSD of operator-owned
dust; all genesis assets sit in the deployer EOA `0xDeF1Cb3D…87EFe`).

## Pre-deploy top-ups (operator wallet actions)

- Deployer EOA `0xDeF1Cb3D2CB4819f0fe36deA4ce2C4a732187EFe`:
  - USDG balance was 0.383 — **DONE 2026-10-03**: swapped 0.002 ETH →
    5.3689 USDG through the canonical v3 fee-100 WETH/USDG pool (tx
    `0x6684b2e4…`), leaving 5.74 USDG on hand at deploy time.
  - Native is 0.00524 ETH — enough for the deploy at the current
    ~0.0265 gwei base fee; a small top-up (→ ~0.02 ETH) is cheap
    headroom. (Actual broadcasts 2026-10-03 spent ≈ 0.0013 each.)
- Keeper hot key: generate a DEDICATED key (never the deployer or the
  `0xfEed…` attestor key) and fund it with ≥ 0.1 ETH native. Note its
  address — Phase 4 needs it for `KEEPER_PRIVATE_KEY` on the host.

## Phase 2 — contracts deploy (this VM, your terminal)

```sh
cd /home/ubuntu/gusd/apps/contracts
export PATH=~/.foundry/bin:$PATH
rm -rf broadcast cache

RPC=https://rpc.mainnet.chain.robinhood.com
ENV=( UNDERLYING=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
      ORACLE_ATTESTOR=0xfEed079814cB1fFd2E7aECd3A991A78309e0b5e8
      TREASURY=0xDeF1Cb3D2CB4819f0fe36deA4ce2C4a732187EFe
      STABLES=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
      SEED_PRICE_H100=24503 SEED_PRICE_H200=37872
      SEED_PRICE_L40S=13376 SEED_PRICE_RTX4090=4449
      # Canonical v4 stack — WITHOUT these the deploy falls back to a fresh
      # second PoolManager/StateView/Quoter + solmate WETH (fragmented stack;
      # happened in the first 2026-10-03 broadcast). Always set them.
      POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951
      STATE_VIEW=0xF3334192D15450CdD385c8B70e03f9A6bD9E673b
      QUOTER=0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94
      POSITION_MANAGER=0x58daec3116aae6D93017bAAea7749052E8a04fA7
      WETH=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
      PRIVATE_KEY=<DEPLOY_KEY> )

# 1) dry run — sim only; exercises the five mainnet guards.
#    CAUTION: this REWRITES deployments/4663.json with simulated
#    addresses — restored from backup right after.
env "${ENV[@]}" forge script script/Deploy.s.sol --rpc-url $RPC --sig "run()"

# 2) restore the poison record from backup
cp deployments/4663.20260928.json.bak deployments/4663.json

# 3) broadcast (same env, gas pinned at 0.05 gwei; current base ~0.0265)
env "${ENV[@]}" forge script script/Deploy.s.sol --rpc-url $RPC \
  --broadcast --sig "run()" --with-gas-price 50000000
```

Expect the broadcast to spend ≈ 0.0006-0.001 ETH and take a couple of
minutes. When it lands, tell me — I take over: verify via eth_call
probes, commit the record + regenerated web artifacts, push, open the
PR, then the host cutover (which I run over SSH; the only secret there
is the keeper key you place in `infra/.env` yourself).

Two 4663-specific post-deploy quirks (2026-10-03 observed):

- The RPC can serve a **stale `block.number` to forge sims** (both
  2026-10-03 broadcasts read ~26.1M while the head was ~79M; txs still
  landed at real head-range blocks). The persisted record's `startBlock`
  can therefore be far behind — check the first broadcast tx's landing
  block (`cast receipt <hash> blockNumber`) and patch `startBlock` to
  that block minus 1 before committing.
- SwapRouter02 on 4663 is Permit2-only for ERC20 input; funding ETH→USDG
  = WETH.deposit → ERC20-approve Permit2 → Permit2.approve(router) →
  `exactInputSingle` with the **7-field** struct (v2 has no per-swap
  deadline field).

## Phase 4 input you'll need on the host

Edit `infra/.env` on the host AFTER the record lands (I will have staged
everything else). You add exactly two secret lines:

```sh
KEEPER_PRIVATE_KEY=<KEEPER_KEY>    # the dedicated hot key
# ATTESTOR_PRIVATE_KEY is already present on the host (the 0xfEed… key)
```

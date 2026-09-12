// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateView} from "@uniswap/v4-periphery/lens/StateView.sol";
import {PositionManager} from "@uniswap/v4-periphery/PositionManager.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/interfaces/IV4Quoter.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {Actions} from "@uniswap/v4-periphery/libraries/Actions.sol";
// test-only Planner reuse, same as Demo: production frontends encode the
// PositionManager bundle offchain
import {Planner, Plan} from "v4-periphery-test/shared/Planner.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GUSD} from "../src/GUSD.sol";
import {GPUIssuance} from "../src/GPUIssuance.sol";
import {GPUMarketLiquidity} from "../src/GPUMarketLiquidity.sol";
import {GPUToken} from "../src/GPUToken.sol";
import {RevenueLedger} from "../src/RevenueLedger.sol";
import {sgUSD} from "../src/sgUSD.sol";
import {GPUHook} from "../src/hooks/GPUHook.sol";
import {GpuRouter} from "../src/GpuRouter.sol";
import {GpuQuoter} from "../src/lens/GpuQuoter.sol";
import {IGPUIssuance} from "../src/interfaces/IGPUIssuance.sol";
import {StableRouter} from "../src/StableRouter.sol";
import {GpuPoolKey} from "../src/libraries/GpuPoolKey.sol";
import {MockGPUPriceOracle} from "../src/oracle/MockGPUPriceOracle.sol";
import {GPUPriceOracle} from "../src/oracle/GPUPriceOracle.sol";
import {Deploy} from "./Deploy.s.sol";

/// @notice Full-catalogue dev/testnet deployment: runs the production Deploy
///         unchanged, then seeds EVERYTHING the web app exercises onchain —
///         all 4 launch SKUs (registered, oracle-priced, issuance-enabled,
///         canonical pools live from Deploy.run), a deterministic mock USDT
///         whitelisted on the StableRouter with a funded USDT/reserve pool,
///         and a compact demo-activity pass (genesis backstop buys, bootstrap
///         conversion sells, actor trades, an instant-reprice proof,
///         distribute + staking) so the tape, activity ledgers, vault
///         inventory and cost basis are populated the moment the stack is up.
///
///         Seeding doctrine (C-max): no treasury LP seeds on GPU pools — the
///         vault's inventory originates only from real flows. Genesis buys
///         run the in-swap issuance backstop on the cold pools (principal
///         becomes bid capacity); a bootstrap conversion sells a slice back
///         so the vault holds genuine ask-side GPU. GpuQuoter drives every
///         activity buy (quote == execution). GPU pools carry no LP depth:
///         the hook IS the book; only the hook-free stable pool is LP'd.
///
///         Run: forge script script/Deploy.full.s.sol --rpc-url <url> --broadcast --sig "runFull()"
///         The chain it produces is NON-VIRGIN: Demo.s.sol (virgin-state
///         requires) will not run after it. Minimal flow-testing recipe
///         remains Deploy + Demo; this script is the whole-app recipe for
///         Anvil AND testnets. Actor keys are the public anvil dev keys —
///         test posture only.
contract DeployFull is Deploy {
    using PoolIdLibrary for PoolKey;

    // launch catalogue (PROTOCOL.md §3) — Deploy.run registers all four; the
    // aliases keep the demo code readable and the ids single-sourced in Deploy
    bytes32 constant H100 = H100_ID;
    bytes32 constant H200 = H200_ID;
    bytes32 constant L40S = L40S_ID;
    bytes32 constant RTX_4090 = RTX_4090_ID;
    bytes32[] internal CATALOGUE;

    // the web's mint desk hardcodes this tier for stable funding pools
    // (apps/web/src/data/web3/gusd/actions.ts STABLE_POOL) and StableRouter
    // rejects hook-bearing pools — the key must be exactly this shape
    uint24 constant STABLE_FEE = 100;
    int24 constant STABLE_TICK_SPACING = 1;

    // fixed CREATE2 salt for the mock USDT: identical bytecode + salt +
    // universal proxy ⇒ the SAME address on Anvil and every testnet, which
    // is what lets the web pin it in its per-chain stable display config
    bytes32 constant USDT_SALT = keccak256("gusd.mock.usdt.v1");

    uint256 constant GENESIS_PER_SKU = 10_000e18; // deployer inventory (GPU-wei)
    uint128 constant STABLE_POOL_LIQUIDITY = 1e13; // ~10M units per side at 1:1

    // GpuQuoter floats: seeds the PoolManager during quote simulations. The
    // whole unlock reverts on every quote, so the float is never consumed —
    // it only has to back the largest single simulation. gUSD backs buys;
    // each SKU's GPU float backs sell quotes (the hook takes the seller's
    // GPU in-lock, so the simulation needs physical GPU behind it).
    uint256 constant QUOTER_FLOAT = 2_000_000e6;
    uint256 constant GPU_FLOAT_PER_SKU = 1_000e18;

    // anvil rich keys (test actors, same as Demo): alice = #2, bob = #3
    uint256 constant ALICE_PK = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant BOB_PK = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;

    constructor() {
        CATALOGUE.push(H100);
        CATALOGUE.push(H200);
        CATALOGUE.push(L40S);
        CATALOGUE.push(RTX_4090);
    }

    function runFull() external returns (Deployment memory d) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address alice = vm.addr(ALICE_PK);
        address bob = vm.addr(BOB_PK);
        // Indexer anchor: the pre-broadcast head. Deploy._persist computes
        // block.number - 1 assuming it IS the broadcast entry (true for a
        // standalone `forge script Deploy`), but nested inside runFull the
        // chain has already advanced past the genesis blocks by the time it
        // runs — so capture the anchor here, before any of this run's txs
        // land, and pass it to _persistFull. On a virgin chain this is 0;
        // on a live rerun, this run's redeployment events all land after it.
        uint256 anchorBlock = block.number;

        // ------------------------------------------------ 0) production core
        // Deploy.run() self-scopes its own broadcast (deployer must NOT be
        // broadcasting here) and persists the deployment record. The four
        // launch SKUs come back fully registered: oracle seeds, enabled
        // issuance, canonical pools initialized (empty) at the live oracle
        // prices. The entry is non-virtual, so run it on a local Deploy
        // instance — script contracts are ephemeral and may not use
        // address(this) (which rules out a `this.run()` self-call).
        Deploy inner = new Deploy();
        d = inner.run();
        require(d.underlying != address(0), "core deploy");

        vm.startBroadcast(pk);
        GUSD gusd = GUSD(d.gusd);
        GPUIssuance issuance = GPUIssuance(d.issuance);
        GPUMarketLiquidity vault = GPUMarketLiquidity(d.marketLiquidity);
        GPUHook hook = GPUHook(d.hook);
        RevenueLedger ledger = RevenueLedger(d.ledger);
        sgUSD sg = sgUSD(d.sgusd);
        GpuRouter router = GpuRouter(d.router);
        StableRouter stableRouter = StableRouter(d.stableRouter);
        StateView stateView = StateView(d.stateView);
        // stock V4Quoter: valid for the hook-free stable pool only (GPU pools
        // quote through the float-seeded GpuQuoter)
        IV4Quoter quoter = IV4Quoter(d.quoter);
        GpuQuoter gq = GpuQuoter(d.gpuQuoter);
        // PositionManager has a payable fallback (WETH deposits): cast via
        // an interface-shaped variable, same as Demo
        address posmAddr = d.positionManager;
        PositionManager posm;
        assembly ("memory-safe") {
            posm := posmAddr
        }

        // ----------------------------- 2) deployer gUSD working balance
        // Mock reserve funds itself (the Deploy default posture); a real
        // UNDERLYING has no mint — fall back to transferring holdings.
        // 16M = the 4M gUSD backing (pulled back out by the mint below) + the
        // 10M stable-pool LP position + slack. GUSD mint/redeem rounds the
        // payout through this balance and the reserve, so it must clear both.
        _fundReserve(d.underlying, deployer, 16_000_000e6, deployer);
        IERC20(d.underlying).approve(d.gusd, type(uint256).max);
        // Covers the quoter float (2M) + the genesis backstop buys across the
        // catalogue (~0.07M incl. fees) + slack; the mock reserve mints freely.
        gusd.mint(4_000_000e6, deployer);
        gusd.approve(d.router, type(uint256).max);

        // ------------------------------------------- 2.5) quoter float
        // One owner funding backs every quote in this pass: each quote ends
        // in a reverted unlock, so the float is never actually consumed.
        gusd.approve(d.gpuQuoter, type(uint256).max);
        gq.setGusdFloat(QUOTER_FLOAT);

        // --------------------- 3) genesis inventory: in-swap backstop per SKU
        // Pools are registered but carry nothing: no LP, no vault inventory.
        // The hook's ladder walks W=0 and the issuance backstop mints 100%
        // of the demand in-swap — the principal lands in the vault as bid
        // capacity (notePrincipal) inside the very same swap. maxPaid is the
        // exact hand-computed charge chain: base + issuance fee + hook fee
        // (+2 wei slack for the fee-adjusted spend-cap floor).
        for (uint256 i; i < CATALOGUE.length; ++i) {
            bytes32 gpuId = CATALOGUE[i];
            uint256 price = _priceOf(gpuId);
            uint256 base = Math.mulDiv(GENESIS_PER_SKU, price, issuance.compositionDivisor(), Math.Rounding.Ceil);
            uint256 ifee = Math.mulDiv(base, 50, 10_000, Math.Rounding.Ceil);
            uint256 charge = base + ifee;
            // The hook fee rides on top of the charge (read live from the
            // hook — Deploy sets hookFeeBps); the 2-wei slack covers the
            // fee-adjusted spend-cap ceiling.
            uint256 hfee = Math.mulDiv(charge, hook.hookFeeBps(), 10_000, Math.Rounding.Ceil);
            uint256 paid = _buy(
                router,
                GpuRouter.BuyParams({
                    gpuId: gpuId,
                    gpuOut: GENESIS_PER_SKU,
                    payment: d.gusd,
                    maxPaid: charge + hfee + 2,
                    deadline: 0,
                    sqrtLimitX96: 0,
                    recipient: deployer
                })
            );
            require(paid == charge + hfee, "genesis charge chain");
        }

        // ------------------------------ 3.4) quoter GPU float: sell quotes
        // Sell quotes seed the PoolManager with the quoter's GPU float — the
        // same revert-borne doctrine as the gUSD float above (the whole
        // unlock rolls back, so the float only has to back the largest
        // single simulation). Funded out of the deployer's genesis inventory
        // — a genuine primary buy's output — one SKU at a time.
        for (uint256 i; i < CATALOGUE.length; ++i) {
            GPUToken token = GPUToken(issuance.tokenOf(CATALOGUE[i]));
            token.approve(d.gpuQuoter, GPU_FLOAT_PER_SKU);
            gq.setGpuFloat(address(token), GPU_FLOAT_PER_SKU);
        }

        // ------------------- 3.5) bootstrap conversion: ask-side inventory
        // The vault starts bid-only (principal from the genesis backstop).
        // Selling ~1% of each SKU's genesis inventory has the vault BUY GPU
        // at its own bid — genuine market acquisition, the only source of
        // ask-side inventory — so the activity pass's buys fill from POL.
        for (uint256 i; i < CATALOGUE.length; ++i) {
            bytes32 gpuId = CATALOGUE[i];
            GPUToken token = GPUToken(issuance.tokenOf(gpuId));
            uint256 price = _priceOf(gpuId);
            uint256 expected = 100e18 * price / issuance.compositionDivisor(); // 100 GPU in gUSD-wei
            token.approve(d.router, type(uint256).max);
            router.sell(
                GpuRouter.SellParams({
                    gpuId: gpuId,
                    gpuIn: 100e18,
                    payout: d.underlying,
                    // bid = oracle - 0.5%; the seller also bears the 0.1% POL
                    // fee and the 0.5% hook fee — proceeds land ~1.1% under
                    // the oracle, so 2% slack
                    minOut: expected * 98 / 100,
                    deadline: 0,
                    sqrtLimitX96: 0,
                    recipient: deployer
                })
            );
        }

        // ------------------- 4) mock USDT (deterministic) + stable pool
        bytes memory usdtInit = abi.encodePacked(
            type(MockERC20).creationCode, abi.encode("Mock Tether USD", "USDT", uint8(6))
        );
        address usdt = address(new MockERC20{salt: USDT_SALT}("Mock Tether USD", "USDT", 6));
        require(usdt == vm.computeCreate2Address(USDT_SALT, keccak256(usdtInit), CREATE2_PROXY), "usdt salt");
        stableRouter.setStable(usdt, true);

        PoolKey memory skey;
        skey.currency0 = usdt < d.underlying ? Currency.wrap(usdt) : Currency.wrap(d.underlying);
        skey.currency1 = usdt < d.underlying ? Currency.wrap(d.underlying) : Currency.wrap(usdt);
        skey.fee = STABLE_FEE;
        skey.tickSpacing = STABLE_TICK_SPACING;
        skey.hooks = IHooks(address(0));
        PoolManager(d.poolManager).initialize(skey, uint160(1) << 96); // 1:1 (both 6-dec)

        // --------------------------------- 5) stable-pool seed only
        // GPU pools start EMPTY of deployer liquidity — the hook is the book
        // (backstop + vault inventory + any external LPs that arrive), and
        // treasury LP seeds are explicitly out of design. Only the hook-free
        // stable pool is LP'd here: the web's mint desk hardcodes it
        // (apps/web/src/data/web3/gusd/actions.ts STABLE_POOL) and
        // StableRouter rejects hook-bearing pools.
        MockERC20(usdt).mint(deployer, 12_000_000e6);
        IERC20(usdt).approve(d.permit2, type(uint256).max);
        IAllowanceTransfer(d.permit2).approve(usdt, d.positionManager, type(uint160).max, type(uint48).max);
        // the stable pool's other side is the RESERVE (mock USDG), not gUSD —
        // it needs its own Permit2 -> POSM allowance or settle() reverts
        IERC20(d.underlying).approve(d.permit2, type(uint256).max);
        IAllowanceTransfer(d.permit2).approve(d.underlying, d.positionManager, type(uint160).max, type(uint48).max);

        _mintPosition(posm, skey, -887272, 887272, STABLE_POOL_LIQUIDITY, deployer);
        require(posm.balanceOf(deployer) == 1, "stable seed only");

        // --------------------------------------------- 6) fund test actors
        (bool okAlice,) = alice.call{value: 1 ether}("");
        require(okAlice, "alice gas");
        (bool okBob,) = bob.call{value: 1 ether}("");
        require(okBob, "bob gas");
        _fundReserve(d.underlying, alice, 1_000_000e6, deployer);
        _fundReserve(d.underlying, bob, 1_000_000e6, deployer);
        MockERC20(usdt).mint(alice, 100_000e6);
        MockERC20(usdt).mint(bob, 100_000e6);
        vm.stopBroadcast();

        // ============================================ ACTIVITY PASS
        // alice: gUSD position + stable-funded mint (wallet history, cost
        // basis); bob: pool buys + sells on every SKU (tape, volumes, fees)
        // — every buy quote==execution through the GpuQuoter.

        // --------------------------------------------------- alice leg
        vm.startBroadcast(ALICE_PK);
        IERC20(d.underlying).approve(d.gusd, type(uint256).max);
        gusd.mint(10_000e6, alice);
        gusd.approve(d.router, type(uint256).max);
        // 50 H100 from the vault's ask at the oracle ceiling: the bootstrap
        // conversion left exactly 100 GPU of ask inventory, so this is a
        // pure-POL fill at 25_000 x 1.005 = 25_125/GPU — charge 125_625_000
        // + hook fee 628_125. The assert pins quote, hook and hand math to
        // the same number.
        {
            PoolKey memory ahkey = _canonicalKey(d, H100);
            GpuQuoter.QuoteResult memory ra = gq.quoteBuyExactOut(ahkey, 50e18);
            require(ra.gusdIn == 126_253_125, "alice quote at ask ceiling");
            uint256 paidA = _buy(
                router,
                GpuRouter.BuyParams({
                    gpuId: H100,
                    gpuOut: 50e18,
                    payment: d.gusd,
                    maxPaid: ra.gusdIn,
                    deadline: 0,
                    sqrtLimitX96: 0,
                    recipient: alice
                })
            );
            require(paidA == ra.gusdIn, "alice quote==execution");
        }
        // stable funding round-trip: USDT -> gUSD through the seeded pool
        IERC20(usdt).approve(d.stableRouter, type(uint256).max);
        bool usdtIsC0 = usdt < d.underlying;
        (uint256 swapOut,) = quoter.quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({poolKey: skey, zeroForOne: usdtIsC0, exactAmount: 10_000e6, hookData: ""})
        );
        require(swapOut >= 9_900e6, "stable pool depth");
        stableRouter.mint(usdt, 10_000e6, (swapOut * 995) / 1_000, skey, alice);
        gusd.approve(d.stableRouter, type(uint256).max);
        stableRouter.redeem(usdt, 5_000e6, (5_000e6 * 990) / 1_000, skey, alice);
        vm.stopBroadcast();

        // ----------------------------------------------------- bob leg
        vm.startBroadcast(BOB_PK);
        IERC20(d.underlying).approve(d.router, type(uint256).max);
        gusd.approve(d.router, type(uint256).max);
        // pool BUY + SELL on every SKU: quote -> exact execution (the web's
        // own flow), lighting up each market's tape/rows. Fills come from
        // the vault's ask (buys) and bid (sells) — the pools carry no LP.
        for (uint256 i; i < CATALOGUE.length; ++i) {
            bytes32 gpuId = CATALOGUE[i];
            GPUToken token = GPUToken(issuance.tokenOf(gpuId));
            PoolKey memory key = _canonicalKey(d, gpuId);

            GpuQuoter.QuoteResult memory rb = gq.quoteBuyExactOut(key, 2e18);
            uint256 paidB = _buy(
                router,
                GpuRouter.BuyParams({
                    gpuId: gpuId,
                    gpuOut: 2e18,
                    payment: d.underlying,
                    maxPaid: rb.gusdIn,
                    deadline: 0,
                    sqrtLimitX96: 0,
                    recipient: bob
                })
            );
            require(paidB == rb.gusdIn, "bob quote==execution");

            token.approve(d.router, type(uint256).max);
            uint256 price = _priceOf(gpuId);
            router.sell(
                GpuRouter.SellParams({
                    gpuId: gpuId,
                    gpuIn: 1e18,
                    payout: d.underlying,
                    // 100% POL bid fill: proceeds land ~1.1% under the
                    // oracle (bid spread + POL fee + hook fee)
                    minOut: price * 98 / 100,
                    deadline: 0,
                    sqrtLimitX96: 0,
                    recipient: bob
                })
            );
        }
        vm.stopBroadcast();

        // --------------------------- oracle reprice: instant and structural
        // The C-max proof segment. One oracle publish — no keeper, no
        // recenter, no pending phase — and the very next swap prices both
        // edges from the fresh reference. bob's buy fills from the vault's
        // ask at the NEW ask ($3.0150); its proceeds re-enter the bid
        // inventory without re-counting principal (provenance invariant);
        // polState shows the repriced book immediately.
        (uint256 base6,,) = _repriceAndQuote(d, deployer, H100, 30_000);
        require(base6 == 3_000_000, "repriced issuance (1 x 3.00)");
        vm.startBroadcast(BOB_PK);
        IERC20(d.underlying).approve(d.gusd, type(uint256).max);
        gusd.mint(20e6, bob);
        {
            PoolKey memory hkey = _canonicalKey(d, H100);
            uint256 bidBefore = vault.bidInventoryGusd(H100);
            uint256 principalBefore = vault.principalContributed(H100);
            uint256 askBefore = vault.askInventoryGpu(H100);
            GpuQuoter.QuoteResult memory r6 = gq.quoteBuyExactOut(hkey, 2e18);
            // 2 GPU at the new ask 30_000 x 1.005 = 30_150: charge
            // 6_030_000 + hook fee 30_150 — instantly repriced.
            require(r6.gusdIn == 6_060_150, "quote at the new ask");
            uint256 paid6 = _buy(
                router,
                GpuRouter.BuyParams({
                    gpuId: H100,
                    gpuOut: 2e18,
                    payment: d.gusd,
                    maxPaid: r6.gusdIn,
                    deadline: 0,
                    sqrtLimitX96: 0,
                    recipient: bob
                })
            );
            require(paid6 == r6.gusdIn, "quote==execution (repriced)");
            require(vault.bidInventoryGusd(H100) - bidBefore == 6_023_970, "POL proceeds -> bid capacity");
            require(vault.principalContributed(H100) == principalBefore, "principal never re-counted");
            require(askBefore - vault.askInventoryGpu(H100) == 2e18, "ask inventory consumed");
            (, , , bool live6, uint256 askPrice6, uint256 bidPrice6) = hook.polState(H100);
            require(live6, "pol live post-reprice");
            require(askPrice6 == 30_150 && bidPrice6 == 29_850, "edges repriced in-swap");
        }
        vm.stopBroadcast();

        // ----------------------------- distribute protocol revenue
        // Fees route to the revenue ledger in-swap (POL fee, hook fee,
        // issuance fee) — there is no harvest phase to run first.
        vm.startBroadcast(pk);
        ledger.distribute();
        require(gusd.balanceOf(d.ledger) == 0, "ledger drained");

        // ------------------------------------- alice stakes into sgUSD
        // (separate broadcast segments: alice's stake follows distribute so
        // her shares mint at the appreciated rate)
        vm.stopBroadcast();
        vm.startBroadcast(ALICE_PK);
        gusd.approve(d.sgusd, type(uint256).max);
        sg.deposit(1_000e6, alice);
        vm.stopBroadcast();

        // ============================================ RECORD + ASSERTS
        address[] memory stables = new address[](2);
        stables[0] = d.underlying;
        stables[1] = usdt;
        _persistFull(d, stables, anchorBlock);

        require(stateView.getLiquidity(skey.toId()) > 0, "stable pool liquidity");
        require(stableRouter.allStables().length == 2, "stables whitelisted");
        // POL accounting: per-SKU principal capitalized == the genesis
        // backstop buys (the only issuance in this pass). Every activity
        // fill rode the vault's inventory: ask-side proceeds re-enter the
        // bid inventory WITHOUT re-counting principal (asserted at the
        // reprice step), and sell fills consume bid capacity only.
        for (uint256 i; i < CATALOGUE.length; ++i) {
            bytes32 gpuId = CATALOGUE[i];
            address gpuToken = issuance.tokenOf(gpuId);
            require(GPUToken(gpuToken).balanceOf(d.router) == 0, "router empty");
            require(GPUToken(gpuToken).balanceOf(d.hook) == 0, "hook empty at rest");
            require(vault.principalContributed(gpuId) == _priceOf(gpuId) * 1e6, "sku principal");
            require(vault.bidInventoryGusd(gpuId) > 0, "sku bid depth");
            require(vault.askInventoryGpu(gpuId) > 0, "sku ask inventory");
        }
        (uint256 stableQuote,) = quoter.quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({poolKey: skey, zeroForOne: usdtIsC0, exactAmount: 1_000e6, hookData: ""})
        );
        // 1bp fee + sub-0.5% impact on the 10M/side full-range pool: a sane
        // "prices 1:1" bound, not a hard peg guarantee
        require(stableQuote >= 990e6, "stable pool prices 1:1");
        require(gusd.balanceOf(d.router) == 0, "router dust");
        require(gusd.balanceOf(address(hook)) == 0, "hook drained");
        require(sg.convertToAssets(1e6) > 1e6, "sgUSD accrual");

        console2.log("full catalogue live:", vm.toString(CATALOGUE.length), "SKUs");
        console2.log("mock USDT (pin in apps/web/src/data/web3/stables.ts):", usdt);
        console2.log("stable pool", vm.toString(Currency.unwrap(skey.currency0)), "/", vm.toString(Currency.unwrap(skey.currency1)));
        console2.log("gpuQuoter (float-funded):", d.gpuQuoter);
        console2.log("sgUSD assets", gusd.balanceOf(address(sg)));
        console2.log("vault revenue to date", ledger.totalToVault());
    }

    // ------------------------------------------------------------------ helpers

    /// @dev Reprice through whichever oracle deployment is live — identical
    ///      dispatch to Demo's helper. Returns the post-reprice issue quote
    ///      for 1 whole GPU (base only, fee excluded).
    function _repriceAndQuote(Deployment memory d, address deployer, bytes32 gpuId, uint256 price)
        internal
        returns (uint256 base, uint256 fee, uint256 total)
    {
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        _setPrice(deployer, d.oracle, gpuId, price);
        vm.stopBroadcast();
        return GPUIssuance(d.issuance).quoteIssue(gpuId, 1e18);
    }

    /// @dev Oracle seeding dispatch, verbatim from Demo: publish() when the
    ///      deployer is the publisher (the Deploy default), setPriceOverride()
    ///      when a separate PUBLISHER was granted, the legacy mock otherwise.
    function _setPrice(address deployer, address oracleAddr, bytes32 gpuId, uint256 price) internal {
        try GPUPriceOracle(oracleAddr).publisher() returns (address pub) {
            if (pub == deployer) {
                GPUPriceOracle(oracleAddr).publish(gpuId, price, block.timestamp);
            } else {
                GPUPriceOracle(oracleAddr).setPriceOverride(gpuId, price, block.timestamp);
            }
        } catch {
            MockGPUPriceOracle(oracleAddr).setPrice(gpuId, price, block.timestamp);
        }
    }

    function _buy(GpuRouter router, GpuRouter.BuyParams memory p) internal returns (uint256 paid) {
        paid = router.buy(p);
    }

    function _canonicalKey(Deployment memory d, bytes32 gpuId) internal view returns (PoolKey memory key) {
        GPUIssuance issuance = GPUIssuance(d.issuance);
        address gpuToken = issuance.tokenOf(gpuId);
        IGPUIssuance.PoolParams memory pp = issuance.poolParamsOf(gpuId);
        key = GpuPoolKey.canonical(d.gusd, gpuToken, pp, GPUHook(d.hook));
    }

    function _mintPosition(
        PositionManager posm,
        PoolKey memory key,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        address owner
    ) internal {
        Plan memory plan = Planner.init();
        plan.add(
            Actions.MINT_POSITION,
            abi.encode(key, tickLower, tickUpper, liquidity, type(uint128).max, type(uint128).max, owner, "")
        );
        // 1-hour deadline: the simulation bakes block.timestamp at sim time,
        // but a 150-tx broadcast lands minutes later (forge re-sends the
        // recorded calldata verbatim) — a +600s deadline reverted
        // DeadlinePassed mid-broadcast. A production frontend uses
        // minutes-long deadlines for the same reason.
        posm.modifyLiquidities(plan.finalizeModifyLiquidityWithClose(key), block.timestamp + 3600);
    }

    /// @dev The deploy-time seed table — the same constants Deploy used to seed
    ///      the oracle, reused for spend caps and sell floors. Single-sourced
    ///      from Deploy's catalogue: no second price table here.
    function _priceOf(bytes32 gpuId) internal pure returns (uint256) {
        GpuCatalogEntry[] memory e = gpuCatalogue();
        for (uint256 i; i < e.length; ++i) {
            if (e[i].id == gpuId) return e[i].seedPrice;
        }
        revert("unknown gpu");
    }

    /// @dev Mock reserve mints itself; a real UNDERLYING has no mint — fall
    ///      back to the deployer's holdings (script targets the mock posture).
    function _fundReserve(address token, address to, uint256 amount, address from) internal {
        try MockERC20(token).mint(to, amount) {
            return;
        } catch {
            require(IERC20(token).balanceOf(from) >= amount, "deployer reserve too small");
            IERC20(token).transfer(to, amount);
        }
    }

    /// @dev Rewrite the deployment record Deploy wrote, with the extended
    ///      stables list. `anchorBlock` is the pre-broadcast head captured at
    ///      runFull entry — Deploy._persist's own `block.number - 1` sees the
    ///      already-advanced chain head when nested here, which would point
    ///      the indexer's backfill past the genesis events. The serialize key
    ///      must differ from Deploy's "deployment": vm's registry persists
    ///      across the script, and serializing the 2-element stables array
    ///      into a key that already holds Deploy's 1-element array mutates it
    ///      in place without resizing — the USDT entry silently vanished.
    function _persistFull(Deployment memory d, address[] memory stables, uint256 anchorBlock) internal {
        string memory path = string.concat("./deployments/", vm.toString(block.chainid), ".json");

        string memory obj = "deployment.full";
        vm.serializeAddress(obj, "underlying", d.underlying);
        vm.serializeAddress(obj, "stableRouter", d.stableRouter);
        vm.serializeAddress(obj, "stables", stables);
        vm.serializeAddress(obj, "poolManager", d.poolManager);
        vm.serializeAddress(obj, "stateView", d.stateView);
        vm.serializeAddress(obj, "gusd", d.gusd);
        vm.serializeAddress(obj, "sgusd", d.sgusd);
        vm.serializeAddress(obj, "ledger", d.ledger);
        vm.serializeAddress(obj, "marketLiquidity", d.marketLiquidity);
        vm.serializeAddress(obj, "issuance", d.issuance);
        vm.serializeAddress(obj, "oracle", d.oracle);
        try GPUPriceOracle(d.oracle).publisher() returns (address pub) {
            vm.serializeAddress(obj, "oraclePublisher", pub);
        } catch {}
        vm.serializeAddress(obj, "hook", d.hook);
        vm.serializeAddress(obj, "router", d.router);
        vm.serializeAddress(obj, "gpuQuoter", d.gpuQuoter);
        vm.serializeAddress(obj, "permit2", d.permit2);
        vm.serializeAddress(obj, "positionManager", d.positionManager);
        vm.serializeAddress(obj, "quoter", d.quoter);
        vm.serializeAddress(obj, "weth", d.weth);
        string memory out = vm.serializeUint(obj, "chainId", block.chainid);
        out = vm.serializeUint(obj, "startBlock", anchorBlock);
        vm.writeJson(out, path);
        console2.log("deployment record updated:", path);
    }
}

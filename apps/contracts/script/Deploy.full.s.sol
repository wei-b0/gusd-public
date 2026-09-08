// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateView} from "@uniswap/v4-periphery/lens/StateView.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PositionManager} from "@uniswap/v4-periphery/PositionManager.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/interfaces/IV4Quoter.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {Actions} from "@uniswap/v4-periphery/libraries/Actions.sol";
// test-only Planner reuse, same as Demo: production frontends encode the
// PositionManager bundle offchain
import {Planner, Plan} from "v4-periphery-test/shared/Planner.sol";
import {GUSD} from "../src/GUSD.sol";
import {GPUIssuance} from "../src/GPUIssuance.sol";
import {GPUMarketLiquidity} from "../src/GPUMarketLiquidity.sol";
import {GPUToken} from "../src/GPUToken.sol";
import {RevenueLedger} from "../src/RevenueLedger.sol";
import {sgUSD} from "../src/sgUSD.sol";
import {GPUHook} from "../src/hooks/GPUHook.sol";
import {GpuRouter} from "../src/GpuRouter.sol";
import {StableRouter} from "../src/StableRouter.sol";
import {GpuPoolKey} from "../src/libraries/GpuPoolKey.sol";
import {IGPUIssuance} from "../src/interfaces/IGPUIssuance.sol";
import {MockGPUPriceOracle} from "../src/oracle/MockGPUPriceOracle.sol";
import {GPUPriceOracle} from "../src/oracle/GPUPriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Deploy} from "./Deploy.s.sol";

/// @notice Full-catalogue dev/testnet deployment: runs the production Deploy
///         unchanged, then seeds EVERYTHING the web app exercises onchain —
///         all 7 canonical SKUs (oracle price + enabled issuance + canonical
///         pool), a deterministic mock USDT whitelisted on the StableRouter
///         with a funded USDT/reserve pool, full-range LP depth on every
///         pool, and a compact demo-activity pass (buys, sells, stable
///         funding, staking, harvest + distribute) from two test actors so
///         the tape, activity ledgers, and cost basis are populated the
///         moment the stack is up.
///
///         Run: forge script script/Deploy.full.s.sol --rpc-url <url> --broadcast --sig "runFull()"
///         The chain it produces is NON-VIRGIN: Demo.s.sol (virgin-state
///         requires) will not run after it. Minimal flow-testing recipe
///         remains Deploy + Demo; this script is the whole-app recipe for
///         Anvil AND testnets. Actor keys are the public anvil dev keys —
///         test posture only.
contract DeployFull is Deploy {
    using PoolIdLibrary for PoolKey;

    // canonical catalogue (PROTOCOL.md §3); H100 is registered by Deploy.run
    bytes32 constant A100 = bytes32(bytes("A100_SXM_80GB"));
    bytes32 constant H100 = bytes32(bytes("H100_SXM_80GB"));
    bytes32 constant H200 = bytes32(bytes("H200_141GB"));
    bytes32 constant B200 = bytes32(bytes("B200_192GB"));
    bytes32 constant B300 = bytes32(bytes("B300_288GB"));
    bytes32 constant GB200 = bytes32(bytes("GB200_192GB"));
    bytes32 constant GB300 = bytes32(bytes("GB300_288GB"));
    bytes32[] internal CATALOGUE;

    // oracle seed prices, PRICE_SCALE fixed point (×10_000): $/GPU-hour
    uint256 constant A100_PRICE = 18_000; // $1.80
    uint256 constant H200_PRICE = 32_000; // $3.20
    uint256 constant B200_PRICE = 55_000; // $5.50
    uint256 constant B300_PRICE = 70_000; // $7.00
    uint256 constant GB200_PRICE = 85_000; // $8.50
    uint256 constant GB300_PRICE = 100_000; // $10.00

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
    uint128 constant GPU_POOL_LIQUIDITY = 2e15; // ~25x Demo's H100 position
    uint128 constant STABLE_POOL_LIQUIDITY = 1e13; // ~10M units per side at 1:1

    // anvil rich keys (test actors, same as Demo): alice = #2, bob = #3
    uint256 constant ALICE_PK = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant BOB_PK = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;

    constructor() {
        CATALOGUE.push(A100);
        CATALOGUE.push(H100);
        CATALOGUE.push(H200);
        CATALOGUE.push(B200);
        CATALOGUE.push(B300);
        CATALOGUE.push(GB200);
        CATALOGUE.push(GB300);
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
        // broadcasting here) and persists the deployment record. H100 comes
        // back fully registered: oracle seed, enabled issuance, canonical
        // pool initialized (empty) at the live oracle price. The entry is
        // non-virtual, so run it on a local Deploy instance — script
        // contracts are ephemeral and may not use address(this) (which
        // rules out a `this.run()` self-call).
        Deploy inner = new Deploy();
        d = inner.run();
        require(d.underlying != address(0), "core deploy");

        vm.startBroadcast(pk);
        GUSD gusd = GUSD(d.gusd);
        GPUIssuance issuance = GPUIssuance(d.issuance);
        GPUMarketLiquidity pol = GPUMarketLiquidity(d.marketLiquidity);
        GPUHook hook = GPUHook(d.hook);
        RevenueLedger ledger = RevenueLedger(d.ledger);
        sgUSD sg = sgUSD(d.sgusd);
        GpuRouter router = GpuRouter(d.router);
        StableRouter stableRouter = StableRouter(d.stableRouter);
        StateView stateView = StateView(d.stateView);
        IV4Quoter quoter = IV4Quoter(d.quoter);
        // PositionManager has a payable fallback (WETH deposits): cast via
        // an interface-shaped variable, same as Demo
        address posmAddr = d.positionManager;
        PositionManager posm;
        assembly ("memory-safe") {
            posm := posmAddr
        }

        // --------------------------------------- 1) catalogue: 6 new SKUs
        // Order per SKU mirrors Deploy's H100 quartet: createGpu -> oracle
        // price -> setIssuanceEnabled -> canonical pool. The oracle seed
        // MUST precede pool init (oracleSqrtPriceX96 reverts OraclePriceZero
        // on an unpublished GPU).
        _createGpu(d, deployer, A100, "A100 SXM 80GB GPU-hour", "A100", A100_PRICE);
        _createGpu(d, deployer, H200, "H200 141GB GPU-hour", "H200", H200_PRICE);
        _createGpu(d, deployer, B200, "B200 192GB GPU-hour", "B200", B200_PRICE);
        _createGpu(d, deployer, B300, "B300 288GB GPU-hour", "B300", B300_PRICE);
        _createGpu(d, deployer, GB200, "GB200 192GB GPU-hour", "GB200", GB200_PRICE);
        _createGpu(d, deployer, GB300, "GB300 288GB GPU-hour", "GB300", GB300_PRICE);

        // ----------------------------- 2) deployer gUSD working balance
        // Mock reserve funds itself (the Deploy default posture); a real
        // UNDERLYING has no mint — fall back to transferring holdings.
        _fundReserve(d.underlying, deployer, 12_000_000e6, deployer);
        IERC20(d.underlying).approve(d.gusd, type(uint256).max);
        gusd.mint(1_000_000e6, deployer);
        gusd.approve(d.router, type(uint256).max);

        // --------------------- 3) genesis inventory: 100% issuance per SKU
        // Pool is still empty -> pure primary issuance at the oracle price +
        // 0.5% issuance fee. maxPaid = base x 1.005 (+1 wei rounding slack).
        for (uint256 i; i < CATALOGUE.length; ++i) {
            bytes32 gpuId = CATALOGUE[i];
            uint256 price = _priceOf(gpuId);
            // gUSD-wei per whole GPU = price x 100 (1e4 scale -> 1e6 scale);
            // GENESIS_PER_SKU is in GPU-wei, hence the 1e18 divisor
            uint256 maxPaid = (GENESIS_PER_SKU * price * 100 * 1_005) / (1_000 * 1e18) + 1;
            uint256 paid = _buy(
                router,
                GpuRouter.BuyParams({
                    gpuId: gpuId,
                    gpuOut: GENESIS_PER_SKU,
                    poolGpuOut: 0,
                    issueGpuOut: GENESIS_PER_SKU,
                    payment: d.gusd,
                    maxPaid: maxPaid,
                    sqrtLimitX96: 0,
                    recipient: deployer
                })
            );
            require(paid <= maxPaid, "genesis overspend");
        }

        // ------------------- 3.5) bootstrap conversion: ask-side inventory
        // Bid-only bands hold no GPU, so pool BUYs would be unquotable until
        // sellers convert band depth. Selling ~1% of each SKU's genesis
        // inventory converts a slice of the band into GPU (the position pays
        // out its gUSD for the seller's GPU), which seeds the ask side and
        // makes the activity pass's pool legs executable.
        for (uint256 i; i < CATALOGUE.length; ++i) {
            bytes32 gpuId = CATALOGUE[i];
            GPUToken token = GPUToken(issuance.tokenOf(gpuId));
            uint256 price = _priceOf(gpuId);
            uint256 expected = 100e18 * price / 1e16; // 100 GPU in gUSD-wei
            token.approve(d.router, type(uint256).max);
            router.sell(
                GpuRouter.SellParams({
                    gpuId: gpuId,
                    gpuIn: 100e18,
                    payout: d.underlying,
                    // the sell executes against the bid band, which the POL
                    // prices bandSpreadTicks (120 ticks ≈ 1.3%) below the ask
                    // by design; add the in-band discount + 0.5% hook fee —
                    // proceeds land ~1.8% under the oracle, so 3% slack
                    minOut: expected * 97 / 100,
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
        // GPU pools start EMPTY of deployer liquidity — each primary issuance
        // capitalizes its own market via the POL (bid bands), and a bootstrap
        // conversion (below) seeds the ask side. Only the hook-free stable
        // pool is LP'd here: the web's mint desk hardcodes it (apps/web/src/
        // data/web3/gusd/actions.ts STABLE_POOL) and StableRouter rejects
        // hook-bearing pools.
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
        // basis); bob: pool buys + sells on every SKU (tape, volumes, fees).

        // --------------------------------------------------- alice leg
        vm.startBroadcast(ALICE_PK);
        IERC20(d.underlying).approve(d.gusd, type(uint256).max);
        gusd.mint(10_000e6, alice);
        gusd.approve(d.router, type(uint256).max);
        // 100 H100 from a fully-liquid market: pure issuance leg at the
        // oracle ceiling — her avg entry lands at 2.5125 gUSD
        _buy(
            router,
            GpuRouter.BuyParams({
                gpuId: H100,
                gpuOut: 100e18,
                poolGpuOut: 0,
                issueGpuOut: 100e18,
                payment: d.gusd,
                maxPaid: 300e6,
                sqrtLimitX96: 0,
                recipient: alice
            })
        );
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
        // pool BUY + SELL on every SKU: the H100 pass mirrors Demo (quote ->
        // exact execution), the rest light up each market's tape/rows.
        for (uint256 i; i < CATALOGUE.length; ++i) {
            bytes32 gpuId = CATALOGUE[i];
            GPUToken token = GPUToken(issuance.tokenOf(gpuId));
            bool gIsC0 = d.gusd < address(token);
            PoolKey memory key = _canonicalKey(d, gpuId);

            (uint256 quotedIn,) = quoter.quoteExactOutputSingle(
                IV4Quoter.QuoteExactSingleParams({poolKey: key, zeroForOne: gIsC0, exactAmount: 2e18, hookData: ""})
            );
            _buy(
                router,
                GpuRouter.BuyParams({
                    gpuId: gpuId,
                    gpuOut: 2e18,
                    poolGpuOut: 2e18,
                    issueGpuOut: 0,
                    payment: d.underlying,
                    maxPaid: quotedIn,
                    sqrtLimitX96: 0,
                    recipient: bob
                })
            );

            token.approve(d.router, type(uint256).max);
            uint256 price = _priceOf(gpuId);
            router.sell(
                GpuRouter.SellParams({
                    gpuId: gpuId,
                    gpuIn: 1e18,
                    payout: d.underlying,
                    minOut: (price * 90), // 0.9 x oracle in underlying-wei
                    sqrtLimitX96: 0,
                    recipient: bob
                })
            );
        }
        vm.stopBroadcast();

        // ------------------------------------- H100 reprice + repriced BUY
        // Only the NEXT issuance reprices; the pool keeps its tick. bob's
        // issuance buy at $3.00 vs his $2.50 pool entries gives the UI real
        // realized-PnL data.
        (uint256 base6,,) = _repriceAndQuote(d, deployer, H100, 30_000);
        vm.startBroadcast(BOB_PK);
        IERC20(d.underlying).approve(d.gusd, type(uint256).max);
        gusd.mint(10e6, bob);
        gusd.approve(d.router, type(uint256).max);
        _buy(
            router,
            GpuRouter.BuyParams({
                gpuId: H100,
                gpuOut: 1e18,
                poolGpuOut: 0,
                issueGpuOut: 1e18,
                payment: d.gusd,
                maxPaid: 5e6,
                sqrtLimitX96: 0,
                recipient: bob
            })
        );
        vm.stopBroadcast();
        require(base6 == 3_000_000, "repriced issuance (1 x 3.00)");
        // The defer, asserted where it happens: the pool still trades at the
        // pre-reprice price, past the new band's corridor, so bob's principal
        // correctly waits instead of being placed at a stale anchor.
        require(pol.pendingPrincipal(H100) == 3_000_000, "H100 deferred pending (repriced buy)");

        // --------------------------------- convergence: recenter + arb buy
        // An oracle move leaves the pool behind — and the design does NOT
        // force it back (no oracle-bounded swaps: blocked swaps are dead
        // capital). Two permissionless forces close the gap instead, and in
        // production arbitrageurs/keepers call them within moments. The demo
        // scripts both so the desk shows market ≈ index after this pass:
        vm.startBroadcast(pk);
        // 1) recenter: stale 2.50-anchored bands are removed and the same
        //    real inventory redeployed around $3.00 where geometry allows —
        //    recovered GPU to an ask band at reference + fee. The recovered
        //    gUSD honestly DEFERS: the pool still trades at ~$2.50, cheaper
        //    than the entire new bid zone, and nothing may place at a stale
        //    anchor (same corridor rule that deferred bob's buy). Removal is
        //    not a swap; nobody trades at stale prices.
        uint256 removed = pol.recenter(H100, 10);
        require(removed >= 1, "stale bands recentred");
        // principal is a cumulative statistic: recentering re-prices
        // inventory, it never re-counts it.
        require(pol.principalContributed(H100) == 25_253_000_000, "recenter re-counted principal");
        vm.stopBroadcast();

        vm.startBroadcast(BOB_PK);
        PoolKey memory hkey = _canonicalKey(d, H100);
        bool hGIsC0 = d.gusd < address(GPUToken(issuance.tokenOf(H100)));
        (uint256 convIn,) = quoter.quoteExactOutputSingle(
            IV4Quoter.QuoteExactSingleParams({poolKey: hkey, zeroForOne: hGIsC0, exactAmount: 1e18, hookData: ""})
        );
        // 2) the arb buy — the convergence force the design waits for: the
        //    pool leg jumps spot through the (empty) pre-reprice range into
        //    the fresh ask band and fills at reference × (1 + fee) ± in-band
        //    movement, plus the 0.8% LP+protocol fee stack the quoter
        //    includes — the 17% discount is gone. Corridor bound ~±3%.
        require(convIn >= 2_940_000 && convIn <= 3_100_000, "post-recenter ask within corridor of reference");
        _buy(
            router,
            GpuRouter.BuyParams({
                gpuId: H100,
                gpuOut: 1e18,
                poolGpuOut: 1e18,
                issueGpuOut: 0,
                payment: d.underlying,
                maxPaid: convIn,
                sqrtLimitX96: 0,
                recipient: bob
            })
        );
        vm.stopBroadcast();

        // 3) the pool now trades inside the corridor, so the deferred
        //    principal (bob's repriced 3 + the recentred gUSD) places as the
        //    bid band at the new anchor — the router already attempted it
        //    best-effort inside the buy; a no-op here if so. This call MUST
        //    sit inside a broadcast: off-broadcast calls mutate only the
        //    script's local EVM, so the require would pass while the chain
        //    keeps the principal pending.
        vm.startBroadcast(pk);
        pol.deployPending(H100);
        require(pol.pendingPrincipal(H100) == 0, "pending placed post-convergence");
        vm.stopBroadcast();

        // -------------------------------- harvest revenue -> sgUSD vault
        vm.startBroadcast(pk);
        for (uint256 i; i < CATALOGUE.length; ++i) {
            hook.harvestTradingFees(_canonicalKey(d, CATALOGUE[i]).toId(), 0);
            require(hook.pendingTradingFees(_canonicalKey(d, CATALOGUE[i]).toId()) == 0, "harvest");
        }
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

        for (uint256 i; i < CATALOGUE.length; ++i) {
            PoolId pid = _canonicalKey(d, CATALOGUE[i]).toId();
            require(stateView.getLiquidity(pid) > 0, "pool liquidity");
            require(GPUToken(issuance.tokenOf(CATALOGUE[i])).balanceOf(d.router) == 0, "router empty");
        }
        require(stableRouter.allStables().length == 2, "stables whitelisted");
        // POL accounting: per-SKU principal capitalized == genesis (10k GPU) +
        // alice (100) + bob's repriced 1; every unit deployed — bob's repriced
        // buy deferred past the corridor (asserted where it happened), then
        // the convergence pass recentred and placed it. H100's price check is
        // excluded because its oracle seed moved mid-flow (25k at 2.50, 3 at
        // 3.00) — pinned explicitly below.
        for (uint256 i; i < CATALOGUE.length; ++i) {
            if (CATALOGUE[i] != H100) {
                require(pol.principalContributed(CATALOGUE[i]) == _priceOf(CATALOGUE[i]) * 1e6, "sku principal");
            }
            require(pol.pendingPrincipal(CATALOGUE[i]) == 0, "sku pending deployed");
            require(pol.bidDepth(CATALOGUE[i]) > 0, "sku bid depth");
        }
        require(pol.principalContributed(H100) == 25_253_000_000, "H100 principal (25k + 250 + 3)");
        // the convergence proof, as state: the pool now trades within the
        // band corridor (~±720 ticks) of the oracle reference — market,
        // oracle, and index agree within the spread the design promises.
        // referenceSqrtPriceX96 is sqrt(h) in gUSD-per-GPU terms, while the
        // pool's slot0 tick is in pool-price terms (1/h when gUSD is
        // currency0) — mirror the orientation before comparing.
        {
            PoolKey memory hkey = _canonicalKey(d, H100);
            (, int24 spotTick,,) = stateView.getSlot0(hkey.toId());
            int24 hTick = TickMath.getTickAtSqrtPrice(uint160(issuance.referenceSqrtPriceX96(H100)));
            bool hGIsC0 = d.gusd < address(GPUToken(issuance.tokenOf(H100)));
            int24 refTick = hGIsC0 ? -hTick : hTick;
            uint256 drift = spotTick > refTick ? uint256(int256(spotTick - refTick)) : uint256(int256(refTick - spotTick));
            require(drift <= 720, "spot within band corridor of reference");
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
        console2.log("sgUSD assets", gusd.balanceOf(address(sg)));
        console2.log("vault revenue to date", ledger.totalToVault());
    }

    // ------------------------------------------------------------------ helpers

    /// @dev createGpu + oracle seed + enable issuance, in the order Deploy
    ///      uses for H100. Pool initialization is the caller's step.
    function _createGpu(
        Deployment memory d,
        address deployer,
        bytes32 gpuId,
        string memory name,
        string memory symbol,
        uint256 price
    ) internal {
        GPUIssuance issuance = GPUIssuance(d.issuance);
        issuance.createGpu(gpuId, name, symbol, 50, 3000, 60, 600, 120);
        _setPrice(deployer, d.oracle, gpuId, price);
        issuance.setIssuanceEnabled(gpuId, true);
        // Deploy's internal helper: initializes the canonical pool from the
        // (now-seeded) oracle price and asserts hook registration
        _initializeCanonicalPool(d, gpuId);
    }

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

    /// @dev The script's own seed table — the same constants used to seed the
    ///      oracle, reused for spend caps and sell floors. H100 was seeded by
    ///      Deploy.run().
    function _priceOf(bytes32 gpuId) internal pure returns (uint256) {
        if (gpuId == A100) return A100_PRICE;
        if (gpuId == H100) return 25_000; // $2.50 — Deploy's genesis seed
        if (gpuId == H200) return H200_PRICE;
        if (gpuId == B200) return B200_PRICE;
        if (gpuId == B300) return B300_PRICE;
        if (gpuId == GB200) return GB200_PRICE;
        if (gpuId == GB300) return GB300_PRICE;
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

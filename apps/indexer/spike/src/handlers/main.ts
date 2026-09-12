import { GUSD, PoolManager } from "generated";

const POOL_IDS = [
  "0x1111111111111111111111111111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222222222222222222222222222",
];

PoolManager.Initialize.handler(async ({ event, context }) => {
  context.PmPoolInitialized.set({
    id: `${event.block.number}_${event.logIndex}`,
    blockNumber: event.block.number,
    logIndex: event.logIndex,
    blockTimestamp: BigInt(event.block.timestamp),
    poolId: event.params.id,
    currency0: event.params.currency0,
    currency1: event.params.currency1,
    fee: event.params.fee,
    tickSpacing: event.params.tickSpacing,
    hooks: event.params.hooks,
    sqrtPriceX96: event.params.sqrtPriceX96,
    tick: event.params.tick,
  });
});

PoolManager.Swap.handlerWithLoader({
  loader: async ({}) => ({
    poolIds: POOL_IDS,
  }),
  handler: async ({ event, context }) => {
    context.PmSwap.set({
      id: `${event.block.number}_${event.logIndex}`,
      blockNumber: event.block.number,
      logIndex: event.logIndex,
      blockTimestamp: BigInt(event.block.timestamp),
      txHash: event.transaction.hash,
      poolId: event.params.id,
      sender: event.params.sender,
      amount0: event.params.amount0,
      amount1: event.params.amount1,
      sqrtPriceX96: event.params.sqrtPriceX96,
      liquidity: event.params.liquidity,
      tick: event.params.tick,
      fee: event.params.fee,
    });
  },
});

GUSD.Minted.handler(async ({ event, context }) => {
  context.GusdMinted.set({
    id: `${event.block.number}_${event.logIndex}`,
    blockNumber: event.block.number,
    logIndex: event.logIndex,
    blockTimestamp: BigInt(event.block.timestamp),
    user: event.params.to,
    underlyingIn: event.params.underlyingIn,
    gusdOut: event.params.gusdOut,
    fee: event.params.fee,
  });
});

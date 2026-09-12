import { indexer } from "envio";
import { CANONICAL_POOL_IDS, CHAIN_ID, PROTOCOL_ADDRESSES } from "./runtime-config.js";
import type { Table } from "./schema.js";

type EntityOperations = {
  get(id: string): Promise<Record<string, any> | undefined>;
  set(value: Record<string, any>): void;
};

const preloadOverlay = new Map<string, Record<string, any>>();
let preloadActive = false;

const NUMBER_FIELDS = new Set([
  "blockNumber",
  "logIndex",
  "feeBps",
  "poolFee",
  "tickSpacing",
  "source",
  "swapFee",
  "tick",
  "tickLower",
  "tickUpper",
  "registeredBlockNumber",
  "lastSwapBlockNumber",
  "issuanceFeeBps",
  "lastPublishedBlockNumber",
  "firstSeenBlockNumber",
  "lastSeenBlockNumber",
  "mintFeeBps",
  "redeemFeeBps",
  "hookFeeBps",
  "maxDeviationBps",
  "sgusdSplitBps",
]);

function operations(context: Record<string, any>, table: Table): EntityOperations {
  const value = context[table.entity] as EntityOperations | undefined;
  if (!value) throw new Error(`Missing Envio entity operations for ${table.entity}`);
  return value;
}

function toEntity(table: Table, value: Record<string, any>): Record<string, any> {
  const entity: Record<string, any> = { ...value, id: table.id(value) };
  delete entity.chainId;
  for (const field of [...NUMBER_FIELDS, ...table.intNumbers]) {
    if (typeof entity[field] === "bigint") entity[field] = Number(entity[field]);
  }
  for (const field of table.bigintNumbers) {
    if (typeof entity[field] === "number") entity[field] = BigInt(entity[field]);
  }
  return entity;
}

function fromEntity(table: Table, value: Record<string, any> | undefined) {
  if (!value) return null;
  const row: Record<string, any> = { ...value, chainId: CHAIN_ID };
  for (const field of table.bigintNumbers) {
    if (typeof row[field] === "bigint") row[field] = Number(row[field]);
  }
  return row;
}

function createDb(context: Record<string, any>) {
  const isPreload = context.isPreload === true;
  if (isPreload && !preloadActive) {
    preloadOverlay.clear();
    preloadActive = true;
  } else if (!isPreload && preloadActive) {
    preloadOverlay.clear();
    preloadActive = false;
  }
  const read = async (table: Table, id: string) => {
    const key = `${context.chain.id}:${table.entity}:${id}`;
    return (isPreload ? preloadOverlay.get(key) : undefined) ?? operations(context, table).get(id);
  };
  const write = (table: Table, value: Record<string, any>) => {
    const entity = toEntity(table, value);
    if (isPreload) {
      preloadOverlay.set(`${context.chain.id}:${table.entity}:${entity.id}`, entity);
    } else {
      operations(context, table).set(entity);
    }
  };
  return {
    async find(table: Table, key: Record<string, any>) {
      return fromEntity(table, await read(table, table.id(key)));
    },
    insert(table: Table) {
      return {
        values(value: Record<string, any>) {
          const runInsert = async () => {
            write(table, value);
          };
          return {
            then(resolve: (value?: unknown) => unknown, reject: (reason?: unknown) => unknown) {
              return runInsert().then(resolve, reject);
            },
            async onConflictDoUpdate(
              update:
                | Record<string, any>
                | ((row: Record<string, any>) => Record<string, any>),
            ) {
              const existingEntity = await read(table, table.id(value));
              if (!existingEntity) {
                write(table, value);
                return;
              }
              const existing = fromEntity(table, existingEntity) as Record<string, any>;
              const patch = typeof update === "function" ? update(existing) : update;
              write(table, { ...existing, ...patch });
            },
          };
        },
      };
    },
    update(table: Table, key: Record<string, any>) {
      return {
        async set(patch: Record<string, any>) {
          const existingEntity = await read(table, table.id(key));
          if (!existingEntity) throw new Error(`Cannot update missing ${table.entity} ${table.id(key)}`);
          const existing = fromEntity(table, existingEntity) as Record<string, any>;
          write(table, { ...existing, ...patch });
        },
      };
    },
  };
}

const contractAddresses = Object.fromEntries(
  Object.entries(PROTOCOL_ADDRESSES).map(([name, address]) => [name, { address }]),
);

function register(name: string, handler: (args: any) => Promise<void>) {
  const [contract, event] = name.split(":") as [any, any];
  // Pool-id pushdown on the v4 singletons — ponder filtered these on every
  // chain, so every chain with a resolved canonical set gets the same
  // treatment (an offline-codegen artifact carries an empty set: filtering
  // on nothing would silently drop every event, so those stay unfiltered
  // and the untracked-pool invariant below stays the loud backstop).
  const filtered =
    (contract === "PoolManager" || contract === "PositionManager") &&
    CANONICAL_POOL_IDS.length > 0;
  (indexer as any).onEvent(
    {
      contract,
      event,
      ...(filtered ? { where: () => ({ params: [{ id: CANONICAL_POOL_IDS }] }) } : {}),
    } as any,
    async ({ event: envioEvent, context }: any) => {
      const event = {
        args: envioEvent.params,
        block: envioEvent.block,
        transaction: envioEvent.transaction,
        log: { logIndex: envioEvent.logIndex, address: envioEvent.srcAddress },
      };
      await handler({
        event,
        context: {
          chain: context.chain,
          isPreload: context.isPreload,
          db: createDb(context),
          contracts: contractAddresses,
        },
      });
    },
  );
}

export const handlers = { on: register };

(indexer as any).contractRegister(
  { contract: "GPUIssuance", event: "GpuCreated" },
  ({ event, context }: any) => context.chain.GPUToken.add(event.params.token),
);

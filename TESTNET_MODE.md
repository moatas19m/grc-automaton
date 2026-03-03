# Testnet Mode — Master Implementation Prompt

## Goal

Add a **testnet mode** to Conway Automaton where:
1. The **brain** is the user's own Claude API key (or any Anthropic model) instead of Conway Compute / OpenAI
2. The **chain** is BSC Testnet (chain ID 97) with test USDC/BEP-20 tokens instead of Base mainnet USDC
3. The **compute** runs fully local (no Conway Cloud sandbox, no Conway credits) — the user's machine IS the sandbox
4. The **survival pressure** still exists, but is denominated in testnet tokens with no real money at stake

This creates a safe, free playground where anyone with a Claude API key can run a fully autonomous automaton against fake money on a public testnet.

---

## Architecture Overview

```
PRODUCTION MODE (current)                TESTNET MODE (new)
========================                 ===================
Brain:   Conway Compute / OpenAI         User's Claude API key (Anthropic)
Chain:   Base (8453) + real USDC         BSC Testnet (97) + test tokens
Compute: Conway Cloud sandbox            Local machine (no sandbox)
Credits: Conway credits via x402         Simulated credits from testnet token balance
Auth:    SIWE → Conway API key           Skip (no Conway API needed)
```

---

## What Changes (and What Doesn't)

### Unchanged
- Agent loop (`src/agent/loop.ts`) — ReAct cycle stays identical
- Policy engine (`src/agent/policy-engine.ts`) — All safety rules still apply
- Memory system (`src/memory/`) — All 5 tiers work the same
- Heartbeat daemon (`src/heartbeat/`) — Same scheduler, same tasks
- Soul system (`src/soul/`) — Identity evolution unchanged
- Database/state (`src/state/`) — Same SQLite schema
- Self-modification (`src/self-mod/`) — Same audit trails
- Injection defense (`src/agent/injection-defense.ts`) — Same 8-layer sanitization
- Skills system (`src/skills/`) — Same loader
- Observability (`src/observability/`) — Same logging/metrics
- Git state versioning (`src/git/`) — Same

### Changed

| Area | File(s) | What Changes |
|------|---------|--------------|
| **Config** | `src/types.ts`, `src/config.ts` | New `mode: "production" \| "testnet"` field + `testnetConfig` sub-object |
| **Entry point** | `src/index.ts` | Skip Conway auth, skip bootstrap topup, derive credits from testnet token balance |
| **Inference** | `src/inference/types.ts`, `src/conway/inference.ts` | Claude models as default in testnet routing matrix |
| **Chain constants** | `src/conway/x402.ts` | Add BSC Testnet chain + test token address |
| **Credits** | `src/conway/credits.ts` | In testnet: credits = testnet token balance (no Conway API call) |
| **Topup** | `src/conway/topup.ts` | In testnet: topup is a no-op or faucet call (test tokens are free) |
| **Conway client** | `src/conway/client.ts` | In testnet: force local mode, skip all cloud API calls |
| **Provision** | `src/identity/provision.ts` | In testnet: skip SIWE, generate a dummy API key |
| **Wallet** | `src/identity/wallet.ts` | Same wallet generation, but default network display = BSC Testnet |
| **Registry** | `src/registry/erc8004.ts` | In testnet: use BSC Testnet contracts (or skip registration entirely) |
| **Social** | `src/social/client.ts` | In testnet: disable or use local-only messaging |
| **Replication** | `src/replication/spawn.ts` | In testnet: disable child spawning (no cloud VMs) |
| **Setup wizard** | `src/setup/wizard.ts` | New testnet setup flow: ask for Claude API key, skip Conway |
| **CLI** | `src/index.ts` | New `--testnet` flag |

---

## Detailed Changes Per File

### 1. `src/types.ts` — Config Types

Add to `AutomatonConfig`:
```typescript
mode: "production" | "testnet";
testnetConfig?: {
  chain: "bsc-testnet";           // Only BSC testnet for now
  tokenAddress: Address;          // Test USDC/BEP-20 contract on BSC testnet
  rpcUrl?: string;                // Optional custom RPC (default: public BSC testnet RPC)
  faucetUrl?: string;             // Optional faucet URL for test tokens
  skipConwayRegistration: boolean;
  skipSocialRelay: boolean;
  skipChildSpawning: boolean;
};
```

Update `DEFAULT_CONFIG` to include `mode: "production"` (backward compatible).

### 2. `src/config.ts` — Config Loading

- Merge `testnetConfig` with defaults when `mode === "testnet"`
- Default testnet config:
  ```typescript
  const DEFAULT_TESTNET_CONFIG = {
    chain: "bsc-testnet",
    tokenAddress: "0x..." as Address,  // USDC on BSC testnet (see below)
    skipConwayRegistration: true,
    skipSocialRelay: true,
    skipChildSpawning: true,
  };
  ```

### 3. `src/index.ts` — Entry Point

Add `--testnet` CLI flag that:
- Sets `mode: "testnet"` in config
- Skips the Conway API key requirement (lines 186-189)
- Skips Conway automaton registration (lines 232-259)
- Skips bootstrap topup via x402 (lines 320-349)
- Instead: reads testnet token balance as initial credit balance
- Requires `ANTHROPIC_API_KEY` env var or `config.anthropicApiKey`
- Creates Conway client in forced-local mode (empty `sandboxId`)
- Disables social relay
- Logs: `"[TESTNET] Running in testnet mode — BSC Testnet, no real funds"`

The main run loop stays identical — the agent still sleeps, wakes, reasons, acts.

### 4. `src/conway/x402.ts` — Chain Constants

Add BSC Testnet:
```typescript
import { base, baseSepolia, bscTestnet } from "viem/chains";

const USDC_ADDRESSES: Record<string, Address> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",   // Base mainnet
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",   // Base Sepolia
  "eip155:97": "0x...",                                            // BSC Testnet test USDC
};

const CHAINS: Record<string, any> = {
  "eip155:8453": base,
  "eip155:84532": baseSepolia,
  "eip155:97": bscTestnet,
};
```

Update `normalizeNetwork()` to handle `"bsc-testnet"` → `"eip155:97"`.

Update `getUsdcBalance()` — no changes needed, it already takes a `network` param. Just need to pass `"eip155:97"` from testnet mode.

### 5. `src/conway/credits.ts` — Survival Tier from Testnet Balance

Add a testnet-aware financial state function:
```typescript
export async function checkFinancialStateTestnet(
  walletAddress: Address,
  network: string,
): Promise<FinancialState> {
  const usdcBalance = await getUsdcBalance(walletAddress, network);
  // In testnet mode, credits = token balance in cents
  const creditsCents = Math.floor(usdcBalance * 100);
  return {
    creditsCents,
    usdcBalance,
    lastChecked: new Date().toISOString(),
  };
}
```

The survival tier calculation (`getSurvivalTier`) stays the same — it just receives credits derived from the testnet token balance instead of Conway API credits.

### 6. `src/conway/topup.ts` — Testnet Topup

In testnet mode, `topupCredits()` becomes a no-op that returns success:
```typescript
export async function topupCreditsTestnet(): Promise<TopupResult> {
  // In testnet mode, credits come from the faucet, not x402
  return {
    success: true,
    amountUsd: 0,
    creditsCentsAdded: 0,
    error: "Testnet mode: use BSC testnet faucet to get test tokens",
  };
}
```

`bootstrapTopup()` in testnet mode: skip entirely (no x402 payment needed).

### 7. `src/conway/client.ts` — Force Local Mode

When `mode === "testnet"`:
- Force `isLocal = true` regardless of `sandboxId`
- `getCreditsBalance()` → read testnet token balance instead of calling Conway API
- `createSandbox()` → return error "Sandbox creation disabled in testnet mode"
- `transferCredits()` → execute a real BEP-20 transfer on BSC testnet (test tokens)
- `registerAutomaton()` → no-op, return immediately
- All exec/file operations → local `child_process` / `fs` (already supported)

### 8. `src/identity/provision.ts` — Skip SIWE

When `mode === "testnet"`:
- Skip the entire SIWE flow
- Return a dummy provision result:
  ```typescript
  return {
    apiKey: "testnet-local-no-api-key",
    walletAddress: account.address,
    keyPrefix: "testnet",
  };
  ```

### 9. `src/inference/types.ts` — Claude Model Baseline

Add Claude models to `STATIC_MODEL_BASELINE`:
```typescript
{
  modelId: "claude-sonnet-4-6",
  provider: "anthropic",
  displayName: "Claude Sonnet 4.6",
  tierMinimum: "normal",
  costPer1kInput: 30,    // $3.00/M
  costPer1kOutput: 150,  // $15.00/M
  maxTokens: 8192,
  contextWindow: 200000,
  supportsTools: true,
  supportsVision: true,
  parameterStyle: "max_tokens",
  enabled: true,
},
{
  modelId: "claude-haiku-4-5-20251001",
  provider: "anthropic",
  displayName: "Claude Haiku 4.5",
  tierMinimum: "low_compute",
  costPer1kInput: 8,     // $0.80/M
  costPer1kOutput: 40,   // $4.00/M
  maxTokens: 8192,
  contextWindow: 200000,
  supportsTools: true,
  supportsVision: true,
  parameterStyle: "max_tokens",
  enabled: true,
},
```

Add a testnet routing matrix that uses Claude models:
```typescript
export const TESTNET_ROUTING_MATRIX: RoutingMatrix = {
  high: {
    agent_turn: { candidates: ["claude-sonnet-4-6"], maxTokens: 8192, ceilingCents: -1 },
    heartbeat_triage: { candidates: ["claude-haiku-4-5-20251001"], maxTokens: 2048, ceilingCents: 5 },
    safety_check: { candidates: ["claude-sonnet-4-6"], maxTokens: 4096, ceilingCents: 20 },
    summarization: { candidates: ["claude-haiku-4-5-20251001"], maxTokens: 4096, ceilingCents: 15 },
    planning: { candidates: ["claude-sonnet-4-6"], maxTokens: 8192, ceilingCents: -1 },
  },
  normal: {
    agent_turn: { candidates: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"], maxTokens: 4096, ceilingCents: -1 },
    heartbeat_triage: { candidates: ["claude-haiku-4-5-20251001"], maxTokens: 2048, ceilingCents: 5 },
    safety_check: { candidates: ["claude-sonnet-4-6"], maxTokens: 4096, ceilingCents: 10 },
    summarization: { candidates: ["claude-haiku-4-5-20251001"], maxTokens: 4096, ceilingCents: 10 },
    planning: { candidates: ["claude-sonnet-4-6"], maxTokens: 4096, ceilingCents: -1 },
  },
  low_compute: {
    agent_turn: { candidates: ["claude-haiku-4-5-20251001"], maxTokens: 4096, ceilingCents: 10 },
    heartbeat_triage: { candidates: ["claude-haiku-4-5-20251001"], maxTokens: 1024, ceilingCents: 2 },
    safety_check: { candidates: ["claude-haiku-4-5-20251001"], maxTokens: 2048, ceilingCents: 5 },
    summarization: { candidates: ["claude-haiku-4-5-20251001"], maxTokens: 2048, ceilingCents: 5 },
    planning: { candidates: ["claude-haiku-4-5-20251001"], maxTokens: 2048, ceilingCents: 5 },
  },
  critical: {
    agent_turn: { candidates: ["claude-haiku-4-5-20251001"], maxTokens: 2048, ceilingCents: 3 },
    heartbeat_triage: { candidates: ["claude-haiku-4-5-20251001"], maxTokens: 512, ceilingCents: 1 },
    safety_check: { candidates: ["claude-haiku-4-5-20251001"], maxTokens: 1024, ceilingCents: 2 },
    summarization: { candidates: [], maxTokens: 0, ceilingCents: 0 },
    planning: { candidates: [], maxTokens: 0, ceilingCents: 0 },
  },
  dead: {
    agent_turn: { candidates: [], maxTokens: 0, ceilingCents: 0 },
    heartbeat_triage: { candidates: [], maxTokens: 0, ceilingCents: 0 },
    safety_check: { candidates: [], maxTokens: 0, ceilingCents: 0 },
    summarization: { candidates: [], maxTokens: 0, ceilingCents: 0 },
    planning: { candidates: [], maxTokens: 0, ceilingCents: 0 },
  },
};
```

### 10. `src/conway/inference.ts` — Anthropic as Default

In `resolveInferenceBackend()`, no changes needed — it already routes `claude-*` to Anthropic.

In `createInferenceClient()`, ensure `anthropicApiKey` is passed and the Anthropic backend works with the routing matrix above.

### 11. `src/inference/router.ts` — Use Testnet Matrix

When `mode === "testnet"`, use `TESTNET_ROUTING_MATRIX` instead of `DEFAULT_ROUTING_MATRIX`.

The router already supports this — just pass the right matrix at initialization.

### 12. `src/registry/erc8004.ts` — BSC Testnet Support

Add BSC testnet chain config:
```typescript
import { bscTestnet } from "viem/chains";

const CONTRACTS = {
  mainnet: { ... },   // existing
  testnet: { ... },   // existing (Base Sepolia)
  bscTestnet: {
    identity: "0x0000000000000000000000000000000000000000" as Address,  // not deployed
    reputation: "0x0000000000000000000000000000000000000000" as Address,
    chain: bscTestnet,
  },
} as const;
```

In testnet mode: skip ERC-8004 registration entirely (contracts not deployed on BSC testnet).

### 13. `src/agent/tools.ts` — Testnet-Aware Tools

Tools that need testnet awareness:
- **`check_credits`** — Read testnet token balance, not Conway credits
- **`topup_credits`** — Return "use BSC testnet faucet" message
- **`check_usdc_balance`** — Query BSC testnet token balance
- **`create_sandbox`** — Return error in testnet mode
- **`spawn_child`** — Return error in testnet mode
- **`transfer_credits`** — Execute BEP-20 transfer on BSC testnet
- **`x402_fetch`** — Disabled in testnet mode (no x402 endpoints on testnet)

Pass `config.mode` through the `ToolContext` so tools can branch.

### 14. `src/setup/wizard.ts` — Testnet Setup Flow

When `--testnet` flag is detected, run a simplified wizard:
1. Ask for agent name
2. Ask for genesis prompt
3. Ask for Anthropic API key (or check `ANTHROPIC_API_KEY` env var)
4. Generate wallet (same flow)
5. Skip Conway provisioning
6. Write config with `mode: "testnet"`
7. Print: "Your agent's BSC Testnet address: 0x... — send test tokens from a faucet to fund it"

### 15. `src/heartbeat/tasks.ts` — Testnet Task Adjustments

- **`check_credits`** — Read testnet token balance instead of Conway API
- **`check_usdc_balance`** — Check BSC testnet instead of Base
- **`heartbeat_ping`** — Skip Conway ping in testnet mode
- **`check_for_updates`** — Keep as-is (still useful)
- **`check_social_inbox`** — Skip if social relay disabled

---

## BSC Testnet Token Strategy

### Option A: Use existing test USDC on BSC Testnet
BSC Testnet has several test stablecoins. The most reliable approach:
- Use the **BSC Testnet USDC** at a known faucet-mintable address
- Or deploy a simple ERC-20 "TestUSDC" contract that anyone can mint

### Option B: Deploy custom TestUSDC
Deploy a minimal ERC-20 with a public `mint()` function:
```solidity
function mint(address to, uint256 amount) external {
    _mint(to, amount);
}
```
This guarantees availability and lets the automaton self-fund via the `mint()` call.

**Recommendation**: Start with Option A if a reliable BSC testnet USDC exists. Fall back to Option B if needed. The `testnetConfig.tokenAddress` field makes this swappable.

---

## User Experience

### Starting in Testnet Mode
```bash
# First run — triggers testnet setup wizard
automaton --run --testnet

# Or explicitly set up first
automaton --setup --testnet

# Status shows testnet indicator
automaton --status
# === AUTOMATON STATUS ===
# Mode:      TESTNET (BSC Testnet)
# Name:      my-agent
# Address:   0xabc...
# Token Bal: 100.00 tUSDC
# Tier:      high
# Brain:     Claude Sonnet 4.6 (Anthropic)
# ...
```

### Environment Variables
```bash
ANTHROPIC_API_KEY=sk-ant-...     # Required for testnet mode
AUTOMATON_MODE=testnet           # Alternative to --testnet flag
BSC_TESTNET_RPC=https://...      # Optional custom RPC
```

### Config File (`~/.automaton/automaton.json`)
```json
{
  "name": "my-testnet-agent",
  "mode": "testnet",
  "genesisPrompt": "You are a test automaton...",
  "anthropicApiKey": "sk-ant-...",
  "inferenceModel": "claude-sonnet-4-6",
  "testnetConfig": {
    "chain": "bsc-testnet",
    "tokenAddress": "0x...",
    "skipConwayRegistration": true,
    "skipSocialRelay": true,
    "skipChildSpawning": true
  }
}
```

---

## Implementation Order

### Phase 1: Core plumbing (get it running)
1. Add `mode` + `testnetConfig` to types and config
2. Add `--testnet` CLI flag to `src/index.ts`
3. Add BSC testnet chain to `src/conway/x402.ts`
4. Add Claude models to `src/inference/types.ts` baseline + testnet routing matrix
5. Make `src/index.ts` skip Conway auth/registration/topup in testnet mode
6. Make `src/conway/client.ts` force local mode in testnet
7. Make `src/conway/credits.ts` derive credits from testnet token balance

### Phase 2: Tool awareness
8. Pass `mode` through `ToolContext`
9. Update financial tools (`check_credits`, `topup_credits`, `check_usdc_balance`)
10. Disable cloud-only tools (`create_sandbox`, `spawn_child`)
11. Make `transfer_credits` do a real BEP-20 transfer on testnet

### Phase 3: Setup + UX
12. Add testnet setup wizard flow
13. Update `--status` to show testnet info
14. Add testnet indicator to system prompt (`src/agent/system-prompt.ts`)
15. Update heartbeat tasks for testnet

### Phase 4: Testing
16. Add testnet-specific tests
17. Integration test: full agent loop in testnet mode with mocked Anthropic API
18. Verify wallet can send/receive on BSC testnet

---

## Key Design Decisions

1. **Single config flag (`mode`)** — Not a separate binary or branch. One codebase, one config field controls behavior.

2. **Credits = testnet token balance** — The survival tier system works identically. The only difference is WHERE the credit number comes from (testnet token balance vs Conway API).

3. **No Conway Cloud dependency in testnet** — Zero network calls to Conway. The agent is fully self-contained. The only external calls are: Anthropic API (inference) and BSC testnet RPC (token balance).

4. **Same safety model** — Constitution, policy engine, injection defense, path protection all still active. Testnet mode is not "unsafe mode".

5. **Real wallet, fake money** — The wallet is a real EVM wallet that works on BSC testnet. The test tokens have no real value. The agent genuinely transacts on a public blockchain, just with worthless tokens.

6. **Backward compatible** — Existing production configs work unchanged. `mode` defaults to `"production"` if absent.

---

## Files to Create (New)

None. All changes are modifications to existing files. No new modules needed — the testnet logic is conditional branches within existing code, gated by `config.mode === "testnet"`.

---

## Files to Modify (Summary)

| File | Scope of Change |
|------|----------------|
| `src/types.ts` | Add `mode`, `testnetConfig` to `AutomatonConfig` + defaults |
| `src/config.ts` | Merge testnet defaults |
| `src/index.ts` | `--testnet` flag, skip Conway auth/topup, testnet credit derivation |
| `src/conway/x402.ts` | Add BSC testnet chain + token address + network normalizer |
| `src/conway/credits.ts` | Add `checkFinancialStateTestnet()` |
| `src/conway/topup.ts` | Testnet no-op topup |
| `src/conway/client.ts` | Force local mode, testnet credit balance |
| `src/identity/provision.ts` | Skip SIWE in testnet |
| `src/inference/types.ts` | Claude model baseline + testnet routing matrix |
| `src/inference/router.ts` | Select routing matrix based on mode |
| `src/registry/erc8004.ts` | Add BSC testnet entry, skip in testnet mode |
| `src/agent/tools.ts` | Testnet-aware tool branching |
| `src/setup/wizard.ts` | Testnet setup flow |
| `src/heartbeat/tasks.ts` | Testnet-aware heartbeat tasks |
| `src/agent/system-prompt.ts` | Testnet indicator in prompt |

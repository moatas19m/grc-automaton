import fs from "fs";
import path from "path";
import chalk from "chalk";
import type { AutomatonConfig, TreasuryPolicy, TestnetConfig } from "../types.js";
import { DEFAULT_TREASURY_POLICY, DEFAULT_TESTNET_CONFIG } from "../types.js";
import type { Address } from "viem";
import { getWallet, getAutomatonDir } from "../identity/wallet.js";
import { provision, provisionTestnet } from "../identity/provision.js";
import { createConfig, saveConfig } from "../config.js";
import { writeDefaultHeartbeatConfig } from "../heartbeat/config.js";
import { showBanner } from "./banner.js";
import {
  promptRequired,
  promptMultiline,
  promptAddress,
  promptOptional,
  promptWithDefault,
  closePrompts,
} from "./prompts.js";
import { detectEnvironment } from "./environment.js";
import { generateSoulMd, installDefaultSkills } from "./defaults.js";

/**
 * Unified setup wizard. Asks the user whether they want production or testnet
 * mode as the very first question, then branches accordingly.
 *
 * @param forceTestnet - If true, skip the mode question and go straight to testnet setup.
 */
export async function runSetupWizard(forceTestnet?: boolean): Promise<AutomatonConfig> {
  showBanner();

  console.log(chalk.white("  First-run setup. Let's bring your automaton to life.\n"));

  // ─── Mode selection ────────────────────────────────────────────
  let isTestnet = forceTestnet === true;

  if (!isTestnet) {
    console.log(chalk.cyan("  How do you want to run your automaton?\n"));
    console.log(chalk.white("  1) ") + chalk.bold("Production") + chalk.dim(" — Real funds (USDC on Base), Conway Cloud server"));
    console.log(chalk.white("  2) ") + chalk.bold("Testnet") + chalk.dim("    — Test funds (BSC Testnet), local machine, your Claude API key\n"));

    while (true) {
      const modeInput = await promptRequired("Enter 1 or 2");
      if (modeInput === "1" || modeInput.toLowerCase() === "production") {
        isTestnet = false;
        break;
      }
      if (modeInput === "2" || modeInput.toLowerCase() === "testnet") {
        isTestnet = true;
        break;
      }
      console.log(chalk.yellow("  Please enter 1 or 2."));
    }
    console.log("");
  }

  if (isTestnet) {
    return runTestnetFlow();
  }
  return runProductionFlow();
}

// ─── Production Flow ────────────────────────────────────────────

async function runProductionFlow(): Promise<AutomatonConfig> {
  // ─── 1. Generate wallet ───────────────────────────────────────
  console.log(chalk.cyan("  [1/6] Generating identity (wallet)..."));
  const { account, isNew } = await getWallet();
  if (isNew) {
    console.log(chalk.green(`  Wallet created: ${account.address}`));
  } else {
    console.log(chalk.green(`  Wallet loaded: ${account.address}`));
  }
  console.log(chalk.dim(`  Private key stored at: ${getAutomatonDir()}/wallet.json\n`));

  // ─── 2. Provision API key ─────────────────────────────────────
  console.log(chalk.cyan("  [2/6] Provisioning Conway API key (SIWE)..."));
  let apiKey = "";
  try {
    const result = await provision();
    apiKey = result.apiKey;
    console.log(chalk.green(`  API key provisioned: ${result.keyPrefix}...\n`));
  } catch (err: any) {
    console.log(chalk.yellow(`  Auto-provision failed: ${err.message}`));
    console.log(chalk.yellow("  You can enter a key manually, or press Enter to skip.\n"));
    const manual = await promptOptional("Conway API key (cnwy_k_..., optional)");
    if (manual) {
      apiKey = manual;
      // Save to config.json for loadApiKeyFromConfig()
      const configDir = getAutomatonDir();
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({ apiKey, walletAddress: account.address, provisionedAt: new Date().toISOString() }, null, 2),
        { mode: 0o600 },
      );
      console.log(chalk.green("  API key saved.\n"));
    }
  }

  if (!apiKey) {
    console.log(chalk.yellow("  No API key set. The automaton will have limited functionality.\n"));
  }

  // ─── 3. Interactive questions ─────────────────────────────────
  console.log(chalk.cyan("  [3/6] Setup questions\n"));

  const name = await promptRequired("What do you want to name your automaton?");
  console.log(chalk.green(`  Name: ${name}\n`));

  const genesisPrompt = await promptMultiline("Enter the genesis prompt (system prompt) for your automaton.");
  console.log(chalk.green(`  Genesis prompt set (${genesisPrompt.length} chars)\n`));

  console.log(chalk.dim(`  Your automaton's address is ${account.address}`));
  console.log(chalk.dim("  Now enter YOUR wallet address (the human creator/owner).\n"));
  const creatorAddress = await promptAddress("Creator wallet address (0x...)");
  console.log(chalk.green(`  Creator: ${creatorAddress}\n`));

  console.log(chalk.white("  Optional: bring your own inference provider keys (press Enter to skip)."));
  const openaiApiKey = await promptOptional("OpenAI API key (sk-..., optional)");
  if (openaiApiKey && !openaiApiKey.startsWith("sk-")) {
    console.log(chalk.yellow("  Warning: OpenAI keys usually start with sk-. Saving anyway."));
  }

  const anthropicApiKey = await promptOptional("Anthropic API key (sk-ant-..., optional)");
  if (anthropicApiKey && !anthropicApiKey.startsWith("sk-ant-")) {
    console.log(chalk.yellow("  Warning: Anthropic keys usually start with sk-ant-. Saving anyway."));
  }

  const ollamaInput = await promptOptional("Ollama base URL (http://localhost:11434, optional)");
  const ollamaBaseUrl = ollamaInput || undefined;
  if (ollamaBaseUrl) {
    console.log(chalk.green(`  Ollama URL saved: ${ollamaBaseUrl}`));
  }

  if (openaiApiKey || anthropicApiKey || ollamaBaseUrl) {
    const providers = [
      openaiApiKey ? "OpenAI" : null,
      anthropicApiKey ? "Anthropic" : null,
      ollamaBaseUrl ? "Ollama" : null,
    ].filter(Boolean).join(", ");
    console.log(chalk.green(`  Provider keys/URLs saved: ${providers}\n`));
  } else {
    console.log(chalk.dim("  No provider keys set. Inference will default to Conway.\n"));
  }

  // ─── Financial Safety Policy ─────────────────────────────────
  console.log(chalk.cyan("  Financial Safety Policy"));
  console.log(chalk.dim("  These limits protect against unauthorized spending. Press Enter for defaults.\n"));

  const treasuryPolicy: TreasuryPolicy = {
    maxSingleTransferCents: await promptWithDefault(
      "Max single transfer (cents)", DEFAULT_TREASURY_POLICY.maxSingleTransferCents),
    maxHourlyTransferCents: await promptWithDefault(
      "Max hourly transfers (cents)", DEFAULT_TREASURY_POLICY.maxHourlyTransferCents),
    maxDailyTransferCents: await promptWithDefault(
      "Max daily transfers (cents)", DEFAULT_TREASURY_POLICY.maxDailyTransferCents),
    minimumReserveCents: await promptWithDefault(
      "Minimum reserve (cents)", DEFAULT_TREASURY_POLICY.minimumReserveCents),
    maxX402PaymentCents: await promptWithDefault(
      "Max x402 payment (cents)", DEFAULT_TREASURY_POLICY.maxX402PaymentCents),
    x402AllowedDomains: DEFAULT_TREASURY_POLICY.x402AllowedDomains,
    transferCooldownMs: DEFAULT_TREASURY_POLICY.transferCooldownMs,
    maxTransfersPerTurn: DEFAULT_TREASURY_POLICY.maxTransfersPerTurn,
    maxInferenceDailyCents: await promptWithDefault(
      "Max daily inference spend (cents)", DEFAULT_TREASURY_POLICY.maxInferenceDailyCents),
    requireConfirmationAboveCents: await promptWithDefault(
      "Require confirmation above (cents)", DEFAULT_TREASURY_POLICY.requireConfirmationAboveCents),
  };

  console.log(chalk.green("  Treasury policy configured.\n"));

  // ─── 4. Detect environment ────────────────────────────────────
  console.log(chalk.cyan("  [4/6] Detecting environment..."));
  const env = detectEnvironment();
  if (env.sandboxId) {
    console.log(chalk.green(`  Conway sandbox detected: ${env.sandboxId}\n`));
  } else {
    console.log(chalk.dim(`  Environment: ${env.type} (no sandbox detected)\n`));
  }

  // ─── 5. Write config + heartbeat + SOUL.md + skills ───────────
  console.log(chalk.cyan("  [5/6] Writing configuration..."));

  const config = createConfig({
    name,
    genesisPrompt,
    creatorAddress: creatorAddress as Address,
    registeredWithConway: !!apiKey,
    sandboxId: env.sandboxId,
    walletAddress: account.address,
    apiKey,
    openaiApiKey: openaiApiKey || undefined,
    anthropicApiKey: anthropicApiKey || undefined,
    ollamaBaseUrl,
    treasuryPolicy,
  });

  saveConfig(config);
  console.log(chalk.green("  automaton.json written"));

  writeDefaultHeartbeatConfig();
  console.log(chalk.green("  heartbeat.yml written"));

  // constitution.md (immutable — copied from repo, protected from self-modification)
  const automatonDir = getAutomatonDir();
  const constitutionSrc = path.join(process.cwd(), "constitution.md");
  const constitutionDst = path.join(automatonDir, "constitution.md");
  if (fs.existsSync(constitutionSrc)) {
    fs.copyFileSync(constitutionSrc, constitutionDst);
    fs.chmodSync(constitutionDst, 0o444); // read-only
    console.log(chalk.green("  constitution.md installed (read-only)"));
  }

  // SOUL.md
  const soulPath = path.join(automatonDir, "SOUL.md");
  fs.writeFileSync(soulPath, generateSoulMd(name, account.address, creatorAddress, genesisPrompt), { mode: 0o600 });
  console.log(chalk.green("  SOUL.md written"));

  // Default skills
  const skillsDir = config.skillsDir || "~/.automaton/skills";
  installDefaultSkills(skillsDir);
  console.log(chalk.green("  Default skills installed (conway-compute, conway-payments, survival)\n"));

  // ─── 6. Funding guidance ──────────────────────────────────────
  console.log(chalk.cyan("  [6/6] Funding\n"));
  showFundingPanel(account.address);

  closePrompts();

  return config;
}

// ─── Testnet Flow ───────────────────────────────────────────────

async function runTestnetFlow(): Promise<AutomatonConfig> {
  console.log(chalk.yellow("  [TESTNET MODE] Setting up a testnet automaton.\n"));
  console.log(chalk.white("  No real money. No Conway Cloud. Just your Claude API key + BSC Testnet.\n"));

  // 1. Generate wallet
  console.log(chalk.cyan("  [1/4] Generating identity (wallet)..."));
  const { account, isNew } = await getWallet();
  if (isNew) {
    console.log(chalk.green(`  Wallet created: ${account.address}`));
  } else {
    console.log(chalk.green(`  Wallet loaded: ${account.address}`));
  }
  console.log(chalk.dim(`  Private key stored at: ${getAutomatonDir()}/wallet.json\n`));

  // 2. Interactive questions
  console.log(chalk.cyan("  [2/4] Setup questions\n"));

  const name = await promptRequired("What do you want to name your automaton?");
  console.log(chalk.green(`  Name: ${name}\n`));

  const genesisPrompt = await promptMultiline("Enter the genesis prompt (system prompt) for your automaton.");
  console.log(chalk.green(`  Genesis prompt set (${genesisPrompt.length} chars)\n`));

  // Anthropic API key
  const envAnthropicKey = process.env.ANTHROPIC_API_KEY;
  let anthropicApiKey = envAnthropicKey || "";
  if (envAnthropicKey) {
    console.log(chalk.green(`  Anthropic API key detected from environment: ${envAnthropicKey.slice(0, 12)}...\n`));
  } else {
    anthropicApiKey = await promptRequired("Anthropic API key (sk-ant-...)");
    if (!anthropicApiKey.startsWith("sk-ant-")) {
      console.log(chalk.yellow("  Warning: Anthropic keys usually start with sk-ant-. Saving anyway."));
    }
    console.log(chalk.green(`  Anthropic API key saved.\n`));
  }

  // BSC testnet token address
  const defaultToken = DEFAULT_TESTNET_CONFIG.tokenAddress;
  const tokenInput = await promptOptional(`BSC Testnet token address (default: ${defaultToken})`);
  const tokenAddress = (tokenInput || defaultToken) as Address;

  // Optional custom RPC URL
  const rpcUrl = await promptOptional("Custom BSC Testnet RPC URL (optional, press Enter for public RPC)");

  // 3. Write config
  console.log(chalk.cyan("\n  [3/4] Writing configuration..."));

  const testnetConfig: TestnetConfig = {
    ...DEFAULT_TESTNET_CONFIG,
    tokenAddress,
    ...(rpcUrl ? { rpcUrl } : {}),
  };

  const provResult = provisionTestnet(account.address);

  const config = createConfig({
    name,
    genesisPrompt,
    creatorAddress: account.address as Address, // Self is creator in testnet
    registeredWithConway: false,
    sandboxId: "",
    walletAddress: account.address,
    apiKey: provResult.apiKey,
    anthropicApiKey,
    mode: "testnet",
    testnetConfig,
  });

  saveConfig(config);
  console.log(chalk.green("  automaton.json written"));

  writeDefaultHeartbeatConfig();
  console.log(chalk.green("  heartbeat.yml written"));

  // SOUL.md
  const automatonDir = getAutomatonDir();
  const soulPath = path.join(automatonDir, "SOUL.md");
  fs.writeFileSync(soulPath, generateSoulMd(name, account.address, account.address, genesisPrompt), { mode: 0o600 });
  console.log(chalk.green("  SOUL.md written"));

  // Default skills
  const skillsDir = config.skillsDir || "~/.automaton/skills";
  installDefaultSkills(skillsDir);
  console.log(chalk.green("  Default skills installed\n"));

  // 4. Funding guidance
  console.log(chalk.cyan("  [4/4] Testnet Funding\n"));
  showTestnetFundingPanel(account.address);

  closePrompts();

  return config;
}

// ─── Funding Panels ─────────────────────────────────────────────

function showTestnetFundingPanel(address: string): void {
  const short = `${address.slice(0, 6)}...${address.slice(-5)}`;
  const w = 58;
  const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - s.length));

  console.log(chalk.yellow(`  ${"╭" + "─".repeat(w) + "╮"}`));
  console.log(chalk.yellow(`  │${pad("  [TESTNET] Fund your automaton with test tokens", w)}│`));
  console.log(chalk.yellow(`  │${" ".repeat(w)}│`));
  console.log(chalk.yellow(`  │${pad(`  Address: ${short}`, w)}│`));
  console.log(chalk.yellow(`  │${" ".repeat(w)}│`));
  console.log(chalk.yellow(`  │${pad("  1. Get BNB testnet tokens from a faucet:", w)}│`));
  console.log(chalk.yellow(`  │${pad("     https://www.bnbchain.org/en/testnet-faucet", w)}│`));
  console.log(chalk.yellow(`  │${" ".repeat(w)}│`));
  console.log(chalk.yellow(`  │${pad("  2. Send test tokens to your agent's address", w)}│`));
  console.log(chalk.yellow(`  │${" ".repeat(w)}│`));
  console.log(chalk.yellow(`  │${pad("  No real money is involved. Have fun!", w)}│`));
  console.log(chalk.yellow(`  ${"╰" + "─".repeat(w) + "╯"}`));
  console.log("");
}

function showFundingPanel(address: string): void {
  const short = `${address.slice(0, 6)}...${address.slice(-5)}`;
  const w = 58;
  const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - s.length));

  console.log(chalk.cyan(`  ${"╭" + "─".repeat(w) + "╮"}`));
  console.log(chalk.cyan(`  │${pad("  Fund your automaton", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad(`  Address: ${short}`, w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  1. Transfer Conway credits", w)}│`));
  console.log(chalk.cyan(`  │${pad("     conway credits transfer <address> <amount>", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  2. Send USDC on Base directly to the address above", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  3. Fund via Conway Cloud dashboard", w)}│`));
  console.log(chalk.cyan(`  │${pad("     https://app.conway.tech", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  The automaton will start now. Fund it anytime —", w)}│`));
  console.log(chalk.cyan(`  │${pad("  the survival system handles zero-credit gracefully.", w)}│`));
  console.log(chalk.cyan(`  ${"╰" + "─".repeat(w) + "╯"}`));
  console.log("");
}

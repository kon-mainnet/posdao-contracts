/**
 * KONET fresh-proxy deployment helper.
 *
 * SCOPE: this script deploys a NEW POSDAO contract set (fresh implementations + fresh
 * AdminUpgradeabilityProxy proxies) onto an already-running KONET chain (e.g. a live testnet).
 * It is a FRESH-PROXY deployment only:
 *   - It does NOT upgrade or migrate any existing proxy.
 *   - It does NOT re-initialize an already-initialized proxy.
 *   - It does NOT change proxy admin or transfer ownership of existing contracts.
 *
 * SIGNING MODEL (private-key raw transactions):
 * - This script signs and sends RAW transactions using private keys from the environment.
 *   It does NOT rely on a node keystore, unlocked accounts, or provider-managed accounts.
 *   Any plain HTTP RPC endpoint (e.g. https://testkonet.de-app.com) is sufficient.
 *   - KONET_DEPLOYER_PRIVATE_KEY signs the implementation and proxy creation transactions.
 *   - KONET_PROXY_ADMIN_PRIVATE_KEY signs the upgradeToAndCall (initialize) transactions.
 *   - The address recovered from each private key MUST equal its declared role address
 *     (KONET_DEPLOYER / KONET_PROXY_ADMIN); a mismatch aborts.
 *   - The operational owner does NOT sign anything during deployment; it is only injected as
 *     the initialize() `_owner` argument. Do NOT provide an operational-owner private key.
 *   - Private keys and signed raw transactions are NEVER logged.
 *
 * WARNING:
 * - Do NOT use the proxy admin as the operational owner. They MUST be different addresses.
 * - Do NOT call an implementation initializer through the proxy fallback from the proxy admin.
 *   Initialization is performed via the admin-only `upgradeToAndCall(impl, initCalldata)`, which
 *   delegatecalls initialize() in the proxy's storage with msg.sender preserved as the admin —
 *   so the `block.number == 0 || msg.sender == _admin()` guard passes on a live chain.
 * - The initialize() `_owner` argument is always KONET_OPERATIONAL_OWNER, and each initializer
 *   enforces `_owner != _admin()`, so KONET_PROXY_ADMIN != KONET_OPERATIONAL_OWNER is required.
 * - Run in DRY-RUN mode first (the default). Real transactions require KONET_EXECUTE=true, and
 *   mainnet execution is blocked unless KONET_ALLOW_MAINNET_EXECUTE=true.
 *
 * PROXY CONSTRUCTION + INITIALIZATION:
 *   Each proxy is constructed pointing directly at its REAL implementation, so every proxy exposes
 *   its real code before any initializer runs. This is required because the fresh POSDAO set has a
 *   circular init dependency — ValidatorSetAuRa.initialize() calls into the StakingAuRa proxy
 *   (getDelegatorPoolsLength), and StakingAuRa.initialize() reads ValidatorSetAuRa
 *   (idByStakingAddress) — so all target proxies must already carry real code. The proxy admin
 *   then runs `upgradeToAndCall(realImplementation, initCalldata)` to initialize in-place; this
 *   proxy (BaseUpgradeabilityProxy) accepts an upgrade to the same implementation, so no
 *   placeholder implementation is needed.
 *
 * WHY NOT InitializerAuRa:
 *   InitializerAuRa is designed for the GENESIS initialization path (block.number == 0). On a
 *   live testnet (block.number > 0) InitializerAuRa would call each initializer through the proxy
 *   fallback, but it is not the proxy admin, so the guard
 *     require(block.number == 0 || msg.sender == _admin());
 *   fails (block.number > 0 AND msg.sender != _admin()). Therefore live fresh deployment does NOT
 *   use InitializerAuRa; the proxy admin runs each initializer via upgradeToAndCall() instead.
 *
 * Run (dry-run, default) — standalone node against a plain HTTP RPC:
 *   npm run compile
 *   KONET_RPC_URL=https://testkonet.de-app.com KONET_EXECUTE=false \
 *   node scripts/deploy_for_konet.js
 *
 * Run (dry-run) via truffle exec (still uses KONET_RPC_URL if set; no unlocked account needed):
 *   KONET_RPC_URL=https://testkonet.de-app.com \
 *   npx truffle exec scripts/deploy_for_konet.js --network development
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Contract set. artifact = compiled artifact / truffle artifact name.
const CONTRACTS = {
  validatorSet: { label: 'ValidatorSetAuRa', artifact: 'ValidatorSetAuRa', proxyEnvOut: 'KONET_VALIDATOR_SET_PROXY', ownerManaged: false },
  blockReward: { label: 'BlockRewardAuRa', artifact: 'BlockRewardAuRa', proxyEnvOut: 'KONET_BLOCK_REWARD_PROXY', ownerManaged: true },
  random: { label: 'RandomAuRa', artifact: 'RandomAuRa', proxyEnvOut: 'KONET_RANDOM_PROXY', ownerManaged: true },
  staking: { label: 'StakingAuRa', artifact: 'StakingAuRa', proxyEnvOut: 'KONET_STAKING_PROXY', ownerManaged: true },
  txPermission: { label: 'TxPermission', artifact: 'TxPermission', proxyEnvOut: 'KONET_TX_PERMISSION_PROXY', ownerManaged: true },
  certifier: { label: 'Certifier', artifact: 'Certifier', proxyEnvOut: 'KONET_CERTIFIER_PROXY', ownerManaged: true },
  governance: { label: 'Governance', artifact: 'Governance', proxyEnvOut: 'KONET_GOVERNANCE_PROXY', ownerManaged: true },
};

// Implementation deploy order (§3.1).
const DEPLOY_ORDER = ['validatorSet', 'blockReward', 'random', 'staking', 'txPermission', 'certifier', 'governance'];
// Initialize order (§3.3): ValidatorSet first (pool ids), then Staking, then the rest.
const INIT_ORDER = ['validatorSet', 'staking', 'blockReward', 'random', 'txPermission', 'certifier', 'governance'];

// initialize() ABI fragments.
const INIT_ABI = {
  validatorSet: {
    name: 'initialize', type: 'function', inputs: [
      { name: '_blockRewardContract', type: 'address' },
      { name: '_governanceContract', type: 'address' },
      { name: '_randomContract', type: 'address' },
      { name: '_stakingContract', type: 'address' },
      { name: '_initialMiningAddresses', type: 'address[]' },
      { name: '_initialStakingAddresses', type: 'address[]' },
      { name: '_firstValidatorIsUnremovable', type: 'bool' },
    ],
  },
  staking: {
    name: 'initialize', type: 'function', inputs: [
      { name: '_validatorSetContract', type: 'address' },
      { name: '_governanceContract', type: 'address' },
      { name: '_initialIds', type: 'uint256[]' },
      { name: '_delegatorMinStake', type: 'uint256' },
      { name: '_candidateMinStake', type: 'uint256' },
      { name: '_stakingEpochDuration', type: 'uint256' },
      { name: '_stakingEpochStartBlock', type: 'uint256' },
      { name: '_stakeWithdrawDisallowPeriod', type: 'uint256' },
      { name: '_owner', type: 'address' },
    ],
  },
  blockReward: {
    name: 'initialize', type: 'function', inputs: [
      { name: '_validatorSet', type: 'address' },
      { name: '_prevBlockReward', type: 'address' },
      { name: '_owner', type: 'address' },
    ],
  },
  random: {
    name: 'initialize', type: 'function', inputs: [
      { name: '_collectRoundLength', type: 'uint256' },
      { name: '_validatorSet', type: 'address' },
      { name: '_punishForUnreveal', type: 'bool' },
      { name: '_owner', type: 'address' },
    ],
  },
  txPermission: {
    name: 'initialize', type: 'function', inputs: [
      { name: '_allowed', type: 'address[]' },
      { name: '_certifier', type: 'address' },
      { name: '_validatorSet', type: 'address' },
      { name: '_owner', type: 'address' },
    ],
  },
  certifier: {
    name: 'initialize', type: 'function', inputs: [
      { name: '_certifiedAddresses', type: 'address[]' },
      { name: '_validatorSet', type: 'address' },
      { name: '_owner', type: 'address' },
    ],
  },
  governance: {
    name: 'initialize', type: 'function', inputs: [
      { name: '_validatorSetContract', type: 'address' },
      { name: '_owner', type: 'address' },
    ],
  },
};

// upgradeToAndCall(address,bytes) ABI fragment (admin-only).
const UPGRADE_TO_AND_CALL_ABI = {
  name: 'upgradeToAndCall', type: 'function', payable: true, inputs: [
    { name: 'newImplementation', type: 'address' },
    { name: 'data', type: 'bytes' },
  ],
};

// AdminUpgradeabilityProxy constructor ABI fragment (address _logic, address _admin).
const PROXY_CONSTRUCTOR_INPUTS = [
  { name: '_logic', type: 'address' },
  { name: '_admin', type: 'address' },
];

// idByStakingAddress(address) view fragment.
const ID_BY_STAKING_ABI = {
  name: 'idByStakingAddress', type: 'function', stateMutability: 'view', inputs: [
    { name: '', type: 'address' },
  ], outputs: [{ name: '', type: 'uint256' }],
};

// -----------------------------------------------------------------------------
// Env helpers (minimal .env loader, no external dependency; existing env wins).
// -----------------------------------------------------------------------------
function loadDotEnv(envPath) {
  const file = envPath || path.join(process.cwd(), '.env');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return false;
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
  return true;
}

function env(name) {
  const v = process.env[name];
  return (v === undefined || v === null || String(v).trim() === '') ? undefined : String(v).trim();
}

function readList(name) {
  const raw = env(name);
  if (raw === undefined) return undefined;
  return raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

function readBool(name) {
  const raw = env(name);
  if (raw === undefined) return undefined;
  const low = raw.toLowerCase();
  if (low === 'true' || low === '1') return true;
  if (low === 'false' || low === '0') return false;
  return { invalid: raw };
}

function eqAddr(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

// -----------------------------------------------------------------------------
// Private-key helpers. NEVER log the key material itself.
// -----------------------------------------------------------------------------
function normalizePrivateKey(pk) {
  if (!pk) {
    return null;
  }

  const trimmed = pk.trim();
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

function accountFromPrivateKey(web3, privateKey) {
  const normalized = normalizePrivateKey(privateKey);

  if (!normalized) {
    return null;
  }

  return web3.eth.accounts.privateKeyToAccount(normalized);
}

function assertPrivateKeyMatchesRole(web3, roleName, expectedAddress, privateKey) {
  const account = accountFromPrivateKey(web3, privateKey);

  if (!account) {
    throw new Error(`${roleName} private key is required for execute mode`);
  }

  if (!eqAddr(account.address, expectedAddress)) {
    throw new Error(
      `${roleName} private key address mismatch: expected ${expectedAddress}, got ${account.address}`
    );
  }

  return account;
}

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------
function loadConfig() {
  return {
    rpcUrl: env('KONET_RPC_URL'),
    deployMode: env('KONET_DEPLOY_MODE') || 'fresh-proxy',
    execute: readBool('KONET_EXECUTE') === true,
    executeRaw: readBool('KONET_EXECUTE'),
    expectedChainId: env('KONET_EXPECTED_CHAIN_ID'),
    allowMainnetExecute: readBool('KONET_ALLOW_MAINNET_EXECUTE') === true,
    mainnetChainId: env('KONET_MAINNET_CHAIN_ID'),

    proxyAdmin: env('KONET_PROXY_ADMIN'),
    operationalOwner: env('KONET_OPERATIONAL_OWNER'),
    deployer: env('KONET_DEPLOYER'),

    // Signing keys (never logged).
    deployerPrivateKey: env('KONET_DEPLOYER_PRIVATE_KEY'),
    proxyAdminPrivateKey: env('KONET_PROXY_ADMIN_PRIVATE_KEY'),

    // Gas config.
    gasPrice: env('KONET_GAS_PRICE'),
    gasLimitMultiplierBps: env('KONET_GAS_LIMIT_MULTIPLIER_BPS') || '12000',

    initialMining: readList('KONET_INITIAL_MINING_ADDRESSES'),
    initialStaking: readList('KONET_INITIAL_STAKING_ADDRESSES'),
    firstValidatorIsUnremovable: readBool('KONET_FIRST_VALIDATOR_IS_UNREMOVABLE'),

    delegatorMinStake: env('KONET_DELEGATOR_MIN_STAKE'),
    candidateMinStake: env('KONET_CANDIDATE_MIN_STAKE'),
    stakingEpochDuration: env('KONET_STAKING_EPOCH_DURATION'),
    stakingEpochStartBlock: env('KONET_STAKING_EPOCH_START_BLOCK'),
    stakeWithdrawDisallowPeriod: env('KONET_STAKE_WITHDRAW_DISALLOW_PERIOD'),

    collectRoundLength: env('KONET_COLLECT_ROUND_LENGTH'),
    punishForUnreveal: readBool('KONET_PUNISH_FOR_UNREVEAL'),

    allowedAddresses: readList('KONET_ALLOWED_ADDRESSES'),
    certifiedAddresses: readList('KONET_CERTIFIED_ADDRESSES'),

    prevBlockReward: env('KONET_PREV_BLOCK_REWARD'),
  };
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------
function validateRoles(web3, cfg, errors) {
  const isAddress = web3.utils.isAddress;
  if (!cfg.proxyAdmin) errors.push('KONET_PROXY_ADMIN not set');
  else if (!isAddress(cfg.proxyAdmin)) errors.push(`KONET_PROXY_ADMIN invalid: ${cfg.proxyAdmin}`);
  else if (cfg.proxyAdmin.toLowerCase() === ZERO_ADDRESS) errors.push('KONET_PROXY_ADMIN must not be zero');

  if (!cfg.operationalOwner) errors.push('KONET_OPERATIONAL_OWNER not set');
  else if (!isAddress(cfg.operationalOwner)) errors.push(`KONET_OPERATIONAL_OWNER invalid: ${cfg.operationalOwner}`);
  else if (cfg.operationalOwner.toLowerCase() === ZERO_ADDRESS) errors.push('KONET_OPERATIONAL_OWNER must not be zero');

  if (cfg.proxyAdmin && cfg.operationalOwner && isAddress(cfg.proxyAdmin) && isAddress(cfg.operationalOwner)) {
    if (cfg.proxyAdmin.toLowerCase() === cfg.operationalOwner.toLowerCase()) {
      errors.push('KONET_PROXY_ADMIN == KONET_OPERATIONAL_OWNER; the operational owner must differ from the proxy admin');
    }
  }
  if (cfg.deployer && !isAddress(cfg.deployer)) errors.push(`KONET_DEPLOYER invalid: ${cfg.deployer}`);
}

// Collects the inputs required by initialize(); returns a list of missing input descriptions.
function missingInitInputs(web3, cfg) {
  const isAddress = web3.utils.isAddress;
  const missing = [];

  // validators
  if (!cfg.initialMining || cfg.initialMining.length === 0) missing.push('KONET_INITIAL_MINING_ADDRESSES (comma-separated)');
  if (!cfg.initialStaking || cfg.initialStaking.length === 0) missing.push('KONET_INITIAL_STAKING_ADDRESSES (comma-separated)');
  if (cfg.initialMining && cfg.initialStaking && cfg.initialMining.length !== cfg.initialStaking.length) {
    missing.push('KONET_INITIAL_MINING_ADDRESSES.length must equal KONET_INITIAL_STAKING_ADDRESSES.length');
  }
  for (const a of (cfg.initialMining || [])) if (!isAddress(a)) missing.push(`invalid mining address: ${a}`);
  for (const a of (cfg.initialStaking || [])) if (!isAddress(a)) missing.push(`invalid staking address: ${a}`);
  if (cfg.firstValidatorIsUnremovable === undefined) missing.push('KONET_FIRST_VALIDATOR_IS_UNREMOVABLE (true|false)');
  if (cfg.firstValidatorIsUnremovable && cfg.firstValidatorIsUnremovable.invalid !== undefined) missing.push('KONET_FIRST_VALIDATOR_IS_UNREMOVABLE must be true|false');

  // staking params
  if (cfg.delegatorMinStake === undefined) missing.push('KONET_DELEGATOR_MIN_STAKE');
  if (cfg.candidateMinStake === undefined) missing.push('KONET_CANDIDATE_MIN_STAKE');
  if (cfg.stakingEpochDuration === undefined) missing.push('KONET_STAKING_EPOCH_DURATION');
  if (cfg.stakingEpochStartBlock === undefined) missing.push('KONET_STAKING_EPOCH_START_BLOCK');
  if (cfg.stakeWithdrawDisallowPeriod === undefined) missing.push('KONET_STAKE_WITHDRAW_DISALLOW_PERIOD');

  // random params
  if (cfg.collectRoundLength === undefined) missing.push('KONET_COLLECT_ROUND_LENGTH');
  if (cfg.punishForUnreveal === undefined) missing.push('KONET_PUNISH_FOR_UNREVEAL (true|false)');
  if (cfg.punishForUnreveal && cfg.punishForUnreveal.invalid !== undefined) missing.push('KONET_PUNISH_FOR_UNREVEAL must be true|false');

  // permission / certifier
  if (cfg.allowedAddresses === undefined) missing.push('KONET_ALLOWED_ADDRESSES (comma-separated; may be empty list only if intended)');
  if (cfg.certifiedAddresses === undefined) missing.push('KONET_CERTIFIED_ADDRESSES (comma-separated; may be empty list only if intended)');

  // block reward — no silent default; the zero address must be explicit for a fresh deploy.
  if (cfg.prevBlockReward === undefined) missing.push('KONET_PREV_BLOCK_REWARD (use the zero address explicitly for a fresh deploy)');
  else if (!isAddress(cfg.prevBlockReward)) missing.push(`KONET_PREV_BLOCK_REWARD invalid: ${cfg.prevBlockReward}`);

  return missing;
}

// -----------------------------------------------------------------------------
// Artifact loading (works under `truffle exec` and standalone node).
// -----------------------------------------------------------------------------
function loadArtifact(name) {
  // eslint-disable-next-line no-undef
  if (typeof artifacts !== 'undefined' && artifacts.require) {
    // eslint-disable-next-line no-undef
    return artifacts.require(name);
  }

  const artifactPath = path.join(__dirname, '..', 'build', 'contracts', `${name}.json`);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`artifact ${name} not found at ${artifactPath}; run \`npm run compile\` first`);
  }
  return JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
}

function normalizeArtifact(artifact) {
  return {
    abi: artifact.abi,
    bytecode: artifact.bytecode || artifact.unlinked_binary,
  };
}

// -----------------------------------------------------------------------------
// Raw transaction sender (private-key signed). This is the ONLY write path.
// Never logs private keys or signed raw transactions.
// -----------------------------------------------------------------------------
const nonceTracker = {};

async function nextNonce(web3, address) {
  const key = address.toLowerCase();

  if (nonceTracker[key] === undefined) {
    nonceTracker[key] = await web3.eth.getTransactionCount(address, 'pending');
    return nonceTracker[key];
  }

  nonceTracker[key] += 1;
  return nonceTracker[key];
}

function applyGasMultiplier(cfg, estimatedGas) {
  const bps = Number(cfg.gasLimitMultiplierBps || '12000');
  return Math.ceil(Number(estimatedGas) * bps / 10000);
}

async function sendSignedTransaction(web3, cfg, account, tx, label) {
  const from = account.address;
  const nonce = await nextNonce(web3, from);
  const gasPrice = cfg.gasPrice || await web3.eth.getGasPrice();
  const chainId = await web3.eth.getChainId();

  const estimatePayload = {
    from,
    data: tx.data,
    value: tx.value || '0x0',
  };

  if (tx.to) {
    estimatePayload.to = tx.to;
  }

  const estimatedGas = await web3.eth.estimateGas(estimatePayload);
  const gas = applyGasMultiplier(cfg, estimatedGas);

  const signPayload = {
    from,
    data: tx.data,
    value: tx.value || '0x0',
    gas,
    gasPrice,
    nonce,
    chainId,
  };

  if (tx.to) {
    signPayload.to = tx.to;
  }

  console.log(`[tx] ${label}`);
  console.log(`  from: ${from}`);
  console.log(`  to: ${tx.to || '<contract creation>'}`);
  console.log(`  gas estimate: ${estimatedGas}`);
  console.log(`  gas limit: ${gas}`);
  console.log(`  gas price: ${gasPrice}`);
  console.log(`  nonce: ${nonce}`);

  const signed = await account.signTransaction(signPayload);
  const receipt = await web3.eth.sendSignedTransaction(signed.rawTransaction);

  console.log(`  tx hash: ${receipt.transactionHash}`);
  console.log(`  gas used: ${receipt.gasUsed}`);

  return {
    label,
    transactionHash: receipt.transactionHash,
    contractAddress: receipt.contractAddress || null,
    gasUsed: receipt.gasUsed,
    status: receipt.status,
  };
}

// -----------------------------------------------------------------------------
// Deployment primitives (raw tx)
// -----------------------------------------------------------------------------
async function deployContract(web3, cfg, deployerAccount, artifact, args, label) {
  const normalized = normalizeArtifact(artifact);

  if (!normalized.bytecode || normalized.bytecode === '0x') {
    throw new Error(`${label} bytecode is empty`);
  }

  const contract = new web3.eth.Contract(normalized.abi);
  const data = contract.deploy({
    data: normalized.bytecode,
    arguments: args || [],
  }).encodeABI();

  const receipt = await sendSignedTransaction(web3, cfg, deployerAccount, { data }, label);

  if (!receipt.contractAddress) {
    throw new Error(`${label} deployment did not return contractAddress`);
  }

  return {
    address: receipt.contractAddress,
    receipt,
  };
}

async function callUpgradeToAndCall(web3, cfg, proxyAdminAccount, proxyAddress, implementationAddress, initCalldata, label) {
  const data = web3.eth.abi.encodeFunctionCall(UPGRADE_TO_AND_CALL_ABI, [implementationAddress, initCalldata]);

  return sendSignedTransaction(web3, cfg, proxyAdminAccount, {
    to: proxyAddress,
    data,
  }, `${label} upgradeToAndCall`);
}

// -----------------------------------------------------------------------------
// Calldata (built at execute time, once proxy addresses are known)
// -----------------------------------------------------------------------------
function buildInitCalldata(web3, key, proxies, ids, cfg) {
  const owner = cfg.operationalOwner;
  let args;
  switch (key) {
    case 'validatorSet':
      args = [
        proxies.blockReward, proxies.governance, proxies.random, proxies.staking,
        cfg.initialMining, cfg.initialStaking, cfg.firstValidatorIsUnremovable === true,
      ];
      break;
    case 'staking':
      args = [
        proxies.validatorSet, proxies.governance, ids,
        cfg.delegatorMinStake, cfg.candidateMinStake, cfg.stakingEpochDuration,
        cfg.stakingEpochStartBlock, cfg.stakeWithdrawDisallowPeriod, owner,
      ];
      break;
    case 'blockReward':
      args = [proxies.validatorSet, cfg.prevBlockReward, owner];
      break;
    case 'random':
      args = [cfg.collectRoundLength, proxies.validatorSet, cfg.punishForUnreveal === true, owner];
      break;
    case 'txPermission':
      args = [cfg.allowedAddresses, proxies.certifier, proxies.validatorSet, owner];
      break;
    case 'certifier':
      args = [cfg.certifiedAddresses, proxies.validatorSet, owner];
      break;
    case 'governance':
      args = [proxies.validatorSet, owner];
      break;
    default:
      throw new Error(`unknown contract key: ${key}`);
  }
  return web3.eth.abi.encodeFunctionCall(INIT_ABI[key], args);
}

// -----------------------------------------------------------------------------
// Reporting
// -----------------------------------------------------------------------------
function line() { console.log('-'.repeat(78)); }

function printPlan(cfg, chainId) {
  line();
  console.log('KONET fresh-proxy deployment plan');
  line();
  console.log(`Deploy mode        : ${cfg.deployMode}`);
  console.log(`RPC URL            : ${cfg.rpcUrl || '(truffle provider; no KONET_RPC_URL)'}`);
  console.log(`Chain id           : ${chainId}${cfg.expectedChainId ? ' (expected ' + cfg.expectedChainId + ')' : ''}`);
  console.log(`Mode               : ${cfg.execute ? 'EXECUTE (real transactions requested)' : 'DRY-RUN (no transactions)'}`);
  console.log(`Deployer / signer  : ${cfg.deployer || '(unset)'}`);
  console.log(`Proxy admin        : ${cfg.proxyAdmin || '(unset)'}`);
  console.log(`Operational owner  : ${cfg.operationalOwner || '(unset)'}`);
  console.log(`Mining addresses   : ${cfg.initialMining ? cfg.initialMining.length : 0}`);
  console.log(`Staking addresses  : ${cfg.initialStaking ? cfg.initialStaking.length : 0}`);
  console.log(`Deploy order       : ${DEPLOY_ORDER.map(k => CONTRACTS[k].label).join(' -> ')}`);
  console.log(`Initialize order   : ${INIT_ORDER.map(k => CONTRACTS[k].label).join(' -> ')}`);
}

// Reports signer-key status without ever printing the key material.
function reportSignerKeys(web3, cfg) {
  line();
  console.log('Signer keys (private-key raw-transaction signing):');

  function reportOne(roleName, expectedAddress, privateKey) {
    if (!privateKey) {
      console.log(`  ${roleName}: private key NOT provided (required for execute mode)`);
      return;
    }
    let account;
    try {
      account = accountFromPrivateKey(web3, privateKey);
    } catch (e) {
      console.log(`  ${roleName}: private key present but invalid (${e.message})`);
      return;
    }
    if (!expectedAddress) {
      console.log(`  ${roleName}: private key present; recovered ${account.address} (role address unset)`);
      return;
    }
    const match = eqAddr(account.address, expectedAddress);
    console.log(`  ${roleName}: private key present; address ${match ? 'MATCHES' : 'MISMATCH vs'} role ${expectedAddress}`);
  }

  reportOne('KONET_DEPLOYER', cfg.deployer, cfg.deployerPrivateKey);
  reportOne('KONET_PROXY_ADMIN', cfg.proxyAdmin, cfg.proxyAdminPrivateKey);
  console.log('  (KONET_OPERATIONAL_OWNER does not sign during deployment; no private key needed)');
}

// -----------------------------------------------------------------------------
// Execute-mode gate (throws on any failure). Returns the signing accounts.
// -----------------------------------------------------------------------------
async function assertExecuteAllowed(web3, cfg, chainId) {
  const errors = [];

  if (cfg.deployMode !== 'fresh-proxy') {
    errors.push(`KONET_DEPLOY_MODE must be 'fresh-proxy' (got '${cfg.deployMode}')`);
  }
  if (cfg.executeRaw && cfg.executeRaw.invalid !== undefined) {
    errors.push(`KONET_EXECUTE must be true|false (got '${cfg.executeRaw.invalid}')`);
  }
  if (!cfg.expectedChainId) {
    errors.push('KONET_EXECUTE=true requires KONET_EXPECTED_CHAIN_ID');
  } else if (String(chainId) !== String(cfg.expectedChainId)) {
    errors.push(`chainId mismatch: connected ${chainId}, expected ${cfg.expectedChainId}`);
  }

  // Mainnet guard.
  if (cfg.mainnetChainId && String(chainId) === String(cfg.mainnetChainId) && !cfg.allowMainnetExecute) {
    errors.push(`refusing mainnet execute (chainId ${chainId}): set KONET_ALLOW_MAINNET_EXECUTE=true to override`);
  }

  validateRoles(web3, cfg, errors);
  if (!cfg.deployer) errors.push('KONET_DEPLOYER not set (required for execute mode)');
  for (const m of missingInitInputs(web3, cfg)) errors.push(`missing init input: ${m}`);

  // Private-key signing: the deployer and proxy admin keys must be present and must recover to
  // their declared role addresses. No node keystore / unlocked account is used or required.
  const deployerAccount = accountFromPrivateKey(web3, cfg.deployerPrivateKey);
  if (!deployerAccount) {
    errors.push('KONET_DEPLOYER_PRIVATE_KEY is required for execute mode');
  } else if (cfg.deployer && !eqAddr(deployerAccount.address, cfg.deployer)) {
    errors.push(`KONET_DEPLOYER_PRIVATE_KEY address mismatch: expected ${cfg.deployer}, got ${deployerAccount.address}`);
  }

  const proxyAdminAccount = accountFromPrivateKey(web3, cfg.proxyAdminPrivateKey);
  if (!proxyAdminAccount) {
    errors.push('KONET_PROXY_ADMIN_PRIVATE_KEY is required for execute mode');
  } else if (cfg.proxyAdmin && !eqAddr(proxyAdminAccount.address, cfg.proxyAdmin)) {
    errors.push(`KONET_PROXY_ADMIN_PRIVATE_KEY address mismatch: expected ${cfg.proxyAdmin}, got ${proxyAdminAccount.address}`);
  }

  if (errors.length) {
    line();
    console.log('Execute gate FAILED:');
    for (const e of errors) console.log(`  x ${e}`);
    throw new Error(`Execute preconditions failed with ${errors.length} error(s).`);
  }

  // Defensive re-check via the throwing helper (addresses are already validated above).
  return {
    deployerAccount: assertPrivateKeyMatchesRole(web3, 'KONET_DEPLOYER', cfg.deployer, cfg.deployerPrivateKey),
    proxyAdminAccount: assertPrivateKeyMatchesRole(web3, 'KONET_PROXY_ADMIN', cfg.proxyAdmin, cfg.proxyAdminPrivateKey),
  };
}

// -----------------------------------------------------------------------------
// Execute: deploy implementations + proxies, initialize via upgradeToAndCall, verify.
// -----------------------------------------------------------------------------
async function executeFreshDeploy(web3, cfg, deployerAccount, proxyAdminAccount) {
  const proxyArtifact = loadArtifact('AdminUpgradeabilityProxy');
  const artifactFor = {};
  for (const key of DEPLOY_ORDER) {
    artifactFor[key] = loadArtifact(CONTRACTS[key].artifact);
  }

  const impls = {};
  const proxies = {};
  const initTx = {};

  // §11.1 implementations (signed by the deployer key)
  line();
  console.log('Deploying implementations (signed by deployer key)...');
  for (const key of DEPLOY_ORDER) {
    const dep = await deployContract(web3, cfg, deployerAccount, artifactFor[key], [], `${CONTRACTS[key].label} implementation`);
    impls[key] = dep.address;
    console.log(`  ${CONTRACTS[key].label} impl: ${dep.address}`);
  }

  // §11.2 proxies (constructor: real impl + proxy admin; no init calldata here).
  // The real implementation is set at construction so every proxy exposes real code before any
  // initializer runs — required by the circular init dependency between ValidatorSetAuRa and
  // StakingAuRa (see the header comment). Initialization happens in §11.3 via upgradeToAndCall.
  line();
  console.log('Deploying proxies (AdminUpgradeabilityProxy, constructed with the real implementation)...');
  const proxyNormalized = normalizeArtifact(proxyArtifact);
  if (!proxyNormalized.bytecode || proxyNormalized.bytecode === '0x') {
    throw new Error('AdminUpgradeabilityProxy bytecode is empty');
  }
  for (const key of DEPLOY_ORDER) {
    // Build creation bytecode = proxy bytecode + encoded (realImpl, proxyAdmin).
    const encodedArgs = web3.eth.abi.encodeParameters(
      PROXY_CONSTRUCTOR_INPUTS.map(i => i.type),
      [impls[key], cfg.proxyAdmin]
    );
    const data = proxyNormalized.bytecode + encodedArgs.replace(/^0x/, '');
    const receipt = await sendSignedTransaction(web3, cfg, deployerAccount, { data }, `${CONTRACTS[key].label} proxy`);
    if (!receipt.contractAddress) {
      throw new Error(`${CONTRACTS[key].label} proxy deployment did not return contractAddress`);
    }
    proxies[key] = receipt.contractAddress;
    console.log(`  ${CONTRACTS[key].label} proxy: ${receipt.contractAddress}`);
  }

  // §11.3 initialize via admin upgradeToAndCall (same real impl + init calldata), signed by proxy admin
  line();
  console.log('Initializing via proxy admin upgradeToAndCall (signed by proxy admin key)...');
  for (const key of INIT_ORDER) {
    let ids = [];
    if (key === 'staking') {
      // _initialIds are NOT guessed: read them from the just-initialized ValidatorSetAuRa proxy.
      // The read goes through the proxy fallback (idByStakingAddress lives on the implementation),
      // so `from` MUST NOT be the proxy admin — the transparent-proxy guard blocks the admin from
      // the fallback (some RPCs default eth_call `from` to accounts[0]). Use the zero address,
      // which is guaranteed != admin.
      const vs = new web3.eth.Contract([ID_BY_STAKING_ABI], proxies.validatorSet);
      for (const stakingAddr of cfg.initialStaking) {
        const id = await vs.methods.idByStakingAddress(stakingAddr).call({ from: ZERO_ADDRESS });
        const idStr = id.toString();
        if (idStr === '0') {
          throw new Error(`idByStakingAddress(${stakingAddr}) == 0 after ValidatorSet init; cannot build StakingAuRa initCalldata`);
        }
        ids.push(idStr);
      }
    }
    const initCalldata = buildInitCalldata(web3, key, proxies, ids, cfg);
    let receipt;
    try {
      receipt = await callUpgradeToAndCall(web3, cfg, proxyAdminAccount, proxies[key], impls[key], initCalldata, CONTRACTS[key].label);
    } catch (e) {
      throw new Error(`upgradeToAndCall failed for ${CONTRACTS[key].label} (proxy ${proxies[key]}) from admin ${cfg.proxyAdmin}: ${e.message}`);
    }
    initTx[key] = receipt.transactionHash;
    console.log(`  ${CONTRACTS[key].label} initialized: tx ${initTx[key]}`);
  }

  return { impls, proxies, initTx };
}

async function verifyDeploy(web3, cfg, result) {
  const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
  const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  const ownerSlotHash = web3.utils.keccak256('konet.proxy.owner');
  const OWNER_SLOT = '0x' + (BigInt(ownerSlotHash) - 1n).toString(16).padStart(64, '0');

  function addrFromWord(word) {
    if (!word || word === '0x') return ZERO_ADDRESS;
    const hex = word.replace(/^0x/, '').padStart(64, '0');
    return web3.utils.toChecksumAddress('0x' + hex.slice(-40));
  }

  line();
  console.log('Post-deploy verification:');
  for (const key of DEPLOY_ORDER) {
    const proxy = result.proxies[key];
    const problems = [];
    const proxyCode = await web3.eth.getCode(proxy);
    if (!proxyCode || proxyCode === '0x') problems.push('proxy has no code');
    const implCode = await web3.eth.getCode(result.impls[key]);
    if (!implCode || implCode === '0x') problems.push('implementation has no code');

    const implSlot = addrFromWord(await web3.eth.getStorageAt(proxy, IMPLEMENTATION_SLOT));
    if (implSlot.toLowerCase() !== result.impls[key].toLowerCase()) problems.push(`impl slot ${implSlot} != ${result.impls[key]}`);
    const adminSlot = addrFromWord(await web3.eth.getStorageAt(proxy, ADMIN_SLOT));
    if (adminSlot.toLowerCase() !== cfg.proxyAdmin.toLowerCase()) problems.push(`admin slot ${adminSlot} != KONET_PROXY_ADMIN`);

    if (CONTRACTS[key].ownerManaged) {
      const ownerSlot = addrFromWord(await web3.eth.getStorageAt(proxy, OWNER_SLOT));
      if (ownerSlot.toLowerCase() !== cfg.operationalOwner.toLowerCase()) problems.push(`owner slot ${ownerSlot} != KONET_OPERATIONAL_OWNER`);
      if (ownerSlot.toLowerCase() === cfg.proxyAdmin.toLowerCase()) problems.push('owner == admin');
    }

    console.log(`  ${CONTRACTS[key].label}: ${problems.length ? 'PROBLEM -> ' + problems.join('; ') : 'ok'}`);
  }
  console.log('\nFor full evidence (owner-only eth_call, admin fallback block, code hashes), run:');
  console.log('  KONET_RPC_URL=<rpc> node scripts/inspect_konet_onchain_evidence.js');
  console.log('  (or: npx truffle exec scripts/inspect_konet_onchain_evidence.js --network konet)');
  console.log('  (populate the *_PROXY env vars from the block below first)');
}

function printOutput(result) {
  line();
  console.log('Deployment result:');
  console.log('Contract | Implementation | Proxy | Init Tx | Status');
  for (const key of DEPLOY_ORDER) {
    console.log(`${CONTRACTS[key].label} | ${result.impls[key]} | ${result.proxies[key]} | ${result.initTx[key] || '-'} | deployed`);
  }
  line();
  console.log('Copy into your .env (evidence inspector uses the _PROXY names):');
  for (const key of DEPLOY_ORDER) {
    console.log(`${CONTRACTS[key].proxyEnvOut}=${result.proxies[key]}`);
  }
}

// -----------------------------------------------------------------------------
// Runner
// -----------------------------------------------------------------------------
async function run(web3) {
  loadDotEnv();
  const cfg = loadConfig();

  let chainId = null;
  try { chainId = await web3.eth.getChainId(); }
  catch (e) { try { chainId = await web3.eth.net.getId(); } catch (e2) { /* leave null */ } }

  printPlan(cfg, chainId);

  // Soft validation (reported in both modes).
  const roleErrors = [];
  validateRoles(web3, cfg, roleErrors);
  const missing = missingInitInputs(web3, cfg);

  line();
  if (roleErrors.length) {
    console.log('Role config errors:');
    for (const e of roleErrors) console.log(`  x ${e}`);
  } else {
    console.log('Role config: OK (proxy admin != operational owner).');
  }
  if (missing.length) {
    console.log('Missing / invalid init inputs:');
    for (const m of missing) console.log(`  - ${m}`);
  } else {
    console.log('Init inputs: all present.');
  }

  // Signer-key status (no secret material is printed).
  reportSignerKeys(web3, cfg);

  // Fresh-proxy: calldata references proxy addresses that do not exist yet in dry-run.
  line();
  console.log('Initialize calldata (fresh-proxy):');
  for (const key of INIT_ORDER) {
    console.log(`  ${CONTRACTS[key].label}: will be built after proxy deployment`);
  }

  if (!cfg.execute) {
    line();
    console.log('DRY-RUN complete. No transactions were sent. execute mode: false');
    console.log('Set KONET_EXECUTE=true (with KONET_EXPECTED_CHAIN_ID and signing keys) to deploy.');
    return { mode: 'dry-run', chainId };
  }

  // ---- EXECUTE ----
  const { deployerAccount, proxyAdminAccount } = await assertExecuteAllowed(web3, cfg, chainId);
  console.log(`\nExecute gate OK. Deploying as ${deployerAccount.address} (proxy admin ${proxyAdminAccount.address}).`);

  const result = await executeFreshDeploy(web3, cfg, deployerAccount, proxyAdminAccount);
  await verifyDeploy(web3, cfg, result);
  printOutput(result);
  return { mode: 'execute', chainId, result };
}

// -----------------------------------------------------------------------------
// Web3 provider resolution.
// KONET_RPC_URL (plain HTTP RPC) takes precedence; otherwise fall back to the truffle-injected
// web3 global. No unlocked/keystore account is ever required — signing is done with private keys.
// -----------------------------------------------------------------------------
function resolveWeb3(globalWeb3) {
  const url = env('KONET_RPC_URL');
  if (url) {
    let Web3;
    try { Web3 = require('web3'); }
    catch (e) { throw new Error(`KONET_RPC_URL is set but the web3 module is unavailable: ${e.message}`); }
    // web3 1.x may expose the constructor as Web3 or Web3.default depending on the bundling.
    const Ctor = Web3.default || Web3;
    return new Ctor(new Ctor.providers.HttpProvider(url));
  }
  if (globalWeb3) return globalWeb3;
  throw new Error('No web3 available: set KONET_RPC_URL (recommended) or run via `truffle exec`.');
}

// -----------------------------------------------------------------------------
// Entry points
// -----------------------------------------------------------------------------

// truffle exec: `web3` and `artifacts` are injected globals. KONET_RPC_URL, if set, still wins.
module.exports = async function (callback) {
  try {
    loadDotEnv();
    // eslint-disable-next-line no-undef
    const globalWeb3 = (typeof web3 !== 'undefined') ? web3 : null;
    const web3Instance = resolveWeb3(globalWeb3);
    await run(web3Instance);
    return callback();
  } catch (err) {
    return callback(err);
  }
};

// Standalone node: requires KONET_RPC_URL. Supports both dry-run and execute (build artifacts
// are loaded from build/contracts, so run `npm run compile` first).
if (require.main === module) {
  (async () => {
    loadDotEnv();
    try {
      const web3Instance = resolveWeb3(null);
      await run(web3Instance);
      process.exit(0);
    } catch (err) {
      console.error(err.message || err);
      process.exit(1);
    }
  })();
}

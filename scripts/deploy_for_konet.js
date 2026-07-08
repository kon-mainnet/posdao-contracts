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
 * WHY NOT InitializerAuRa:
 *   InitializerAuRa is designed for the GENESIS initialization path (block.number == 0). On a
 *   live testnet (block.number > 0) InitializerAuRa would call each initializer through the proxy
 *   fallback, but it is not the proxy admin, so the guard
 *     require(block.number == 0 || msg.sender == _admin());
 *   fails (block.number > 0 AND msg.sender != _admin()). Therefore live fresh deployment does NOT
 *   use InitializerAuRa; the proxy admin runs each initializer via upgradeToAndCall() instead.
 *
 * Run (dry-run, default):
 *   KONET_DEPLOY_MODE=fresh-proxy KONET_EXECUTE=false \
 *   KONET_PROXY_ADMIN=0x... KONET_OPERATIONAL_OWNER=0x... KONET_EXPECTED_CHAIN_ID=... \
 *   npx truffle exec scripts/deploy_for_konet.js --network konet
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Contract set. artifact = truffle artifact name.
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

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------
function loadConfig() {
  return {
    deployMode: env('KONET_DEPLOY_MODE') || 'fresh-proxy',
    execute: readBool('KONET_EXECUTE') === true,
    executeRaw: readBool('KONET_EXECUTE'),
    expectedChainId: env('KONET_EXPECTED_CHAIN_ID'),
    allowMainnetExecute: readBool('KONET_ALLOW_MAINNET_EXECUTE') === true,
    mainnetChainId: env('KONET_MAINNET_CHAIN_ID'),

    proxyAdmin: env('KONET_PROXY_ADMIN'),
    operationalOwner: env('KONET_OPERATIONAL_OWNER'),
    deployer: env('KONET_DEPLOYER'),

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
  console.log(`Chain id           : ${chainId}${cfg.expectedChainId ? ' (expected ' + cfg.expectedChainId + ')' : ''}`);
  console.log(`Mode               : ${cfg.execute ? 'EXECUTE (real transactions requested)' : 'DRY-RUN (no transactions)'}`);
  console.log(`Deployer / signer  : ${cfg.deployer || '(truffle default account[0])'}`);
  console.log(`Proxy admin        : ${cfg.proxyAdmin || '(unset)'}`);
  console.log(`Operational owner  : ${cfg.operationalOwner || '(unset)'}`);
  console.log(`Mining addresses   : ${cfg.initialMining ? cfg.initialMining.length : 0}`);
  console.log(`Staking addresses  : ${cfg.initialStaking ? cfg.initialStaking.length : 0}`);
  console.log(`Deploy order       : ${DEPLOY_ORDER.map(k => CONTRACTS[k].label).join(' -> ')}`);
  console.log(`Initialize order   : ${INIT_ORDER.map(k => CONTRACTS[k].label).join(' -> ')}`);
}

// -----------------------------------------------------------------------------
// Execute-mode gate (throws on any failure)
// -----------------------------------------------------------------------------
async function assertExecuteAllowed(web3, cfg, chainId, accounts) {
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
  for (const m of missingInitInputs(web3, cfg)) errors.push(`missing init input: ${m}`);

  // Signer availability: the deployer and (critically) the proxy admin must be signable by the
  // provider, because upgradeToAndCall must be sent FROM the proxy admin.
  const lc = accounts.map(a => a.toLowerCase());
  const deployer = cfg.deployer || accounts[0];
  if (!deployer) errors.push('no deployer account available (set KONET_DEPLOYER or provide a funded account[0])');
  else if (cfg.deployer && !lc.includes(cfg.deployer.toLowerCase())) {
    errors.push(`KONET_DEPLOYER ${cfg.deployer} is not in the provider accounts; the provider cannot sign for it`);
  }
  if (cfg.proxyAdmin && !lc.includes(cfg.proxyAdmin.toLowerCase())) {
    errors.push(`KONET_PROXY_ADMIN ${cfg.proxyAdmin} is not in the provider accounts; it cannot send upgradeToAndCall. ` +
      'Provide a provider/unlocked account for the proxy admin.');
  }

  if (errors.length) {
    line();
    console.log('Execute gate FAILED:');
    for (const e of errors) console.log(`  x ${e}`);
    throw new Error(`Execute preconditions failed with ${errors.length} error(s).`);
  }
  return { deployer };
}

// -----------------------------------------------------------------------------
// Execute: deploy implementations + proxies, initialize via upgradeToAndCall, verify.
// -----------------------------------------------------------------------------
async function executeFreshDeploy(web3, cfg, artifactsRef, deployer) {
  const AdminUpgradeabilityProxy = artifactsRef.require('AdminUpgradeabilityProxy');
  const artifactFor = {};
  for (const key of DEPLOY_ORDER) {
    artifactFor[key] = artifactsRef.require(CONTRACTS[key].artifact);
  }

  const impls = {};
  const proxies = {};
  const initTx = {};

  // §3.1 implementations
  line();
  console.log('Deploying implementations...');
  for (const key of DEPLOY_ORDER) {
    const inst = await artifactFor[key].new({ from: deployer });
    impls[key] = inst.address;
    console.log(`  ${CONTRACTS[key].label} impl: ${inst.address}`);
  }

  // §3.2 proxies (constructor sets impl + proxy admin; no init calldata here)
  line();
  console.log('Deploying proxies (AdminUpgradeabilityProxy)...');
  for (const key of DEPLOY_ORDER) {
    const proxy = await AdminUpgradeabilityProxy.new(impls[key], cfg.proxyAdmin, { from: deployer });
    proxies[key] = proxy.address;
    console.log(`  ${CONTRACTS[key].label} proxy: ${proxy.address}`);
  }

  // §3.3 initialize via admin upgradeToAndCall (same impl, with init calldata)
  line();
  console.log('Initializing via proxy admin upgradeToAndCall...');
  for (const key of INIT_ORDER) {
    let ids = [];
    if (key === 'staking') {
      // _initialIds are NOT guessed: read them from the just-initialized ValidatorSetAuRa.
      const vs = await artifactFor.validatorSet.at(proxies.validatorSet);
      for (const stakingAddr of cfg.initialStaking) {
        const id = await vs.idByStakingAddress(stakingAddr);
        const idStr = id.toString();
        if (idStr === '0') {
          throw new Error(`idByStakingAddress(${stakingAddr}) == 0 after ValidatorSet init; cannot build StakingAuRa initCalldata`);
        }
        ids.push(idStr);
      }
    }
    const initCalldata = buildInitCalldata(web3, key, proxies, ids, cfg);
    const proxyAsAdmin = await AdminUpgradeabilityProxy.at(proxies[key]);
    let receipt;
    try {
      receipt = await proxyAsAdmin.upgradeToAndCall(impls[key], initCalldata, { from: cfg.proxyAdmin });
    } catch (e) {
      throw new Error(`upgradeToAndCall failed for ${CONTRACTS[key].label} (proxy ${proxies[key]}) from admin ${cfg.proxyAdmin}: ${e.message}`);
    }
    initTx[key] = receipt.tx || (receipt.receipt && receipt.receipt.transactionHash) || '(unknown)';
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
  console.log('  npx truffle exec scripts/inspect_konet_onchain_evidence.js --network konet');
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
async function run(web3, artifactsRef) {
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

  // Fresh-proxy: calldata references proxy addresses that do not exist yet in dry-run.
  line();
  console.log('Initialize calldata (fresh-proxy):');
  for (const key of INIT_ORDER) {
    console.log(`  ${CONTRACTS[key].label}: will be built after proxy deployment`);
  }

  if (!cfg.execute) {
    line();
    console.log('DRY-RUN complete. No transactions were sent. execute mode: false');
    console.log('Set KONET_EXECUTE=true (with KONET_EXPECTED_CHAIN_ID) to deploy.');
    return { mode: 'dry-run', chainId };
  }

  // ---- EXECUTE ----
  if (!artifactsRef) {
    throw new Error('fresh-proxy execute requires `truffle exec` (artifacts unavailable in standalone node mode).');
  }
  const accounts = await web3.eth.getAccounts();
  const { deployer } = await assertExecuteAllowed(web3, cfg, chainId, accounts);
  console.log(`\nExecute gate OK. Deploying as ${deployer} (proxy admin ${cfg.proxyAdmin}).`);

  const result = await executeFreshDeploy(web3, cfg, artifactsRef, deployer);
  await verifyDeploy(web3, cfg, result);
  printOutput(result);
  return { mode: 'execute', chainId, result };
}

// -----------------------------------------------------------------------------
// Entry points
// -----------------------------------------------------------------------------

// truffle exec: `web3` and `artifacts` are injected globals.
module.exports = async function (callback) {
  try {
    // eslint-disable-next-line no-undef
    const w3 = (typeof web3 !== 'undefined') ? web3 : null;
    // eslint-disable-next-line no-undef
    const art = (typeof artifacts !== 'undefined') ? artifacts : null;
    if (!w3) throw new Error('No web3 available. Run via `truffle exec` or set KONET_RPC_URL for a standalone dry-run.');
    await run(w3, art);
    return callback();
  } catch (err) {
    return callback(err);
  }
};

// Standalone node: dry-run only (no artifacts, so no deploy). Requires KONET_RPC_URL.
if (require.main === module) {
  (async () => {
    loadDotEnv();
    const url = env('KONET_RPC_URL');
    if (!url) {
      console.error('Standalone mode requires KONET_RPC_URL (dry-run only). For execute, use: ' +
        'npx truffle exec scripts/deploy_for_konet.js --network konet');
      process.exit(1);
    }
    let Web3;
    try { Web3 = require('web3'); }
    catch (e) { console.error('Could not require("web3"). Use `truffle exec` instead.'); process.exit(1); }
    const web3 = new Web3(new Web3.providers.HttpProvider(url));
    try {
      const out = await run(web3, null);
      process.exit(out.mode === 'dry-run' ? 0 : 0);
    } catch (err) {
      console.error(err.message || err);
      process.exit(1);
    }
  })();
}

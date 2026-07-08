/**
 * KONET on-chain evidence inspector (READ-ONLY).
 *
 * Purpose: provide evidence for CON-01 / GLOBAL-01 source-level mitigation by reading, from the
 * deployed proxy addresses, whether the proxy admin is separated from the operational owner and
 * whether the transparent-proxy admin-block behaves as expected.
 *
 * This script performs READ-ONLY operations only:
 *   - web3.eth.getStorageAt / getCode / call / getChainId / getBlockNumber
 * It NEVER sends a write transaction. The transferOwnership(...) checks are done purely via
 * eth_call (no state change, no gas spent, nothing broadcast).
 *
 * Run with truffle (uses the injected `web3`):
 *   npx truffle exec scripts/inspect_konet_onchain_evidence.js --network konet
 *
 * Or standalone against an RPC URL:
 *   KONET_RPC_URL=http://... node scripts/inspect_konet_onchain_evidence.js
 *
 * Configuration comes from environment variables (see .env.example). A local `.env` file, if
 * present, is loaded with a tiny built-in parser (no dotenv dependency). Existing environment
 * variables always take precedence over `.env`.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// EIP-1967 slots (match contracts/upgradeability/UpgradeabilityAdmin.sol and
// BaseUpgradeabilityProxy.sol).
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

// -----------------------------------------------------------------------------
// Minimal .env loader (no external dependency). Does NOT override already-set env vars.
// -----------------------------------------------------------------------------
function loadDotEnv(envPath) {
  const file = envPath || path.join(process.cwd(), '.env');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return false; // no .env; rely on the process environment
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
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
  return true;
}

function env(name) {
  const v = process.env[name];
  return (v === undefined || v === null || String(v).trim() === '') ? undefined : String(v).trim();
}

// -----------------------------------------------------------------------------
// Storage / code helpers
// -----------------------------------------------------------------------------
function slotMinusOne(web3, label) {
  const hash = web3.utils.keccak256(label);
  const slot = BigInt(hash) - 1n;
  return '0x' + slot.toString(16).padStart(64, '0');
}

function addressFromStorageWord(web3, word) {
  if (!word || word === '0x') {
    return ZERO_ADDRESS;
  }
  const hex = word.replace(/^0x/, '').padStart(64, '0');
  const addr = '0x' + hex.slice(-40);
  return web3.utils.toChecksumAddress(addr);
}

function codeInfo(web3, code) {
  const normalized = code && code !== '0x' ? code : '0x';
  return {
    hasCode: normalized !== '0x',
    sizeBytes: normalized === '0x' ? 0 : (normalized.length - 2) / 2,
    hash: normalized === '0x' ? null : web3.utils.keccak256(normalized),
  };
}

function isZero(addr) {
  return !addr || addr.toLowerCase() === ZERO_ADDRESS;
}

function eqAddr(a, b) {
  return a && b && a.toLowerCase() === b.toLowerCase();
}

function shorten(v, head, tail) {
  if (!v) return '-';
  if (v.length <= head + tail + 3) return v;
  return v.slice(0, head) + '…' + v.slice(-tail);
}

// Picks a getter to use as the admin-fallback probe. It must be a plain (non-admin, non-owner)
// view function that a non-admin caller can successfully call, so that a revert when the proxy
// admin calls it is unambiguously attributable to the transparent-proxy admin-block — not to an
// onlyOwner check. Preference: isInitialized(), then validatorSetContract(), then the first
// getter that returned successfully for a non-admin call.
function selectFallbackProbe(target, result) {
  const preferred = ['isInitialized', 'validatorSetContract'];

  for (const name of preferred) {
    const getter = target.getters.find(g => g.name === name);
    const entry = result.getters[name];
    if (getter && entry && entry.error === null) {
      return getter;
    }
  }

  for (const getter of target.getters) {
    const entry = result.getters[getter.name];
    if (entry && entry.error === null) {
      return getter;
    }
  }

  return null;
}

// -----------------------------------------------------------------------------
// Targets (6 owner-managed proxies)
// -----------------------------------------------------------------------------
const TARGETS = [
  {
    key: 'certifier',
    label: 'Certifier',
    proxyEnv: 'KONET_CERTIFIER_PROXY',
    expectedImplEnv: 'KONET_CERTIFIER_IMPL_EXPECTED',
    hasIsInitialized: true,
    getters: [
      { name: 'isInitialized', signature: 'isInitialized()', returnType: 'bool' },
      { name: 'validatorSetContract', signature: 'validatorSetContract()', returnType: 'address', expectedEnv: 'KONET_VALIDATOR_SET_PROXY' },
    ],
  },
  {
    key: 'governance',
    label: 'Governance',
    proxyEnv: 'KONET_GOVERNANCE_PROXY',
    expectedImplEnv: 'KONET_GOVERNANCE_IMPL_EXPECTED',
    hasIsInitialized: false, // no isInitialized(); infer from validatorSetContract != 0
    getters: [
      { name: 'validatorSetContract', signature: 'validatorSetContract()', returnType: 'address', expectedEnv: 'KONET_VALIDATOR_SET_PROXY' },
    ],
  },
  {
    key: 'random',
    label: 'RandomAuRa',
    proxyEnv: 'KONET_RANDOM_PROXY',
    expectedImplEnv: 'KONET_RANDOM_IMPL_EXPECTED',
    hasIsInitialized: true,
    getters: [
      { name: 'isInitialized', signature: 'isInitialized()', returnType: 'bool' },
      { name: 'validatorSetContract', signature: 'validatorSetContract()', returnType: 'address', expectedEnv: 'KONET_VALIDATOR_SET_PROXY' },
    ],
  },
  {
    key: 'blockReward',
    label: 'BlockRewardAuRa',
    proxyEnv: 'KONET_BLOCK_REWARD_PROXY',
    expectedImplEnv: 'KONET_BLOCK_REWARD_IMPL_EXPECTED',
    hasIsInitialized: true,
    getters: [
      { name: 'isInitialized', signature: 'isInitialized()', returnType: 'bool' },
      { name: 'validatorSetContract', signature: 'validatorSetContract()', returnType: 'address', expectedEnv: 'KONET_VALIDATOR_SET_PROXY' },
    ],
  },
  {
    key: 'staking',
    label: 'StakingAuRa',
    proxyEnv: 'KONET_STAKING_PROXY',
    expectedImplEnv: 'KONET_STAKING_IMPL_EXPECTED',
    hasIsInitialized: true,
    getters: [
      { name: 'isInitialized', signature: 'isInitialized()', returnType: 'bool' },
      { name: 'validatorSetContract', signature: 'validatorSetContract()', returnType: 'address', expectedEnv: 'KONET_VALIDATOR_SET_PROXY' },
      { name: 'governanceContract', signature: 'governanceContract()', returnType: 'address', expectedEnv: 'KONET_GOVERNANCE_PROXY' },
    ],
  },
  {
    key: 'txPermission',
    label: 'TxPermission',
    proxyEnv: 'KONET_TX_PERMISSION_PROXY',
    expectedImplEnv: 'KONET_TX_PERMISSION_IMPL_EXPECTED',
    hasIsInitialized: true,
    getters: [
      { name: 'isInitialized', signature: 'isInitialized()', returnType: 'bool' },
      { name: 'validatorSetContract', signature: 'validatorSetContract()', returnType: 'address', expectedEnv: 'KONET_VALIDATOR_SET_PROXY' },
      { name: 'certifierContract', signature: 'certifierContract()', returnType: 'address', expectedEnv: 'KONET_CERTIFIER_PROXY' },
    ],
  },
];

// -----------------------------------------------------------------------------
// Per-target inspection (all read-only)
// -----------------------------------------------------------------------------
async function inspectTarget(web3, ownerSlot, target) {
  const result = {
    key: target.key,
    label: target.label,
    proxyAddress: env(target.proxyEnv) || null,
    implementationAddress: null,
    proxyAdminAddress: null,
    operationalOwnerAddress: null,
    proxyCodeHash: null,
    proxyCodeSize: 0,
    implementationCodeHash: null,
    implementationCodeSize: 0,
    adminIsZero: null,
    ownerIsZero: null,
    implementationIsZero: null,
    adminEqualsOwner: null,
    adminDiffersFromOwner: null,
    expectedImplementationMatch: null, // null = not checked
    getters: {},
    dependencyMatches: {},
    ownerCallCheck: 'skipped',
    ownerCallError: null,
    adminFallbackBlockedCheck: 'skipped',
    adminFallbackError: null,
    adminFallbackProbe: null,
    status: 'FAIL',
    warnings: [],
    errors: [],
  };

  if (!result.proxyAddress) {
    result.errors.push(`${target.proxyEnv} not set`);
    result.status = 'FAIL';
    return result;
  }
  if (!web3.utils.isAddress(result.proxyAddress)) {
    result.errors.push(`${target.proxyEnv} is not a valid address: ${result.proxyAddress}`);
    result.status = 'FAIL';
    return result;
  }
  result.proxyAddress = web3.utils.toChecksumAddress(result.proxyAddress);

  // Proxy code
  try {
    const proxyCode = await web3.eth.getCode(result.proxyAddress);
    const ci = codeInfo(web3, proxyCode);
    result.proxyCodeHash = ci.hash;
    result.proxyCodeSize = ci.sizeBytes;
    if (!ci.hasCode) result.errors.push('proxy has no code at the given address');
  } catch (e) {
    result.errors.push(`getCode(proxy) failed: ${e.message}`);
  }

  // Storage slots -> addresses
  try {
    const implWord = await web3.eth.getStorageAt(result.proxyAddress, IMPLEMENTATION_SLOT);
    result.implementationAddress = addressFromStorageWord(web3, implWord);
  } catch (e) {
    result.errors.push(`getStorageAt(implementation) failed: ${e.message}`);
  }
  try {
    const adminWord = await web3.eth.getStorageAt(result.proxyAddress, ADMIN_SLOT);
    result.proxyAdminAddress = addressFromStorageWord(web3, adminWord);
  } catch (e) {
    result.errors.push(`getStorageAt(admin) failed: ${e.message}`);
  }
  try {
    const ownerWord = await web3.eth.getStorageAt(result.proxyAddress, ownerSlot);
    result.operationalOwnerAddress = addressFromStorageWord(web3, ownerWord);
  } catch (e) {
    result.errors.push(`getStorageAt(owner) failed: ${e.message}`);
  }

  // Implementation code
  if (result.implementationAddress && !isZero(result.implementationAddress)) {
    try {
      const implCode = await web3.eth.getCode(result.implementationAddress);
      const ci = codeInfo(web3, implCode);
      result.implementationCodeHash = ci.hash;
      result.implementationCodeSize = ci.sizeBytes;
      if (!ci.hasCode) result.errors.push('implementation has no code');
    } catch (e) {
      result.errors.push(`getCode(implementation) failed: ${e.message}`);
    }
  }

  // Derived flags
  result.implementationIsZero = isZero(result.implementationAddress);
  result.adminIsZero = isZero(result.proxyAdminAddress);
  result.ownerIsZero = isZero(result.operationalOwnerAddress);
  if (result.proxyAdminAddress && result.operationalOwnerAddress) {
    result.adminEqualsOwner = eqAddr(result.proxyAdminAddress, result.operationalOwnerAddress);
    result.adminDiffersFromOwner = !result.adminEqualsOwner;
  } else {
    result.adminEqualsOwner = null;
    result.adminDiffersFromOwner = null;
  }

  // Expected implementation cross-check
  const expectedImpl = env(target.expectedImplEnv);
  if (expectedImpl) {
    if (!web3.utils.isAddress(expectedImpl)) {
      result.warnings.push(`${target.expectedImplEnv} is not a valid address; skipped impl match`);
    } else {
      result.expectedImplementationMatch = eqAddr(result.implementationAddress, expectedImpl);
      if (!result.expectedImplementationMatch) {
        result.errors.push(`implementation ${result.implementationAddress} != expected ${expectedImpl}`);
      }
    }
  } else {
    result.warnings.push(`${target.expectedImplEnv} not set; implementation match not verified`);
  }

  // Getters (read-only eth_call, no `from` so the call hits the implementation, not the admin path)
  for (const g of target.getters) {
    const entry = { value: null, error: null };
    try {
      const data = web3.eth.abi.encodeFunctionSignature(g.signature);
      const raw = await web3.eth.call({ to: result.proxyAddress, data });
      if (raw && raw !== '0x') {
        entry.value = web3.eth.abi.decodeParameter(g.returnType, raw);
      } else {
        entry.error = 'empty return (function may not exist on this implementation)';
      }
    } catch (e) {
      entry.error = e.message;
    }
    result.getters[g.name] = entry;

    // Dependency cross-check
    if (g.expectedEnv && g.returnType === 'address' && entry.value) {
      const expectedDep = env(g.expectedEnv);
      if (expectedDep && web3.utils.isAddress(expectedDep)) {
        const match = eqAddr(entry.value, expectedDep);
        result.dependencyMatches[g.name] = { expectedEnv: g.expectedEnv, expected: expectedDep, actual: entry.value, match };
        if (!match) {
          result.errors.push(`${g.name} ${entry.value} != expected ${g.expectedEnv} ${expectedDep}`);
        }
      } else {
        result.dependencyMatches[g.name] = { expectedEnv: g.expectedEnv, expected: expectedDep || null, actual: entry.value, match: null };
        if (!expectedDep) result.warnings.push(`${g.expectedEnv} not set; ${g.name} dependency not verified`);
      }
    }
  }

  // Initialization state
  if (target.hasIsInitialized) {
    const g = result.getters['isInitialized'];
    result.initialized = g && g.error === null ? Boolean(g.value) : null;
    if (result.initialized === false) result.warnings.push('isInitialized() returned false');
    if (result.initialized === null) result.warnings.push('could not read isInitialized()');
  } else {
    // Governance: infer from validatorSetContract != zero
    const g = result.getters['validatorSetContract'];
    const vs = g && g.error === null ? g.value : null;
    result.initialized = vs ? !isZero(vs) : null;
    if (result.initialized === false) result.warnings.push('validatorSetContract is zero (looks uninitialized)');
    if (result.initialized === null) result.warnings.push('could not infer initialization (no validatorSetContract)');
  }

  // owner-only eth_call simulation: operational owner calling transferOwnership(owner).
  // Pure eth_call, never broadcast. Success => the owner is authorized through the proxy.
  const owner = result.operationalOwnerAddress;
  const admin = result.proxyAdminAddress;
  let transferData = null;
  try {
    transferData = web3.eth.abi.encodeFunctionCall(
      { name: 'transferOwnership', type: 'function', inputs: [{ name: 'newOwner', type: 'address' }] },
      [owner && !isZero(owner) ? owner : result.proxyAddress]
    );
  } catch (e) {
    result.warnings.push(`could not encode transferOwnership calldata: ${e.message}`);
  }

  if (transferData && owner && !isZero(owner)) {
    try {
      await web3.eth.call({ to: result.proxyAddress, from: owner, data: transferData });
      result.ownerCallCheck = 'pass';
    } catch (e) {
      result.ownerCallCheck = 'fail';
      result.ownerCallError = e.message; // preserve: some clients restrict eth_call `from`
    }
  } else {
    result.ownerCallCheck = 'skipped';
    if (isZero(owner)) result.ownerCallError = 'operational owner is zero';
  }

  // admin fallback block simulation: the proxy admin calls a PLAIN GETTER (not an onlyOwner
  // function) through the proxy. A non-admin can call this getter successfully (verified above),
  // so if the admin's call reverts it is unambiguously the transparent-proxy admin-block — not an
  // onlyOwner check. transferOwnership() must NOT be used here: it is onlyOwner, so an admin call
  // would revert on `msg.sender != owner` even without a fallback block, masking the real cause.
  const fallbackProbe = selectFallbackProbe(target, result);

  if (fallbackProbe && admin && !isZero(admin)) {
    const probeData = web3.eth.abi.encodeFunctionSignature(fallbackProbe.signature);

    try {
      await web3.eth.call({ to: result.proxyAddress, from: admin, data: probeData });
      result.adminFallbackBlockedCheck = 'fail';
      result.adminFallbackError =
        `admin call to ${fallbackProbe.signature} unexpectedly succeeded; fallback may not be blocked`;
    } catch (e) {
      result.adminFallbackBlockedCheck = 'pass';
      result.adminFallbackError = e.message;
    }

    result.adminFallbackProbe = fallbackProbe.signature;
  } else {
    result.adminFallbackBlockedCheck = 'skipped';

    if (!fallbackProbe) {
      result.adminFallbackError = 'no successful non-admin getter available for fallback probe';
      result.warnings.push('admin fallback block check skipped: no getter probe available');
    }

    if (isZero(admin)) {
      result.adminFallbackError = 'proxy admin is zero';
    }
  }

  result.status = decideStatus(result);
  return result;
}

function decideStatus(r) {
  // Hard failures
  if (r.proxyCodeSize === 0) return 'FAIL';
  if (r.implementationIsZero) return 'FAIL';
  if (r.implementationCodeSize === 0) return 'FAIL';
  if (r.ownerIsZero) return 'FAIL';
  if (r.adminEqualsOwner) return 'FAIL';
  if (r.expectedImplementationMatch === false) return 'FAIL';
  for (const k of Object.keys(r.dependencyMatches)) {
    if (r.dependencyMatches[k].match === false) return 'FAIL';
  }
  if (r.ownerCallCheck === 'fail') return 'FAIL';
  if (r.adminFallbackBlockedCheck === 'fail') return 'FAIL';

  // Warnings that do not undermine the core admin/owner separation
  let warn = false;
  if (r.adminIsZero) warn = true; // admin renounced or unset
  if (r.expectedImplementationMatch === null) warn = true;
  for (const k of Object.keys(r.dependencyMatches)) {
    if (r.dependencyMatches[k].match === null) warn = true;
  }
  if (r.warnings.length > 0) warn = true;
  // adminFallbackBlockedCheck skipped is only acceptable when admin is zero
  if (r.adminFallbackBlockedCheck === 'skipped' && !r.adminIsZero) warn = true;

  return warn ? 'WARN' : 'OK';
}

// -----------------------------------------------------------------------------
// Reporting
// -----------------------------------------------------------------------------
function printTable(results) {
  const rows = results.map(r => ({
    Contract: r.label,
    Proxy: shorten(r.proxyAddress, 8, 6),
    Implementation: shorten(r.implementationAddress, 8, 6),
    'Proxy Admin': shorten(r.proxyAdminAddress, 8, 6),
    'Operational Owner': shorten(r.operationalOwnerAddress, 8, 6),
    'Admin != Owner': r.adminDiffersFromOwner === null ? '?' : (r.adminDiffersFromOwner ? 'yes' : 'NO'),
    'Impl Code Hash': shorten(r.implementationCodeHash, 8, 4),
    'Proxy Code Hash': shorten(r.proxyCodeHash, 8, 4),
    Status: r.status,
  }));
  // Fallback to console.table for alignment.
  console.log('');
  console.table(rows);
}

function toMarkdown(report) {
  const lines = [];
  lines.push('# KONET On-chain Evidence Report');
  lines.push('');
  lines.push(`- Generated at block: ${report.blockNumber}`);
  lines.push(`- Chain id: ${report.chainId}${report.chainIdMatch === false ? ' (MISMATCH vs expected ' + report.expectedChainId + ')' : ''}`);
  lines.push(`- Source commit: ${report.sourceCommit || '(unset)'}`);
  lines.push(`- Summary: total ${report.summary.total}, OK ${report.summary.OK}, WARN ${report.summary.WARN}, FAIL ${report.summary.FAIL}`);
  lines.push('');
  lines.push('| Contract | Proxy | Implementation | Proxy Admin | Operational Owner | Admin != Owner | Impl Code Hash | Proxy Code Hash | Status |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of report.targets) {
    lines.push(`| ${r.label} | ${r.proxyAddress || '-'} | ${r.implementationAddress || '-'} | ${r.proxyAdminAddress || '-'} | ${r.operationalOwnerAddress || '-'} | ${r.adminDiffersFromOwner === null ? '?' : (r.adminDiffersFromOwner ? 'yes' : 'NO')} | ${r.implementationCodeHash || '-'} | ${r.proxyCodeHash || '-'} | ${r.status} |`);
  }
  lines.push('');
  lines.push('## Per-contract detail');
  for (const r of report.targets) {
    lines.push('');
    lines.push(`### ${r.label} (${r.key})`);
    lines.push(`- status: **${r.status}**`);
    lines.push(`- initialized: ${r.initialized}`);
    lines.push(`- ownerCallCheck: ${r.ownerCallCheck}`);
    lines.push(`- adminFallbackBlockedCheck: ${r.adminFallbackBlockedCheck}`);
    lines.push(`- adminFallbackProbe: ${r.adminFallbackProbe || '-'}`);
    if (r.warnings.length) lines.push(`- warnings: ${r.warnings.join('; ')}`);
    if (r.errors.length) lines.push(`- errors: ${r.errors.join('; ')}`);
  }
  lines.push('');
  lines.push('> Read-only evidence for CON-01 / GLOBAL-01 source-level mitigation. This report does');
  lines.push('> not claim any CertiK finding is resolved; final status is decided by CertiK.');
  lines.push('');
  return lines.join('\n');
}

function writeIfRequested(report) {
  const jsonPath = env('KONET_EVIDENCE_OUTPUT_JSON');
  const mdPath = env('KONET_EVIDENCE_OUTPUT_MD');
  if (jsonPath) {
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    console.log(`Wrote JSON evidence: ${jsonPath}`);
  }
  if (mdPath) {
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, toMarkdown(report));
    console.log(`Wrote Markdown evidence: ${mdPath}`);
  }
}

// -----------------------------------------------------------------------------
// Core runner
// -----------------------------------------------------------------------------
async function run(web3) {
  loadDotEnv();

  const ownerSlot = slotMinusOne(web3, 'konet.proxy.owner');
  console.log('Storage slots:');
  console.log(`  ADMIN_SLOT          : ${ADMIN_SLOT}`);
  console.log(`  IMPLEMENTATION_SLOT : ${IMPLEMENTATION_SLOT}`);
  console.log(`  OWNER_SLOT          : ${ownerSlot}  (keccak256("konet.proxy.owner") - 1)`);

  let chainId = null;
  try {
    chainId = await web3.eth.getChainId();
  } catch (e) {
    try { chainId = await web3.eth.net.getId(); } catch (e2) { /* leave null */ }
  }
  let blockNumber = null;
  try { blockNumber = await web3.eth.getBlockNumber(); } catch (e) { /* leave null */ }

  const expectedChainId = env('KONET_EXPECTED_CHAIN_ID');
  const chainIdMatch = expectedChainId ? (String(chainId) === String(expectedChainId)) : null;
  console.log(`\nChain id: ${chainId}${chainIdMatch === false ? ' (MISMATCH: expected ' + expectedChainId + ')' : ''}`);
  console.log(`Block number: ${blockNumber}`);

  // Evidence integrity: querying the wrong chain would produce misleading results. Abort hard.
  if (expectedChainId && String(chainId) !== String(expectedChainId)) {
    throw new Error(`chainId mismatch: expected ${expectedChainId}, got ${chainId}`);
  }

  const targets = [];
  for (const t of TARGETS) {
    // Sequential to keep RPC pressure low and output deterministic.
    // eslint-disable-next-line no-await-in-loop
    const r = await inspectTarget(web3, ownerSlot, t);
    targets.push(r);
  }

  printTable(targets);

  const summary = { total: targets.length, OK: 0, WARN: 0, FAIL: 0 };
  for (const r of targets) summary[r.status] = (summary[r.status] || 0) + 1;
  console.log(`\nTotal targets: ${summary.total}`);
  console.log(`OK: ${summary.OK}`);
  console.log(`WARN: ${summary.WARN}`);
  console.log(`FAIL: ${summary.FAIL}`);

  const report = {
    generatedAtBlock: blockNumber,
    blockNumber,
    chainId: chainId === null ? null : String(chainId),
    expectedChainId: expectedChainId || null,
    chainIdMatch,
    sourceCommit: env('KONET_SOURCE_COMMIT') || null,
    slots: { ADMIN_SLOT, IMPLEMENTATION_SLOT, OWNER_SLOT: ownerSlot },
    summary,
    targets,
  };

  writeIfRequested(report);

  // Print per-contract warnings/errors for quick reading.
  for (const r of targets) {
    if (r.warnings.length || r.errors.length) {
      console.log(`\n[${r.label}] status=${r.status}`);
      for (const w of r.warnings) console.log(`  ! ${w}`);
      for (const e of r.errors) console.log(`  x ${e}`);
    }
  }

  return report;
}

// -----------------------------------------------------------------------------
// Entry points
// -----------------------------------------------------------------------------

// truffle exec entry point (uses the injected global `web3`).
module.exports = async function (callback) {
  try {
    // eslint-disable-next-line no-undef
    const w3 = (typeof web3 !== 'undefined') ? web3 : null;
    if (!w3) {
      throw new Error('No web3 available. Run via `truffle exec` or set KONET_RPC_URL for standalone.');
    }
    await run(w3);
    return callback();
  } catch (err) {
    return callback(err);
  }
};

// Standalone entry point: `KONET_RPC_URL=... node scripts/inspect_konet_onchain_evidence.js`
if (require.main === module) {
  (async () => {
    loadDotEnv();
    const url = env('KONET_RPC_URL');
    if (!url) {
      console.error('Standalone mode requires KONET_RPC_URL. Alternatively run via: npx truffle exec ' +
        'scripts/inspect_konet_onchain_evidence.js --network konet');
      process.exit(1);
    }
    let Web3;
    try {
      Web3 = require('web3');
    } catch (e) {
      console.error('Could not require("web3") for standalone mode. Use `truffle exec` instead.');
      process.exit(1);
    }
    const web3 = new Web3(new Web3.providers.HttpProvider(url));
    try {
      await run(web3);
      process.exit(0);
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  })();
}

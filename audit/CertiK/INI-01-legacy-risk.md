# CertiK INI-01 — Legacy Platform Risk

## Finding

| Field | Value |
|-------|-------|
| ID | INI-01 |
| Title | Deploying the Forked Project on Archived Platform |
| Severity | Informational |
| Status | Acknowledged |
| Location | `contracts/InitializerAuRa.sol` |

This document records the position on CertiK finding INI-01. INI-01 is an
informational, acknowledged finding about the platform the forked POSDAO
codebase targets. It is **not** a code-level bug and is not something a
short-term source patch can close. It is tracked here as a legacy platform risk
that is managed through operational controls and a modernization roadmap.

## Risk acknowledgement

The following risks are explicitly acknowledged:

- **Legacy POSDAO codebase.** This repository is a fork of the POSDAO
  contracts and inherits the design, assumptions, and constraints of that
  legacy codebase.
- **Archived execution platform.** The contracts were designed to run on
  OpenEthereum (formerly Parity Ethereum). OpenEthereum is archived and no
  longer actively maintained, which is a standing platform-level risk.
- **Legacy Solidity compiler.** The contracts are pinned to Solidity 0.5.10.
  This is an old compiler line that no longer receives fixes or improvements,
  and carries the usual risks of running on an unmaintained toolchain.
- **Client / consensus compatibility.** POSDAO relies on client-specific
  behavior — zero-gas service transactions, validator-set service transactions,
  and other POSDAO client integration points. Correct operation depends on the
  underlying client honoring these assumptions.

These risks are platform- and lifecycle-level. They are not defects that a
targeted code change can "fix," and this document does not claim they are
resolved by code.

## Why this is not patched directly

INI-01 is deliberately **not** addressed by an in-place code patch in this maintenance change:

- A naive `pragma` bump (e.g. moving 0.5.10 → a newer Solidity line) is **not**
  a safe, isolated change. Compiler-version changes can alter generated code and
  semantics.
- Such a change can affect **storage layout**, **ABI**, **genesis
  initialization**, **validator-set logic**, **staking logic**, and **POSDAO
  client behavior** that depends on the exact deployed bytecode and interfaces.
- For an upgradeable, consensus-critical system, any of those shifts can break
  running networks or invalidate existing state.

For these reasons, modernization must be handled as a **separate, dedicated
migration project** with its own review and testing, not as a side effect of an
audit-remediation change.

## Current operational mitigation

Until a full migration is undertaken, INI-01 is managed operationally:

- The repository is maintained as a **POSDAO compatibility maintenance line**,
  preserving compatibility with the existing POSDAO client and network behavior.
- **Consensus-sensitive changes are avoided** unless strictly necessary, to
  reduce the risk of divergence from established network behavior.
- **Compile and targeted regression tests** are kept working so that intended,
  scoped changes remain verifiable.
- **Audit remediation and long-term modernization are kept separate.** Source-
  level mitigations for CON-01 / GLOBAL-01 were completed independently of the
  platform-modernization question raised by INI-01.
- **Client compatibility assumptions are documented** so that the platform
  dependency is explicit rather than implicit.

## Future modernization roadmap

A future modernization effort, tracked separately from audit remediation, is
expected to cover:

- Reducing the dependency on the archived OpenEthereum client.
- Verifying POSDAO compatibility on a maintained client (e.g. Nethermind).
- Evaluating migration to Solidity 0.8.x.
- Reviewing storage layout for compatibility across any compiler/implementation
  changes.
- Reviewing proxy upgrade safety.
- Running a full regression test suite.
- Testnet deployment and validation before any production change.
- A rollback / contingency plan for the migration.

## Status position

- INI-01 is managed as an **acknowledged legacy platform risk**.
- CON-01 / GLOBAL-01 source-level mitigation has been completed; INI-01 is a
  distinct, platform-lifecycle concern and is handled through operational
  controls and the modernization roadmap above.
- This document does **not** claim INI-01 is fixed, resolved, or fully mitigated
  by code. CertiK must decide whether to update the finding status; until then
  INI-01 remains an acknowledged legacy platform risk.

# KONET 배포 절차서

## 1. 문서 목적

이 문서는 이미 블록이 진행 중인 KONET 테스트넷에 POSDAO contract set 을 배포하기 위한
운영 절차서다.

- genesis 배포 문서가 아니다.
- 기존 proxy upgrade 문서도 아니다.

운영자가 `scripts/deploy_for_konet.js` 로 컨트랙트를 배포하고,
`scripts/inspect_konet_onchain_evidence.js` 로 배포 결과를 검증하는 순서를 정리한다.
전체 흐름은 **dry-run → execute → evidence 조회** 순이다.

## 2. 현재 지원 범위

현재 `scripts/deploy_for_konet.js` 가 지원하는 범위:

- POSDAO contract set 배포
- implementation 배포
- `AdminUpgradeabilityProxy` 배포
- proxy admin 의 `upgradeToAndCall` 로 initialize 실행
- deployment output 으로 proxy 주소 출력
- 배포 후 inspect script 로 admin / owner / implementation / code hash 확인

반드시 명시:

- 현재 `deploy_for_konet.js` 는 기존 proxy upgrade 를 지원하지 않는다.
- 이미 initialized 된 기존 proxy 에 initialize 를 다시 호출하는 용도로 사용하지 않는다.

## 3. 이 가이드가 다루지 않는 것

- genesis/spec 기반 체인 초기 배포
- 기존 proxy upgrade
- 기존 proxy 의 admin-owner migration
- mainnet 실제 배포
- Nethermind POSDAO compatibility 검증
- Solidity 0.8.x migration

## 4. 왜 deploy_for_xdai.js 를 쓰지 않는가

- 기존 `deploy_for_xdai.js` 는 legacy one-off live-chain script 다.
- 단일 owner 가 proxy admin / operational owner / tx signer 역할을 모두 겸하는 구조다.
- UPG-01 이후 transparent proxy 는 proxy admin 의 implementation fallback 호출을 차단한다.
- 따라서 proxy admin 이 proxy fallback 을 통해 `initialize()` 를 직접 호출하면 revert 될 수
  있다.
- issue2 이후 owner-managed initializer 는 `_owner != _admin()` 을 요구하므로 admin == owner
  구조도 맞지 않는다.
- 따라서 live chain 배포는 `deploy_for_konet.js` 를 사용한다.

## 5. InitializerAuRa 를 live chain 에서 쓰지 않는 이유

- `InitializerAuRa` 는 genesis initialization path 에 적합하다.
- 이미 `block.number > 0` 인 live chain 에서는 각 initializer 의
  `require(block.number == 0 || msg.sender == _admin())` 조건을 만족해야 한다.
- `InitializerAuRa` 가 proxy fallback 으로 initialize 를 호출하면 `msg.sender` 는
  `InitializerAuRa` 가 되므로 proxy admin 이 아니다.
- proxy admin 이 직접 fallback 으로 initialize 를 호출하는 것도 transparent proxy
  admin-block 때문에 막힌다.
- 따라서 live chain 배포에서는 `InitializerAuRa` 를 사용하지 않고, proxy admin 의
  `upgradeToAndCall` 로 initialize 한다.

혼동 방지를 위해:

- 체인이 이미 돌고 있어도 컨트랙트 배포는 가능하다.
- 문제는 컨트랙트를 못 올린다는 뜻이 아니라, genesis 용 초기화 방식을 그대로 쓰면 안 된다는
  뜻이다.

## 6. 배포 구조 요약

대상 컨트랙트:

```text
ValidatorSetAuRa
BlockRewardAuRa
RandomAuRa
StakingAuRa
TxPermission
Certifier
Governance
```

배포 흐름:

```text
1. implementation 7개 배포 (deployer private key 로 서명)
2. AdminUpgradeabilityProxy 7개 배포 (constructor 에 각 real implementation 을 넣는다)
3. proxy admin이 각 proxy에 upgradeToAndCall(realImplementation, initializeCalldata) 호출
4. operational owner를 owner-managed contracts의 _owner로 주입
5. 배포 후 evidence 조회
```

proxy constructor 에 real implementation 을 넣는 이유: fresh POSDAO set 은 초기화 시점에
컨트랙트 간 상호 호출(circular dependency)이 있다. `ValidatorSetAuRa.initialize` 는
StakingAuRa proxy 의 `getDelegatorPoolsLength` 를 호출하고, `StakingAuRa.initialize` 는
ValidatorSetAuRa 의 `idByStakingAddress` 를 읽는다. 따라서 어떤 initialize 가 실행되기 전에
모든 proxy 가 이미 real code 를 노출하고 있어야 한다. 이 repo 의 proxy
(`BaseUpgradeabilityProxy`) 는 동일 implementation 으로의 upgrade 를 허용하므로, real impl 로
proxy 를 만든 뒤 `upgradeToAndCall(realImpl, initCalldata)` 로 in-place 초기화하면 된다.
별도의 placeholder implementation 은 필요하지 않다.

역할 분리:

```text
deployer: implementation/proxy 배포 tx signer (KONET_DEPLOYER_PRIVATE_KEY 로 서명)
proxy admin: upgradeToAndCall 실행 주체 (KONET_PROXY_ADMIN_PRIVATE_KEY 로 서명)
operational owner: onlyOwner 운영 함수 담당 (배포 단계에서는 tx 를 보내지 않음)
```

서명 방식:

```text
- script 는 .env 의 private key 로 raw transaction 을 직접 sign/send 한다.
- 노드 keystore / unlocked account / provider-managed account 에 의존하지 않는다.
- 테스트넷 RPC 는 단순 HTTP RPC (예: https://testkonet.de-app.com) 면 충분하다.
- private key 에서 복원한 주소는 반드시 해당 role 주소와 일치해야 한다. 불일치 시 중단한다.
- operational owner 는 initialize 의 _owner 값일 뿐이며, private key 를 넣지 않는다.
```

반드시 명시:

```text
KONET_PROXY_ADMIN != KONET_OPERATIONAL_OWNER
```

## 7. 사전 준비물

- [ ] 테스트넷 RPC URL (단순 HTTP RPC, 예: `https://testkonet.de-app.com`)
- [ ] 테스트넷 chainId
- [ ] deployer 주소 + `KONET_DEPLOYER_PRIVATE_KEY`
- [ ] proxy admin 주소 + `KONET_PROXY_ADMIN_PRIVATE_KEY`
- [ ] operational owner 주소 (private key 불필요)
- [ ] deployer 계정에 충분한 native token
- [ ] proxy admin 계정에 충분한 native token
- [ ] initial mining addresses
- [ ] initial staking addresses
- [ ] staking parameters
- [ ] random parameters
- [ ] TxPermission allowed addresses
- [ ] Certifier certified addresses
- [ ] previous BlockReward address (이전 BlockReward 가 없으면 zero address 명시)
- [ ] `npm run compile` (standalone node 실행 시 build artifact 필요)

signer 관련 주의:

- script 는 `.env` 의 private key 로 raw transaction 을 직접 서명해서 보낸다. 노드에
  keystore/unlocked account 가 있을 필요가 없다.
- `KONET_DEPLOYER_PRIVATE_KEY` 는 implementation/proxy 배포 tx 서명에 사용한다.
- `KONET_PROXY_ADMIN_PRIVATE_KEY` 는 `upgradeToAndCall` tx 서명에 사용한다.
- 각 private key 에서 복원한 주소가 role 주소(`KONET_DEPLOYER` / `KONET_PROXY_ADMIN`)와
  일치해야 한다. 불일치하면 script 가 중단한다.
- `KONET_DEPLOYER == KONET_PROXY_ADMIN` 이면 두 private key 값이 같을 수 있다.
- operational owner 는 배포 단계에서 tx 를 보내지 않으므로 private key 가 필요 없다.
  `KONET_OPERATIONAL_OWNER_PRIVATE_KEY` 같은 값은 추가하지 않는다.
- private key 는 절대 로그로 출력되지 않으며, `.env` 는 gitignore 대상이라 커밋하지 않는다.

## 8. .env 설정

`.env.example` 의 배포 입력값(A 섹션) 을 기준으로 값을 채운다.

```dotenv
KONET_RPC_URL=https://testkonet.de-app.com
KONET_DEPLOY_MODE=fresh-proxy
KONET_EXECUTE=false
KONET_EXPECTED_CHAIN_ID=

KONET_DEPLOYER=0x...
KONET_PROXY_ADMIN=0x...
KONET_OPERATIONAL_OWNER=0x...

# signing keys - 실제 값은 커밋하지 않는다 (.env 는 gitignore 대상)
KONET_DEPLOYER_PRIVATE_KEY=
KONET_PROXY_ADMIN_PRIVATE_KEY=

KONET_INITIAL_MINING_ADDRESSES=0x...,0x...
KONET_INITIAL_STAKING_ADDRESSES=0x...,0x...
KONET_FIRST_VALIDATOR_IS_UNREMOVABLE=false

KONET_DELEGATOR_MIN_STAKE=
KONET_CANDIDATE_MIN_STAKE=
KONET_STAKING_EPOCH_DURATION=
KONET_STAKING_EPOCH_START_BLOCK=
KONET_STAKE_WITHDRAW_DISALLOW_PERIOD=

KONET_COLLECT_ROUND_LENGTH=
KONET_PUNISH_FOR_UNREVEAL=true

KONET_ALLOWED_ADDRESSES=
KONET_CERTIFIED_ADDRESSES=

KONET_PREV_BLOCK_REWARD=0x0000000000000000000000000000000000000000
```

주의:

- `KONET_PREV_BLOCK_REWARD` 는 자동 default 로 처리하지 않는다.
- 이전 BlockReward 가 없으면 zero address 를 명시적으로 입력한다.
- `.env` 는 gitignore 대상이며 커밋하지 않는다. private key 값은 `.env` 에만 넣는다.
- `.env.example` 에는 실제 private key 를 넣지 않는다 (빈 값만 둔다).

## 9. Dry-run 실행

standalone node (권장, 단순 HTTP RPC + private key signing):

```bash
npm run compile

KONET_RPC_URL=https://testkonet.de-app.com \
KONET_EXECUTE=false \
node scripts/deploy_for_konet.js
```

또는 truffle exec (더 이상 unlocked account 에 의존하지 않는다):

```bash
KONET_RPC_URL=https://testkonet.de-app.com \
npx truffle exec scripts/deploy_for_konet.js --network development
```

설명:

- dry-run 은 트랜잭션을 보내지 않는다.
- role validation, required input validation, deployment plan 을 확인한다.
- private key 가 제공된 경우, 복원 주소와 role 주소의 일치 여부도 함께 보고한다.
- `KONET_RPC_URL` 이 설정되어 있으면 truffle exec 에서도 그 RPC 를 명시적으로 사용한다.

## 10. Dry-run 결과 확인 항목

| 항목 | 기대값 | 실패 시 조치 |
|---|---|---|
| deploy mode | `fresh-proxy` | `.env` 수정 |
| execute mode | false | dry-run 상태 유지 |
| chainId | expected 와 일치 | network config 확인 |
| proxy admin != operational owner | true | 주소 재설정 |
| initial mining/staking length | 동일 | 초기 validator 주소 확인 |
| missing inputs | 없음 | `.env` 보완 |
| signer keys | deployer/proxy admin private key 주소가 role 과 일치 | private key 재확인 |

## 11. 테스트넷 배포 실행

standalone node:

```bash
KONET_RPC_URL=https://testkonet.de-app.com \
KONET_EXECUTE=true \
node scripts/deploy_for_konet.js
```

또는 truffle exec:

```bash
KONET_RPC_URL=https://testkonet.de-app.com \
KONET_EXECUTE=true \
npx truffle exec scripts/deploy_for_konet.js --network development
```

반드시 주의:

- dry-run 이 모두 통과하기 전에는 실행하지 않는다.
- `KONET_EXECUTE=true` 는 테스트넷에서만 사용한다.
- execute mode 는 `KONET_DEPLOYER_PRIVATE_KEY` 와 `KONET_PROXY_ADMIN_PRIVATE_KEY` 를 요구하며,
  각 key 의 복원 주소가 role 주소와 일치해야 한다.
- mainnet chainId 에서는 `KONET_ALLOW_MAINNET_EXECUTE=true` 없이는 실행되어서는 안 된다.

## 12. 배포 후 출력값 정리

script 가 출력하는 proxy 주소를 `.env` 또는 별도 운영 문서에 저장한다.

```dotenv
KONET_VALIDATOR_SET_PROXY=0x...
KONET_BLOCK_REWARD_PROXY=0x...
KONET_RANDOM_PROXY=0x...
KONET_STAKING_PROXY=0x...
KONET_TX_PERMISSION_PROXY=0x...
KONET_CERTIFIER_PROXY=0x...
KONET_GOVERNANCE_PROXY=0x...
```

주의:

- 배포 결과 주소는 evidence 조회에 필요하다.
- `reports/` 또는 `docs/generated/` 에 생성되는 결과 파일은 gitignore 대상이며 커밋하지
  않는다.

## 13. 배포 후 on-chain evidence 조회

```bash
npx truffle exec scripts/inspect_konet_onchain_evidence.js --network konet
```

또는:

```bash
KONET_RPC_URL=http://... node scripts/inspect_konet_onchain_evidence.js
```

확인 항목:

```text
- proxy has code
- implementation has code
- EIP-1967 implementation slot
- EIP-1967 admin slot
- owner slot
- proxy admin != operational owner
- owner-only eth_call simulation
- admin fallback block simulation
- dependency getter values
```

## 14. 성공 기준

- 모든 implementation/proxy 배포 완료
- 모든 initialize tx 성공
- proxy admin != operational owner
- owner slot == `KONET_OPERATIONAL_OWNER`
- admin slot == `KONET_PROXY_ADMIN`
- implementation slot == deployed implementation
- admin fallback getter call revert
- operational owner onlyOwner eth_call pass
- evidence inspector 결과 OK 또는 설명 가능한 WARN 만 존재

## 15. 실패 시 중단 기준

아래 중 하나라도 발생하면 중단한다.

- chainId mismatch
- `KONET_PROXY_ADMIN == KONET_OPERATIONAL_OWNER`
- deployer/proxy admin private key 누락 또는 role 주소와 불일치
- initial mining/staking address length mismatch
- missing required env
- `upgradeToAndCall` 실패
- initialize 실패
- owner slot mismatch
- admin == owner
- implementation slot mismatch
- evidence inspector FAIL

## 16. 절대 하면 안 되는 것

- deploy_for_xdai.js 사용 금지
- InitializerAuRa를 live chain 배포에 사용 금지
- proxy fallback 으로 initialize 직접 호출 금지
- proxy admin 과 operational owner 를 같은 주소로 설정 금지
- dry-run 없이 `KONET_EXECUTE=true` 실행 금지
- 테스트넷 검증 없이 mainnet 실행 금지
- private key / mnemonic 을 repo 에 저장 금지
- `reports/` 또는 `docs/generated/` 결과 파일 커밋 금지

## 17. 메인넷 적용 전 추가 확인

- 테스트넷 배포 성공
- 테스트넷 evidence inspector 결과 OK
- 배포 주소표 정리
- proxy admin 운영 주체 확인
- proxy admin multisig/timelock 적용 여부 검토
- operational owner 운영 주체 확인
- rollback plan 준비
- CertiK / 거래소 공유용 수정내역 리포트 작성
- mainnet chainId safety gate 확인

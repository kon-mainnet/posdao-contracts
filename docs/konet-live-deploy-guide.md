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
1. implementation 7개 배포
2. AdminUpgradeabilityProxy 7개 배포
3. proxy admin이 각 proxy에 upgradeToAndCall(implementation, initializeCalldata) 호출
4. operational owner를 owner-managed contracts의 _owner로 주입
5. 배포 후 evidence 조회
```

역할 분리:

```text
deployer: implementation/proxy 배포 tx signer
proxy admin: upgradeToAndCall 실행 주체
operational owner: onlyOwner 운영 함수 담당
```

반드시 명시:

```text
KONET_PROXY_ADMIN != KONET_OPERATIONAL_OWNER
```

## 7. 사전 준비물

- [ ] 테스트넷 RPC URL
- [ ] 테스트넷 chainId
- [ ] deployer 계정
- [ ] proxy admin 계정
- [ ] operational owner 주소
- [ ] deployer 계정에 충분한 native token
- [ ] proxy admin 계정에 충분한 native token
- [ ] initial mining addresses
- [ ] initial staking addresses
- [ ] staking parameters
- [ ] random parameters
- [ ] TxPermission allowed addresses
- [ ] Certifier certified addresses
- [ ] previous BlockReward address (이전 BlockReward 가 없으면 zero address 명시)

signer 관련 주의:

- `KONET_DEPLOYER` 와 `KONET_PROXY_ADMIN` 이 다르면 provider 가 두 계정 모두 서명할 수 있어야
  한다.
- proxy admin 은 `upgradeToAndCall` tx 를 보내야 하므로, 테스트넷 provider 에서 해당 계정이
  unlocked 되어 있거나 서명 가능해야 한다.

## 8. .env 설정

`.env.example` 의 배포 입력값(A 섹션) 을 기준으로 값을 채운다.

```dotenv
KONET_DEPLOY_MODE=fresh-proxy
KONET_EXECUTE=false
KONET_EXPECTED_CHAIN_ID=

KONET_PROXY_ADMIN=0x...
KONET_OPERATIONAL_OWNER=0x...
KONET_DEPLOYER=0x...

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
- `.env` 는 gitignore 대상이며 커밋하지 않는다. private key / mnemonic 을 넣지 않는다.

## 9. Dry-run 실행

```bash
npx truffle exec scripts/deploy_for_konet.js --network konet
```

또는:

```bash
KONET_EXECUTE=false npx truffle exec scripts/deploy_for_konet.js --network konet
```

설명:

- dry-run 은 트랜잭션을 보내지 않는다.
- role validation, required input validation, deployment plan 을 확인한다.

## 10. Dry-run 결과 확인 항목

| 항목 | 기대값 | 실패 시 조치 |
|---|---|---|
| deploy mode | `fresh-proxy` | `.env` 수정 |
| execute mode | false | dry-run 상태 유지 |
| chainId | expected 와 일치 | network config 확인 |
| proxy admin != operational owner | true | 주소 재설정 |
| initial mining/staking length | 동일 | 초기 validator 주소 확인 |
| missing inputs | 없음 | `.env` 보완 |
| signer availability | deployer/proxy admin 사용 가능 | provider/unlocked account 확인 |

## 11. 테스트넷 배포 실행

```bash
KONET_EXECUTE=true npx truffle exec scripts/deploy_for_konet.js --network konet
```

반드시 주의:

- dry-run 이 모두 통과하기 전에는 실행하지 않는다.
- `KONET_EXECUTE=true` 는 테스트넷에서만 사용한다.
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
- deployer/proxy admin signer 사용 불가
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

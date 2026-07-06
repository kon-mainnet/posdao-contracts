pragma solidity 0.5.10;

import "./interfaces/IBlockRewardAuRa.sol";
import "./interfaces/ICertifier.sol";
import "./interfaces/IGovernance.sol";
import "./interfaces/IRandomAuRa.sol";
import "./interfaces/IStakingAuRa.sol";
import "./interfaces/ITxPermission.sol";
import "./interfaces/IValidatorSetAuRa.sol";



/// @dev Used once on network startup and then destroyed.
/// Needed for initializing upgradeable contracts since
/// upgradeable contracts can't have constructors.
contract InitializerAuRa {
    /// @param _contracts An array of the contracts:
    ///   0 is ValidatorSetAuRa,
    ///   1 is BlockRewardAuRa,
    ///   2 is RandomAuRa,
    ///   3 is StakingAuRa,
    ///   4 is TxPermission,
    ///   5 is Certifier,
    ///   6 is Governance.
    /// @param _owner The contracts' owner.
    /// @param _miningAddresses The array of initial validators' mining addresses.
    /// @param _stakingAddresses The array of initial validators' staking addresses.
    /// @param _firstValidatorIsUnremovable The boolean flag defining whether the first validator in the
    /// `_miningAddresses/_stakingAddresses` array is non-removable.
    /// Should be `false` for production network.
    /// @param _delegatorMinStake The minimum allowed amount of delegator stake in Wei
    /// (see the `StakingAuRa` contract).
    /// @param _candidateMinStake The minimum allowed amount of candidate stake in Wei
    /// (see the `StakingAuRa` contract).
    /// @param _stakingEpochDuration The duration of a staking epoch in blocks
    /// (e.g., 120954 = 1 week for 5-seconds blocks in AuRa).
    /// @param _stakingEpochStartBlock The number of the first block of initial staking epoch
    /// (must be zero if the network is starting from genesis block).
    /// @param _stakeWithdrawDisallowPeriod The duration period (in blocks) at the end of a staking epoch
    /// during which participants cannot stake or withdraw their staking tokens
    /// (e.g., 4320 = 6 hours for 5-seconds blocks in AuRa).
    /// @param _collectRoundLength The length of a collection round in blocks (see the `RandomAuRa` contract).
    constructor(
        address[] memory _contracts,
        address _owner,
        address[] memory _miningAddresses,
        address[] memory _stakingAddresses,
        bool _firstValidatorIsUnremovable,
        uint256 _delegatorMinStake,
        uint256 _candidateMinStake,
        uint256 _stakingEpochDuration,
        uint256 _stakingEpochStartBlock,
        uint256 _stakeWithdrawDisallowPeriod,
        uint256 _collectRoundLength
    ) public {
        IValidatorSetAuRa(_contracts[0]).initialize(
            _contracts[1], // _blockRewardContract
            _contracts[6], // _governanceContract
            _contracts[2], // _randomContract
            _contracts[3], // _stakingContract
            _miningAddresses,
            _stakingAddresses,
            _firstValidatorIsUnremovable
        );
        // Extracted into a private function (and the numeric params packed into a fixed array)
        // to keep the stack within Solidity 0.5.x limits after adding the operational owner arg.
        uint256[5] memory _stakingParams;
        _stakingParams[0] = _delegatorMinStake;
        _stakingParams[1] = _candidateMinStake;
        _stakingParams[2] = _stakingEpochDuration;
        _stakingParams[3] = _stakingEpochStartBlock;
        _stakingParams[4] = _stakeWithdrawDisallowPeriod;
        _initStaking(_contracts, _owner, _stakingAddresses, _stakingParams);
        // Remaining initializations are extracted to keep the constructor's stack within limits.
        _initOthers(_contracts, _owner, _collectRoundLength);
        if (block.number > 0) {
            selfdestruct(msg.sender); // this is to clear the state
            // OpenEthereum and Nethermind clients
            // behave differently for SELFDESTRUCT on genesis block
            // (see https://github.com/openethereum/openethereum/issues/184)
            // so we call `selfdestruct` here only if we are not in genesis
        }
    }

    /// @param _stakingParams Packed numeric parameters:
    ///   [0] _delegatorMinStake, [1] _candidateMinStake, [2] _stakingEpochDuration,
    ///   [3] _stakingEpochStartBlock, [4] _stakeWithdrawDisallowPeriod.
    function _initStaking(
        address[] memory _contracts,
        address _owner,
        address[] memory _stakingAddresses,
        uint256[5] memory _stakingParams
    ) private {
        uint256[] memory _ids = new uint256[](_stakingAddresses.length);
        for (uint256 i = 0; i < _ids.length; i++) {
            _ids[i] = IValidatorSetAuRa(_contracts[0]).idByStakingAddress(_stakingAddresses[i]);
        }
        IStakingAuRa(_contracts[3]).initialize(
            _contracts[0], // _validatorSetContract
            _contracts[6], // _governanceContract
            _ids,
            _stakingParams[0],
            _stakingParams[1],
            _stakingParams[2],
            _stakingParams[3],
            _stakingParams[4],
            _owner
        );
    }

    function _initOthers(
        address[] memory _contracts,
        address _owner,
        uint256 _collectRoundLength
    ) private {
        IBlockRewardAuRa(_contracts[1]).initialize(_contracts[0], address(0), _owner);
        IRandomAuRa(_contracts[2]).initialize(_collectRoundLength, _contracts[0], true, _owner);
        address[] memory permittedAddresses = new address[](1);
        permittedAddresses[0] = _owner;
        ITxPermission(_contracts[4]).initialize(permittedAddresses, _contracts[5], _contracts[0], _owner);
        ICertifier(_contracts[5]).initialize(permittedAddresses, _contracts[0], _owner);
        IGovernance(_contracts[6]).initialize(_contracts[0], _owner);
    }
}

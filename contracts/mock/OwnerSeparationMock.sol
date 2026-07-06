pragma solidity 0.5.10;

import "../upgradeability/UpgradeableOwned.sol";


/// @dev Minimal harness to unit-test the interaction between the transparent proxy
/// admin-block (UpgradeabilityProxy) and the operational owner (UpgradeableOwned).
/// Not part of the production system.
contract OwnerSeparationMock is UpgradeableOwned {
    uint256 public actionCount;
    bool private _initialized;

    /// @dev Mirrors the production initialize guard: the operational owner must be a
    /// non-zero address and must differ from the proxy admin.
    function initialize(address _owner) external {
        require(!_initialized);
        _initialized = true;
        require(_owner != address(0));
        require(_owner != _admin());
        _setOwner(_owner);
    }

    function owner() external view returns (address) {
        return _owner();
    }

    function admin() external view returns (address) {
        return _admin();
    }

    function ownerAction() external onlyOwner {
        actionCount++;
    }
}

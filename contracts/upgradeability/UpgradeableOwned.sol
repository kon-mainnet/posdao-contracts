pragma solidity 0.5.10;

import "./UpgradeabilityAdmin.sol";


contract UpgradeableOwned is UpgradeabilityAdmin {

    // WARNING: since this contract is upgradeable, do not remove
    // existing storage variables, do not change their order,
    // and do not change their types!

    /// @dev Storage slot for the operational owner address, separate from the proxy admin slot.
    /// Value: keccak256("konet.proxy.owner") - 1
    bytes32 internal constant OWNER_SLOT =
        bytes32(uint256(keccak256("konet.proxy.owner")) - 1);

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /// @dev Access check: revert unless `msg.sender` is the owner of the contract.
    modifier onlyOwner() {
        require(msg.sender == _owner(), "UpgradeableOwned: caller is not the owner");
        _;
    }

    /// @dev Returns the current operational owner address.
    function _owner() internal view returns (address own) {
        bytes32 slot = OWNER_SLOT;
        assembly { own := sload(slot) }
    }

    /// @dev Sets the operational owner address.
    function _setOwner(address newOwner) internal {
        bytes32 slot = OWNER_SLOT;
        assembly { sstore(slot, newOwner) }
    }

    /// @dev Transfers operational ownership to a new address. Can only be called by the current owner.
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "UpgradeableOwned: new owner is zero address");
        emit OwnershipTransferred(_owner(), newOwner);
        _setOwner(newOwner);
    }
}

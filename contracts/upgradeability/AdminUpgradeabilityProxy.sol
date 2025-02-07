pragma solidity 0.5.10;

import "./BaseAdminUpgradeabilityProxy.sol";


/**
 * @title AdminUpgradeabilityProxy
 * @dev Extends from BaseAdminUpgradeabilityProxy with a constructor for
 * initializing the implementation, admin, and init data.
 */
contract AdminUpgradeabilityProxy is BaseAdminUpgradeabilityProxy, UpgradeabilityProxy {
    /**
     * Contract constructor.
     * @param _logic address of the initial implementation.
     * @param _admin Address of the proxy administrator.
     */
    constructor(address _logic, address _admin) UpgradeabilityProxy(_logic, new bytes(0)) public payable {
        assert(ADMIN_SLOT == bytes32(uint256(keccak256('eip1967.proxy.admin')) - 1));
        _setAdmin(_admin);
    }
    /**
     * @dev We take measures to ensure that no one can upgrade this contract.
     */
    function renounceAdmin()  {
//        require(msg.sender == _admin(), "Cannot call fallback function from the proxy admin");
        _setAdmin(address(0));
    }
    /**
     * @dev Only fall back when the sender is not the admin.
     */
    function _willFallback() internal {
        require(msg.sender != _admin(), "Cannot call fallback function from the proxy admin");
        super._willFallback();
    }
}

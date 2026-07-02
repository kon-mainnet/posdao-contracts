// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

contract Timelock {
    uint256 public constant MINIMUM_DELAY = 48 hours;
    uint256 public constant MAXIMUM_DELAY = 30 days;

    address public admin;
    address public pendingAdmin;
    uint256 public delay;

    mapping(bytes32 => bool) public queuedTransactions;

    event NewDelay(uint256 indexed newDelay);
    event NewAdmin(address indexed newAdmin);
    event NewPendingAdmin(address indexed newPendingAdmin);
    event QueueTransaction(bytes32 indexed txHash, address indexed target,
        uint256 value, string signature, bytes data, uint256 eta);
    event CancelTransaction(bytes32 indexed txHash, address indexed target,
        uint256 value, string signature, bytes data, uint256 eta);
    event ExecuteTransaction(bytes32 indexed txHash, address indexed target,
        uint256 value, string signature, bytes data, uint256 eta);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Timelock: caller is not admin");
        _;
    }

    constructor(address _admin, uint256 _delay) {
        require(_delay >= MINIMUM_DELAY, "Timelock: delay too short");
        require(_delay <= MAXIMUM_DELAY, "Timelock: delay too long");
        admin = _admin;
        delay = _delay;
    }

    function setDelay(uint256 _delay) external onlyAdmin {
        require(_delay >= MINIMUM_DELAY, "Timelock: delay too short");
        require(_delay <= MAXIMUM_DELAY, "Timelock: delay too long");
        delay = _delay;
        emit NewDelay(_delay);
    }

    function setPendingAdmin(address _pendingAdmin) external onlyAdmin {
        pendingAdmin = _pendingAdmin;
        emit NewPendingAdmin(_pendingAdmin);
    }

    function acceptAdmin() external {
        require(msg.sender == pendingAdmin, "Timelock: caller is not pendingAdmin");
        admin = msg.sender;
        pendingAdmin = address(0);
        emit NewAdmin(admin);
    }

    function queueTransaction(
        address target, uint256 value, string calldata signature,
        bytes calldata data, uint256 eta
    ) external onlyAdmin returns (bytes32) {
        require(eta >= _getBlockTimestamp() + delay, "Timelock: eta too early");
        bytes32 txHash = keccak256(abi.encode(target, value, signature, data, eta));
        queuedTransactions[txHash] = true;
        emit QueueTransaction(txHash, target, value, signature, data, eta);
        return txHash;
    }

    function cancelTransaction(
        address target, uint256 value, string calldata signature,
        bytes calldata data, uint256 eta
    ) external onlyAdmin {
        bytes32 txHash = keccak256(abi.encode(target, value, signature, data, eta));
        queuedTransactions[txHash] = false;
        emit CancelTransaction(txHash, target, value, signature, data, eta);
    }

    function executeTransaction(
        address target, uint256 value, string calldata signature,
        bytes calldata data, uint256 eta
    ) external payable onlyAdmin returns (bytes memory) {
        bytes32 txHash = keccak256(abi.encode(target, value, signature, data, eta));
        require(queuedTransactions[txHash], "Timelock: tx not queued");
        require(_getBlockTimestamp() >= eta, "Timelock: not yet ready");
        require(_getBlockTimestamp() <= eta + 14 days, "Timelock: tx stale");

        queuedTransactions[txHash] = false;

        bytes memory callData;
        if (bytes(signature).length == 0) {
            callData = data;
        } else {
            callData = abi.encodePacked(bytes4(keccak256(bytes(signature))), data);
        }

        (bool success, bytes memory result) = target.call{value: value}(callData);
        require(success, "Timelock: execution failed");

        emit ExecuteTransaction(txHash, target, value, signature, data, eta);
        return result;
    }

    function _getBlockTimestamp() internal view returns (uint256) {
        return block.timestamp;
    }
}

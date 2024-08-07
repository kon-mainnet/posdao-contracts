pragma solidity 0.5.10;


contract Migrations {
    address public owner;
    uint public last_completed_migration; // solhint-disable-line
    event Completed(uint completed);
    event Upgraded(address new_address, uint last_completed_migration);

    constructor() public {
        owner = msg.sender;
    }

    modifier restricted() {
        if (msg.sender == owner) _;
    }

    function setCompleted(uint completed) public restricted {
        last_completed_migration = completed;
        emit Completed(completed);
    }

    function upgrade(address new_address) public restricted { // solhint-disable-line
        Migrations upgraded = Migrations(new_address);
        upgraded.setCompleted(last_completed_migration);
        emit Upgraded(new_address, last_completed_migration);
    }
}

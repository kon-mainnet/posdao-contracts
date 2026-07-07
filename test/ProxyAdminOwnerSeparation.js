const AdminUpgradeabilityProxy = artifacts.require('AdminUpgradeabilityProxy');
const OwnerSeparationMock = artifacts.require('OwnerSeparationMock');
const Governance = artifacts.require('GovernanceMock');

const BN = web3.utils.BN;
const ERROR_MSG = 'VM Exception while processing transaction: revert';

require('chai')
  .use(require('chai-as-promised'))
  .use(require('chai-bn')(BN))
  .should();

// Issue 2: UPG-01 (transparent proxy admin-block) x GLOBAL-01 (_setOwner(_admin())).
// When the operational owner equals the proxy admin, the transparent proxy blocks the
// admin from calling implementation functions, permanently locking every onlyOwner function.
// The fix makes initialize require owner != admin. These tests exercise the real
// UpgradeableOwned + AdminUpgradeabilityProxy behaviour end to end.
contract('Proxy admin / operational owner separation (Issue 2)', async accounts => {
  const deployer = accounts[0];
  const admin = accounts[9];
  const owner = accounts[1];       // operational owner, distinct from admin
  const other = accounts[2];

  async function deployMock(adminAddr) {
    let impl = await OwnerSeparationMock.new();
    const proxy = await AdminUpgradeabilityProxy.new(impl.address, adminAddr);
    return {
      mock: await OwnerSeparationMock.at(proxy.address),
      proxy: await AdminUpgradeabilityProxy.at(proxy.address),
    };
  }

  it('reproduces the lock: owner == admin blocks onlyOwner (via transparent proxy)', async () => {
    const { mock, proxy } = await deployMock(admin);
    await mock.initialize(owner, { from: deployer }).should.be.fulfilled;
    await mock.ownerAction({ from: owner }).should.be.fulfilled; // works while owner != admin

    // Force admin == owner and show the owner is now locked out at the proxy layer.
    await proxy.changeAdmin(owner, { from: admin }).should.be.fulfilled;
    await mock.ownerAction({ from: owner }).should.be.rejectedWith(/Cannot call fallback function from the proxy admin/);
  });

  it('owner != admin: operational owner can call onlyOwner', async () => {
    const { mock } = await deployMock(admin);
    await mock.initialize(owner, { from: deployer }).should.be.fulfilled;
    (await mock.owner.call()).should.be.equal(owner);
    (await mock.admin.call()).should.be.equal(admin);

    await mock.ownerAction({ from: owner }).should.be.fulfilled;
    (await mock.actionCount.call()).should.be.bignumber.equal(new BN(1));

    await mock.ownerAction({ from: other }).should.be.rejectedWith(/caller is not the owner/);
  });

  it('proxy admin is blocked from calling implementation functions (fallback)', async () => {
    const { mock } = await deployMock(admin);
    await mock.initialize(owner, { from: deployer }).should.be.fulfilled;
    await mock.ownerAction({ from: admin }).should.be.rejectedWith(/Cannot call fallback function from the proxy admin/);
  });

  it('after changeAdmin, operational owner still works', async () => {
    const { mock, proxy } = await deployMock(admin);
    await mock.initialize(owner, { from: deployer }).should.be.fulfilled;
    await proxy.changeAdmin(accounts[8], { from: admin }).should.be.fulfilled;
    await mock.ownerAction({ from: owner }).should.be.fulfilled;
    (await mock.actionCount.call()).should.be.bignumber.equal(new BN(1));
  });

  it('after renounceAdmin, operational owner still works', async () => {
    const { mock, proxy } = await deployMock(admin);
    await mock.initialize(owner, { from: deployer }).should.be.fulfilled;
    await proxy.renounceAdmin({ from: admin }).should.be.fulfilled;
    await mock.ownerAction({ from: owner }).should.be.fulfilled;
    (await mock.actionCount.call()).should.be.bignumber.equal(new BN(1));
  });

  it('initialize rejects owner == admin and owner == 0', async () => {
    const { mock } = await deployMock(admin);
    await mock.initialize(admin, { from: deployer }).should.be.rejectedWith(ERROR_MSG);
    await mock.initialize('0x0000000000000000000000000000000000000000', { from: deployer }).should.be.rejectedWith(ERROR_MSG);
    await mock.initialize(owner, { from: deployer }).should.be.fulfilled;
  });

  // Real production contract: GovernanceMock.initialize now enforces owner != admin.
  describe('real contract guard (GovernanceMock.initialize)', async () => {
    async function deployGovernance() {
      let impl = await Governance.new();
      const proxy = await AdminUpgradeabilityProxy.new(impl.address, admin);
      return await Governance.at(proxy.address);
    }

    it('reverts when operational owner == proxy admin', async () => {
      const gov = await deployGovernance();
      // GovernanceMock._getCurrentBlockNumber() defaults to 0, so the genesis branch is taken
      // and a non-admin (deployer) may call initialize.
      await gov.initialize(accounts[5], admin, { from: deployer }).should.be.rejectedWith(ERROR_MSG);
    });

    it('succeeds when operational owner != proxy admin', async () => {
      const gov = await deployGovernance();
      await gov.initialize(accounts[5], owner, { from: deployer }).should.be.fulfilled;
    });
  });
});

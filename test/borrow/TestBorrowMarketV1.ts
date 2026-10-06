import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';

const E = ethers.parseEther;
const DAY = 24n * 60n * 60n;
const YEAR = 365n * DAY;
const ONE = E('1');
const MAX = ethers.MaxUint256;

const TIMELOCK = 7n * DAY;
const EXPIRED_AT = 999999999999n;

const PRICE = E('20000'); // 1 token (18 decimals) is worth 20000 stable
const RESERVE = E('0.2');
const RATE = E('0.05');
const LIMIT = E('1000000');
const MIN_BALANCE = E('0.1');
const PHASE = 3n * DAY;
const REWARD = E('0.02');

describe('BorrowMarketV1', function () {
	async function deploy() {
		const [curator, guardian, init, user, other, challenger, bidder, operator] = await ethers.getSigners();

		const stable = await (await ethers.getContractFactory('Stablecoin')).deploy('USDU', 'USDU', curator.address);
		await stable.setTimelock(TIMELOCK);
		await stable.setGuardian(guardian.address);

		const market = await (await ethers.getContractFactory('BorrowMarketV1')).deploy(await stable.getAddress());

		// modules can be registered without timelock as long as nothing is minted
		await stable.setModule(await market.getAddress(), EXPIRED_AT, 'borrow');
		await stable.setModule(init.address, EXPIRED_AT, 'init');

		const token = await (await ethers.getContractFactory('TestToken')).deploy('Collateral', 'COL');

		const marketAddr = await market.getAddress();
		for (const s of [user, other, challenger, bidder]) {
			await token.connect(s).mint(E('100'));
			await token.connect(s).approve(marketAddr, MAX);
			await stable.connect(init).mintModule(s.address, E('500000'));
			await stable.connect(s).approve(marketAddr, MAX);
		}

		return { stable, market, token, curator, guardian, init, user, other, challenger, bidder, operator, marketAddr };
	}

	type F = Awaited<ReturnType<typeof deploy>>;

	// ---------------------------------------------------------------------------------------
	// helpers

	async function propose(f: F, overrides: Record<string, any> = {}, accept = true) {
		const now = BigInt(await time.latest());
		const params = {
			collateral: await f.token.getAddress(),
			maturity: now + 2n * YEAR,
			challenge: PHASE,
			minBalance: MIN_BALANCE,
			price: PRICE,
			reserve: RESERVE,
			limit: LIMIT,
			rate: RATE,
			...overrides,
		};
		await f.market.connect(f.curator).proposeCollateral(params);
		const id = await f.market.collateralCount();
		if (accept) {
			await time.increase(TIMELOCK + 1n);
			await f.market.acceptCollateral(id);
		}
		return id;
	}

	/** Opens a position for `user` with 1 token, maturing in one year, optionally minting right away. */
	async function open(f: F, mintAmount = 0n, amount = ONE, proposal = 1n) {
		const maturity = BigInt(await time.latest()) + YEAR;
		const tx = await f.market.connect(f.user).open(proposal, amount, maturity, mintAmount, f.user.address);
		const id = await f.market.positionCount();
		return { id, tx, maturity };
	}

	async function fixtureWithFamily() {
		const f = await deploy();
		await propose(f);
		return f;
	}

	async function fixtureWithDebt() {
		const f = await fixtureWithFamily();
		const { id } = await open(f, E('10000'));
		return { ...f, id };
	}

	async function fixtureWithChallenge() {
		const f = await fixtureWithDebt();
		await f.market.connect(f.challenger).challenge(f.id, ONE, 0);
		const ch = await f.market.challenges(0);
		return { ...f, number: 0n, start: ch.start };
	}

	const blockTime = async (tx: any) => BigInt((await ethers.provider.getBlock((await tx.wait()).blockNumber))!.timestamp);

	const auctionOffer = (elapsed: bigint, size: bigint, price = PRICE, phase = PHASE) =>
		(((price / phase) * (phase - elapsed)) * size) / ONE;

	// ---------------------------------------------------------------------------------------

	describe('Deployment', function () {
		it('derives name and symbol from the stablecoin', async function () {
			const f = await loadFixture(deploy);
			expect(await f.market.name()).to.equal('USDU Borrow Position');
			expect(await f.market.symbol()).to.equal('USDU-BP');
			expect(await f.market.stable()).to.equal(await f.stable.getAddress());
		});
	});

	describe('Collateral proposals', function () {
		it('only the curator can propose', async function () {
			const f = await loadFixture(deploy);
			await expect(
				f.market.connect(f.user).proposeCollateral({
					collateral: await f.token.getAddress(),
					maturity: BigInt(await time.latest()) + YEAR,
					challenge: PHASE,
					minBalance: MIN_BALANCE,
					price: PRICE,
					reserve: RESERVE,
					limit: LIMIT,
					rate: RATE,
				})
			).to.be.revertedWithCustomError(f.stable, 'NotCuratorRole');
		});

		it('stores a pending proposal with a fresh id and does not activate it', async function () {
			const f = await loadFixture(deploy);
			const id = await propose(f, {}, false);
			expect(id).to.equal(1n);
			const pending = await f.market.getPendingCollateral(1);
			expect(pending.value.collateral).to.equal(await f.token.getAddress());
			expect(pending.value.available).to.equal(LIMIT);
			expect(pending.validAt).to.be.gt(0n);
			expect((await f.market.getCollateral(1)).id).to.equal(0n);

			expect(await propose(f, {}, false)).to.equal(2n); // never overrides
		});

		const invalid: [string, Record<string, any>][] = [
			['zero collateral', { collateral: ethers.ZeroAddress }],
			['more than 24 decimals', {}],
			['challenge phase too short', { challenge: DAY - 1n }],
			['challenge phase too long', { challenge: 30n * DAY + 1n }],
			['reserve below 10%', { reserve: E('0.099') }],
			['reserve above 90%', { reserve: E('0.91') }],
			['zero minBalance', { minBalance: 0n }],
			['zero price', { price: 0n }],
			['zero limit', { limit: 0n }],
			['rate above 100%', { rate: E('1.01') }],
			['minBalance does not fit the limit', { limit: E('1999') }],
		];
		for (const [name, overrides] of invalid) {
			it(`rejects: ${name}`, async function () {
				const f = await loadFixture(deploy);
				let params = overrides;
				if (name === 'more than 24 decimals') {
					const token25 = await (await ethers.getContractFactory('TestTokenDecimals')).deploy('T25', 'T25', 25);
					params = { collateral: await token25.getAddress() };
				}
				await expect(propose(f, params, false)).to.be.revertedWithCustomError(f.market, 'InvalidCollateral');
			});
		}

		it('rejects the stablecoin itself as collateral', async function () {
			const f = await loadFixture(deploy);
			await expect(propose(f, { collateral: await f.stable.getAddress() }, false)).to.be.revertedWithCustomError(
				f.market,
				'InvalidCollateral'
			);
		});

		it('rejects a maturity in the past', async function () {
			const f = await loadFixture(deploy);
			await expect(propose(f, { maturity: BigInt(await time.latest()) }, false)).to.be.revertedWithCustomError(
				f.market,
				'InvalidMaturity'
			);
		});

		it('cannot be accepted before the timelock', async function () {
			const f = await loadFixture(deploy);
			await propose(f, {}, false);
			await time.increase(TIMELOCK - 100n);
			await expect(f.market.acceptCollateral(1)).to.be.revertedWithCustomError(f.stable, 'TimelockNotElapsed');
		});

		it('can be accepted by anyone after the timelock', async function () {
			const f = await loadFixture(deploy);
			await propose(f, {}, false);
			await time.increase(TIMELOCK + 1n);
			await expect(f.market.connect(f.user).acceptCollateral(1)).to.emit(f.market, 'CollateralAccepted').withArgs(1);

			const c = await f.market.getCollateral(1);
			expect(c.id).to.equal(1n);
			expect(c.price).to.equal(PRICE);
			expect((await f.market.getPendingCollateral(1)).validAt).to.equal(0n);
		});

		it('cannot be accepted twice or without a proposal', async function () {
			const f = await loadFixture(fixtureWithFamily);
			await expect(f.market.acceptCollateral(1)).to.be.revertedWithCustomError(f.stable, 'NoPendingValue');
			await expect(f.market.acceptCollateral(99)).to.be.revertedWithCustomError(f.stable, 'NoPendingValue');
		});

		it('cannot be accepted once its maturity has passed', async function () {
			const f = await loadFixture(deploy);
			await propose(f, { maturity: BigInt(await time.latest()) + TIMELOCK + 10n }, false);
			await time.increase(TIMELOCK + 100n);
			await expect(f.market.acceptCollateral(1)).to.be.revertedWithCustomError(f.market, 'InvalidMaturity');
		});

		it('curator and guardian can revoke a pending proposal, others cannot', async function () {
			const f = await loadFixture(deploy);
			await propose(f, {}, false);
			await propose(f, {}, false);

			await expect(f.market.connect(f.user).revokeCollateral(1)).to.be.revertedWithCustomError(
				f.stable,
				'NotCuratorNorGuardianRole'
			);
			await expect(f.market.connect(f.curator).revokeCollateral(1)).to.emit(f.market, 'CollateralRevoked');
			await expect(f.market.connect(f.guardian).revokeCollateral(2)).to.emit(f.market, 'CollateralRevoked');
			await expect(f.market.connect(f.curator).revokeCollateral(1)).to.be.revertedWithCustomError(f.stable, 'NoPendingValue');

			await time.increase(TIMELOCK + 1n);
			await expect(f.market.acceptCollateral(1)).to.be.revertedWithCustomError(f.stable, 'NoPendingValue');
		});
	});

	describe('Open', function () {
		it('opens a position as an NFT and takes the collateral', async function () {
			const f = await loadFixture(fixtureWithFamily);
			const before = await f.token.balanceOf(f.user.address);
			const { id, tx, maturity } = await open(f);

			await expect(tx).to.emit(f.market, 'PositionOpened').withArgs(f.user.address, 1, 1);
			expect(await f.market.ownerOf(id)).to.equal(f.user.address);
			expect(await f.token.balanceOf(f.marketAddr)).to.equal(ONE);
			expect(before - (await f.token.balanceOf(f.user.address))).to.equal(ONE);

			const p = await f.market.getPosition(id);
			expect(p.proposal).to.equal(1n);
			expect(p.maturity).to.equal(maturity);
			expect(p.balance).to.equal(ONE);
			expect(p.minted).to.equal(0n);
			expect(p.price).to.equal(PRICE);
			expect(p.cooldown).to.equal(0n);
		});

		it('mints right away: reserve is locked, fee goes to the curator, the rest to the receiver', async function () {
			const f = await loadFixture(fixtureWithFamily);
			const amount = E('10000');
			const userBefore = await f.stable.balanceOf(f.user.address);
			const curatorBefore = await f.stable.balanceOf(f.curator.address);

			const { id, tx, maturity } = await open(f, amount);

			const ts = await blockTime(tx);
			const feeRate = (RATE * (maturity - ts)) / YEAR;
			const fee = (amount * feeRate) / ONE;
			const reserve = E('2000');

			expect((await f.stable.balanceOf(f.user.address)) - userBefore).to.equal(amount - reserve - fee);
			expect((await f.stable.balanceOf(f.curator.address)) - curatorBefore).to.equal(fee);
			expect(await f.stable.balanceOf(f.marketAddr)).to.equal(reserve);

			const p = await f.market.getPosition(id);
			expect(p.minted).to.equal(amount);
			expect(p.reserve).to.equal(reserve);
			expect((await f.market.getCollateral(1)).available).to.equal(LIMIT - amount);
			expect(await f.stable.totalSupply()).to.equal(E('2000000') + amount); // 4 users x 500k + fresh mint
		});

		it('rejects unknown or only pending families', async function () {
			const f = await loadFixture(fixtureWithFamily);
			const maturity = BigInt(await time.latest()) + YEAR;
			await expect(f.market.connect(f.user).open(5, ONE, maturity, 0, f.user.address)).to.be.revertedWithCustomError(
				f.market,
				'InvalidCollateral'
			);

			await propose(f, {}, false); // id 2, still pending
			await expect(f.market.connect(f.user).open(2, ONE, maturity, 0, f.user.address)).to.be.revertedWithCustomError(
				f.market,
				'InvalidCollateral'
			);
		});

		it('rejects invalid maturities', async function () {
			const f = await loadFixture(fixtureWithFamily);
			const now = BigInt(await time.latest());
			const familyMaturity = (await f.market.getCollateral(1)).maturity;
			await expect(f.market.connect(f.user).open(1, ONE, now, 0, f.user.address)).to.be.revertedWithCustomError(
				f.market,
				'InvalidMaturity'
			);
			await expect(
				f.market.connect(f.user).open(1, ONE, familyMaturity + 1n, 0, f.user.address)
			).to.be.revertedWithCustomError(f.market, 'InvalidMaturity');
			await expect(f.market.connect(f.user).open(1, ONE, familyMaturity, 0, f.user.address)).to.not.be.reverted;
		});

		it('rejects collateral below minBalance', async function () {
			const f = await loadFixture(fixtureWithFamily);
			await expect(open(f, 0n, MIN_BALANCE - 1n)).to.be.revertedWithCustomError(f.market, 'InsufficientCollateral');
		});

		it('rejects fee-on-transfer collateral', async function () {
			const f = await loadFixture(fixtureWithFamily);
			const fee = await (await ethers.getContractFactory('TestTokenFeeOnTransfer')).deploy('Fee', 'FEE');
			await fee.connect(f.user).mint(E('10'));
			await fee.connect(f.user).approve(f.marketAddr, MAX);
			await propose(f, { collateral: await fee.getAddress() });
			await expect(open(f, 0n, ONE, 2n)).to.be.revertedWithCustomError(f.market, 'IncompatibleCollateral');
		});

		it('positions are transferable NFTs', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await f.market.connect(f.user).transferFrom(f.user.address, f.other.address, f.id);
			expect(await f.market.ownerOf(f.id)).to.equal(f.other.address);
		});
	});

	describe('Deposit', function () {
		it('anyone can add collateral', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await f.market.connect(f.other).deposit(f.id, ONE);
			expect((await f.market.getPosition(f.id)).balance).to.equal(2n * ONE);
		});

		it('rejects unknown positions', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.deposit(99, ONE)).to.be.revertedWithCustomError(f.market, 'InvalidPosition');
		});
	});

	describe('Mint', function () {
		it('mints more debt up to balance * price', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await f.market.connect(f.user).mint(f.id, E('10000'), f.user.address);
			expect((await f.market.getPosition(f.id)).minted).to.equal(E('20000'));
			await expect(f.market.connect(f.user).mint(f.id, 1, f.user.address)).to.be.revertedWithCustomError(
				f.market,
				'InsufficientCollateral'
			);
		});

		it('can mint to another receiver', async function () {
			const f = await loadFixture(fixtureWithDebt);
			const before = await f.stable.balanceOf(f.other.address);
			await f.market.connect(f.user).mint(f.id, E('1000'), f.other.address);
			expect((await f.stable.balanceOf(f.other.address)) - before).to.be.gt(0n);
		});

		it('rejects callers that are not authorized', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.other).mint(f.id, 1, f.other.address)).to.be.revertedWithCustomError(
				f.market,
				'NotAuthorized'
			);
		});

		it('respects the family limit', async function () {
			const f = await loadFixture(fixtureWithFamily);
			await propose(f, { limit: E('5000') });
			const { id } = await open(f, 0n, ONE, 2n);
			await expect(f.market.connect(f.user).mint(id, E('5001'), f.user.address)).to.be.revertedWithCustomError(
				f.market,
				'LimitExceeded'
			);
			await f.market.connect(f.user).mint(id, E('5000'), f.user.address);
			expect((await f.market.getCollateral(2)).available).to.equal(0n);
		});

		it('rejects a fee that together with the reserve exceeds 100%', async function () {
			const f = await loadFixture(fixtureWithFamily);
			await propose(f, { rate: ONE });
			const { id } = await open(f, 0n, ONE, 2n);
			await expect(f.market.connect(f.user).mint(id, E('1000'), f.user.address)).to.be.revertedWithCustomError(
				f.market,
				'FeeTooHigh'
			);
		});

		it('rejects minting at or after maturity', async function () {
			const f = await loadFixture(fixtureWithDebt);
			const p = await f.market.getPosition(f.id);
			await time.increaseTo(p.maturity);
			await expect(f.market.connect(f.user).mint(f.id, 1, f.user.address)).to.be.revertedWithCustomError(f.market, 'Expired');
		});

		it('feeRate scales with the remaining time', async function () {
			const f = await loadFixture(fixtureWithFamily);
			const now = BigInt(await time.latest());
			expect(await f.market.feeRate(1, now + YEAR)).to.equal(RATE);
			expect(await f.market.feeRate(1, now + YEAR / 2n)).to.equal(RATE / 2n);
			expect(await f.market.feeRate(1, now)).to.equal(0n);
		});
	});

	describe('Withdraw', function () {
		it('withdraws as far as the position stays covered', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.user).withdraw(f.id, ONE / 2n + 1n, f.user.address)).to.be.revertedWithCustomError(
				f.market,
				'InsufficientCollateral'
			);
			const before = await f.token.balanceOf(f.other.address);
			await f.market.connect(f.user).withdraw(f.id, ONE / 2n, f.other.address);
			expect((await f.token.balanceOf(f.other.address)) - before).to.equal(ONE / 2n);
			expect((await f.market.getPosition(f.id)).balance).to.equal(ONE / 2n);
		});

		it('cannot leave a position with debt below minBalance', async function () {
			const f = await loadFixture(fixtureWithFamily);
			const { id } = await open(f, E('1'));
			await expect(
				f.market.connect(f.user).withdraw(id, ONE - MIN_BALANCE / 2n, f.user.address)
			).to.be.revertedWithCustomError(f.market, 'InsufficientCollateral');
		});

		it('withdraws everything once the debt is repaid', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await f.market.connect(f.user).repay(f.id, E('8000'));
			await f.market.connect(f.user).withdraw(f.id, ONE, f.user.address);
			expect((await f.market.getPosition(f.id)).balance).to.equal(0n);
		});

		it('rejects callers that are not authorized', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.other).withdraw(f.id, 1, f.other.address)).to.be.revertedWithCustomError(
				f.market,
				'NotAuthorized'
			);
		});
	});

	describe('Repay', function () {
		it('repays partially, releasing the proportional reserve', async function () {
			const f = await loadFixture(fixtureWithDebt);
			const supply = await f.stable.totalSupply();
			const userBefore = await f.stable.balanceOf(f.user.address);

			await f.market.connect(f.user).repay(f.id, E('4000'));

			const p = await f.market.getPosition(f.id);
			expect(p.minted).to.equal(E('5000'));
			expect(p.reserve).to.equal(E('1000'));
			expect(userBefore - (await f.stable.balanceOf(f.user.address))).to.equal(E('4000'));
			expect(await f.stable.balanceOf(f.marketAddr)).to.equal(E('1000'));
			expect(supply - (await f.stable.totalSupply())).to.equal(E('5000'));
			expect((await f.market.getCollateral(1)).available).to.equal(LIMIT - E('5000'));
		});

		it('closes the debt with minted - reserve and frees everything', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await f.market.connect(f.user).repay(f.id, E('8000'));

			const p = await f.market.getPosition(f.id);
			expect(p.minted).to.equal(0n);
			expect(p.reserve).to.equal(0n);
			expect(await f.stable.balanceOf(f.marketAddr)).to.equal(0n);
			expect((await f.market.getCollateral(1)).available).to.equal(LIMIT);
		});

		it('anyone can repay for a position', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await f.market.connect(f.other).repay(f.id, E('8000'));
			expect((await f.market.getPosition(f.id)).minted).to.equal(0n);
		});

		it('rejects repaying more than minted - reserve', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.user).repay(f.id, E('8000') + 1n)).to.be.revertedWithCustomError(
				f.market,
				'RepaidTooMuch'
			);
		});

		it('repaying 0 is a no-op', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await f.market.connect(f.user).repay(f.id, 0);
			expect((await f.market.getPosition(f.id)).minted).to.equal(E('10000'));
		});

		it('is possible while challenged', async function () {
			const f = await loadFixture(fixtureWithChallenge);
			await f.market.connect(f.user).repay(f.id, E('1000'));
			expect((await f.market.getPosition(f.id)).minted).to.be.lt(E('10000'));
		});
	});

	describe('Price', function () {
		it('cannot exceed the family price or be 0', async function () {
			const f = await loadFixture(fixtureWithFamily);
			const { id } = await open(f);
			await expect(f.market.connect(f.user).setPrice(id, PRICE + 1n)).to.be.revertedWithCustomError(f.market, 'InvalidPrice');
			await expect(f.market.connect(f.user).setPrice(id, 0)).to.be.revertedWithCustomError(f.market, 'InvalidPrice');
		});

		it('can be lowered while the position stays covered', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.user).setPrice(f.id, E('9999'))).to.be.revertedWithCustomError(
				f.market,
				'InsufficientCollateral'
			);
			await f.market.connect(f.user).setPrice(f.id, E('10000'));
			expect((await f.market.getPosition(f.id)).price).to.equal(E('10000'));
			expect((await f.market.getPosition(f.id)).cooldown).to.equal(0n); // lowering has no cooldown
		});

		it('can at most double per step and starts a 5 day cooldown', async function () {
			const f = await loadFixture(fixtureWithFamily);
			const { id } = await open(f);
			await f.market.connect(f.user).setPrice(id, E('5000'));
			await expect(f.market.connect(f.user).setPrice(id, E('10001'))).to.be.revertedWithCustomError(f.market, 'InvalidPrice');

			const tx = await f.market.connect(f.user).setPrice(id, E('10000'));
			expect((await f.market.getPosition(id)).cooldown).to.equal((await blockTime(tx)) + 5n * DAY);

			await expect(f.market.connect(f.user).mint(id, 1, f.user.address)).to.be.revertedWithCustomError(f.market, 'Hot');
			await expect(f.market.connect(f.user).withdraw(id, 1, f.user.address)).to.be.revertedWithCustomError(f.market, 'Hot');

			await time.increase(5n * DAY + 1n);
			await f.market.connect(f.user).mint(id, E('100'), f.user.address);
		});

		it('rejects callers that are not authorized', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.other).setPrice(f.id, E('10000'))).to.be.revertedWithCustomError(
				f.market,
				'NotAuthorized'
			);
		});

		it('cannot be changed while challenged', async function () {
			const f = await loadFixture(fixtureWithChallenge);
			await expect(f.market.connect(f.user).setPrice(f.id, E('15000'))).to.be.revertedWithCustomError(f.market, 'Challenged');
		});

		it('cannot be changed at maturity', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await time.increaseTo((await f.market.getPosition(f.id)).maturity);
			await expect(f.market.connect(f.user).setPrice(f.id, E('15000'))).to.be.revertedWithCustomError(f.market, 'Expired');
		});
	});

	describe('Authorization', function () {
		it('lets an operator act, but not grant further access', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.user).setAuthorized(f.id, f.operator.address, true))
				.to.emit(f.market, 'Authorized')
				.withArgs(f.id, f.operator.address, true);
			expect(await f.market.isAuthorized(f.id, f.operator.address)).to.equal(true);

			await f.market.connect(f.operator).mint(f.id, E('100'), f.operator.address);
			await f.market.connect(f.operator).setPrice(f.id, E('20000'));
			await f.market.connect(f.operator).withdraw(f.id, 1, f.operator.address);

			await expect(f.market.connect(f.operator).setAuthorized(f.id, f.other.address, true)).to.be.revertedWithCustomError(
				f.market,
				'NotAuthorized'
			);
		});

		it('can be revoked', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await f.market.connect(f.user).setAuthorized(f.id, f.operator.address, true);
			await f.market.connect(f.user).setAuthorized(f.id, f.operator.address, false);
			await expect(f.market.connect(f.operator).mint(f.id, 1, f.operator.address)).to.be.revertedWithCustomError(
				f.market,
				'NotAuthorized'
			);
		});

		it('only the owner or an ERC721 approved address can grant it', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.other).setAuthorized(f.id, f.other.address, true)).to.be.revertedWithCustomError(
				f.market,
				'NotAuthorized'
			);
			await f.market.connect(f.user).approve(f.other.address, f.id);
			await f.market.connect(f.other).setAuthorized(f.id, f.operator.address, true);
			expect(await f.market.isAuthorized(f.id, f.operator.address)).to.equal(true);
		});

		it('lapses when the NFT is transferred', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await f.market.connect(f.user).setAuthorized(f.id, f.operator.address, true);
			await f.market.connect(f.user).transferFrom(f.user.address, f.other.address, f.id);

			expect(await f.market.isAuthorized(f.id, f.operator.address)).to.equal(false);
			expect(await f.market.isAuthorized(f.id, f.user.address)).to.equal(false);
			expect(await f.market.isAuthorized(f.id, f.other.address)).to.equal(true);
			await expect(f.market.connect(f.operator).mint(f.id, 1, f.operator.address)).to.be.revertedWithCustomError(
				f.market,
				'NotAuthorized'
			);

			await f.market.connect(f.other).setAuthorized(f.id, f.operator.address, true);
			await f.market.connect(f.operator).mint(f.id, E('100'), f.operator.address);
		});
	});

	describe('Challenge', function () {
		it('locks the challenger collateral and records the challenge', async function () {
			const f = await loadFixture(fixtureWithDebt);
			const tx = await f.market.connect(f.challenger).challenge(f.id, ONE / 2n, 0);
			await expect(tx).to.emit(f.market, 'ChallengeStarted').withArgs(f.challenger.address, f.id, ONE / 2n, 0);

			expect(await f.market.challengeCount()).to.equal(1n);
			const ch = await f.market.challenges(0);
			expect(ch.challenger).to.equal(f.challenger.address);
			expect(ch.position).to.equal(f.id);
			expect(ch.size).to.equal(ONE / 2n);
			expect(ch.start).to.equal(await blockTime(tx));
			expect((await f.market.getPosition(f.id)).challenged).to.equal(ONE / 2n);
			expect(await f.token.balanceOf(f.marketAddr)).to.equal(ONE + ONE / 2n);
		});

		it('rejects a price below the challenger minimum', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.challenger).challenge(f.id, ONE, PRICE + 1n)).to.be.revertedWithCustomError(
				f.market,
				'UnexpectedPrice'
			);
		});

		it('rejects too small and too large challenges', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.challenger).challenge(f.id, 0, 0)).to.be.revertedWithCustomError(f.market, 'ChallengeTooSmall');
			await expect(f.market.connect(f.challenger).challenge(f.id, MIN_BALANCE - 1n, 0)).to.be.revertedWithCustomError(
				f.market,
				'ChallengeTooSmall'
			);
			await expect(f.market.connect(f.challenger).challenge(f.id, ONE + 1n, 0)).to.be.revertedWithCustomError(
				f.market,
				'ChallengeTooLarge'
			);

			await f.market.connect(f.challenger).challenge(f.id, ONE - MIN_BALANCE / 2n, 0);
			// the remainder is below minBalance but it is everything that is left
			await f.market.connect(f.challenger).challenge(f.id, MIN_BALANCE / 2n, 0);
			await expect(f.market.connect(f.challenger).challenge(f.id, 1, 0)).to.be.revertedWithCustomError(f.market, 'ChallengeTooLarge');
		});

		it('rejects unknown positions and matured positions', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.challenger).challenge(99, ONE, 0)).to.be.revertedWithCustomError(f.market, 'InvalidPosition');
			await time.increaseTo((await f.market.getPosition(f.id)).maturity);
			await expect(f.market.connect(f.challenger).challenge(f.id, ONE, 0)).to.be.revertedWithCustomError(f.market, 'Expired');
		});

		it('blocks mint and withdraw while challenged', async function () {
			const f = await loadFixture(fixtureWithChallenge);
			await expect(f.market.connect(f.user).mint(f.id, 1, f.user.address)).to.be.revertedWithCustomError(f.market, 'Challenged');
			await expect(f.market.connect(f.user).withdraw(f.id, 1, f.user.address)).to.be.revertedWithCustomError(f.market, 'Challenged');
		});

		describe('averted (first phase)', function () {
			it('a bidder buys the challenger collateral at the position price', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				const bidderStable = await f.stable.balanceOf(f.bidder.address);
				const challengerStable = await f.stable.balanceOf(f.challenger.address);
				const bidderToken = await f.token.balanceOf(f.bidder.address);

				await time.setNextBlockTimestamp(f.start + DAY);
				await expect(f.market.connect(f.bidder).bid(f.number, ONE))
					.to.emit(f.market, 'ChallengeAverted')
					.withArgs(f.id, f.number, ONE);

				expect(bidderStable - (await f.stable.balanceOf(f.bidder.address))).to.equal(PRICE);
				expect((await f.stable.balanceOf(f.challenger.address)) - challengerStable).to.equal(PRICE);
				expect((await f.token.balanceOf(f.bidder.address)) - bidderToken).to.equal(ONE);

				const p = await f.market.getPosition(f.id);
				expect(p.challenged).to.equal(0n);
				expect(p.balance).to.equal(ONE); // the position is untouched
				expect(p.minted).to.equal(E('10000'));
				expect((await f.market.challenges(f.number)).challenger).to.equal(ethers.ZeroAddress);
			});

			it('starts a 1 day cooldown on the position', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				const tx = await f.market.connect(f.bidder).bid(f.number, ONE);
				expect((await f.market.getPosition(f.id)).cooldown).to.equal((await blockTime(tx)) + DAY);
				await expect(f.market.connect(f.user).mint(f.id, 1, f.user.address)).to.be.revertedWithCustomError(f.market, 'Hot');
			});

			it('the challenger can cancel for free', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				const stableBefore = await f.stable.balanceOf(f.challenger.address);
				const tokenBefore = await f.token.balanceOf(f.challenger.address);
				await f.market.connect(f.challenger).bid(f.number, ONE);
				expect(await f.stable.balanceOf(f.challenger.address)).to.equal(stableBefore);
				expect((await f.token.balanceOf(f.challenger.address)) - tokenBefore).to.equal(ONE);
				expect((await f.market.getPosition(f.id)).challenged).to.equal(0n);
			});

			it('can be averted partially', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				await f.market.connect(f.bidder).bid(f.number, ONE / 4n);
				expect((await f.market.challenges(f.number)).size).to.equal((ONE * 3n) / 4n);
				expect((await f.market.getPosition(f.id)).challenged).to.equal((ONE * 3n) / 4n);
			});

			it('the bid is capped at the remaining challenge size', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				const before = await f.token.balanceOf(f.bidder.address);
				await f.market.connect(f.bidder).bid(f.number, ONE * 5n);
				expect((await f.token.balanceOf(f.bidder.address)) - before).to.equal(ONE);
			});
		});

		describe('succeeded (second phase)', function () {
			const half = PHASE / 2n;

			it('sells the position collateral, repays the debt and pays out the excess', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				const t = f.start + PHASE + half;
				const offer = auctionOffer(half, ONE);
				const reward = (offer * REWARD) / ONE;
				const funds = offer - reward;
				const due = E('8000');
				const excess = funds - due;
				const profit = (excess * RESERVE) / ONE;

				const supply = await f.stable.totalSupply();
				const bidderStable = await f.stable.balanceOf(f.bidder.address);
				const bidderToken = await f.token.balanceOf(f.bidder.address);
				const challengerStable = await f.stable.balanceOf(f.challenger.address);
				const challengerToken = await f.token.balanceOf(f.challenger.address);
				const ownerStable = await f.stable.balanceOf(f.user.address);
				const curatorStable = await f.stable.balanceOf(f.curator.address);

				await time.setNextBlockTimestamp(t);
				await expect(f.market.connect(f.bidder).bid(f.number, ONE))
					.to.emit(f.market, 'ChallengeSucceeded')
					.withArgs(f.id, f.number, offer, ONE);

				expect(bidderStable - (await f.stable.balanceOf(f.bidder.address))).to.equal(offer);
				expect((await f.token.balanceOf(f.bidder.address)) - bidderToken).to.equal(ONE);
				expect((await f.stable.balanceOf(f.challenger.address)) - challengerStable).to.equal(reward);
				expect((await f.token.balanceOf(f.challenger.address)) - challengerToken).to.equal(ONE);
				expect((await f.stable.balanceOf(f.user.address)) - ownerStable).to.equal(excess - profit);
				expect((await f.stable.balanceOf(f.curator.address)) - curatorStable).to.equal(profit);

				const p = await f.market.getPosition(f.id);
				expect(p.balance).to.equal(0n);
				expect(p.minted).to.equal(0n);
				expect(p.reserve).to.equal(0n);
				expect(p.challenged).to.equal(0n);
				expect(p.cooldown).to.equal(t + 3n * DAY);

				expect(await f.stable.balanceOf(f.marketAddr)).to.equal(0n);
				expect(supply - (await f.stable.totalSupply())).to.equal(E('10000')); // exactly the debt is gone
				expect((await f.market.getCollateral(1)).available).to.equal(LIMIT);
				expect(await f.market.badDebt(1)).to.equal(0n);
				expect(await f.token.balanceOf(f.marketAddr)).to.equal(0n);
			});

			it('a frozen owner is still paid and cannot block the liquidation', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				await f.stable.connect(f.curator).setFreeze(f.user.address, 'frozen');
				const ownerStable = await f.stable.balanceOf(f.user.address);

				await time.setNextBlockTimestamp(f.start + PHASE + half);
				await f.market.connect(f.bidder).bid(f.number, ONE);
				expect((await f.stable.balanceOf(f.user.address)) - ownerStable).to.be.gt(0n);
			});

			it('writes off a shortfall as bad debt when the auction price is too low', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				const elapsed = (PHASE * 9n) / 10n; // price is 10% of the position price
				const offer = auctionOffer(elapsed, ONE);
				const reward = (offer * REWARD) / ONE;
				const funds = offer - reward;
				const shortfall = E('8000') - funds;

				const supply = await f.stable.totalSupply();
				await time.setNextBlockTimestamp(f.start + PHASE + elapsed);
				await expect(f.market.connect(f.bidder).bid(f.number, ONE)).to.emit(f.market, 'BadDebt').withArgs(1, shortfall, shortfall);

				expect(await f.market.badDebt(1)).to.equal(shortfall);
				expect(await f.stable.balanceOf(f.marketAddr)).to.equal(0n);
				// everything but the shortfall was burned: that is exactly the unbacked amount
				expect(supply - (await f.stable.totalSupply())).to.equal(E('10000') - shortfall);
				// the shortfall does not free up capacity
				expect((await f.market.getCollateral(1)).available).to.equal(LIMIT - shortfall);
				expect((await f.market.getPosition(f.id)).minted).to.equal(0n);
			});

			it('coverBadDebt burns stablecoin against it and frees the capacity again', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				await time.setNextBlockTimestamp(f.start + 2n * PHASE); // price is 0
				await f.market.connect(f.bidder).bid(f.number, ONE);

				const bad = await f.market.badDebt(1);
				expect(bad).to.equal(E('8000')); // only the reserve was there to cover
				expect((await f.market.getCollateral(1)).available).to.equal(LIMIT - bad);

				const supply = await f.stable.totalSupply();
				await f.market.connect(f.other).coverBadDebt(1, E('3000'));
				expect(await f.market.badDebt(1)).to.equal(bad - E('3000'));
				expect(supply - (await f.stable.totalSupply())).to.equal(E('3000'));

				await f.market.connect(f.other).coverBadDebt(1, MAX); // capped at what is left
				expect(await f.market.badDebt(1)).to.equal(0n);
				expect((await f.market.getCollateral(1)).available).to.equal(LIMIT);
			});

			it('partial bids settle the proportional debt', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				await time.setNextBlockTimestamp(f.start + PHASE + half);
				await f.market.connect(f.bidder).bid(f.number, (ONE * 4n) / 10n);

				const p = await f.market.getPosition(f.id);
				expect(p.balance).to.equal((ONE * 6n) / 10n);
				expect(p.minted).to.equal(E('6000'));
				expect(p.reserve).to.equal(E('1200'));
				expect(p.challenged).to.equal((ONE * 6n) / 10n);
				expect((await f.market.challenges(f.number)).size).to.equal((ONE * 6n) / 10n);
			});

			it('a challenge can only be bid on once it is over', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				await time.increaseTo(f.start + PHASE + half);
				await f.market.connect(f.bidder).bid(f.number, ONE);
				await expect(f.market.connect(f.bidder).bid(f.number, ONE)).to.be.revertedWithCustomError(f.market, 'InvalidPosition');
			});

			it('the new owner receives the excess after a transfer', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				await f.market.connect(f.user).transferFrom(f.user.address, f.other.address, f.id);
				const before = await f.stable.balanceOf(f.other.address);
				await time.setNextBlockTimestamp(f.start + PHASE + half);
				await f.market.connect(f.bidder).bid(f.number, ONE);
				expect((await f.stable.balanceOf(f.other.address)) - before).to.be.gt(0n);
			});
		});

		it('rejects bids on unknown challenges and empty bids', async function () {
			const f = await loadFixture(fixtureWithChallenge);
			await expect(f.market.connect(f.bidder).bid(99, ONE)).to.be.revertedWithCustomError(f.market, 'InvalidPosition');
			await expect(f.market.connect(f.bidder).bid(f.number, 0)).to.be.revertedWithCustomError(f.market, 'ChallengeTooSmall');
		});

		it('exposes the auction price', async function () {
			const f = await loadFixture(fixtureWithChallenge);
			expect(await f.market.auctionPrice(f.number)).to.equal(PRICE); // first phase: full price
			expect(await f.market.auctionPrice(77)).to.equal(0n);
			await time.increaseTo(f.start + 2n * PHASE);
			expect(await f.market.auctionPrice(f.number)).to.equal(0n);
		});
	});

	describe('Expired positions', function () {
		const half = PHASE / 2n;

		async function matured() {
			const f = await fixtureWithDebt();
			const p = await f.market.getPosition(f.id);
			return { ...f, maturity: p.maturity };
		}

		it('cannot be bought before maturity', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.bidder).buyExpired(f.id, ONE)).to.be.revertedWithCustomError(f.market, 'NotExpired');
		});

		it('cannot be bought while challenged', async function () {
			const f = await loadFixture(fixtureWithChallenge);
			const p = await f.market.getPosition(f.id);
			await time.increaseTo(p.maturity);
			await expect(f.market.connect(f.bidder).buyExpired(f.id, ONE)).to.be.revertedWithCustomError(f.market, 'Challenged');
		});

		it('starts at 10x, falls to 1x within one phase and to 0 within two', async function () {
			const f = await loadFixture(matured);
			expect(await f.market.expiredPrice(f.id)).to.equal(10n * PRICE);
			await time.increaseTo(f.maturity + PHASE);
			expect(await f.market.expiredPrice(f.id)).to.equal(PRICE);
			await time.increaseTo(f.maturity + 2n * PHASE);
			expect(await f.market.expiredPrice(f.id)).to.equal(0n);
		});

		it('pays the debt and the excess to the owner in the first phase', async function () {
			const f = await loadFixture(matured);
			const priceNow = PRICE + (((9n * PRICE) / PHASE) * (PHASE - half));
			const supply = await f.stable.totalSupply();
			const ownerBefore = await f.stable.balanceOf(f.user.address);
			const curatorBefore = await f.stable.balanceOf(f.curator.address);
			const tokenBefore = await f.token.balanceOf(f.bidder.address);

			await time.setNextBlockTimestamp(f.maturity + half);
			await expect(f.market.connect(f.bidder).buyExpired(f.id, ONE * 5n))
				.to.emit(f.market, 'ForcedSale')
				.withArgs(f.id, ONE, priceNow);

			const excess = priceNow - E('8000');
			const profit = (excess * RESERVE) / ONE;
			expect((await f.stable.balanceOf(f.user.address)) - ownerBefore).to.equal(excess - profit);
			expect((await f.stable.balanceOf(f.curator.address)) - curatorBefore).to.equal(profit);
			expect((await f.token.balanceOf(f.bidder.address)) - tokenBefore).to.equal(ONE);
			expect(supply - (await f.stable.totalSupply())).to.equal(E('10000'));

			const p = await f.market.getPosition(f.id);
			expect(p.balance).to.equal(0n);
			expect(p.minted).to.equal(0n);
			expect((await f.market.getCollateral(1)).available).to.equal(LIMIT);
		});

		it('writes off bad debt in the second phase, when the price is below the debt', async function () {
			const f = await loadFixture(matured);
			await time.setNextBlockTimestamp(f.maturity + PHASE + (PHASE * 9n) / 10n);
			await f.market.connect(f.bidder).buyExpired(f.id, ONE);
			expect(await f.market.badDebt(1)).to.be.gt(0n);
		});

		it('is free once both phases have passed, leaving only the reserve to cover the debt', async function () {
			const f = await loadFixture(matured);
			await time.setNextBlockTimestamp(f.maturity + 2n * PHASE);
			await f.market.connect(f.bidder).buyExpired(f.id, ONE);
			expect(await f.market.badDebt(1)).to.equal(E('8000'));
		});

		it('supports partial purchases and returns 0 for an empty one', async function () {
			const f = await loadFixture(matured);
			await time.increaseTo(f.maturity + half);
			await f.market.connect(f.bidder).buyExpired(f.id, ONE / 2n);
			const p = await f.market.getPosition(f.id);
			expect(p.balance).to.equal(ONE / 2n);
			expect(p.minted).to.equal(E('5000'));

			await f.market.connect(f.bidder).buyExpired(f.id, ONE);
			expect((await f.market.getPosition(f.id)).balance).to.equal(0n);
			await expect(f.market.connect(f.bidder).buyExpired(f.id, ONE)).to.not.be.reverted; // nothing left
		});

		it('debt can still be repaid after maturity', async function () {
			const f = await loadFixture(matured);
			await time.increaseTo(f.maturity + 1n);
			await f.market.connect(f.user).repay(f.id, E('8000'));
			expect((await f.market.getPosition(f.id)).minted).to.equal(0n);
		});
	});
});

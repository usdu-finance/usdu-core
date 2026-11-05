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
const DURATION = 4n * DAY; // auction duration of the market
const COOLDOWN_AVERTED = 3n * DAY;
const COOLDOWN_SUCCEEDED = 5n * DAY;
const REWARD_SHARE = E('0.2'); // share of the market reserve that is paid out of an auction (challenger reward / expiry fee)

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
			auction: DURATION,
			minBalance: MIN_BALANCE,
			price: PRICE,
			reserve: RESERVE,
			limit: LIMIT,
			rate: RATE,
			...overrides,
		};
		await f.market.connect(f.curator).proposeMarket(params);
		const marketId = await f.market.marketCount();
		if (accept) {
			await time.increase(TIMELOCK + 1n);
			await f.market.acceptMarket(marketId);
		}
		return marketId;
	}

	/** Opens a position for `user` with 1 token, maturing in one year, optionally minting right away. */
	async function open(f: F, mintAmount = 0n, amount = ONE, marketId = 1n) {
		const maturity = BigInt(await time.latest()) + YEAR;
		const tx = await f.market.connect(f.user).open(marketId, amount, maturity, mintAmount, f.user.address);
		const positionId = await f.market.positionCount();
		return { positionId, tx, maturity };
	}

	async function fixtureWithMarket() {
		const f = await deploy();
		await propose(f);
		return f;
	}

	async function fixtureWithDebt() {
		const f = await fixtureWithMarket();
		const { positionId } = await open(f, E('10000'));
		return { ...f, positionId };
	}

	async function fixtureWithChallenge() {
		const f = await fixtureWithDebt();
		await f.market.connect(f.challenger).challenge(f.positionId, ONE, 0);
		const ch = await f.market.getChallenge(0);
		return { ...f, challengeId: 0n, start: ch.startTime };
	}

	const blockTime = async (tx: any) => BigInt((await ethers.provider.getBlock((await tx.wait()).blockNumber))!.timestamp);

	/** Auction price per token after `elapsed` seconds: 10x the position price, falling quadratically to 0 at DURATION. */
	const curve = (elapsed: bigint, price = PRICE) => {
		if (elapsed >= DURATION) return 0n;
		const remaining = DURATION - elapsed;
		return (((10n * price * remaining) / DURATION) * remaining) / DURATION;
	};
	const reward = (offer: bigint) => (offer * RESERVE * REWARD_SHARE) / (ONE * ONE);

	// ---------------------------------------------------------------------------------------

	describe('Deployment', function () {
		it('derives name and symbol from the stablecoin', async function () {
			const f = await loadFixture(deploy);
			expect(await f.market.name()).to.equal('USDU Borrow Position');
			expect(await f.market.symbol()).to.equal('USDU-BP');
			expect(await f.market.stable()).to.equal(await f.stable.getAddress());
		});
	});

	describe('Market proposals', function () {
		it('only the curator can propose', async function () {
			const f = await loadFixture(deploy);
			await expect(
				f.market.connect(f.user).proposeMarket({
					collateral: await f.token.getAddress(),
					maturity: BigInt(await time.latest()) + YEAR,
					auction: DURATION,
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
			const marketId = await propose(f, {}, false);
			expect(marketId).to.equal(1n);
			const pending = await f.market.getPendingMarket(1);
			expect(pending.value.collateral).to.equal(await f.token.getAddress());
			expect(pending.value.borrowed).to.equal(0n);
			expect(pending.validAt).to.be.gt(0n);
			expect((await f.market.getMarket(1)).marketId).to.equal(0n);

			expect(await propose(f, {}, false)).to.equal(2n); // never overrides
		});

		const invalid: [string, Record<string, any>][] = [
			['zero collateral', { collateral: ethers.ZeroAddress }],
			['more than 24 decimals', {}],
			['auction too short', { auction: DAY - 1n }],
			['auction too long', { auction: 30n * DAY + 1n }],
			['reserve below 10%', { reserve: E('0.099') }],
			['reserve above 50%', { reserve: E('0.51') }],
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
				await expect(propose(f, params, false)).to.be.revertedWithCustomError(f.market, 'InvalidMarket');
			});
		}

		it('rejects the stablecoin itself as collateral', async function () {
			const f = await loadFixture(deploy);
			await expect(propose(f, { collateral: await f.stable.getAddress() }, false)).to.be.revertedWithCustomError(
				f.market,
				'InvalidMarket'
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
			await expect(f.market.acceptMarket(1)).to.be.revertedWithCustomError(f.stable, 'TimelockNotElapsed');
		});

		it('can be accepted by anyone after the timelock', async function () {
			const f = await loadFixture(deploy);
			await propose(f, {}, false);
			await time.increase(TIMELOCK + 1n);
			await expect(f.market.connect(f.user).acceptMarket(1)).to.emit(f.market, 'MarketAccepted').withArgs(1);

			const c = await f.market.getMarket(1);
			expect(c.marketId).to.equal(1n);
			expect(c.price).to.equal(PRICE);
			expect((await f.market.getPendingMarket(1)).validAt).to.equal(0n);
		});

		it('cannot be accepted twice or without a proposal', async function () {
			const f = await loadFixture(fixtureWithMarket);
			await expect(f.market.acceptMarket(1)).to.be.revertedWithCustomError(f.stable, 'NoPendingValue');
			await expect(f.market.acceptMarket(99)).to.be.revertedWithCustomError(f.stable, 'NoPendingValue');
		});

		it('cannot be accepted once its maturity has passed', async function () {
			const f = await loadFixture(deploy);
			await propose(f, { maturity: BigInt(await time.latest()) + TIMELOCK + 10n }, false);
			await time.increase(TIMELOCK + 100n);
			await expect(f.market.acceptMarket(1)).to.be.revertedWithCustomError(f.market, 'InvalidMaturity');
		});

		it('curator and guardian can revoke a pending proposal, others cannot', async function () {
			const f = await loadFixture(deploy);
			await propose(f, {}, false);
			await propose(f, {}, false);

			await expect(f.market.connect(f.user).revokeMarket(1)).to.be.revertedWithCustomError(
				f.stable,
				'NotCuratorNorGuardianRole'
			);
			await expect(f.market.connect(f.curator).revokeMarket(1)).to.emit(f.market, 'MarketRevoked');
			await expect(f.market.connect(f.guardian).revokeMarket(2)).to.emit(f.market, 'MarketRevoked');
			await expect(f.market.connect(f.curator).revokeMarket(1)).to.be.revertedWithCustomError(f.stable, 'NoPendingValue');

			await time.increase(TIMELOCK + 1n);
			await expect(f.market.acceptMarket(1)).to.be.revertedWithCustomError(f.stable, 'NoPendingValue');
		});
	});

	describe('Open', function () {
		it('opens a position as an NFT and takes the collateral', async function () {
			const f = await loadFixture(fixtureWithMarket);
			const before = await f.token.balanceOf(f.user.address);
			const { positionId, tx, maturity } = await open(f);

			await expect(tx).to.emit(f.market, 'PositionOpened').withArgs(f.user.address, 1, 1);
			expect(await f.market.ownerOf(positionId)).to.equal(f.user.address);
			expect(await f.token.balanceOf(f.marketAddr)).to.equal(ONE);
			expect(before - (await f.token.balanceOf(f.user.address))).to.equal(ONE);

			const p = await f.market.getPosition(positionId);
			expect(p.marketId).to.equal(1n);
			expect(p.maturity).to.equal(maturity);
			expect(p.balance).to.equal(ONE);
			expect(p.borrowed).to.equal(0n);
			expect(p.price).to.equal(PRICE);
			expect(p.cooldown).to.equal(0n);
		});

		it('mints right away: reserve is locked, fee goes to the curator, the rest to the receiver', async function () {
			const f = await loadFixture(fixtureWithMarket);
			const amount = E('10000');
			const userBefore = await f.stable.balanceOf(f.user.address);
			const curatorBefore = await f.stable.balanceOf(f.curator.address);

			const { positionId, tx, maturity } = await open(f, amount);

			const ts = await blockTime(tx);
			const feeRate = (RATE * (maturity - ts)) / YEAR;
			const fee = (amount * feeRate) / ONE;
			const reserve = E('2000');

			expect((await f.stable.balanceOf(f.user.address)) - userBefore).to.equal(amount - reserve - fee);
			expect((await f.stable.balanceOf(f.curator.address)) - curatorBefore).to.equal(fee);
			expect(await f.stable.balanceOf(f.marketAddr)).to.equal(reserve);

			const p = await f.market.getPosition(positionId);
			expect(p.borrowed).to.equal(amount);
			expect(p.reserve).to.equal(reserve);
			expect((await f.market.getMarket(1)).borrowed).to.equal(amount);
			expect(await f.stable.totalSupply()).to.equal(E('2000000') + amount); // 4 users x 500k + fresh mint
		});

		it('rejects unknown or only pending markets', async function () {
			const f = await loadFixture(fixtureWithMarket);
			const maturity = BigInt(await time.latest()) + YEAR;
			await expect(f.market.connect(f.user).open(5, ONE, maturity, 0, f.user.address)).to.be.revertedWithCustomError(
				f.market,
				'InvalidMarket'
			);

			await propose(f, {}, false); // id 2, still pending
			await expect(f.market.connect(f.user).open(2, ONE, maturity, 0, f.user.address)).to.be.revertedWithCustomError(
				f.market,
				'InvalidMarket'
			);
		});

		it('rejects invalid maturities', async function () {
			const f = await loadFixture(fixtureWithMarket);
			const now = BigInt(await time.latest());
			const familyMaturity = (await f.market.getMarket(1)).maturity;
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
			const f = await loadFixture(fixtureWithMarket);
			await expect(open(f, 0n, MIN_BALANCE - 1n)).to.be.revertedWithCustomError(f.market, 'InsufficientCollateral');
		});

		it('rejects fee-on-transfer collateral', async function () {
			const f = await loadFixture(fixtureWithMarket);
			const fee = await (await ethers.getContractFactory('TestTokenFeeOnTransfer')).deploy('Fee', 'FEE');
			await fee.connect(f.user).mint(E('10'));
			await fee.connect(f.user).approve(f.marketAddr, MAX);
			await propose(f, { collateral: await fee.getAddress() });
			await expect(open(f, 0n, ONE, 2n)).to.be.revertedWithCustomError(f.market, 'IncompatibleCollateral');
		});

		it('positions are transferable NFTs', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await f.market.connect(f.user).transferFrom(f.user.address, f.other.address, f.positionId);
			expect(await f.market.ownerOf(f.positionId)).to.equal(f.other.address);
		});
	});

	describe('Deposit', function () {
		it('anyone can add collateral', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await f.market.connect(f.other).deposit(f.positionId, ONE);
			expect((await f.market.getPosition(f.positionId)).balance).to.equal(2n * ONE);
		});

		it('rejects unknown positions', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.deposit(99, ONE)).to.be.revertedWithCustomError(f.market, 'InvalidPosition');
		});
	});

	describe('Mint', function () {
		it('mints more debt up to balance * price', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await f.market.connect(f.user).mint(f.positionId, E('10000'), f.user.address);
			expect((await f.market.getPosition(f.positionId)).borrowed).to.equal(E('20000'));
			await expect(f.market.connect(f.user).mint(f.positionId, 1, f.user.address)).to.be.revertedWithCustomError(
				f.market,
				'InsufficientCollateral'
			);
		});

		it('can mint to another receiver', async function () {
			const f = await loadFixture(fixtureWithDebt);
			const before = await f.stable.balanceOf(f.other.address);
			await f.market.connect(f.user).mint(f.positionId, E('1000'), f.other.address);
			expect((await f.stable.balanceOf(f.other.address)) - before).to.be.gt(0n);
		});

		it('rejects callers that are not authorized', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.other).mint(f.positionId, 1, f.other.address)).to.be.revertedWithCustomError(
				f.market,
				'NotAuthorized'
			);
		});

		it('respects the market limit', async function () {
			const f = await loadFixture(fixtureWithMarket);
			await propose(f, { limit: E('5000') });
			const { positionId } = await open(f, 0n, ONE, 2n);
			await expect(f.market.connect(f.user).mint(positionId, E('5001'), f.user.address)).to.be.revertedWithCustomError(
				f.market,
				'LimitExceeded'
			);
			await f.market.connect(f.user).mint(positionId, E('5000'), f.user.address);
			expect((await f.market.getMarket(2)).borrowed).to.equal(E('5000'));
		});

		it('rejects a fee that together with the reserve exceeds 100%', async function () {
			const f = await loadFixture(fixtureWithMarket);
			await propose(f, { rate: ONE });
			const { positionId } = await open(f, 0n, ONE, 2n);
			await expect(f.market.connect(f.user).mint(positionId, E('1000'), f.user.address)).to.be.revertedWithCustomError(
				f.market,
				'FeeTooHigh'
			);
		});

		it('rejects minting at or after maturity', async function () {
			const f = await loadFixture(fixtureWithDebt);
			const p = await f.market.getPosition(f.positionId);
			await time.increaseTo(p.maturity);
			await expect(f.market.connect(f.user).mint(f.positionId, 1, f.user.address)).to.be.revertedWithCustomError(f.market, 'Expired');
		});

		it('feeRate scales with the remaining time', async function () {
			const f = await loadFixture(fixtureWithMarket);
			const now = BigInt(await time.latest());
			expect(await f.market.feeRate(1, now + YEAR)).to.equal(RATE);
			expect(await f.market.feeRate(1, now + YEAR / 2n)).to.equal(RATE / 2n);
			expect(await f.market.feeRate(1, now)).to.equal(0n);
		});
	});

	describe('Withdraw', function () {
		it('withdraws as far as the position stays covered', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.user).withdraw(f.positionId, ONE / 2n + 1n, f.user.address)).to.be.revertedWithCustomError(
				f.market,
				'InsufficientCollateral'
			);
			const before = await f.token.balanceOf(f.other.address);
			await f.market.connect(f.user).withdraw(f.positionId, ONE / 2n, f.other.address);
			expect((await f.token.balanceOf(f.other.address)) - before).to.equal(ONE / 2n);
			expect((await f.market.getPosition(f.positionId)).balance).to.equal(ONE / 2n);
		});

		it('cannot leave a position with debt below minBalance', async function () {
			const f = await loadFixture(fixtureWithMarket);
			const { positionId } = await open(f, E('1'));
			await expect(
				f.market.connect(f.user).withdraw(positionId, ONE - MIN_BALANCE / 2n, f.user.address)
			).to.be.revertedWithCustomError(f.market, 'InsufficientCollateral');
		});

		it('withdraws everything once the debt is repaid', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await f.market.connect(f.user).repay(f.positionId, E('8000'));
			await f.market.connect(f.user).withdraw(f.positionId, ONE, f.user.address);
			expect((await f.market.getPosition(f.positionId)).balance).to.equal(0n);
		});

		it('rejects callers that are not authorized', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.other).withdraw(f.positionId, 1, f.other.address)).to.be.revertedWithCustomError(
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

			await f.market.connect(f.user).repay(f.positionId, E('4000'));

			const p = await f.market.getPosition(f.positionId);
			expect(p.borrowed).to.equal(E('5000'));
			expect(p.reserve).to.equal(E('1000'));
			expect(userBefore - (await f.stable.balanceOf(f.user.address))).to.equal(E('4000'));
			expect(await f.stable.balanceOf(f.marketAddr)).to.equal(E('1000'));
			expect(supply - (await f.stable.totalSupply())).to.equal(E('5000'));
			expect((await f.market.getMarket(1)).borrowed).to.equal(E('5000'));
		});

		it('closes the debt with borrowed - reserve and frees everything', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await f.market.connect(f.user).repay(f.positionId, E('8000'));

			const p = await f.market.getPosition(f.positionId);
			expect(p.borrowed).to.equal(0n);
			expect(p.reserve).to.equal(0n);
			expect(await f.stable.balanceOf(f.marketAddr)).to.equal(0n);
			expect((await f.market.getMarket(1)).borrowed).to.equal(0n);
		});

		it('anyone can repay for a position', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await f.market.connect(f.other).repay(f.positionId, E('8000'));
			expect((await f.market.getPosition(f.positionId)).borrowed).to.equal(0n);
		});

		it('rejects repaying more than borrowed - reserve', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.user).repay(f.positionId, E('8000') + 1n)).to.be.revertedWithCustomError(
				f.market,
				'RepaidTooMuch'
			);
		});

		it('repaying 0 is a no-op', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await f.market.connect(f.user).repay(f.positionId, 0);
			expect((await f.market.getPosition(f.positionId)).borrowed).to.equal(E('10000'));
		});

		it('is possible while challenged', async function () {
			const f = await loadFixture(fixtureWithChallenge);
			await f.market.connect(f.user).repay(f.positionId, E('1000'));
			expect((await f.market.getPosition(f.positionId)).borrowed).to.be.lt(E('10000'));
		});
	});

	describe('Price', function () {
		it('cannot exceed the market price or be 0', async function () {
			const f = await loadFixture(fixtureWithMarket);
			const { positionId } = await open(f);
			await expect(f.market.connect(f.user).setPrice(positionId, PRICE + 1n)).to.be.revertedWithCustomError(f.market, 'InvalidPrice');
			await expect(f.market.connect(f.user).setPrice(positionId, 0)).to.be.revertedWithCustomError(f.market, 'InvalidPrice');
		});

		it('can be lowered while the position stays covered', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.user).setPrice(f.positionId, E('9999'))).to.be.revertedWithCustomError(
				f.market,
				'InsufficientCollateral'
			);
			await f.market.connect(f.user).setPrice(f.positionId, E('10000'));
			expect((await f.market.getPosition(f.positionId)).price).to.equal(E('10000'));
			expect((await f.market.getPosition(f.positionId)).cooldown).to.equal(0n); // lowering has no cooldown
		});

		it('can at most double per step and starts a 5 day cooldown', async function () {
			const f = await loadFixture(fixtureWithMarket);
			const { positionId } = await open(f);
			await f.market.connect(f.user).setPrice(positionId, E('5000'));
			await expect(f.market.connect(f.user).setPrice(positionId, E('10001'))).to.be.revertedWithCustomError(f.market, 'InvalidPrice');

			const tx = await f.market.connect(f.user).setPrice(positionId, E('10000'));
			expect((await f.market.getPosition(positionId)).cooldown).to.equal((await blockTime(tx)) + 5n * DAY);

			await expect(f.market.connect(f.user).mint(positionId, 1, f.user.address)).to.be.revertedWithCustomError(f.market, 'Hot');
			await expect(f.market.connect(f.user).withdraw(positionId, 1, f.user.address)).to.be.revertedWithCustomError(f.market, 'Hot');

			await time.increase(5n * DAY + 1n);
			await f.market.connect(f.user).mint(positionId, E('100'), f.user.address);
		});

		it('rejects callers that are not authorized', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.other).setPrice(f.positionId, E('10000'))).to.be.revertedWithCustomError(
				f.market,
				'NotAuthorized'
			);
		});

		it('cannot be changed while challenged', async function () {
			const f = await loadFixture(fixtureWithChallenge);
			await expect(f.market.connect(f.user).setPrice(f.positionId, E('15000'))).to.be.revertedWithCustomError(f.market, 'Challenged');
		});

		it('cannot be changed at maturity', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await time.increaseTo((await f.market.getPosition(f.positionId)).maturity);
			await expect(f.market.connect(f.user).setPrice(f.positionId, E('15000'))).to.be.revertedWithCustomError(f.market, 'Expired');
		});
	});

	describe('Authorization', function () {
		it('lets an operator act, but not grant further access', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.user).setAuthorized(f.positionId, f.operator.address, true))
				.to.emit(f.market, 'Authorized')
				.withArgs(f.positionId, f.operator.address, true);
			expect(await f.market.isAuthorized(f.positionId, f.operator.address)).to.equal(true);

			await f.market.connect(f.operator).mint(f.positionId, E('100'), f.operator.address);
			await f.market.connect(f.operator).setPrice(f.positionId, E('20000'));
			await f.market.connect(f.operator).withdraw(f.positionId, 1, f.operator.address);

			await expect(f.market.connect(f.operator).setAuthorized(f.positionId, f.other.address, true)).to.be.revertedWithCustomError(
				f.market,
				'NotAuthorized'
			);
		});

		it('can be revoked', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await f.market.connect(f.user).setAuthorized(f.positionId, f.operator.address, true);
			await f.market.connect(f.user).setAuthorized(f.positionId, f.operator.address, false);
			await expect(f.market.connect(f.operator).mint(f.positionId, 1, f.operator.address)).to.be.revertedWithCustomError(
				f.market,
				'NotAuthorized'
			);
		});

		it('only the owner or an ERC721 approved address can grant it', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.other).setAuthorized(f.positionId, f.other.address, true)).to.be.revertedWithCustomError(
				f.market,
				'NotAuthorized'
			);
			await f.market.connect(f.user).approve(f.other.address, f.positionId);
			await f.market.connect(f.other).setAuthorized(f.positionId, f.operator.address, true);
			expect(await f.market.isAuthorized(f.positionId, f.operator.address)).to.equal(true);
		});

		it('lapses when the NFT is transferred', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await f.market.connect(f.user).setAuthorized(f.positionId, f.operator.address, true);
			await f.market.connect(f.user).transferFrom(f.user.address, f.other.address, f.positionId);

			expect(await f.market.isAuthorized(f.positionId, f.operator.address)).to.equal(false);
			expect(await f.market.isAuthorized(f.positionId, f.user.address)).to.equal(false);
			expect(await f.market.isAuthorized(f.positionId, f.other.address)).to.equal(true);
			await expect(f.market.connect(f.operator).mint(f.positionId, 1, f.operator.address)).to.be.revertedWithCustomError(
				f.market,
				'NotAuthorized'
			);

			await f.market.connect(f.other).setAuthorized(f.positionId, f.operator.address, true);
			await f.market.connect(f.operator).mint(f.positionId, E('100'), f.operator.address);
		});
	});

	describe('Challenge', function () {
		it('locks the challenger collateral and records the challenge', async function () {
			const f = await loadFixture(fixtureWithDebt);
			const tx = await f.market.connect(f.challenger).challenge(f.positionId, ONE / 2n, 0);
			await expect(tx).to.emit(f.market, 'ChallengeStarted').withArgs(f.challenger.address, f.positionId, ONE / 2n, 0);

			expect(await f.market.challengeCount()).to.equal(1n);
			const ch = await f.market.getChallenge(0);
			expect(ch.challenger).to.equal(f.challenger.address);
			expect(ch.positionId).to.equal(f.positionId);
			expect(ch.collateralSize).to.equal(ONE / 2n);
			expect(ch.startTime).to.equal(await blockTime(tx));
			expect((await f.market.getPosition(f.positionId)).challenged).to.equal(ONE / 2n);
			expect(await f.token.balanceOf(f.marketAddr)).to.equal(ONE + ONE / 2n);
		});

		it('rejects a price below the challenger minimum', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.challenger).challenge(f.positionId, ONE, PRICE + 1n)).to.be.revertedWithCustomError(
				f.market,
				'UnexpectedPrice'
			);
		});

		it('rejects too small and too large challenges', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.challenger).challenge(f.positionId, 0, 0)).to.be.revertedWithCustomError(f.market, 'ChallengeTooSmall');
			await expect(f.market.connect(f.challenger).challenge(f.positionId, MIN_BALANCE - 1n, 0)).to.be.revertedWithCustomError(
				f.market,
				'ChallengeTooSmall'
			);
			await expect(f.market.connect(f.challenger).challenge(f.positionId, ONE + 1n, 0)).to.be.revertedWithCustomError(
				f.market,
				'ChallengeTooLarge'
			);

			await f.market.connect(f.challenger).challenge(f.positionId, ONE - MIN_BALANCE / 2n, 0);
			// the remainder is below minBalance but it is everything that is left
			await f.market.connect(f.challenger).challenge(f.positionId, MIN_BALANCE / 2n, 0);
			await expect(f.market.connect(f.challenger).challenge(f.positionId, 1, 0)).to.be.revertedWithCustomError(f.market, 'ChallengeTooLarge');
		});

		it('rejects unknown positions and matured positions', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.challenger).challenge(99, ONE, 0)).to.be.revertedWithCustomError(f.market, 'InvalidPosition');
			await time.increaseTo((await f.market.getPosition(f.positionId)).maturity);
			await expect(f.market.connect(f.challenger).challenge(f.positionId, ONE, 0)).to.be.revertedWithCustomError(f.market, 'Expired');
		});

		it('blocks mint and withdraw while challenged', async function () {
			const f = await loadFixture(fixtureWithChallenge);
			await expect(f.market.connect(f.user).mint(f.positionId, 1, f.user.address)).to.be.revertedWithCustomError(f.market, 'Challenged');
			await expect(f.market.connect(f.user).withdraw(f.positionId, 1, f.user.address)).to.be.revertedWithCustomError(f.market, 'Challenged');
		});

		describe('averted (at or above the position price)', function () {
			it('a bidder buys the challenger collateral at the auction price', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				const elapsed = DURATION / 2n; // 2.5x the position price
				const price = curve(elapsed);
				expect(price).to.equal(E('50000'));
				const bidderStable = await f.stable.balanceOf(f.bidder.address);
				const challengerStable = await f.stable.balanceOf(f.challenger.address);
				const bidderToken = await f.token.balanceOf(f.bidder.address);

				await time.setNextBlockTimestamp(f.start + elapsed);
				await expect(f.market.connect(f.bidder).bid(f.challengeId, ONE))
					.to.emit(f.market, 'ChallengeAverted')
					.withArgs(f.positionId, f.challengeId, ONE);

				expect(bidderStable - (await f.stable.balanceOf(f.bidder.address))).to.equal(price);
				expect((await f.stable.balanceOf(f.challenger.address)) - challengerStable).to.equal(price);
				expect((await f.token.balanceOf(f.bidder.address)) - bidderToken).to.equal(ONE);

				const p = await f.market.getPosition(f.positionId);
				expect(p.challenged).to.equal(0n);
				expect(p.balance).to.equal(ONE); // the position is untouched
				expect(p.borrowed).to.equal(E('10000'));
				expect((await f.market.getChallenge(f.challengeId)).challenger).to.equal(ethers.ZeroAddress);
			});

			it('averting right after the challenge costs about 10x the position price', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				await time.setNextBlockTimestamp(f.start + 1n);
				const before = await f.stable.balanceOf(f.bidder.address);
				await f.market.connect(f.bidder).bid(f.challengeId, ONE);
				expect(before - (await f.stable.balanceOf(f.bidder.address))).to.equal(curve(1n));
				expect(curve(1n)).to.be.gt(E('199990'));
			});

			it('starts a cooldown on the position', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				const tx = await f.market.connect(f.bidder).bid(f.challengeId, ONE);
				expect((await f.market.getPosition(f.positionId)).cooldown).to.equal((await blockTime(tx)) + COOLDOWN_AVERTED);
				await expect(f.market.connect(f.user).mint(f.positionId, 1, f.user.address)).to.be.revertedWithCustomError(f.market, 'Hot');
			});

			it('can be averted partially', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				await f.market.connect(f.bidder).bid(f.challengeId, ONE / 4n);
				expect((await f.market.getChallenge(f.challengeId)).collateralSize).to.equal((ONE * 3n) / 4n);
				expect((await f.market.getPosition(f.positionId)).challenged).to.equal((ONE * 3n) / 4n);
			});

			it('the bid is capped at the remaining challenge size', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				const before = await f.token.balanceOf(f.bidder.address);
				await f.market.connect(f.bidder).bid(f.challengeId, ONE * 5n);
				expect((await f.token.balanceOf(f.bidder.address)) - before).to.equal(ONE);
			});
		});

		describe('succeeded (below the position price)', function () {
			const elapsed = (DURATION * 3n) / 4n; // price is 0.625x the position price

			it('sells the position collateral, repays the debt and the curator gets the excess', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				const t = f.start + elapsed;
				const offer = curve(elapsed);
				expect(offer).to.equal(E('12500'));
				const fee = reward(offer);
				const funds = offer - fee;
				const due = E('8000');
				const excess = funds - due; // the owner is liquidated: all of it goes to the curator
				expect(excess).to.equal(E('4000'));

				const supply = await f.stable.totalSupply();
				const bidderStable = await f.stable.balanceOf(f.bidder.address);
				const bidderToken = await f.token.balanceOf(f.bidder.address);
				const challengerStable = await f.stable.balanceOf(f.challenger.address);
				const challengerToken = await f.token.balanceOf(f.challenger.address);
				const ownerStable = await f.stable.balanceOf(f.user.address);
				const curatorStable = await f.stable.balanceOf(f.curator.address);

				await time.setNextBlockTimestamp(t);
				await expect(f.market.connect(f.bidder).bid(f.challengeId, ONE))
					.to.emit(f.market, 'ChallengeSucceeded')
					.withArgs(f.positionId, f.challengeId, offer, ONE);

				expect(bidderStable - (await f.stable.balanceOf(f.bidder.address))).to.equal(offer);
				expect((await f.token.balanceOf(f.bidder.address)) - bidderToken).to.equal(ONE);
				expect((await f.stable.balanceOf(f.challenger.address)) - challengerStable).to.equal(fee);
				expect((await f.token.balanceOf(f.challenger.address)) - challengerToken).to.equal(ONE);
				expect(await f.stable.balanceOf(f.user.address)).to.equal(ownerStable);
				expect((await f.stable.balanceOf(f.curator.address)) - curatorStable).to.equal(excess);

				const p = await f.market.getPosition(f.positionId);
				expect(p.balance).to.equal(0n);
				expect(p.borrowed).to.equal(0n);
				expect(p.reserve).to.equal(0n);
				expect(p.challenged).to.equal(0n);
				expect(p.cooldown).to.equal(t + COOLDOWN_SUCCEEDED);

				expect(await f.stable.balanceOf(f.marketAddr)).to.equal(0n);
				expect(supply - (await f.stable.totalSupply())).to.equal(E('10000')); // exactly the debt is gone
				expect((await f.market.getMarket(1)).borrowed).to.equal(0n);
				expect((await f.market.getMarket(1)).badDebt).to.equal(0n);
				expect(await f.token.balanceOf(f.marketAddr)).to.equal(0n);
			});

			it('the switch happens at the position price', async function () {
				// 1x is reached after ~68.4% of the duration: slightly before it is averted, slightly after it succeeded
				const before = await loadFixture(fixtureWithChallenge);
				await time.setNextBlockTimestamp(before.start + (DURATION * 68n) / 100n);
				await expect(before.market.connect(before.bidder).bid(before.challengeId, ONE)).to.emit(before.market, 'ChallengeAverted');

				const after = await loadFixture(fixtureWithChallenge);
				await time.setNextBlockTimestamp(after.start + (DURATION * 69n) / 100n);
				await expect(after.market.connect(after.bidder).bid(after.challengeId, ONE)).to.emit(after.market, 'ChallengeSucceeded');
			});

			it('a frozen owner cannot block the liquidation, the owner gets nothing anyway', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				await f.stable.connect(f.curator).setFreeze(f.user.address, 'frozen');
				const ownerStable = await f.stable.balanceOf(f.user.address);

				await time.setNextBlockTimestamp(f.start + elapsed);
				await f.market.connect(f.bidder).bid(f.challengeId, ONE);
				expect(await f.stable.balanceOf(f.user.address)).to.equal(ownerStable);
				expect((await f.market.getPosition(f.positionId)).balance).to.equal(0n);
			});

			it('writes off a shortfall as bad debt when the auction price is too low', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				const late = (DURATION * 9n) / 10n; // price is 0.1x the position price
				const offer = curve(late);
				expect(offer).to.equal(E('2000'));
				const funds = offer - reward(offer);
				const shortfall = E('8000') - funds;

				const supply = await f.stable.totalSupply();
				await time.setNextBlockTimestamp(f.start + late);
				await expect(f.market.connect(f.bidder).bid(f.challengeId, ONE)).to.emit(f.market, 'BadDebt').withArgs(1, shortfall, shortfall);

				expect((await f.market.getMarket(1)).badDebt).to.equal(shortfall);
				expect(await f.stable.balanceOf(f.marketAddr)).to.equal(0n);
				// everything but the shortfall was burned: that is exactly the unbacked amount
				expect(supply - (await f.stable.totalSupply())).to.equal(E('10000') - shortfall);
				// the shortfall does not free up capacity
				expect((await f.market.getMarket(1)).borrowed).to.equal(shortfall);
				expect((await f.market.getPosition(f.positionId)).borrowed).to.equal(0n);
			});

			it('coverBadDebt burns stablecoin against it and frees the capacity again', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				await time.setNextBlockTimestamp(f.start + DURATION); // price is 0
				await f.market.connect(f.bidder).bid(f.challengeId, ONE);

				const bad = (await f.market.getMarket(1)).badDebt;
				expect(bad).to.equal(E('8000')); // only the reserve was there to cover
				expect((await f.market.getMarket(1)).borrowed).to.equal(bad);

				const supply = await f.stable.totalSupply();
				await f.market.connect(f.other).coverBadDebt(1, E('3000'));
				expect((await f.market.getMarket(1)).badDebt).to.equal(bad - E('3000'));
				expect(supply - (await f.stable.totalSupply())).to.equal(E('3000'));

				await f.market.connect(f.other).coverBadDebt(1, MAX); // capped at what is left
				expect((await f.market.getMarket(1)).badDebt).to.equal(0n);
				expect((await f.market.getMarket(1)).borrowed).to.equal(0n);
			});

			it('partial bids settle the proportional debt', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				await time.setNextBlockTimestamp(f.start + elapsed);
				await f.market.connect(f.bidder).bid(f.challengeId, (ONE * 4n) / 10n);

				const p = await f.market.getPosition(f.positionId);
				expect(p.balance).to.equal((ONE * 6n) / 10n);
				expect(p.borrowed).to.equal(E('6000'));
				expect(p.reserve).to.equal(E('1200'));
				expect(p.challenged).to.equal((ONE * 6n) / 10n);
				expect((await f.market.getChallenge(f.challengeId)).collateralSize).to.equal((ONE * 6n) / 10n);
			});

			it('a challenge is gone once it is fully bid on', async function () {
				const f = await loadFixture(fixtureWithChallenge);
				await time.increaseTo(f.start + elapsed);
				await f.market.connect(f.bidder).bid(f.challengeId, ONE);
				await expect(f.market.connect(f.bidder).bid(f.challengeId, ONE)).to.be.revertedWithCustomError(f.market, 'InvalidChallenge');
			});
		});

		it('rejects bids on unknown challenges and empty bids', async function () {
			const f = await loadFixture(fixtureWithChallenge);
			await expect(f.market.connect(f.bidder).bid(99, ONE)).to.be.revertedWithCustomError(f.market, 'InvalidChallenge');
			await expect(f.market.connect(f.bidder).bid(f.challengeId, 0)).to.be.revertedWithCustomError(f.market, 'ChallengeTooSmall');
		});

		it('exposes the auction price: 10x at the start, falling to 0 at the end of the duration', async function () {
			const f = await loadFixture(fixtureWithChallenge);
			expect(await f.market.auctionPrice(f.challengeId)).to.be.gt(E('199000')); // right after the start: ~10x
			await time.increaseTo(f.start + DURATION / 2n);
			expect(await f.market.auctionPrice(f.challengeId)).to.be.closeTo(E('50000'), E('1'));
			expect(await f.market.auctionPrice(77)).to.equal(0n);
			await time.increaseTo(f.start + DURATION);
			expect(await f.market.auctionPrice(f.challengeId)).to.equal(0n);
		});
	});

	describe('Expired positions', function () {
		async function matured() {
			const f = await fixtureWithDebt();
			const p = await f.market.getPosition(f.positionId);
			return { ...f, maturity: p.maturity };
		}

		it('cannot be bought before maturity', async function () {
			const f = await loadFixture(fixtureWithDebt);
			await expect(f.market.connect(f.bidder).buyExpired(f.positionId, ONE)).to.be.revertedWithCustomError(f.market, 'NotExpired');
		});

		it('cannot be bought while challenged', async function () {
			const f = await loadFixture(fixtureWithChallenge);
			const p = await f.market.getPosition(f.positionId);
			await time.increaseTo(p.maturity);
			await expect(f.market.connect(f.bidder).buyExpired(f.positionId, ONE)).to.be.revertedWithCustomError(f.market, 'Challenged');
		});

		it('uses the same curve: 10x at maturity, falling to 0 at the end of the duration', async function () {
			const f = await loadFixture(matured);
			await time.increaseTo(f.maturity);
			expect(await f.market.expiredPrice(f.positionId)).to.be.closeTo(10n * PRICE, E('10'));
			await time.increaseTo(f.maturity + DURATION / 2n);
			expect(await f.market.expiredPrice(f.positionId)).to.be.closeTo(E('50000'), E('1'));
			await time.increaseTo(f.maturity + DURATION);
			expect(await f.market.expiredPrice(f.positionId)).to.equal(0n);
		});

		it('at or above the position price the curator gets the expiry fee on top of its profit share', async function () {
			const f = await loadFixture(matured);
			const elapsed = DURATION / 2n;
			const price = curve(elapsed);
			const fee = reward(price);
			const funds = price - fee;
			const excess = funds - E('8000');
			const profit = (excess * RESERVE) / ONE;
			const supply = await f.stable.totalSupply();
			const ownerBefore = await f.stable.balanceOf(f.user.address);
			const curatorBefore = await f.stable.balanceOf(f.curator.address);
			const tokenBefore = await f.token.balanceOf(f.bidder.address);

			await time.setNextBlockTimestamp(f.maturity + elapsed);
			await expect(f.market.connect(f.bidder).buyExpired(f.positionId, ONE * 5n))
				.to.emit(f.market, 'ExpiredBought')
				.withArgs(f.positionId, ONE, price);

			expect((await f.stable.balanceOf(f.user.address)) - ownerBefore).to.equal(excess - profit);
			expect((await f.stable.balanceOf(f.curator.address)) - curatorBefore).to.equal(fee + profit);
			expect((await f.token.balanceOf(f.bidder.address)) - tokenBefore).to.equal(ONE);
			expect(supply - (await f.stable.totalSupply())).to.equal(E('10000'));

			const p = await f.market.getPosition(f.positionId);
			expect(p.balance).to.equal(0n);
			expect(p.borrowed).to.equal(0n);
			expect((await f.market.getMarket(1)).borrowed).to.equal(0n);
		});

		it('below the position price there is no fee, the debt is cleared and the owner forfeits what is left', async function () {
			const f = await loadFixture(matured);
			const elapsed = (DURATION * 3n) / 4n; // 0.625x the position price
			const price = curve(elapsed);
			const excess = price - E('8000');
			const ownerBefore = await f.stable.balanceOf(f.user.address);
			const curatorBefore = await f.stable.balanceOf(f.curator.address);

			await time.setNextBlockTimestamp(f.maturity + elapsed);
			await f.market.connect(f.bidder).buyExpired(f.positionId, ONE);

			expect((await f.stable.balanceOf(f.curator.address)) - curatorBefore).to.equal(excess);
			expect(await f.stable.balanceOf(f.user.address)).to.equal(ownerBefore);
			expect((await f.market.getMarket(1)).badDebt).to.equal(0n);
		});

		it('writes off bad debt when the price is below the debt, without any fee', async function () {
			const f = await loadFixture(matured);
			const elapsed = (DURATION * 9n) / 10n; // 0.1x the position price
			const price = curve(elapsed);
			const curatorBefore = await f.stable.balanceOf(f.curator.address);

			await time.setNextBlockTimestamp(f.maturity + elapsed);
			await f.market.connect(f.bidder).buyExpired(f.positionId, ONE);

			expect((await f.market.getMarket(1)).badDebt).to.equal(E('8000') - price);
			expect(await f.stable.balanceOf(f.curator.address)).to.equal(curatorBefore);
		});

		it('is free once the duration has passed, leaving only the reserve to cover the debt', async function () {
			const f = await loadFixture(matured);
			await time.setNextBlockTimestamp(f.maturity + DURATION);
			await f.market.connect(f.bidder).buyExpired(f.positionId, ONE);
			expect((await f.market.getMarket(1)).badDebt).to.equal(E('8000'));
		});

		describe('curator proceeds cover bad debt first', function () {
			// position 1 is sold for free (8000 bad debt), then position 2 is opened and sold with an excess
			async function withBadDebt() {
				const f = await fixtureWithDebt();
				await time.increase(10n * DAY);
				const second = await open(f, E('10000'));
				const m1 = (await f.market.getPosition(f.positionId)).maturity;
				await time.setNextBlockTimestamp(m1 + DURATION);
				await f.market.connect(f.bidder).buyExpired(f.positionId, ONE);
				expect((await f.market.getMarket(1)).badDebt).to.equal(E('8000'));
				return { ...f, second: second.positionId, maturity: second.maturity };
			}

			it('what the owner forfeits reduces the bad debt, nothing is left for the curator', async function () {
				const f = await loadFixture(withBadDebt);
				const elapsed = (DURATION * 3n) / 4n; // no fee, the whole excess of 4500 is forfeited
				const profit = curve(elapsed) - E('8000');
				expect(profit).to.equal(E('4500'));
				const curatorBefore = await f.stable.balanceOf(f.curator.address);
				const supply = await f.stable.totalSupply();

				await time.setNextBlockTimestamp(f.maturity + elapsed);
				await expect(f.market.connect(f.bidder).buyExpired(f.second, ONE)).to.emit(f.market, 'BadDebt').withArgs(1, 0, E('3500'));

				const m = await f.market.getMarket(1);
				expect(m.badDebt).to.equal(E('3500'));
				expect(m.borrowed).to.equal(E('3500')); // capacity is freed with every repaid unit
				expect(await f.stable.balanceOf(f.curator.address)).to.equal(curatorBefore);
				expect(supply - (await f.stable.totalSupply())).to.equal(E('10000') + profit);
				expect(await f.stable.balanceOf(f.marketAddr)).to.equal(0n);
			});

			it('the expiry fee and the profit share clear the bad debt, the curator gets the rest', async function () {
				const f = await loadFixture(withBadDebt);
				const elapsed = DURATION / 2n; // fee = 2000, profit = 8000
				const price = curve(elapsed);
				const fee = reward(price);
				const profit = ((price - fee - E('8000')) * RESERVE) / ONE;
				expect(fee + profit).to.equal(E('10000'));
				const curatorBefore = await f.stable.balanceOf(f.curator.address);

				await time.setNextBlockTimestamp(f.maturity + elapsed);
				await f.market.connect(f.bidder).buyExpired(f.second, ONE);

				const m = await f.market.getMarket(1);
				expect(m.badDebt).to.equal(0n);
				expect(m.borrowed).to.equal(0n);
				expect((await f.stable.balanceOf(f.curator.address)) - curatorBefore).to.equal(E('10000') - E('8000'));
			});

			it('also applies to succeeded challenges', async function () {
				const f = await loadFixture(withBadDebt);
				await f.market.connect(f.challenger).challenge(f.second, ONE, 0);
				const ch = await f.market.getChallenge(0);
				const elapsed = (DURATION * 3n) / 4n;
				const profit = curve(elapsed) - reward(curve(elapsed)) - E('8000'); // the whole excess
				const curatorBefore = await f.stable.balanceOf(f.curator.address);

				await time.setNextBlockTimestamp(ch.startTime + elapsed);
				await f.market.connect(f.bidder).bid(0, ONE);

				expect((await f.market.getMarket(1)).badDebt).to.equal(E('8000') - profit);
				expect(await f.stable.balanceOf(f.curator.address)).to.equal(curatorBefore);
			});
		});

		it('supports partial purchases and returns 0 for an empty one', async function () {
			const f = await loadFixture(matured);
			await time.increaseTo(f.maturity + DURATION / 2n);
			await f.market.connect(f.bidder).buyExpired(f.positionId, ONE / 2n);
			const p = await f.market.getPosition(f.positionId);
			expect(p.balance).to.equal(ONE / 2n);
			expect(p.borrowed).to.equal(E('5000'));

			await f.market.connect(f.bidder).buyExpired(f.positionId, ONE);
			expect((await f.market.getPosition(f.positionId)).balance).to.equal(0n);
			await expect(f.market.connect(f.bidder).buyExpired(f.positionId, ONE)).to.not.be.reverted; // nothing left
		});

		it('debt can still be repaid after maturity', async function () {
			const f = await loadFixture(matured);
			await time.increaseTo(f.maturity + 1n);
			await f.market.connect(f.user).repay(f.positionId, E('8000'));
			expect((await f.market.getPosition(f.positionId)).borrowed).to.equal(0n);
		});
	});
});

import hardhat, { ethers, web3 } from "hardhat";
import { addressBook } from "blockchain-addressbook";
import { predictAddresses } from "../../utils/predictAddresses";
import { setCorrectCallFee } from "../../utils/setCorrectCallFee";
import { verifyContracts } from "../../utils/verifyContracts";

const registerSubsidy = require("../../utils/registerSubsidy");

const {
  USDC: { address: USDC },
  USDT: { address: USDT },
  QUICK: { address: QUICK },
  WMATIC: { address: WMATIC },
} = addressBook.polygon.tokens;
const { quickswap, beefyfinance } = addressBook.polygon.platforms;

const shouldVerifyOnEtherscan = false;

const want = web3.utils.toChecksumAddress("0x2cF7252e74036d1Da831d11089D326296e64a728");
const rewardPool = web3.utils.toChecksumAddress("0x251d9837a13f38f3fe629ce2304fa00710176222");

const vaultParams = {
  mooName: "Moo Quick USDC-USDT",
  mooSymbol: "mooQuickUSDC-USDT",
  delay: 21600,
};

const strategyParams = {
  want: want,
  rewardPool: rewardPool,
  unirouter: quickswap.router,
  strategist: "0xBa4cB13Ed28C6511d9fa29A0570Fd2f2C9D08cE3", // some address
  keeper: beefyfinance.keeper,
  beefyFeeRecipient: beefyfinance.beefyFeeRecipient,
  outputToNativeRoute: [QUICK, WMATIC],
  outputToLp0Route: [QUICK, USDC],
  outputToLp1Route: [QUICK, WMATIC, USDT],
};

const contractNames = {
  vault: "BeefyVaultV6",
  strategy: "StrategyPolygonQuickLP",
};

async function main() {
  if (
    Object.values(vaultParams).some(v => v === undefined) ||
    Object.values(strategyParams).some(v => v === undefined) ||
    Object.values(contractNames).some(v => v === undefined)
  ) {
    console.error("one of config values undefined");
    return;
  }

  await hardhat.run("compile");

  const Vault = await ethers.getContractFactory(contractNames.vault);
  const Strategy = await ethers.getContractFactory(contractNames.strategy);

  const [deployer] = await ethers.getSigners();

  console.log("Deploying:", vaultParams.mooName);

  const predictedAddresses = await predictAddresses({ creator: deployer.address });

  const vaultConstructorArguments = [
    predictedAddresses.strategy,
    vaultParams.mooName,
    vaultParams.mooSymbol,
    vaultParams.delay,
  ];
  const vault = await Vault.deploy(...vaultConstructorArguments, {gasPrice: 30000000000, gasLimit: 5000000});
  await vault.deployed();

  const strategyConstructorArguments = [
    strategyParams.want,
    strategyParams.rewardPool,
    vault.address,
    strategyParams.unirouter,
    strategyParams.keeper,
    strategyParams.strategist,
    strategyParams.beefyFeeRecipient,
    strategyParams.outputToNativeRoute,
    strategyParams.outputToLp0Route,
    strategyParams.outputToLp1Route,
  ];
  const strategy = await Strategy.deploy(...strategyConstructorArguments, {gasPrice: 30000000000, gasLimit: 5000000});
  await strategy.deployed();

  // add this info to PR
  console.log();
  console.log("Vault:", vault.address);
  console.log("Strategy:", strategy.address);
  console.log("Want:", strategyParams.want);
  console.log("RewardPool:", strategyParams.rewardPool);

  console.log();
  console.log("Running post deployment");

  if (shouldVerifyOnEtherscan) {
    await verifyContracts(vault, vaultConstructorArguments, strategy, strategyConstructorArguments);
  }
  await setCorrectCallFee(strategy, hardhat.network.name);
  console.log();

  if (hardhat.network.name === "bsc") {
    await registerSubsidy(vault.address, deployer);
    await registerSubsidy(strategy.address, deployer);
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });

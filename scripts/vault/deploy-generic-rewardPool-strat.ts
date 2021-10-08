import hardhat, { ethers, web3 } from "hardhat";
import { addressBook } from "blockchain-addressbook";
import { predictAddresses } from "../../utils/predictAddresses";
import { setCorrectCallFee } from "../../utils/setCorrectCallFee";
import { verifyContracts } from "../../utils/verifyContracts";

const registerSubsidy = require("../../utils/registerSubsidy");

const {
  UNI: { address: UNI }, //TODO 2
  ETH: {address: ETH},
  QUICK: { address: QUICK }, //TODO 3
  WMATIC: { address: WMATIC }, //TODO 4
} = addressBook.polygon.tokens;
const { quickswap, beefyfinance } = addressBook.polygon.platforms;

const shouldVerifyOnEtherscan = false; //TRUE IF DEPLOYING TO MAINNET

const want = web3.utils.toChecksumAddress("0xF7135272a5584Eb116f5a77425118a8B4A2ddfDb"); //TODO 5
const rewardPool = web3.utils.toChecksumAddress("0x76cC4059Dd19518c377934CD799615B3543967fd"); //TODO 6

const vaultParams = {
  mooName: "Moo Quick WETH-UNI", //TODO 7
  mooSymbol: "mooQuickWETH-UNI", //TODO 8
  delay: 21600,
};

const strategyParams = {
  want: want, 
  rewardPool: rewardPool,
  unirouter: quickswap.router,
  strategist: "0x6dcAB4d155CFfa74E65056fdC94164732D611E85", // CHECK IF KEEP OG STRAT ADDRESS
  keeper: beefyfinance.keeper,
  beefyFeeRecipient: beefyfinance.beefyFeeRecipient,
  outputToNativeRoute: [QUICK, WMATIC], //TODO 9
  outputToLp0Route: [QUICK, ETH], //TODO 10
  outputToLp1Route: [QUICK, ETH, UNI], //TODO 11
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

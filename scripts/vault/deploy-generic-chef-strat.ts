import hardhat, { ethers, web3 } from "hardhat";
import { addressBook } from "blockchain-addressbook";
import { predictAddresses } from "../../utils/predictAddresses";
import { setCorrectCallFee } from "../../utils/setCorrectCallFee";
import { setPendingRewardsFunctionName } from "../../utils/setPendingRewardsFunctionName";
import { verifyContracts } from "../../utils/verifyContracts";

const registerSubsidy = require("../../utils/registerSubsidy");

const {
  USDC: { address: USDC },
  WMATIC: { address: WMATIC },
} = addressBook.polygon.tokens;
const { quickswap, beefyfinance } = addressBook.polygon.platforms;

const polySAGE = "0x2ed945Dc703D85c80225d95ABDe41cdeE14e1992";
const sageChef = "0x0451b4893e4a77E7Eec3B25E816ed7FFeA1EBA68";

const shouldVerifyOnEtherscan = false;

const want = web3.utils.toChecksumAddress("0x62F089467e22de4bc1FB5EE605eDe7e782b76B29");

const vaultParams = {
  mooName: "Moo Polysage Quick USDC-SAGE",
  mooSymbol: "mooPolysageQuickUSDC-SAGE",
  delay: 21600,
};

const strategyParams = {
  want,
  poolId: 1,
  chef: sageChef,
  unirouter: quickswap.router,
  strategist: "0xBa4cB13Ed28C6511d9fa29A0570Fd2f2C9D08cE3", // some address
  keeper: beefyfinance.keeper,
  beefyFeeRecipient: beefyfinance.beefyFeeRecipient,
  outputToNativeRoute: [polySAGE, WMATIC],
  outputToLp0Route: [polySAGE, USDC],
  outputToLp1Route: [polySAGE],
  pendingRewardsFunctionName: "pendingSage", // used for rewardsAvailable(), use correct function name from masterchef
};

const contractNames = {
  vault: "BeefyVaultV6",
  strategy: "StrategyCommonChefLP",
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
  const vault = await Vault.deploy(...vaultConstructorArguments, {gasLimit: 5000000});
  await vault.deployed();

  const strategyConstructorArguments = [
    strategyParams.want,
    strategyParams.poolId,
    strategyParams.chef,
    vault.address,
    strategyParams.unirouter,
    strategyParams.keeper,
    strategyParams.strategist,
    strategyParams.beefyFeeRecipient,
    strategyParams.outputToNativeRoute,
    strategyParams.outputToLp0Route,
    strategyParams.outputToLp1Route,
  ];
  const strategy = await Strategy.deploy(...strategyConstructorArguments, {gasLimit: 5000000});
  await strategy.deployed();

  // add this info to PR
  console.log();
  console.log("Vault:", vault.address);
  console.log("Strategy:", strategy.address);
  console.log("Want:", strategyParams.want);
  console.log("PoolId:", strategyParams.poolId);

  console.log();
  console.log("Running post deployment");

  if (shouldVerifyOnEtherscan) {
    verifyContracts(vault, vaultConstructorArguments, strategy, strategyConstructorArguments);
  }
  await setCorrectCallFee(strategy, hardhat.network.name);
  await setPendingRewardsFunctionName(strategy, strategyParams.pendingRewardsFunctionName);
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

import hardhat, { ethers, web3 } from "hardhat";
import { addressBook } from "blockchain-addressbook";
import { predictAddresses } from "../../utils/predictAddresses";
import { setCorrectCallFee } from "../../utils/setCorrectCallFee";
import { setPendingRewardsFunctionName } from "../../utils/setPendingRewardsFunctionName";
import { verifyContracts } from "../../utils/verifyContracts";

const registerSubsidy = require("../../utils/registerSubsidy");

const {
  CRV: { address: CRV }, //TODO 1
  WFTM: { address: WFTM }, //TODO 2
  SPIRIT: { address: SPIRIT }, //TODO 3
} = addressBook.fantom.tokens;  //TODO 4
const { spiritswap, beefyfinance } = addressBook.fantom.platforms; //TODO 5

const shouldVerifyOnEtherscan = true;

const want = web3.utils.toChecksumAddress("0x374C8ACb146407Ef0AE8F82BaAFcF8f4EC1708CF"); //TODO 6

const vaultParams = {
  mooName: "Moo Spirit CRV-WFTM", //TODO 7
  mooSymbol: "mooSpiritCRV-WFTM", //TODO 8
  delay: 21600,
};

const strategyParams = {
  want,
  poolId: 10, //TODO 9
  chef: spiritswap.masterchef,
  unirouter: spiritswap.router,
  strategist: "0xBa4cB13Ed28C6511d9fa29A0570Fd2f2C9D08cE3", // STRATEGIST ADDRESS
  keeper: beefyfinance.keeper,
  beefyFeeRecipient: beefyfinance.beefyFeeRecipient,
  outputToNativeRoute: [SPIRIT, WFTM],   //TODO 10
  outputToLp0Route: [SPIRIT, WFTM, CRV], //TODO 11
  outputToLp1Route: [SPIRIT, WFTM],      //TODO 12
  pendingRewardsFunctionName: "pendingSpirit", // used for rewardsAvailable(), use correct function name from masterchef
};

const contractNames = {
  vault: "BeefyVaultV6",
  strategy: "StrategySpiritChefLP",
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

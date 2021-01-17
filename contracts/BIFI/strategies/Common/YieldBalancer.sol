// SPDX-License-Identifier: MIT

pragma solidity 0.6.12;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import "../../interfaces/beefy/IVault.sol";

/**
 * @title Yield Balancer
 * @author sirbeefalot
 * @dev It serves as a load balancer for multiple vaults that optimize the same asset.
 * Subvaults that serve as workers can't charge withdrawal fees to the balancer.
 */
contract YieldBalancer is Ownable, Pausable {
    using SafeERC20 for IERC20;
    using SafeMath for uint;

    /**
     * {want} - The token that the vault looks to maximize.
     * {vault} - The parent vault, entry and exit point for users.
     */
    address public want;
    address public immutable vault;

    /**
     * @dev Struct to store proposed candidates before they are accepted as workers.   
     */
    struct WorkerCandidate {
        address addr;
        uint256 proposedTime;
    }
    
    /**
     * @dev Variables for worker and candidate management.
     * {workers} - Array to keep track of active workers.
     * {workersMap} - Used to check if a worker exists. Prevents accepting a duplicate worker.
     * {candidates} - Array to keep track of potential workers that haven't been accepted/rejected.
     * {approvalDelay} - Seconds that have to pass after a candidate is proposed before it can be accepted.
     */
    address[] public workers;
    mapping (address => bool) public workersMap;
    WorkerCandidate[] public candidates;
    uint256 immutable approvalDelay;

    /**
     * {WORKERS_MAX} - Max number of workers that the balancer can manage. Prevents out of gas errors. 
     * {RATIO_MAX} - Aux const used to make sure all funds are allocated on rebalance.
     */
    uint8 constant public WORKERS_MAX = 12; 
    uint256 constant public RATIO_MAX = 10000;

    /**
     * @dev Used to protect vault users against vault hoping.
     * {WITHDRAWAL_FEE} - Fee taxed when a user withdraws funds. 10 === 0.1% fee.
     * {WITHDRAWAL_MAX} - Aux const used to safely calc the correct amounts.
     */
    uint256 constant public WITHDRAWAL_FEE = 10;
    uint256 constant public WITHDRAWAL_MAX = 10000;

    event CandidateProposed(address candidate);
    event CandidateAccepted(address candidate);
    event CandidateRejected(address candidate);
    event WorkerDeleted(address worker);

    /**
     * @notice Initializes the strategy
     * @param _want Address of the token to maximize.
     * @param _vault Address of the vault that will manage the strat.
     * @param _workers Array of vault addresses that will serve as workers.
     * @param _approvalDelay Delay in seconds before a candidate can be added as worker.
     */
    constructor(
        address _want,
        address _vault, 
        address[] memory _workers, 
        uint256 _approvalDelay
    ) public {
        want = _want;
        vault = _vault;
        approvalDelay = _approvalDelay;

        _addWorkers(_workers);
    }

    //--- USER FUNCTIONS ---//

    /**
     * @notice Puts the funds to work.
     * @dev Will send all the funds to the main worker, at index 0.
     */
    function deposit() public whenNotPaused {
        _workerDepositAll(0);
    }

    /**
     * @dev It withdraws {want} from the workers and sends it to the vault.
     * @param amount How much {want} to withdraw.
     */
    function withdraw(uint256 amount) external {
        require(msg.sender == vault, "!vault");

        uint256 wantBal = IERC20(want).balanceOf(address(this));

        if (wantBal < amount) {
            for (uint8 i = 0; i < workers.length; i++) {
                uint256 workerBal = _workerBalance(i);
                if (workerBal < amount.sub(wantBal)) {
                    _workerWithdrawAll(i);
                    wantBal = IERC20(want).balanceOf(address(this));
                } else {
                    _workerWithdraw(i, amount.sub(wantBal));
                    break;
                }
            }
        }

        wantBal = IERC20(want).balanceOf(address(this));
        uint256 _fee = wantBal.mul(WITHDRAWAL_FEE).div(WITHDRAWAL_MAX);
        IERC20(want).safeTransfer(vault, wantBal.sub(_fee));
    }

    //--- FUNDS REBALANCE ---//

    /**
     * @dev Sends all funds from a vault to another one.
     * @param fromIndex Index of worker to take funds from. 
     * @param toIndex Index of worker where funds will go.
     */
    function rebalancePair(uint8 fromIndex, uint8 toIndex) external onlyOwner {
        require(fromIndex < workers.length, "!from");   
        require(toIndex < workers.length, "!to");   

        _workerWithdrawAll(fromIndex);
        _workerDepositAll(toIndex);
    }

    /**
     * @dev Sends a subset funds from a vault to another one.
     * @param fromIndex Index of worker to take funds from. 
     * @param toIndex Index of worker where funds will go.
     * @param amount How much funds to send
     */
    function rebalancePairPartial(uint8 fromIndex, uint8 toIndex, uint256 amount) external onlyOwner {
        require(fromIndex < workers.length, "!from");   
        require(toIndex < workers.length, "!to");   

        _workerWithdraw(fromIndex, amount);
        _workerDepositAll(toIndex);
    }

    /**
     * @dev Rebalance all workers.
     * @param ratios Array containing the desired balance per worker. 
     */
    function rebalance(uint256[] memory ratios) external onlyOwner {
        require(ratios.length == workers.length, "!balance");
        require(_checkRatios(ratios), '!ratios');

        _workersWithdrawAll();
        uint256 wantBal = IERC20(want).balanceOf(address(this));

        for (uint8 i = 0; i < ratios.length; i++) {
            _workerDeposit(i, wantBal.mul(ratios[i]).div(RATIO_MAX));
        }
    }

    /** 
     * @dev Validates that 100% of the funds are allocated
     * @param ratios Array containing the desired balance ratio per worker. 
    */
    function _checkRatios(uint256[] memory ratios) pure internal returns (bool) {
        uint256 ratio = 0;
        for (uint8 i = 0; i < ratios.length; i++) {
            ratio += ratios[i];
        }
        return ratio == RATIO_MAX;
    }
    
    //--- CANDIDATE MANAGEMENT ---//

    /**
     * @dev Starts the process to add a new worker.
     * @param candidate Address of worker vault
     */
    function proposeCandidate(address candidate) external onlyOwner {
        require(candidate != address(0), "!zero");

        candidates.push(WorkerCandidate({
            addr: candidate,
            proposedTime: now
        }));
            
        emit CandidateProposed(candidate);
    }

    /**
     * @dev Adds a candidate to the worker pool. Can only be done after {approvalDelay} has passed.
     * @param index Index of candidate in the {candidates} array.
     */
    function acceptCandidate(uint8 index) external onlyOwner {
        require(index < candidates.length, "out of bounds");
        require(workers.length < WORKERS_MAX, "!capacity");

        WorkerCandidate memory candidate = candidates[index]; 
        require(candidate.proposedTime.add(approvalDelay) < now, "!delay");
        require(workersMap[candidate.addr] == false, "!unique");

        _removeCandidate(index);
        _addWorker(candidate.addr);

        emit CandidateAccepted(candidate.addr);
    }

    /**
     * @dev Cancels an attempt to add a worker. Useful in case of an erronoeus proposal,
     * or a bug found later in an upcoming candidate.
     * @param index Index of candidate in the {candidates} array.
     */
    function rejectCandidate(uint8 index) external onlyOwner {
        require(index < candidates.length, "out of bounds");

        emit CandidateRejected(candidates[index].addr);

        _removeCandidate(index);
    }   

    /** 
     * @dev Internal function to remove a candidate from the {candidates} array.
     * @param index Index of candidate in the {candidates} array.
    */
    function _removeCandidate(uint8 index) internal {
        candidates[index] = candidates[candidates.length-1];
        candidates.pop();
    } 

    //--- WORKER MANAGEMENT ---//

    /**
     * @dev Function to switch the order of any two workers. 
     * @param workerA Current index of worker A to switch.
     * @param workerB Current index of worker B to switch.
     */ 
    function switchWorkerOrder(uint8 workerA, uint8 workerB) external onlyOwner {
        require(workerA != workerB, "!same");
        require(workerA < workers.length, "A out of bounds");   
        require(workerB < workers.length, "B out of bounds");   

        address temp = workers[workerA];
        workers[workerA] = workers[workerB];
        workers[workerB] = temp;
    }

    /**
     * @dev Withdraws all {want} from a worker and removes it from the options. 
     * The main worker at index 0 can't be deleted.
     * @param index Index of worker to delete.
     */
    function deleteWorker(uint8 index) external onlyOwner {
        require(index != 0, "!main");
        require(index < workers.length, "out of bounds");   

        address worker = workers[index];
        IERC20(want).safeApprove(worker, 0);

        _workerWithdrawAll(index);
        _removeWorker(index);

        deposit();

        emit WorkerDeleted(worker);
    }

    /** 
     * @dev Removes a worker from the workers list and map.
     * @param workerIndex Index of worker in the array.
    */
    function _removeWorker(uint8 workerIndex) internal {
        address worker = workers[workerIndex];
        IERC20(want).approve(worker, 0);

        workersMap[worker] = false;

        workers[workerIndex] = workers[workers.length-1];
        workers.pop();
    } 

    /** 
     * @dev Adds a group of workers to the workers list and map.
     * @param _workers List of vault addresses.
    */
    function _addWorkers(address[] memory _workers) internal {
        for (uint8 i = 0; i < _workers.length; i++) {
            _addWorker(_workers[i]);
        }
    }

    /** 
     * @dev Adds worker to the workers list and map.
     * @param worker Address of the vault to use as worker.
    */
    function _addWorker(address worker) internal {
        workersMap[worker] = true;
        workers.push(worker); 
        IERC20(want).approve(worker, uint256(-1));
    } 

    //--- FUNDS MANAGEMENT HELPERS ---//

    /**
     * @dev Give or remove {want} allowance from all workers.
     * @param amount Allowance to set. Either '0' or 'uint(-1)' 
     */
    function _workersApprove(uint256 amount) internal {
        for (uint8 i = 0; i < workers.length; i++) {
            IERC20(want).approve(workers[i], amount);
        }
    }

    /**
     * @dev Deposits all {want} in the contract into the given worker.
     * @param workerIndex Index of the worker where the funds will go.
     */
    function _workerDepositAll(uint8 workerIndex) internal {
        uint256 wantBal = IERC20(want).balanceOf(address(this));
        IVault(workers[workerIndex]).deposit(wantBal);
    }

    /** 
     * @dev Internal function to deposit some {want} into a particular worker.
     * @param workerIndex Index of the worker to withdraw from.
     * @param amount How much {want} to deposit.
    */
    function _workerDeposit(uint8 workerIndex, uint256 amount) internal {
        IVault(workers[workerIndex]).deposit(amount);
    }

    /**
     * @dev Withdraws all {want} from all workers.
     */
    function _workersWithdrawAll() internal {
        for (uint8 i = 0; i < workers.length; i++) {
            _workerWithdrawAll(i);
        }
    }

    /** 
     * @dev Internal function to withdraw all {want} from a particular worker.
     * @param workerIndex Index of the worker to withdraw from.
    */
    function _workerWithdrawAll(uint8 workerIndex) internal {
        require(workerIndex < workers.length, "out of bounds");   

        address worker = workers[workerIndex];
        uint256 shares = IERC20(worker).balanceOf(address(this));

        IERC20(worker).approve(worker, shares);
        IVault(worker).withdraw(shares);
    }

    /** 
     * @dev Internal function to withdraw some {want} from a particular worker.
     * @param workerIndex Index of the worker to withdraw from.
     * @param amount How much {want} to withdraw.
    */
    function _workerWithdraw(uint8 workerIndex, uint256 amount) internal {
        require(workerIndex < workers.length, "out of bounds");   

        address worker = workers[workerIndex];
        uint256 pricePerFullShare = IVault(worker).getPricePerFullShare();
        uint256 shares = amount.mul(1e18).div(pricePerFullShare);

        IERC20(worker).approve(worker, shares);
        IVault(worker).withdraw(shares);
    }

    //--- STRATEGY LIFECYCLE METHODS ---//

    /**
     * @dev Function that has to be called as part of strat migration. It sends all the available funds back to the 
     * vault, ready to be migrated to the new strat.
     */ 
    function retireStrat() external {
        require(msg.sender == vault, "!vault");

       _workersWithdrawAll();

        uint256 wantBal = IERC20(want).balanceOf(address(this));
        IERC20(want).transfer(vault, wantBal);
    }

    /**
     * @dev Pauses deposits. Withdraws all funds from workers.
     */
    function panic() external onlyOwner {        
        _workersWithdrawAll();
        pause();
    }

    /**
     * @dev Pauses the strat. Current funds continue to farm but new deposits 
     * are not allowed.
     */
    function pause() public onlyOwner {
        _pause();
        _workersApprove(0);
    }

    /**
     * @dev Unpauses the strat and restarts farming.
     */
    function unpause() external onlyOwner {
        _unpause();
        _workersApprove(uint256(-1));
        deposit();
    }

    //--- VIEW FUNCTIONS ---//

    /**
     * @dev Calculates the total underlaying {want} held by the strat.
     * Takes into account both funds at hand, and funds allocated in workers.
     */
    function balanceOf() external view returns (uint256) {
        return balanceOfWant().add(balanceOfWorkers());
    }

    /**
     * @dev Calculates how much {want} the contract holds.
     */
    function balanceOfWant() public view returns (uint256) {
        return IERC20(want).balanceOf(address(this));
    }

    /**
     * @dev Calculates the total {want} locked in all workers.
     */
    function balanceOfWorkers() public view returns (uint256) {
        uint256 totalBal = 0;

        for (uint8 i = 0; i < workers.length; i++) {
            totalBal = totalBal.add(_workerBalance(i));
        }

        return totalBal;
    }

    /**
     * @dev How much {want} the balancer holds in a particular worker.
     * @param workerIndex Index of the worker to calculate balance.
     */
    function _workerBalance(uint8 workerIndex) internal view returns (uint256) {
        uint256 shares = IERC20(workers[workerIndex]).balanceOf(address(this));  
        uint256 pricePerShare = IVault(workers[workerIndex]).getPricePerFullShare();
        return shares.mul(pricePerShare).div(1e18);
    }
}
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MiniDEX} from "./MiniDEX.sol";

/// @notice Caller-funded two-leg arbitrage. No flash loan is needed for atomicity.
contract AtomicArbitrage is ReentrancyGuard {
    using SafeERC20 for IERC20;
    event Arbitrage(address indexed trader, address indexed dexBuy, address indexed dexSell, uint256 amountIn, uint256 intermediateAmount, uint256 amountOut, uint256 profit);
    function execute(address buy, uint256 buyPool, address sell, uint256 sellPool, address tokenIn, uint256 amountIn, uint256 minProfit, uint256 deadline)
        external nonReentrant returns (uint256 profit)
    {
        require(block.timestamp <= deadline, "Expired");
        require(buy != sell || buyPool != sellPool, "Same pool");
        (address a, address b,,,,) = MiniDEX(buy).pools(buyPool);
        require(tokenIn == a || tokenIn == b, "Invalid input token");
        address intermediate = tokenIn == a ? b : a;
        (address c, address d,,,,) = MiniDEX(sell).pools(sellPool);
        require((a == c && b == d), "Different pairs");
        IERC20 base = IERC20(tokenIn);
        uint256 beforeBalance = base.balanceOf(address(this));
        base.safeTransferFrom(msg.sender, address(this), amountIn);
        base.forceApprove(buy, amountIn);
        uint256 mid = MiniDEX(buy).swap(buyPool, tokenIn, amountIn, 1, deadline);
        IERC20(intermediate).forceApprove(sell, mid);
        uint256 result = MiniDEX(sell).swap(sellPool, intermediate, mid, amountIn + minProfit, deadline);
        require(result > amountIn && base.balanceOf(address(this)) >= beforeBalance + result, "No profit");
        profit = result - amountIn;
        base.safeTransfer(msg.sender, result);
        emit Arbitrage(msg.sender, buy, sell, amountIn, mid, result, profit);
    }
}

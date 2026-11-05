// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/// @notice Constant-product AMM with NFT receipts for fungible pool shares.
/// Fees stay in reserves, so all existing shares participate pro rata.
/// Supports ordinary ERC20s only (no fee-on-transfer or rebasing tokens).
contract MiniDEX is ERC721, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant FEE_BPS = 30;
    uint256 public constant BPS = 10_000;
    uint256 public constant MINIMUM_LIQUIDITY = 1000;
    struct Pool {
        address tokenA;
        address tokenB;
        uint256 reserveA;
        uint256 reserveB;
        uint256 totalShares;
        uint256 createdTimestamp;
    }
    struct Position {
        uint256 poolId;
        uint256 shares;
        uint256 depositedA;
        uint256 depositedB;
        uint256 createdTimestamp;
        address provider;
    }
    mapping(uint256 => Pool) public pools;
    mapping(bytes32 => uint256) public poolByPair;
    mapping(uint256 => Position) public positions;
    uint256 public poolCount;
    uint256 public positionCount;
    event PoolCreated(uint256 indexed poolId, address tokenA, address tokenB);
    event LiquidityAdded(uint256 indexed poolId, uint256 indexed tokenId, address indexed provider, uint256 amountA, uint256 amountB, uint256 shares);
    event LiquidityRemoved(uint256 indexed poolId, uint256 indexed tokenId, address indexed owner, uint256 amountA, uint256 amountB);
    event Swap(uint256 indexed poolId, address indexed trader, address tokenIn, uint256 amountIn, uint256 amountOut);

    constructor() ERC721("MiniDEX Liquidity Position", "MDLP") {}
    modifier timely(uint256 deadline) { require(block.timestamp <= deadline, "Expired"); _; }

    function createPool(address tokenX, address tokenY) external returns (uint256 id) {
        require(tokenX != tokenY && tokenX.code.length > 0 && tokenY.code.length > 0, "Invalid tokens");
        (address a, address b) = tokenX < tokenY ? (tokenX, tokenY) : (tokenY, tokenX);
        bytes32 key = keccak256(abi.encode(a, b));
        require(poolByPair[key] == 0, "Pool exists");
        id = ++poolCount;
        pools[id] = Pool(a, b, 0, 0, 0, block.timestamp);
        poolByPair[key] = id;
        emit PoolCreated(id, a, b);
    }

    /// @param desiredA Amount for pools[id].tokenA (canonical address order).
    function addLiquidity(uint256 id, uint256 desiredA, uint256 desiredB, uint256 minA, uint256 minB, uint256 deadline)
        external nonReentrant timely(deadline) returns (uint256 tokenId)
    {
        Pool storage p = pools[id];
        require(p.tokenA != address(0), "Unknown pool");
        uint256 a = desiredA;
        uint256 b = desiredB;
        uint256 shares;
        if (p.totalShares == 0) {
            require(a <= type(uint112).max && b <= type(uint112).max, "Reserve overflow");
            uint256 root = Math.sqrt(a * b);
            require(root > MINIMUM_LIQUIDITY, "Initial liquidity too small");
            shares = root - MINIMUM_LIQUIDITY;
            p.totalShares = MINIMUM_LIQUIDITY; // Permanently locked, never assigned to an NFT.
        } else {
            uint256 optimalB = Math.mulDiv(a, p.reserveB, p.reserveA);
            if (optimalB <= b) b = optimalB;
            else a = Math.mulDiv(b, p.reserveA, p.reserveB);
            shares = Math.min(Math.mulDiv(a, p.totalShares, p.reserveA), Math.mulDiv(b, p.totalShares, p.reserveB));
        }
        require(a > 0 && b > 0 && shares > 0, "Zero liquidity");
        require(a >= minA && b >= minB, "Liquidity slippage");
        require(p.reserveA + a <= type(uint112).max && p.reserveB + b <= type(uint112).max, "Reserve overflow");
        _pull(p.tokenA, a);
        _pull(p.tokenB, b);
        p.reserveA += a;
        p.reserveB += b;
        p.totalShares += shares;
        tokenId = ++positionCount;
        positions[tokenId] = Position(id, shares, a, b, block.timestamp, msg.sender);
        _safeMint(msg.sender, tokenId);
        emit LiquidityAdded(id, tokenId, msg.sender, a, b, shares);
    }

    function previewRemove(uint256 tokenId) public view returns (uint256 a, uint256 b) {
        ownerOf(tokenId); // Reverts for burned/nonexistent NFT.
        Position storage position = positions[tokenId];
        Pool storage p = pools[position.poolId];
        a = Math.mulDiv(position.shares, p.reserveA, p.totalShares);
        b = Math.mulDiv(position.shares, p.reserveB, p.totalShares);
    }

    function removeLiquidity(uint256 tokenId, uint256 minA, uint256 minB, uint256 deadline)
        external nonReentrant timely(deadline) returns (uint256 a, uint256 b)
    {
        require(ownerOf(tokenId) == msg.sender, "Not position owner");
        (a, b) = previewRemove(tokenId);
        require(a >= minA && b >= minB, "Liquidity slippage");
        Position storage position = positions[tokenId];
        Pool storage p = pools[position.poolId];
        p.totalShares -= position.shares;
        p.reserveA -= a;
        p.reserveB -= b;
        _burn(tokenId);
        IERC20(p.tokenA).safeTransfer(msg.sender, a);
        IERC20(p.tokenB).safeTransfer(msg.sender, b);
        emit LiquidityRemoved(position.poolId, tokenId, msg.sender, a, b);
    }

    function getAmountOut(uint256 id, address tokenIn, uint256 amountIn) public view returns (uint256) {
        Pool storage p = pools[id];
        require(p.tokenA != address(0) && (tokenIn == p.tokenA || tokenIn == p.tokenB), "Invalid pool/token");
        require(amountIn > 0 && amountIn <= type(uint112).max, "Invalid input");
        (uint256 rIn, uint256 rOut) = tokenIn == p.tokenA ? (p.reserveA, p.reserveB) : (p.reserveB, p.reserveA);
        require(rIn > 0 && rOut > 0, "Empty pool");
        uint256 inputWithFee = amountIn * (BPS - FEE_BPS);
        return Math.mulDiv(inputWithFee, rOut, rIn * BPS + inputWithFee);
    }

    function swap(uint256 id, address tokenIn, uint256 amountIn, uint256 minOut, uint256 deadline)
        external nonReentrant timely(deadline) returns (uint256 amountOut)
    {
        amountOut = getAmountOut(id, tokenIn, amountIn);
        require(amountOut > 0 && amountOut >= minOut, "Swap slippage");
        Pool storage p = pools[id];
        _pull(tokenIn, amountIn);
        address tokenOut;
        if (tokenIn == p.tokenA) {
            p.reserveA += amountIn;
            p.reserveB -= amountOut;
            tokenOut = p.tokenB;
        } else {
            p.reserveB += amountIn;
            p.reserveA -= amountOut;
            tokenOut = p.tokenA;
        }
        require(p.reserveA <= type(uint112).max && p.reserveB <= type(uint112).max, "Reserve overflow");
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
        emit Swap(id, msg.sender, tokenIn, amountIn, amountOut);
    }

    function _pull(address token, uint256 amount) private {
        uint256 beforeBalance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        require(IERC20(token).balanceOf(address(this)) - beforeBalance == amount, "Unsupported transfer fee");
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        ownerOf(tokenId);
        Position storage p = positions[tokenId];
        return string.concat("data:application/json;base64,", Base64.encode(bytes(string.concat(
            '{"name":"MiniDEX Position #', Strings.toString(tokenId),
            '","description":"Redeemable AMM liquidity shares. Fees accrue in pool reserves.","attributes":[{"trait_type":"Pool","value":', Strings.toString(p.poolId),
            '},{"trait_type":"Shares","value":"', Strings.toString(p.shares),
            '"},{"trait_type":"Created timestamp","value":', Strings.toString(p.createdTimestamp), '}]}'))));
    }
}

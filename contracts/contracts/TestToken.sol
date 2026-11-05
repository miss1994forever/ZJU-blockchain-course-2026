// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Local teaching token. Faucet is intentionally unrestricted; never use for real value.
contract TestToken is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 10_000 ether;
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}
    function faucet() external { _mint(msg.sender, FAUCET_AMOUNT); }
}

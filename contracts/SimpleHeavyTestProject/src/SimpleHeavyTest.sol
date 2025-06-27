// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract SimpleHeavyTest {
    uint256 public storedValue;

    function getValue() external view returns (uint256) {
        return storedValue;
    }

    function setValue(uint256 _val) external {
        storedValue = _val;
    }

    function heavyCompute() external view returns (uint256) {
        uint256 x = storedValue;
        for (uint256 i = 0; i < 100_000; i++) {
            x = uint256(keccak256(abi.encodePacked(x, i)));
        }
        return x;
    }
}

// SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.0;

import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "./IEuler.sol";
import "hardhat/console.sol";


contract LiquidationBot {
    address immutable owner;

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    struct LiquidationParams {
        address eulerAddr;
        address liquidationAddr;
        address execAddr;
        address swapAddr;

        bytes swapPath;

        address violator;
        address underlying;
        address collateral;
    }

    function liquidate(LiquidationParams memory liqParams) external onlyOwner {
        IEulerExec(liqParams.execAddr).deferLiquidityCheck(address(this), abi.encode(liqParams));
    }

    function onDeferredLiquidityCheck(bytes memory encodedData) external {
        // TODO check caller?
        LiquidationParams memory liqParams = abi.decode(encodedData, (LiquidationParams));

        IEulerLiquidation.LiquidationOpportunity memory liqOpp = IEulerLiquidation(liqParams.liquidationAddr).checkLiquidation(address(this), liqParams.violator, liqParams.underlying, liqParams.collateral);

        uint repay = liqOpp.repay;
        {
            //FIXME decimals
            //uint poolSize = IERC20(liqParams.collateral).balanceOf(liqParams.eulerAddr);
            //if (poolSize < liqOpp.yield) repay = poolSize * 1e18 / liqOpp.conversionRate;
        }

        IEulerLiquidation(liqParams.liquidationAddr).liquidate(liqParams.violator, liqParams.underlying, liqParams.collateral, repay, 0);

        IEulerSwap(liqParams.swapAddr).swapAndRepayUni(
            IEulerSwap.SwapUniExactOutputParams({
                subAccountIdIn: 0,
                subAccountIdOut: 0,
                amountOut: 0,   // amountOut is ignored by swap and repay
                amountInMaximum: type(uint).max,
                deadline: block.timestamp, // FIXME: deadline
                path: liqParams.swapPath
            }),
            0
        );
    }

    function raw(address to, bytes calldata data, uint value) external onlyOwner {
        (bool success, bytes memory result) = to.call{ value: value }(data);
        if (!success) revertBytes(result);
    }

    function revertBytes(bytes memory errMsg) internal pure {
        if (errMsg.length > 0) {
            assembly {
                revert(add(32, errMsg), mload(errMsg))
            }
        }

        revert("empty-error");
    }


    function uint2str(uint _i) internal pure returns (string memory _uintAsString) {
        if (_i == 0) {
            return "0";
        }
        uint j = _i;
        uint len;
        while (j != 0) {
            len++;
            j /= 10;
        }
        bytes memory bstr = new bytes(len);
        uint k = len;
        while (_i != 0) {
            k = k-1;
            uint8 temp = (48 + uint8(_i - _i / 10 * 10));
            bytes1 b1 = bytes1(temp);
            bstr[k] = b1;
            _i /= 10;
        }
        return string(bstr);
    }
}

// SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.0;

import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "./IEuler.sol";
import "hardhat/console.sol";



interface IERC20 {
    event Approval(address indexed owner, address indexed spender, uint value);
    event Transfer(address indexed from, address indexed to, uint value);

    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint);
    function balanceOf(address owner) external view returns (uint);
    function allowance(address owner, address spender) external view returns (uint);

    function approve(address spender, uint value) external returns (bool);
    function transfer(address to, uint value) external returns (bool);
    function transferFrom(address from, address to, uint value) external returns (bool);
}



contract LiquidationBot {
    address immutable owner;

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function raw(address to, bytes calldata data, uint value) external onlyOwner {
        (bool success, bytes memory result) = to.call{ value: value }(data);
        if (!success) revertBytes(result);
    }

    struct LiquidationParams {
        address eulerAddr;
        address liquidationAddr;
        address execAddr;
        address marketsAddr;

        address swapRouter;
        bytes swapPath;

        address violator;
        address underlying;
        address collateral;
    }

    function liquidate(LiquidationParams memory liqParams) external onlyOwner {
        IEulerExec(liqParams.execAddr).deferLiquidityCheck(address(this), abi.encode(liqParams));
    }

    function onDeferredLiquidityCheck(bytes memory encodedData) external {
        LiquidationParams memory liqParams = abi.decode(encodedData, (LiquidationParams));

        IEulerLiquidation.LiquidationOpportunity memory liqOpp = IEulerLiquidation(liqParams.liquidationAddr).checkLiquidation(address(this), liqParams.violator, liqParams.underlying, liqParams.collateral);

        uint repay = liqOpp.repay;
        {
            //FIXME decimals
            //uint poolSize = IERC20(liqParams.collateral).balanceOf(liqParams.eulerAddr);
            //if (poolSize < liqOpp.yield) repay = poolSize * 1e18 / liqOpp.conversionRate;
        }

        IEulerEToken collateralEToken = IEulerEToken(IEulerMarkets(liqParams.marketsAddr).underlyingToEToken(liqParams.collateral));
        IEulerDToken underlyingDToken = IEulerDToken(IEulerMarkets(liqParams.marketsAddr).underlyingToDToken(liqParams.underlying));

        IEulerLiquidation(liqParams.liquidationAddr).liquidate(liqParams.violator, liqParams.underlying, liqParams.collateral, repay, 0);

        uint owed = underlyingDToken.balanceOf(address(this));

        collateralEToken.withdraw(0, type(uint).max);

        uint myCollateralBalance = IERC20(liqParams.collateral).balanceOf(address(this));
        IERC20(liqParams.collateral).approve(liqParams.swapRouter, type(uint).max);

        ISwapRouter.ExactInputParams memory swapParams = ISwapRouter.ExactInputParams(
            liqParams.swapPath,
            address(this),
            block.timestamp + 1, // FIXME: deadline
            myCollateralBalance,
            0
        );


        ISwapRouter(liqParams.swapRouter).exactInput(swapParams);
        //require(false, uint2str(IERC20(liqParams.underlying).balanceOf(address(this))));
        //require(false, uint2str(IERC20(liqParams.collateral).balanceOf(address(this))));

        IERC20(liqParams.underlying).approve(liqParams.eulerAddr, type(uint).max);
        uint underlyingBalance = IERC20(liqParams.underlying).balanceOf(address(this));
        
        underlyingDToken.repay(0, type(uint).max);
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

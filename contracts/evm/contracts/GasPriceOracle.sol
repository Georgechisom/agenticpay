// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title GasPriceOracle
/// @notice Dynamic fee calculation with ERC-20 to ETH conversion rate support.
///         Provides gas price quotes with TTL for meta-transaction relayers.
contract GasPriceOracle {
    // ── State ────────────────────────────────────────────────────────────────

    address public owner;
    uint256 public baseFeePremium;     // Additional premium on top of base fee (in wei)
    uint256 public priorityFee;        // Priority fee for faster inclusion (in wei)

    struct FeeQuote {
        uint256 baseFee;
        uint256 priorityFee;
        uint256 maxFeePerGas;
        uint256 tokenFee;        // Fee in ERC-20 tokens (if applicable)
        uint256 validUntil;      // Quote expiry timestamp
    }

    struct GasPriceRecord {
        uint256 blockNumber;
        uint256 timestamp;
        uint256 baseFee;
        uint256 priorityFee;
        uint256 gasUsedRatio;
    }

    // Token address => price ratio (token per ETH, scaled by 1e18)
    mapping(address => uint256) public tokenPriceRatios;
    mapping(address => bool) public authorizedUpdaters;

    GasPriceRecord[] public priceHistory;     // Max 1000 entries
    uint256 public constant MAX_HISTORY = 1000;

    uint256 public emaAlpha = 20;             // EMA smoothing factor (20 = 20% weight), scaled by 100
    uint256 public lastEmaBaseFee;            // Latest EMA-smoothed base fee
    uint256 public lastEmaPriorityFee;        // Latest EMA-smoothed priority fee

    // ── Events ───────────────────────────────────────────────────────────────

    event PriceRatioUpdated(address indexed token, uint256 ratio);
    event BaseFeePremiumUpdated(uint256 oldPremium, uint256 newPremium);
    event PriorityFeeUpdated(uint256 oldFee, uint256 newFee);
    event UpdaterUpdated(address indexed updater, bool active);
    event GasPriceRecordAdded(uint256 blockNumber, uint256 baseFee, uint256 priorityFee);
    event EmaAlphaUpdated(uint256 oldAlpha, uint256 newAlpha);

    // ── Errors ───────────────────────────────────────────────────────────────

    error NotOwner();
    error NotAuthorized();
    error ZeroAddress();
    error InvalidRatio();
    error InvalidAlpha();

    // ── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyUpdater() {
        if (!authorizedUpdaters[msg.sender] && msg.sender != owner) revert NotAuthorized();
        _;
    }

    modifier onlyAuthorized() {
        if (!authorizedUpdaters[msg.sender] && msg.sender != owner) revert NotAuthorized();
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(uint256 _baseFeePremium, uint256 _priorityFee) {
        owner = msg.sender;
        baseFeePremium = _baseFeePremium;
        priorityFee = _priorityFee;
    }

    // ── Fee Quote ────────────────────────────────────────────────────────────

    function getQuote(address token, uint256 ttlSeconds) external view returns (FeeQuote memory quote) {
        uint256 baseFee = block.basefee;
        uint256 pFee = priorityFee;
        uint256 premium;
        assembly {
            premium := sload(baseFeePremium.slot)
        }
        uint256 maxFee;
        unchecked {
            maxFee = baseFee + premium + pFee;
        }

        uint256 tokenFee;
        if (token != address(0)) {
            uint256 ratio;
            assembly {
                mstore(0, token)
                mstore(0x20, tokenPriceRatios.slot)
                ratio := sload(keccak256(0, 0x40))
            }
            if (ratio > 0) {
                unchecked {
                    tokenFee = (maxFee * ratio) / 1e18;
                }
            }
        }

        uint256 validUntil;
        unchecked {
            validUntil = block.timestamp + ttlSeconds;
        }

        quote = FeeQuote({
            baseFee: baseFee,
            priorityFee: pFee,
            maxFeePerGas: maxFee,
            tokenFee: tokenFee,
            validUntil: validUntil
        });
    }

    function estimateGasCost(uint256 gasLimit) external view returns (uint256 costWei) {
        unchecked {
            return (block.basefee + baseFeePremium + priorityFee) * gasLimit;
        }
    }

    function estimateGasCostInToken(uint256 gasLimit, address token) external view returns (uint256 costTokens) {
        uint256 costWei;
        unchecked {
            costWei = (block.basefee + baseFeePremium + priorityFee) * gasLimit;
        }
        if (token != address(0)) {
            uint256 ratio;
            assembly {
                mstore(0, token)
                mstore(0x20, tokenPriceRatios.slot)
                ratio := sload(keccak256(0, 0x40))
            }
            if (ratio > 0) {
                unchecked {
                    costTokens = (costWei * ratio) / 1e18;
                }
            }
        }
    }

    // ── Price Feed Management ────────────────────────────────────────────────

    /// @notice Set the price ratio for a token.
    /// @param token ERC-20 token address.
    /// @param ratio Token units per 1 ETH (scaled by 1e18). E.g., 2000e18 means 1 ETH = 2000 tokens.
    function setPriceRatio(address token, uint256 ratio) external onlyUpdater {
        if (token == address(0)) revert ZeroAddress();
        if (ratio == 0) revert InvalidRatio();
        tokenPriceRatios[token] = ratio;
        emit PriceRatioUpdated(token, ratio);
    }

    /// @notice Batch update price ratios.
    function setPriceRatios(address[] calldata tokens, uint256[] calldata ratios) external onlyUpdater {
        uint256 len = tokens.length;
        require(len == ratios.length, "Length mismatch");
        for (uint256 i; i < len; ) {
            if (tokens[i] != address(0) && ratios[i] > 0) {
                tokenPriceRatios[tokens[i]] = ratios[i];
                emit PriceRatioUpdated(tokens[i], ratios[i]);
            }
            unchecked { ++i; }
        }
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    function setBaseFeePremium(uint256 newPremium) external onlyOwner {
        uint256 old = baseFeePremium;
        baseFeePremium = newPremium;
        emit BaseFeePremiumUpdated(old, newPremium);
    }

    function setPriorityFee(uint256 newFee) external onlyOwner {
        uint256 old = priorityFee;
        priorityFee = newFee;
        emit PriorityFeeUpdated(old, newFee);
    }

    function setUpdater(address updater, bool active) external onlyOwner {
        if (updater == address(0)) revert ZeroAddress();
        authorizedUpdaters[updater] = active;
        emit UpdaterUpdated(updater, active);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }

    // ── Gas Price Update ─────────────────────────────────────────────────────

    /// @notice Post new base fee and priority fee, updating EMA values.
    /// @param newBaseFee  Current network base fee (in wei).
    /// @param newPriorityFee  Priority fee for inclusion (in wei).
    function update(uint256 newBaseFee, uint256 newPriorityFee) external onlyAuthorized {
        _updateEma(newBaseFee, newPriorityFee);
    }

    // ── Historical Gas Price Storage ─────────────────────────────────────────

    /// @notice Store a new gas price record and update EMA values. Prunes oldest entry when history exceeds 1000.
    /// @param baseFee  Network base fee at this block (in wei).
    /// @param priorityFee  Priority fee observed at this block (in wei).
    /// @param gasUsedRatio  Ratio of gas used to gas limit at this block (scaled by 1e18).
    function recordGasPrice(
        uint256 baseFee,
        uint256 priorityFee,
        uint256 gasUsedRatio
    ) external onlyAuthorized {
        if (priceHistory.length >= MAX_HISTORY) {
            // Prune oldest entry by shifting the array
            for (uint256 i = 0; i < MAX_HISTORY - 1; ) {
                priceHistory[i] = priceHistory[i + 1];
                unchecked { ++i; }
            }
            priceHistory.pop();
        }

        priceHistory.push(GasPriceRecord({
            blockNumber: block.number,
            timestamp: block.timestamp,
            baseFee: baseFee,
            priorityFee: priorityFee,
            gasUsedRatio: gasUsedRatio
        }));

        _updateEma(baseFee, priorityFee);

        emit GasPriceRecordAdded(block.number, baseFee, priorityFee);
    }

    /// @notice Return the EMA-smoothed base fee.
    /// @return EMA base fee in wei.
    function getEmaBaseFee() public view returns (uint256) {
        return lastEmaBaseFee;
    }

    /// @notice Return the EMA-smoothed priority fee.
    /// @return EMA priority fee in wei.
    function getEmaPriorityFee() public view returns (uint256) {
        return lastEmaPriorityFee;
    }

    /// @notice Return historical gas price records in the block range [fromBlock, toBlock].
    /// @param fromBlock  Start block number (inclusive).
    /// @param toBlock    End block number (inclusive).
    /// @return records   Array of GasPriceRecord within the specified range.
    function getPriceHistory(uint256 fromBlock, uint256 toBlock)
        external
        view
        returns (GasPriceRecord[] memory records)
    {
        require(fromBlock <= toBlock, "Invalid block range");

        uint256 count = 0;
        uint256 len = priceHistory.length;

        // Count matching records
        for (uint256 i = 0; i < len; ) {
            if (priceHistory[i].blockNumber >= fromBlock && priceHistory[i].blockNumber <= toBlock) {
                count++;
            }
            unchecked { ++i; }
        }

        records = new GasPriceRecord[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < len; ) {
            if (priceHistory[i].blockNumber >= fromBlock && priceHistory[i].blockNumber <= toBlock) {
                records[idx] = priceHistory[i];
                idx++;
            }
            unchecked { ++i; }
        }
    }

    /// @notice Update the EMA smoothing factor. Alpha is scaled by 100 (e.g., 20 = 20%).
    /// @param alpha  New smoothing factor (must be 1–100).
    function setEmaAlpha(uint256 alpha) external onlyOwner {
        if (alpha == 0 || alpha > 100) revert InvalidAlpha();
        uint256 old = emaAlpha;
        emaAlpha = alpha;
        emit EmaAlphaUpdated(old, alpha);
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    /// @dev Update EMA values using the formula: EMA = alpha * newValue + (1 - alpha) * previousEMA.
    function _updateEma(uint256 newBaseFee, uint256 newPriorityFee) internal {
        uint256 alpha = emaAlpha;
        uint256 baseAlpha;
        uint256 oneMinusAlpha;
        unchecked {
            baseAlpha = alpha;
            oneMinusAlpha = 100 - alpha;
        }

        if (lastEmaBaseFee == 0) {
            // First record — initialize EMA to the new value
            lastEmaBaseFee = newBaseFee;
            lastEmaPriorityFee = newPriorityFee;
        } else {
            unchecked {
                lastEmaBaseFee = (baseAlpha * newBaseFee + oneMinusAlpha * lastEmaBaseFee) / 100;
                lastEmaPriorityFee = (baseAlpha * newPriorityFee + oneMinusAlpha * lastEmaPriorityFee) / 100;
            }
        }
    }
}

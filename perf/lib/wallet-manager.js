/**
 * Wallet Manager Module
 * 
 * Handles wallet generation and transaction building
 */

import ethgo from 'k6/x/ethgo';
import wallet from 'k6/x/ethgo/wallet';
import { jsonCall } from './rpc-client.js';
import { configManager } from './config-loader.js';

// Get configuration
const rpcConfig = configManager.getRpcConfig();
const blockchain = rpcConfig.blockchain;
const contracts = rpcConfig.contracts;

/**
 * Generate test wallets
 * @param {number} count - Number of wallets to generate
 * @returns {array} Array of wallet objects
 */
export function generateWallets(count) {
    return Array.from({ length: count }, (_, index) => {
        const acc = wallet.generateKey();
        return { 
            pk: acc.private_key, 
            addr: acc.address,
            index: index,
            nonce: 0
        };
    });
}

/**
 * Build and sign a raw transaction
 * @param {string} url - RPC endpoint URL
 * @param {object} wallet - Wallet object with pk and addr
 * @param {string} to - Recipient address
 * @param {number|BigInt} value - Transaction value in wei
 * @param {string} data - Transaction data
 * @param {object} options - Additional options
 * @returns {string} Signed raw transaction
 */
export function buildRawTx(url, wallet, to, value, data, options = {}) {
    const chainId = blockchain.chainId;
    
    // Get current nonce for the wallet
    const nonce = Number(jsonCall(url, 'eth_getTransactionCount', [wallet.addr, 'pending'], {
        op: 'get_nonce',
        wallet_addr: wallet.addr
    }));
    
    // Get current gas price with buffer
    const currentGasPrice = Number(jsonCall(url, 'eth_gasPrice', [], { op: 'get_gas_price' }));
    const gasPrice = options.gasPrice || Math.floor(currentGasPrice * blockchain.gasPriceMultiplier);
    
    // Estimate gas limit based on transaction type
    let gasLimit;
    if (options.gasLimit) {
        gasLimit = options.gasLimit;
    } else if (data === '0x' || !data) {
        gasLimit = blockchain.defaultGasLimit.simple;
    } else if (data.startsWith(contracts.erc20TransferSig)) {
        gasLimit = blockchain.defaultGasLimit.erc20;
    } else {
        gasLimit = blockchain.defaultGasLimit.contract;
    }
    
    // Build and sign transaction
    const txParams = {
        nonce: nonce,
        gasPrice: gasPrice,
        gas: gasLimit,
        to: to,
        value: value,
        data: data || '0x',
        chainId: chainId
    };
    
    try {
        return ethgo.signLegacyTx(txParams, wallet.pk);
    } catch (e) {
        console.error(`Failed to sign transaction for wallet ${wallet.addr}: ${e.message}`);
        throw e;
    }
}

/**
 * Build ERC20 transfer data
 * @param {string} recipient - Recipient address
 * @param {BigInt} amount - Token amount
 * @returns {string} Encoded transfer data
 */
export function buildERC20TransferData(recipient, amount) {
    const functionSig = contracts.erc20TransferSig;
    const recipientPadded = recipient.replace(/^0x/, '').padStart(64, '0');
    const amountHex = amount.toString(16).padStart(64, '0');
    return functionSig + recipientPadded + amountHex;
}

/**
 * Fund wallets with ETH
 * @param {string} fundUrl - RPC endpoint for funding
 * @param {array} wallets - Array of wallets to fund
 * @param {string} basePrivKey - Base wallet private key
 * @param {string} baseAddr - Base wallet address
 * @param {function} sleepFn - Sleep function
 */
export function fundWallets(fundUrl, wallets, basePrivKey, baseAddr, sleepFn) {
    const batchSize = rpcConfig.performance.batchSize;
    const fundingAmount = BigInt(rpcConfig.tokens.defaultFundingAmount);
    
    let baseNonce = Number(jsonCall(fundUrl, 'eth_getTransactionCount', [baseAddr, 'pending'], { op: 'get_nonce' }));
    const currentGasPrice = Number(jsonCall(fundUrl, 'eth_gasPrice', [], { op: 'get_gas_price' }));
    const gasPrice = Math.floor(currentGasPrice * blockchain.gasPriceMultiplier);
    
    console.log(`Funding ${wallets.length} wallets with ${fundingAmount} wei each`);
    console.log(`Base nonce: ${baseNonce}, Gas price: ${gasPrice}`);
    
    for (let i = 0; i < wallets.length; i += batchSize) {
        const batch = wallets.slice(i, i + batchSize);
        
        batch.forEach((w, batchIndex) => {
            const nonce = baseNonce + i + batchIndex;
            const raw = ethgo.signLegacyTx({
                nonce: nonce,
                gasPrice: gasPrice,
                gas: blockchain.defaultGasLimit.simple,
                to: w.addr,
                value: fundingAmount,
                data: '0x',
                chainId: blockchain.chainId
            }, basePrivKey);
            
            const txHash = jsonCall(fundUrl, 'eth_sendRawTransaction', [raw], { 
                op: 'fund_wallet',
                wallet_index: w.index,
                nonce: nonce
            });
            
            if (txHash) {
                w.fundingTx = txHash;
            }
        });
        
        if (i + batchSize < wallets.length) {
            sleepFn(0.1);
        }
    }
    
    return baseNonce + wallets.length;
}

/**
 * Distribute ERC20 tokens to wallets
 * @param {string} fundUrl - RPC endpoint
 * @param {array} wallets - Array of wallets
 * @param {string} basePrivKey - Base wallet private key
 * @param {string} erc20Addr - ERC20 contract address
 * @param {number} baseNonce - Starting nonce
 * @param {function} sleepFn - Sleep function
 */
export function distributeERC20Tokens(fundUrl, wallets, basePrivKey, erc20Addr, baseNonce, sleepFn) {
    const batchSize = rpcConfig.performance.batchSize;
    const tokenDecimals = rpcConfig.tokens.defaultDecimals;
    const tokenAmount = (BigInt(10) ** BigInt(tokenDecimals)) / BigInt(rpcConfig.tokens.erc20AirdropDivisor);
    
    const currentGasPrice = Number(jsonCall(fundUrl, 'eth_gasPrice', [], { op: 'get_gas_price' }));
    const gasPrice = Math.floor(currentGasPrice * blockchain.gasPriceMultiplier);
    
    console.log(`Distributing ${tokenAmount} tokens to ${wallets.length} wallets`);
    
    for (let i = 0; i < wallets.length; i += batchSize) {
        const batch = wallets.slice(i, i + batchSize);
        
        batch.forEach((w, batchIndex) => {
            const nonce = baseNonce + i + batchIndex;
            const data = buildERC20TransferData(w.addr, tokenAmount);
            
            const raw = ethgo.signLegacyTx({
                nonce: nonce,
                gasPrice: gasPrice,
                gas: blockchain.defaultGasLimit.erc20,
                to: erc20Addr,
                value: 0,
                data: data,
                chainId: blockchain.chainId
            }, basePrivKey);
            
            const txHash = jsonCall(fundUrl, 'eth_sendRawTransaction', [raw], { 
                op: 'token_airdrop',
                wallet_index: w.index,
                amount: tokenAmount.toString()
            });
            
            if (txHash) {
                w.tokenAirdropTx = txHash;
            }
        });
        
        if (i + batchSize < wallets.length) {
            sleepFn(0.1);
        }
    }
}
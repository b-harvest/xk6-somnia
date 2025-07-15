/**
 * Modular k6 Ethereum RPC Performance Testing Script
 * 
 * This script uses modular configuration and components for better maintainability
 * All configuration is loaded from JSON files in the config directory
 * 
 * @version 2.0.0
 */

// Core imports
import { sleep, check } from 'k6';
import { randomBytes } from 'k6/crypto';

// Module imports
import { configManager } from './lib/config-loader.js';
import { jsonCall, get, post } from './lib/rpc-client.js';
import { wsSub } from './lib/websocket-client.js';
import { 
    generateWallets, 
    buildRawTx, 
    buildERC20TransferData,
    fundWallets,
    distributeERC20Tokens
} from './lib/wallet-manager.js';
import { 
    recordSuccess, 
    recordFailure, 
    addRTT 
} from './lib/metrics.js';

// Load configuration
configManager.loadAll();
const rpcConfig = configManager.getRpcConfig();
const envConfig = configManager.getEnvironment();

// Global run identifier
let RUN_ID;

// Environment variables with defaults from config
const SCENARIO = (__ENV.SCENARIO_TYPE || envConfig.defaults.scenario).trim();
const PROFILE = (__ENV.LOAD_PROFILE || envConfig.defaults.profile).trim().toLowerCase();

// RPC endpoints
const RPC_URLS = (__ENV.RPC_URLS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

if (RPC_URLS.length === 0) {
    throw new Error('At least one RPC_URL must be provided in RPC_URLS environment variable');
}

const PER_RPC_VU = Number(__ENV.PER_RPC_VU || envConfig.defaults.perRpcVu);
const VU_COUNT = Math.max(1, RPC_URLS.length * PER_RPC_VU);

// Get configuration values
const blockchain = rpcConfig.blockchain;
const contracts = rpcConfig.contracts;
const tokens = rpcConfig.tokens;
const validation = rpcConfig.validation;

// Contract and wallet configuration from environment
const CONTRACT = (__ENV.CONTRACT_ADDRESS || contracts.defaultContract).toLowerCase();
const SIMPLE_SIG = __ENV.SIMPLE_SIG || contracts.simpleFunctionSig;
const HEAVY_SIG = __ENV.HEAVY_SIG || contracts.heavyFunctionSig;

const BASE_PRIV = (__ENV.PRIVATE_KEY || '').replace(/^0x/, '');
const BASE_ADDR = (__ENV.WALLET_ADDRESS || '').toLowerCase();
const CHAIN_ID = Number(__ENV.CHAIN_ID || blockchain.chainId);

const ERC20_ADDR = (__ENV.ERC20_TOKEN || '').toLowerCase();
const TOKEN_DECIMALS = Number(__ENV.TOKEN_DECIMALS || tokens.defaultDecimals);
const LOG_TOPIC = __ENV.LOG_TOPIC || rpcConfig.events.defaultLogTopic;

// Performance settings
const WALLET_CNT = Number(__ENV.WALLET_COUNT || rpcConfig.performance.walletCount);

// Get write scenarios from config
const WRITE_SCENARIOS = configManager.getWriteScenarios();

// Validate scenario requirements
const requirements = configManager.getScenarioRequirements(SCENARIO);
if (requirements.requiresWallet && WRITE_SCENARIOS.includes(SCENARIO)) {
    if (!BASE_PRIV || !BASE_ADDR) {
        throw new Error('PRIVATE_KEY and WALLET_ADDRESS are required for write scenarios');
    }
}
if (requirements.requiresERC20 && !ERC20_ADDR) {
    throw new Error('ERC20_TOKEN address is required for ERC20 scenarios');
}

// Current log block for log queries
let currentLogBlock = null;

// Export k6 options
export const options = {
    setupTimeout: envConfig.timeouts.setup,
    teardownTimeout: envConfig.timeouts.teardown,
    scenarios: {
        main: {
            exec: 'main_scenario',
            ...configManager.buildK6Profile(PROFILE, VU_COUNT)
        }
    }
};

/**
 * Setup phase - prepare wallets and initial state
 */
export function setup() {
    const now = new Date();
    const pad = n => n.toString().padStart(2, '0');
    const YYYYMMDD = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const HHMMSS = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const runId = `${envConfig.test.runIdPrefix}_${YYYYMMDD}_${HHMMSS}_${SCENARIO}_${PROFILE}`;
    
    console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        message: 'Starting test setup',
        run_id: runId,
        scenario: SCENARIO,
        profile: PROFILE,
        wallet_count: WALLET_CNT,
        rpc_urls: RPC_URLS.length
    }));

    // Generate test wallets
    const wallets = generateWallets(WALLET_CNT);
    console.log(`Generated ${wallets.length} test wallets`);

    // Fund wallets for write scenarios
    if (WRITE_SCENARIOS.includes(SCENARIO)) {
        console.log('Funding wallets for write scenarios...');
        const fundUrl = RPC_URLS[0];
        
        // Fund wallets with ETH
        let baseNonce = fundWallets(fundUrl, wallets, BASE_PRIV, BASE_ADDR, sleep);

        // Distribute ERC20 tokens if needed
        if (SCENARIO === 'S12_SendRawTxERC20') {
            distributeERC20Tokens(fundUrl, wallets, BASE_PRIV, ERC20_ADDR, baseNonce, sleep);
        }
        
        // Wait for transactions to be mined
        console.log('Waiting for funding transactions to be processed...');
        sleep(envConfig.delays.fundingWait);
    }

    console.log('Setup complete.');
    return { wallets, runId };
}

/**
 * Main test scenario execution
 */
export function main_scenario(data) {
    // Initialize run ID
    if (RUN_ID === undefined) {
        RUN_ID = data.runId;
        globalThis.RUN_ID = RUN_ID; // Make available globally
    }

    // Distribute VUs across RPC endpoints
    const endpointIndex = (__VU - 1) % RPC_URLS.length;
    const rpcUrl = RPC_URLS[endpointIndex];
    const wsUrl = rpcUrl.replace(/^http/, 'ws');
    
    // Assign wallet to VU
    const walletIndex = (__VU - 1) % data.wallets.length;
    const testWallet = data.wallets[walletIndex];

    // Get scenario configuration
    const scenarioConfig = configManager.getScenario(SCENARIO);

    switch (SCENARIO) {
        // Basic RPC method tests
        case 'S1_BlockNumber':
            return jsonCall(rpcUrl, 'eth_blockNumber', [], {}, 
                result => typeof result === 'string' && result.startsWith('0x'));

        case 'S2_ChainId':
            return jsonCall(rpcUrl, 'eth_chainId', [], {}, 
                result => typeof result === 'string' && parseInt(result, 16) === CHAIN_ID);

        case 'S3_GetBalance':
            return jsonCall(rpcUrl, 'eth_getBalance', [testWallet.addr, 'latest'], 
                { wallet_addr: testWallet.addr },
                result => typeof result === 'string' && result.startsWith('0x'));

        case 'S4_GetCode':
            return jsonCall(rpcUrl, 'eth_getCode', [testWallet.addr, 'latest'],
                { wallet_addr: testWallet.addr },
                result => typeof result === 'string');

        // Smart contract interaction tests
        case 'S5_EthCallSimple':
            return jsonCall(rpcUrl, 'eth_call', 
                [{ to: CONTRACT, data: SIMPLE_SIG }, 'latest'],
                { contract_addr: CONTRACT, call_type: 'simple' },
                result => typeof result === 'string' && result.startsWith('0x'));

        case 'S6_EthCallHeavy':
            return jsonCall(rpcUrl, 'eth_call', 
                [{ to: CONTRACT, data: HEAVY_SIG }, 'latest'],
                { contract_addr: CONTRACT, call_type: 'heavy' },
                result => typeof result === 'string' && result.startsWith('0x'));

        // Log queries
        case 'S7_GetLogsSmall': {
            if (currentLogBlock === null) {
                const latestHex = jsonCall(rpcUrl, 'eth_blockNumber', [], { op: 'get_latest_block' });
                if (!latestHex) return null;
                currentLogBlock = Number(latestHex) - validation.blockHistoryDepth;
            }
            
            const fromBlock = currentLogBlock;
            const toBlock = currentLogBlock + Number(__ENV.LOG_BLOCK_RANGE || validation.logBlockRange);
            currentLogBlock = toBlock + 1;
            
            const fromHex = '0x' + fromBlock.toString(16);
            const toHex = '0x' + toBlock.toString(16);
            
            return jsonCall(
                rpcUrl,
                'eth_getLogs',
                [{ 
                    fromBlock: fromHex, 
                    toBlock: toHex, 
                    topics: [LOG_TOPIC],
                    address: __ENV.LOG_ADDRESS || undefined
                }],
                { 
                    fromBlock: fromHex, 
                    toBlock: toHex,
                    block_range: toBlock - fromBlock + 1
                }
            );
        }

        case 'S8_GetLogsRange': {
            const from = __ENV.START_BLOCK || '0x0';
            const to = __ENV.END_BLOCK || '0x3e8';
            return jsonCall(rpcUrl, 'eth_getLogs', [{ fromBlock: from, toBlock: to, topics: [] }]);
        }

        // Block queries
        case 'S9_GetBlockLight':
        case 'S10_GetBlockFull': {
            const includeTransactions = SCENARIO === 'S10_GetBlockFull';
            let targetHex;

            if (__ENV.TARGET_BLOCK) {
                targetHex = __ENV.TARGET_BLOCK;
            } else {
                const latestHex = jsonCall(rpcUrl, 'eth_blockNumber', []);
                if (!latestHex) return null;
                const latestNum = Number(latestHex);
                const offset = Math.floor(Math.random() * validation.maxBlockOffset);
                const targetNum = latestNum - offset;
                targetHex = '0x' + targetNum.toString(16);
            }
            
            return jsonCall(
                rpcUrl,
                'eth_getBlockByNumber',
                [targetHex, includeTransactions],
                { block: targetHex }
            );
        }

        // Transaction sending
        case 'S11_SendRawTxSmall': {
            const transferAmount = BigInt(__ENV.TRANSFER_AMOUNT || tokens.defaultTransferAmount);
            const raw = buildRawTx(rpcUrl, testWallet, testWallet.addr, transferAmount, '0x');
            return jsonCall(rpcUrl, 'eth_sendRawTransaction', [raw], 
                { 
                    tx_type: 'self_transfer',
                    wallet_addr: testWallet.addr,
                    amount: transferAmount.toString()
                },
                result => typeof result === 'string' && result.startsWith('0x') && result.length === 66);
        }

        case 'S12_SendRawTxERC20': {
            const tokenAmount = (BigInt(10) ** BigInt(TOKEN_DECIMALS)) / BigInt(tokens.erc20TransferDivisor);
            const transferData = buildERC20TransferData(testWallet.addr, tokenAmount);
            
            const sender = { pk: BASE_PRIV, addr: BASE_ADDR };
            const raw = buildRawTx(rpcUrl, sender, ERC20_ADDR, 0, transferData);
            
            return jsonCall(rpcUrl, 'eth_sendRawTransaction', [raw], 
                {
                    tx_type: 'erc20_transfer',
                    token_addr: ERC20_ADDR,
                    recipient: testWallet.addr,
                    amount: tokenAmount.toString()
                },
                result => typeof result === 'string' && result.startsWith('0x') && result.length === 66);
        }

        // WebSocket subscriptions
        case 'S13_PendingTxSub':
            return wsSub(wsUrl, rpcUrl, 'eth_subscribe', ['newPendingTransactions']);

        case 'S14_NewHeadSub':
            return wsSub(wsUrl, rpcUrl, 'eth_subscribe', ['newHeads']);

        case 'S15_LogsSubFilter':
            return wsSub(wsUrl, rpcUrl, 'eth_subscribe', ['logs', { 
                address: CONTRACT,
                topics: [LOG_TOPIC]
            }]);

        // Gas estimation
        case 'S17_EstimateGas': {
            const callData = __ENV.EST_DATA || SIMPLE_SIG;
            const targetContract = __ENV.EST_CONTRACT || CONTRACT;
            
            return jsonCall(rpcUrl, 'eth_estimateGas', 
                [{ to: targetContract, data: callData }],
                { contract_addr: targetContract, call_data: callData },
                result => typeof result === 'string' && parseInt(result, 16) > 0);
        }

        // Transaction receipt
        case 'S18_GetTxReceipt': {
            const txHash = __ENV.TX_HASH;
            if (!txHash) {
                throw new Error('TX_HASH environment variable is required for S18_GetTxReceipt scenario');
            }
            
            return jsonCall(rpcUrl, 'eth_getTransactionReceipt', [txHash],
                { tx_hash: txHash },
                result => result && (result.status === '0x1' || result.status === '0x0'));
        }

        // Batch calls
        case 'S19_BatchCalls': {
            const batchSize = Number(__ENV.BATCH_CALL_SIZE || rpcConfig.performance.batchSize);
            const batch = Array.from({ length: batchSize }, (_, i) => ({
                jsonrpc: '2.0', 
                id: i + 1, 
                method: 'eth_call',
                params: [{ to: CONTRACT, data: SIMPLE_SIG }, 'latest'],
            }));
            
            const startTime = Date.now();
            const tags = { 
                run_id: RUN_ID,
                scenario: SCENARIO, 
                endpoint: rpcUrl,
                method: 'batch_eth_call',
                transport: 'http',
                batch_size: batchSize
            };
            
            const res = post(rpcUrl, JSON.stringify(batch), { tags });
            
            if (res.status !== 200) {
                return recordFailure({ ...tags, stage: 'http' }, 
                    `Batch call HTTP error: ${res.status}`, { isHttpError: true });
            }
            
            let batchResponse;
            try {
                batchResponse = res.json();
            } catch (e) {
                return recordFailure({ ...tags, stage: 'json_parse' }, 
                    `Batch response parse error: ${e.message}`);
            }
            
            if (!Array.isArray(batchResponse) || batchResponse.length !== batchSize) {
                return recordFailure({ ...tags, stage: 'batch_validation' }, 
                    `Invalid batch response: expected ${batchSize} items`);
            }
            
            // Validate each response
            let successCount = 0;
            batchResponse.forEach((resp, index) => {
                if (resp.jsonrpc === '2.0' && resp.id === index + 1 && resp.result) {
                    successCount++;
                }
            });
            
            const duration = Date.now() - startTime;
            const successRate = successCount / batchSize;
            
            if (successRate >= validation.successThreshold) {
                recordSuccess({ ...tags, success_count: successCount, success_rate: successRate });
            } else {
                recordFailure({ ...tags, success_count: successCount, success_rate: successRate }, 
                    `Batch success rate too low: ${successRate}`);
            }
            
            addRTT(duration, tags);
            return batchResponse;
        }

        // HTTP handshake test
        case 'S20_HttpHandshake': {
            const startTime = Date.now();
            const tags = { 
                run_id: RUN_ID,
                scenario: SCENARIO, 
                endpoint: rpcUrl,
                method: 'http_handshake',
                transport: 'http'
            };
            
            const res = get(rpcUrl, { 
                timeout: '5s',
                tags: tags
            });
            
            const duration = Date.now() - startTime;
            
            const checks = {
                'http_status_ok': r => r.status >= 200 && r.status < 300,
                'response_time_reasonable': r => r.timings.duration < 5000,
                'connection_established': r => r.timings.connecting >= 0,
                'tls_handshake_ok': r => !rpcUrl.startsWith('https') || r.timings.tls_handshaking >= 0
            };
            
            const handshakeOk = check(res, checks, tags);
            
            if (handshakeOk && res.status >= 200 && res.status < 300) {
                recordSuccess({ ...tags, status: res.status });
            } else {
                recordFailure({ ...tags, status: res.status }, 
                    `HTTP handshake failed: status=${res.status}, duration=${duration}ms`, 
                    { isHttpError: true });
            }
            
            addRTT(duration, tags);
            return {
                status: res.status,
                duration: duration,
                timings: res.timings
            };
        }

        default:
            throw new Error(`Unknown or unsupported scenario: '${SCENARIO}'`);
    }
}

/**
 * Teardown phase - cleanup and fund recovery
 */
export function teardown(data) {
    const teardownStart = Date.now();
    
    console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        message: 'Starting teardown process',
        run_id: RUN_ID,
        scenario: SCENARIO
    }));

    // Wait for pending transactions
    console.log('Waiting for pending transactions to settle...');
    sleep(envConfig.delays.settlementWait);

    // Only perform fund recovery for write scenarios
    if (!WRITE_SCENARIOS.includes(SCENARIO)) {
        console.log('No fund recovery needed for read-only scenario');
        return;
    }

    console.log('Starting fund recovery process...');
    const refundUrl = RPC_URLS[0];
    let recoveredFunds = BigInt(0);
    let successfulRefunds = 0;
    let failedRefunds = 0;
    
    try {
        const currentGasPrice = Number(jsonCall(refundUrl, 'eth_gasPrice', [], { op: 'teardown_gas_price' }));
        const gasPrice = Math.floor(currentGasPrice * blockchain.teardownGasPriceMultiplier);
        
        console.log(`Teardown gas price: ${gasPrice}`);

        // Process wallets in batches
        const batchSize = rpcConfig.performance.batchSize;
        for (let i = 0; i < data.wallets.length; i += batchSize) {
            const batch = data.wallets.slice(i, i + batchSize);
            
            batch.forEach(w => {
                try {
                    const balanceHex = jsonCall(refundUrl, 'eth_getBalance', [w.addr, 'latest'], {
                        op: 'teardown_balance_check',
                        wallet_addr: w.addr
                    });
                    
                    if (!balanceHex) return;
                    
                    const balance = BigInt(balanceHex);
                    const gasCost = BigInt(gasPrice) * BigInt(blockchain.defaultGasLimit.simple);
                    
                    // Only refund if balance covers gas costs with margin
                    if (balance <= gasCost * BigInt(2)) {
                        console.log(`Wallet ${w.addr} balance too low for refund: ${balance}`);
                        return;
                    }

                    const sendValue = balance - gasCost;
                    const raw = buildRawTx(refundUrl, w, BASE_ADDR, sendValue, '0x', { gasPrice });
                    
                    const txHash = jsonCall(refundUrl, 'eth_sendRawTransaction', [raw], { 
                        op: 'teardown_refund',
                        wallet_addr: w.addr,
                        amount: sendValue.toString()
                    });
                    
                    if (txHash) {
                        recoveredFunds += sendValue;
                        successfulRefunds++;
                        console.log(`Refunded ${sendValue} wei from ${w.addr}, tx: ${txHash}`);
                    }
                } catch (e) {
                    failedRefunds++;
                    console.error(`Failed to refund wallet ${w.addr}: ${e.message}`);
                }
            });
            
            if (i + batchSize < data.wallets.length) {
                sleep(envConfig.delays.teardownDelay);
            }
        }
        
    } catch (e) {
        console.error(`Teardown error: ${e.message}`);
    }
    
    const teardownDuration = Date.now() - teardownStart;
    
    console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        message: 'Teardown completed',
        run_id: RUN_ID,
        scenario: SCENARIO,
        duration_ms: teardownDuration,
        recovered_funds_wei: recoveredFunds.toString(),
        successful_refunds: successfulRefunds,
        failed_refunds: failedRefunds,
        total_wallets: data.wallets.length
    }));
}
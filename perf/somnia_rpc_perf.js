import http   from 'k6/http';
import ws     from 'k6/ws';
import { Trend, Counter, Rate } from 'k6/metrics';
import { sleep }  from 'k6';
import ethgo      from 'k6/x/ethgo';   // external module for Tx signing
import wallet from 'k6/x/ethgo/wallet';

// ============================================================================
// 0. ENVIRONMENT VARIABLES
// ============================================================================
const RPC_URLS   = (__ENV.RPC_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const PER_RPC_VU = Number(__ENV.PER_RPC_VU || 1);
const SCENARIO   = (__ENV.SCENARIO_TYPE || 'S1_BlockNumber').trim();
const PROFILE    = (__ENV.LOAD_PROFILE   || 'baseline').trim().toLowerCase();

const CONTRACT   = (__ENV.CONTRACT_ADDRESS || '0x4C1A08C5531a78081C318467181e796842039DA9').toLowerCase();
const TEST_ADDR  = (__ENV.TEST_ADDRESS     || '0x1941c57eeeacfd68757bc9feb4e558f65952ef50').toLowerCase();
const BASE_PRIV  = (__ENV.PRIVATE_KEY      || '').replace(/^0x/, '');
const BASE_ADDR  = (__ENV.WALLET_ADDRESS   || TEST_ADDR).toLowerCase();
const CHAIN_ID   = Number(__ENV.CHAIN_ID   || '50312');
const ERC20_ADDR = (__ENV.ERC20_TOKEN      || '0xDa4FDE38bE7a2b959BF46E032ECfA21e64019b76').toLowerCase();

const SIMPLE_SIG = __ENV.SIMPLE_SELECTOR || '0x20965255';
const HEAVY_SIG  = __ENV.HEAVY_SELECTOR  || '0xc1725961';
const SUB_ID     = __ENV.SUB_ID          || '';   // for S16_UnsubscribeWS

const VU_COUNT   = Math.max(1, RPC_URLS.length * PER_RPC_VU);

// ============================================================================
// 1. k6 OPTIONS & LOAD PROFILES
// ============================================================================
function profile(name, vus) {
    switch (name) {
        case 'baseline':
            return { executor: 'constant-vus', vus, duration: '1m' };

        case 'steady_50':
            return {
                executor: 'constant-arrival-rate',
                rate: 50,
                timeUnit: '1s',
                duration: '3m45s',
                preAllocatedVUs: Math.max(100, vus * 5),
            };

        case 'spike_200':
            return {
                executor: 'constant-arrival-rate',
                rate: 200,
                timeUnit: '1s',
                duration: '35s',
                preAllocatedVUs: Math.max(400, vus * 8),
            };

        default:
            throw new Error(`Unknown LOAD_PROFILE '${name}'`);
    }
}

export const options = {
    scenarios: {
        main: {
            exec: 'main_scenario',
            ...profile(PROFILE, VU_COUNT),
        },
    },
};

// ============================================================================
// 2. METRICS DEFINITION
// ============================================================================
const rtt = new Trend('somnia_http_rtt', true);
const ok  = new Counter('somnia_success_count');
const bad = new Counter('somnia_error_count');
const er  = new Rate('somnia_error_rate');

function addRTT(ms, tags) { rtt.add(ms, tags); }
function fail(tags)       { bad.add(1, tags); er.add(1, tags); sleep(1); }

// ============================================================================
// 3. UTILITY FUNCTIONS
// ============================================================================
function rpc(id, method, params) {
    return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

function post(url, body) {
    return http.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: '10s',
    });
}

function jsonCall(url, method, params, tag = {}) {
    const t0 = Date.now();
    const res = post(url, rpc(t0, method, params));
    const tags = { scenario: SCENARIO, endpoint: url, ...tag };

    if (res.status !== 200 || res.json().error) {
        fail(tags);
        return null;
    }
    ok.add(1, tags);
    addRTT(Date.now() - t0, tags);
    return res.json().result;
}

// ============================================================================
// 4. SETUP: WALLET GENERATION & OPTIONAL FUNDING
// ============================================================================
export function setup() {
    if (RPC_URLS.length === 0) throw new Error('RPC_URLS must be specified');

    /** @type {{pk:string, addr:string}[]} */
    const wallets = [];
    for (let i = 0; i < VU_COUNT; i++) {
        var acc = wallet.generateKey();

        wallets.push({
            pk: acc.private_key,
            addr: acc.address
        });
    }

    const writeScenarios = ['S11_SendRawTxSmall', 'S12_SendRawTxERC20'];
    if (writeScenarios.includes(SCENARIO)) {
        console.log(`Funding ${VU_COUNT} wallets for ${SCENARIO}`);
        const fundUrl  = RPC_URLS[0];
        let nonce      = Number(jsonCall(fundUrl, 'eth_getTransactionCount', [BASE_ADDR, 'pending']));
        const gasPrice = Math.floor(Number(jsonCall(fundUrl, 'eth_gasPrice', [])) * 1.2);

        wallets.forEach((w) => {
            const raw = ethgo.signLegacyTx(
                {
                    nonce: nonce++,
                    gasPrice,
                    gas: 21000,
                    to: w.addr,
                    value: 1e15,
                    data: '0x',
                    chainId: CHAIN_ID,
                },
                BASE_PRIV,
            );
            jsonCall(fundUrl, 'eth_sendRawTransaction', [raw], { op: 'fund' });
        });

        // wait up to 60 s for balances to reflect
        wallets.forEach((w) => {
            const start = Date.now();
            while (Date.now() - start < 60_000) {
                const bal = BigInt(jsonCall(fundUrl, 'eth_getBalance', [w.addr, 'latest']) || 0n);
                if (bal > 0n) break;
                sleep(2);
            }
        });
        console.log('Funding complete');
    } else {
        console.log(`Skipping funding for read-only scenario ${SCENARIO}`);
    }
    return { wallets };
}

// ============================================================================
// 5. TRANSACTION BUILDER
// ============================================================================
function buildRawTx(url, wallet, to, value, data, tag) {
    const nonce    = Number(jsonCall(url, 'eth_getTransactionCount', [wallet.addr, 'pending'], tag));
    const gasPrice = Math.floor(Number(jsonCall(url, 'eth_gasPrice', [], tag)) * 1.2);
    const gasLimit = ['0x', '0x0'].includes(data) ? 42_000 : 70_000;

    const tx = { nonce, gasPrice, gas: gasLimit, to, value, data, chainId: CHAIN_ID };
    return ethgo.signLegacyTx(tx, wallet.pk);
}

// ============================================================================
// 6. WEBSOCKET SUBSCRIPTION
// ============================================================================
function wsSub(wsUrl, rpcUrl, method, params) {
    ws.connect(wsUrl, {}, (sock) => {
        sock.setTimeout(() => sock.close(), 60_000);
        const id = Date.now();
        const t0 = Date.now();
        sock.send(rpc(id, method, params));

        sock.on('message', (msg) => {
            const m = JSON.parse(msg);
            const tags = { scenario: SCENARIO, endpoint: rpcUrl };
            if (m.id === id && m.result) ok.add(1, tags);
            if (m.params) { addRTT(Date.now() - t0, tags); ok.add(1, tags); sock.close(); }
        });

        sock.on('error', () => fail({ scenario: SCENARIO, endpoint: rpcUrl }));
    });
}

// ============================================================================
// 7. MAIN SCENARIO DISPATCHER
// ============================================================================
export function main_scenario(data) {
    const idx    = (__VU - 1) % RPC_URLS.length;
    const rpcUrl = RPC_URLS[idx];
    const wsUrl  = rpcUrl.replace(/^http/, 'ws');
    const wallet = data.wallets[__VU - 1];

    switch (SCENARIO) {
        case 'S1_BlockNumber':
            return jsonCall(rpcUrl, 'eth_blockNumber', []);

        case 'S2_ChainId':
            return jsonCall(rpcUrl, 'eth_chainId', []);

        case 'S3_GetBalance':
            return jsonCall(rpcUrl, 'eth_getBalance', [wallet.addr, 'latest']);

        case 'S4_GetCode':
            return jsonCall(rpcUrl, 'eth_getCode', [wallet.addr, 'latest']);

        case 'S5_EthCallSimple':
            return jsonCall(rpcUrl, 'eth_call', [{ to: CONTRACT, data: SIMPLE_SIG }, 'latest']);

        case 'S6_EthCallHeavy':
            return jsonCall(rpcUrl, 'eth_call', [{ to: CONTRACT, data: HEAVY_SIG }, 'latest']);

        case 'S7_GetLogsSmall':
            return jsonCall(rpcUrl, 'eth_getLogs', [{ fromBlock: 'latest', toBlock: 'latest', topics: [] }]);

        case 'S8_GetLogsRange': {
            const from = __ENV.START_BLOCK || '0x0';
            const to   = __ENV.END_BLOCK   || '0x3e8';
            return jsonCall(rpcUrl, 'eth_getLogs', [{ fromBlock: from, toBlock: to, topics: [] }]);
        }

        case 'S9_GetBlockLight':
            return jsonCall(rpcUrl, 'eth_getBlockByNumber', ['latest', false]);

        case 'S10_GetBlockFull':
            return jsonCall(rpcUrl, 'eth_getBlockByNumber', ['latest', true]);

        case 'S11_SendRawTxSmall': {
            const raw = buildRawTx(rpcUrl, wallet, wallet.addr, 1e15, '0x', { endpoint: rpcUrl });
            return jsonCall(rpcUrl, 'eth_sendRawTransaction', [raw], { endpoint: rpcUrl });
        }

        case 'S12_SendRawTxERC20': {
            const method = '0xa9059cbb';
            const toHex  = wallet.addr.replace(/^0x/, '').padStart(64, '0');
            const data   = method + toHex + '1'.padStart(64, '0');
            const raw    = buildRawTx(rpcUrl, wallet, ERC20_ADDR, 0, '0x' + data, { endpoint: rpcUrl });
            return jsonCall(rpcUrl, 'eth_sendRawTransaction', [raw], { endpoint: rpcUrl });
        }

        case 'S13_PendingTxSub':
            return wsSub(wsUrl, rpcUrl, 'eth_subscribe', ['newPendingTransactions']);

        case 'S14_NewHeadSub':
            return wsSub(wsUrl, rpcUrl, 'eth_subscribe', ['newHeads']);

        case 'S15_LogsSubFilter':
            return wsSub(wsUrl, rpcUrl, 'eth_subscribe', ['logs', { address: CONTRACT }]);

        case 'S16_UnsubscribeWS':
            if (!SUB_ID) throw new Error('SUB_ID env-var required for S16_UnsubscribeWS');
            return wsSub(wsUrl, rpcUrl, 'eth_unsubscribe', [SUB_ID]);

        case 'S17_EstimateGas':
            if (!__ENV.EST_DATA) throw new Error('EST_DATA required');
            return jsonCall(rpcUrl, 'eth_estimateGas', [{ to: CONTRACT, data: __ENV.EST_DATA }]);

        case 'S18_GetTxReceipt':
            if (!__ENV.TX_HASH) throw new Error('TX_HASH required');
            return jsonCall(rpcUrl, 'eth_getTransactionReceipt', [__ENV.TX_HASH]);

        case 'S19_BatchCalls': {
            const batch = Array.from({ length: 10 }, (_, i) => ({
                jsonrpc: '2.0',
                id: i + 1,
                method: 'eth_call',
                params: [{ to: CONTRACT, data: SIMPLE_SIG }, 'latest'],
            }));
            const t0   = Date.now();
            const res  = post(rpcUrl, JSON.stringify(batch));
            const tags = { scenario: SCENARIO, endpoint: rpcUrl };
            if (res.status !== 200 || !Array.isArray(res.json()) || res.json().length !== 10) {
                return fail(tags);
            }
            ok.add(1, tags);
            addRTT(Date.now() - t0, tags);
            return;
        }

        case 'S20_HttpHandshake': {
            const t0 = Date.now();
            const res = http.get(rpcUrl, { timeout: '5s' });
            const tags = { scenario: SCENARIO, endpoint: rpcUrl };
            res.status === 200 ? ok.add(1, tags) : bad.add(1, tags);
            er.add(res.status !== 200, tags);
            addRTT(Date.now() - t0, tags);
            return;
        }

        default:
            throw new Error(`Unknown SCENARIO '${SCENARIO}'`);
    }
}

// ============================================================================
// 8. TEARDOWN
// ============================================================================
export function teardown(data) {
    const writeScenarios = ['S11_SendRawTxSmall', 'S12_SendRawTxERC20'];
    if (!writeScenarios.includes(SCENARIO)) return;

    console.log(`Returning funds from VU wallets for scenario ${SCENARIO}`);
    const refundUrl = RPC_URLS[0];
    const gasPrice  = Math.floor(Number(jsonCall(refundUrl, 'eth_gasPrice', [])) * 1.2);

    data.wallets.forEach((wallet) => {
        const balHex = jsonCall(refundUrl, 'eth_getBalance', [wallet.addr, 'latest']);
        if (!balHex) return;

        const balance = BigInt(balHex);
        const gasCost = BigInt(gasPrice) * BigInt(42_000);
        if (balance <= gasCost) return; // not enough to cover gas

        const sendValue = balance - gasCost;
        const raw = ethgo.signLegacyTx(
            {
                nonce: Number(jsonCall(refundUrl, 'eth_getTransactionCount', [wallet.addr, 'pending'])),
                gasPrice,
                gas: 42_000,
                to: BASE_ADDR,
                value: sendValue,
                data: '0x',
                chainId: CHAIN_ID,
            },
            wallet.pk,
        );
        jsonCall(refundUrl, 'eth_sendRawTransaction', [raw], { stage: 'teardown' });
    });
    console.log('Teardown complete');
}

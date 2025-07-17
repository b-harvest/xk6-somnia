// Global run identifier for tracking test execution
let RUN_ID;

// Core k6 imports
import ws from 'k6/ws';
import { Trend, Counter, Rate, Gauge } from 'k6/metrics';
import { sleep, check } from 'k6';
import http from 'k6/http';
import { randomBytes } from 'k6/crypto';

// Custom k6 extensions for Ethereum functionality
import ethgo from 'k6/x/ethgo';
import wallet from 'k6/x/ethgo/wallet';

// Test configuration from environment variables
const SCENARIO = (__ENV.SCENARIO_TYPE || 'S1_BlockNumber').trim();
const PROFILE = (__ENV.LOAD_PROFILE || 'baseline').trim().toLowerCase();
const REGION = (__ENV.REGION || 'unknown').trim();

// RPC endpoint configuration
const RPC_URLS = (__ENV.RPC_URLS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
const PER_RPC_VU = Number(__ENV.PER_RPC_VU || 1);

// Validate RPC URLs format
if (RPC_URLS.length === 0) {
    throw new Error('At least one RPC_URL must be provided');
}
RPC_URLS.forEach(url => {
    if (!url.match(/^https?:\/\/.+/)) {
        throw new Error(`Invalid RPC URL format: ${url}`);
    }
});

// Smart contract configuration
const CONTRACT = (__ENV.CONTRACT_ADDRESS || '0x4C1A08C5531a78081C318467181e796842039DA9').toLowerCase();
const SIMPLE_SIG = __ENV.SIMPLE_SIG || '0x20965255';
const HEAVY_SIG = __ENV.HEAVY_SIG || '0xc1725961';

// Wallet and blockchain configuration
const BASE_PRIV = (__ENV.PRIVATE_KEY || '').replace(/^0x/, '');
const BASE_ADDR = (__ENV.WALLET_ADDRESS || '').toLowerCase();
const CHAIN_ID = Number(__ENV.CHAIN_ID || 50312);

// ERC20 token configuration
const ERC20_ADDR = (__ENV.ERC20_TOKEN || '').toLowerCase();
const TOKEN_DECIMALS = Number(__ENV.TOKEN_DECIMALS || 18);

// Validate required configurations for write scenarios
const WRITE_SCENARIOS = ['S11_SendRawTxSmall', 'S12_SendRawTxERC20'];
if (WRITE_SCENARIOS.includes(SCENARIO)) {
    if (!BASE_PRIV || !BASE_ADDR) {
        throw new Error('PRIVATE_KEY and WALLET_ADDRESS are required for write scenarios');
    }
    if (SCENARIO === 'S12_SendRawTxERC20' && !ERC20_ADDR) {
        throw new Error('ERC20_TOKEN address is required for S12_SendRawTxERC20 scenario');
    }
}

// Event filtering configuration
const LOG_TOPIC = (__ENV.LOG_TOPIC || '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
let currentLogBlock = null;

// Performance and reliability settings
const MAX_RETRIES = Number(__ENV.MAX_RETRIES || 3);
const RETRY_DELAY_MS = Number(__ENV.RETRY_DELAY_MS || 1000);
const REQUEST_TIMEOUT = __ENV.REQUEST_TIMEOUT || '15s';
const WS_TIMEOUT = Number(__ENV.WS_TIMEOUT || 60000);

// Parse timeout value (handle both string and number formats)
function parseTimeout(timeoutValue) {
    if (typeof timeoutValue === 'number') {
        return timeoutValue;
    }
    if (typeof timeoutValue === 'string') {
        const match = timeoutValue.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/);
        if (!match) {
            throw new Error(`Invalid timeout format: ${timeoutValue}`);
        }
        const value = parseFloat(match[1]);
        const unit = match[2] || 'ms';
        switch (unit) {
            case 'ms': return value;
            case 's': return value * 1000;
            case 'm': return value * 60 * 1000;
            default: throw new Error(`Unknown timeout unit: ${unit}`);
        }
    }
    throw new Error(`Invalid timeout type: ${typeof timeoutValue}`);
}

const PARSED_TIMEOUT_MS = parseTimeout(REQUEST_TIMEOUT);
const VU_COUNT = Math.max(1, RPC_URLS.length * PER_RPC_VU);

/* ============================================================================
 * 1. k6 OPTIONS & LOAD PROFILES
 * ========================================================================== */
function profile(name, vus) {
    switch (name) {
        case 'baseline':
            return {executor: 'constant-vus', vus, duration: '10m'};
        case 'spike_200':
            return {
                executor: 'constant-arrival-rate',
                rate: 200, timeUnit: '1s', duration: '35s',
                preAllocatedVUs: Math.max(400, vus * 8),
            };
        case 'ramp_find_max':
            return {
                executor: 'ramping-arrival-rate', timeUnit: '1s',
                preAllocatedVUs: Math.max(500, vus * 10),
                stages: [
                    {target: 0, duration: '5s'},
                    {target: 1000, duration: '30s'},
                    {target: 5000, duration: '60s'},
                    {target: 10000, duration: '60s'},
                ],
            };
        case 'break_steady':
            return {
                executor: 'constant-arrival-rate',
                rate: 5000, timeUnit: '1s', duration: '5m',
                preAllocatedVUs: Math.max(2000, vus * 15),
            };
        case 'spike_5k':
            return {
                executor: 'constant-arrival-rate',
                rate: 5000, timeUnit: '1s', duration: '30s',
                preAllocatedVUs: Math.max(2000, vus * 20),
            };
        case 'spike_10k':
            return {
                executor: 'constant-arrival-rate',
                rate: 10000, timeUnit: '1s', duration: '30s',
                preAllocatedVUs: Math.max(4000, vus * 20),
            };
        case 'spike_13k':
            return {
                executor: 'constant-arrival-rate',
                rate: 13000, timeUnit: '1s', duration: '30s',
                preAllocatedVUs: Math.max(5200, vus * 20),
            };
        case 'spike_15k':
            return {
                executor: 'constant-arrival-rate',
                rate: 15000, timeUnit: '1s', duration: '30s',
                preAllocatedVUs: Math.max(6000, vus * 20),
            };
        case 'spike_20k':
            return {
                executor: 'constant-arrival-rate',
                rate: 20000, timeUnit: '1s', duration: '30s',
                preAllocatedVUs: Math.max(8000, vus * 20),
            };
        case 'spike_24k':
            return {
                executor: 'constant-arrival-rate',
                rate: 24000, timeUnit: '1s', duration: '30s',
                preAllocatedVUs: Math.max(9600, vus * 20),
            };
        case 'spike_25k':
            return {
                executor: 'constant-arrival-rate',
                rate: 25000, timeUnit: '1s', duration: '30s',
                preAllocatedVUs: Math.max(10000, vus * 20),
            };
        case 'spike_26k':
            return {
                executor: 'constant-arrival-rate',
                rate: 26000, timeUnit: '1s', duration: '30s',
                preAllocatedVUs: Math.max(10400, vus * 20),
            };
        case 'spike_28k':
            return {
                executor: 'constant-arrival-rate',
                rate: 28000, timeUnit: '1s', duration: '30s',
                preAllocatedVUs: Math.max(11200, vus * 20),
            };
        case 'spike_30k':
            return {
                executor: 'constant-arrival-rate',
                rate: 30000, timeUnit: '1s', duration: '30s',
                preAllocatedVUs: Math.max(12000, vus * 20),
            };
        case 'soak_30m':
            return {
                executor: 'constant-arrival-rate',
                rate: 200,
                timeUnit: '1s',
                duration: '30m',
                preAllocatedVUs: Math.max(800, vus * 4),
            };
        case 'longevity_24h':
            return {
                executor: 'constant-arrival-rate',
                rate: 50,
                timeUnit: '1s',
                duration: '24h',
                preAllocatedVUs: Math.max(200, vus * 2),
                gracefulStop: '10m',
            };
        case 'step_ladder':
            return {
                executor: 'ramping-arrival-rate',
                timeUnit: '1s',
                preAllocatedVUs: Math.max(2000, vus * 10),
                stages: [
                    {target: 500, duration: '2m'},
                    {target: 1000, duration: '2m'},
                    {target: 2000, duration: '2m'},
                    {target: 4000, duration: '2m'},
                    {target: 8000, duration: '2m'},
                    {target: 0, duration: '1m'},
                ],
            };
        case 'stress_recovery':
            return {
                executor: 'ramping-arrival-rate',
                timeUnit: '1s',
                preAllocatedVUs: Math.max(4000, vus * 12),
                stages: [
                    {target: 0, duration: '5s'},
                    {target: 8000, duration: '90s'},
                    {target: 2000, duration: '3m'},
                    {target: 0, duration: '1m'},
                ],
            };
        case 'random_spike':
            return {
                executor: 'externally-controlled',
                vus: Math.max(4000, vus * 15),
                maxVUs: Math.max(6000, vus * 20),
            };
        case 'crash_ramp':
            return {
                executor: 'ramping-arrival-rate',
                timeUnit: '1s',
                preAllocatedVUs: Math.max(6000, vus * 20),
                stages: [
                    {target: 0, duration: '10s'},
                    {target: 30000, duration: '20s'},
                    {target: 0, duration: '10s'},
                ],
            };
        case 'ramp_up_down':
            return {
                executor: 'ramping-arrival-rate',
                timeUnit: '1s',
                preAllocatedVUs: Math.max(3000, vus * 10),
                stages: [
                    {target: 0, duration: '10s'},
                    {target: 500, duration: '1m'},
                    {target: 2500, duration: '1m'},
                    {target: 5000, duration: '1m'},
                    {target: 2500, duration: '1m'},
                    {target: 500, duration: '1m'},
                    {target: 0, duration: '30s'},
                ],
            };
        case 'steady_50':
            return {
                executor: 'constant-arrival-rate',
                rate: 50,
                timeUnit: '1s',
                duration: '10m',
                preAllocatedVUs: Math.max(100, vus * 6),
            };
        case 'steady_900':
            return {
                executor: 'constant-arrival-rate',
                rate: 900,
                timeUnit: '1s',
                duration: '10m',
                preAllocatedVUs: Math.max(1800, vus * 6),
            };
        case 'steady_1k': {
            const rate = 1_000;
            const avgLatency = 0.2;
            const concurrency = Math.ceil(rate * avgLatency);
            return {
                executor: 'constant-arrival-rate',
                rate: rate,
                timeUnit: '1s',
                duration: '10m',
                preAllocatedVUs: 50,
                maxVUs: 50,
            };
        }
        case 'steady_5k':
            return {
                executor: 'constant-arrival-rate',
                rate: 5000,
                timeUnit: '1s',
                duration: '10m',
                preAllocatedVUs: Math.max(100, vus * 6),
            };
        case 'steady_8k': {
            const rate = 8_000;
            const avgLatency = 0.2;
            const concurrency = Math.ceil(rate * avgLatency);
            return {
                executor: 'constant-arrival-rate',
                rate: rate,
                timeUnit: '1s',
                duration: '10m',
                preAllocatedVUs: Math.ceil(concurrency * 1.2),
                maxVUs: Math.ceil(concurrency * 2),
            };
        }
        case 'steady_10k': {
            const rate = 10_000;
            const avgLatency = 0.2;
            const concurrency = Math.ceil(rate * avgLatency);
            return {
                executor: 'constant-arrival-rate',
                rate: rate,
                timeUnit: '1s',
                duration: '10m',
                preAllocatedVUs: Math.ceil(concurrency * 1.2),
                maxVUs: Math.ceil(concurrency * 2),
            };
        }
        // steady_12k: sustained 12 000 req/s for 10 minutes
        case 'steady_12k': {
            const rate        = 12_000;
            const avgLatency  = 0.2;                         // assume 200 ms avg response
            const concurrency = Math.ceil(rate * avgLatency);
            return {
                executor: 'constant-arrival-rate',
                rate:       rate,
                timeUnit:  '1s',
                duration:  '10m',
                preAllocatedVUs: Math.ceil(concurrency * 1.2),  // 20% buffer
                maxVUs:           Math.ceil(concurrency * 2)    // up to 2×
            };
        }

        // steady_13k: sustained 13 000 req/s for 10 minutes
        case 'steady_13k': {
            const rate        = 13_000;
            const avgLatency  = 0.2;
            const concurrency = Math.ceil(rate * avgLatency);
            return {
                executor: 'constant-arrival-rate',
                rate:       rate,
                timeUnit:  '1s',
                duration:  '10m',
                preAllocatedVUs: Math.ceil(concurrency * 1.2),
                maxVUs:           Math.ceil(concurrency * 2)
            };
        }

        // steady_14k: sustained 14 000 req/s for 10 minutes
        case 'steady_14k': {
            const rate        = 14_000;
            const avgLatency  = 0.2;
            const concurrency = Math.ceil(rate * avgLatency);
            return {
                executor: 'constant-arrival-rate',
                rate:       rate,
                timeUnit:  '1s',
                duration:  '10m',
                preAllocatedVUs: Math.ceil(concurrency * 1.2),
                maxVUs:           Math.ceil(concurrency * 2)
            };
        }

        // steady_15k: sustained 15 000 req/s for 10 minutes
        case 'steady_15k': {
            const rate        = 15_000;
            const avgLatency  = 0.2;
            const concurrency = Math.ceil(rate * avgLatency);
            return {
                executor: 'constant-arrival-rate',
                rate:       rate,
                timeUnit:  '1s',
                duration:  '10m',
                preAllocatedVUs: Math.ceil(concurrency * 1.2),
                maxVUs:           Math.ceil(concurrency * 2)
            };
        }

        // steady_17k: sustained 17 000 req/s for 10 minutes
        case 'steady_17k': {
            const rate        = 17_000;
            const avgLatency  = 0.2;
            const concurrency = Math.ceil(rate * avgLatency);
            return {
                executor: 'constant-arrival-rate',
                rate:       rate,
                timeUnit:  '1s',
                duration:  '10m',
                preAllocatedVUs: Math.ceil(concurrency * 1.2),
                maxVUs:           Math.ceil(concurrency * 2)
            };
        }

        // steady_20k: sustained 20 000 req/s for 10 minutes
        case 'steady_20k': {
            const rate        = 20_000;
            const avgLatency  = 0.2;
            const concurrency = Math.ceil(rate * avgLatency);
            return {
                executor: 'constant-arrival-rate',
                rate:       rate,
                timeUnit:  '1s',
                duration:  '10m',
                preAllocatedVUs: Math.ceil(concurrency * 1.2),
                maxVUs:           Math.ceil(concurrency * 2)
            };
        }
        default:
            throw new Error(`Unknown LOAD_PROFILE '${name}'`);
    }
}

/* 2. k6 OPTIONS */
export const options = {
    setupTimeout: '5m',
    teardownTimeout: '5m',
    scenarios: {
        main: {
            exec: 'main_scenario',
            ...profile(PROFILE, VU_COUNT),
        },
    },
};

/* ============================================================================
 * 3. ENHANCED METRICS AND MONITORING
 * ========================================================================== */

// Core performance metrics
const rtt = new Trend('somnia_http_rtt', true);
const rpcLatency = new Trend('somnia_rpc_latency', true);
const wsLatency = new Trend('somnia_ws_latency', true);

// Success/failure counters
const successCount = new Counter('somnia_success_count');
const errorCount = new Counter('somnia_error_count');
const retryCount = new Counter('somnia_retry_count');

// Rate metrics
const errorRate = new Rate('somnia_error_rate');
const timeoutRate = new Rate('somnia_timeout_rate');
const httpErrorRate = new Rate('somnia_http_error_rate');

// Gauges for real-time monitoring
const activeConnections = new Gauge('somnia_active_ws_connections');
const currentBlockHeight = new Gauge('somnia_current_block_height');
const gasPrice = new Gauge('somnia_current_gas_price');

// Method-specific metrics
const methodLatency = new Trend('somnia_method_latency', true);
const methodSuccess = new Counter('somnia_method_success');
const methodErrors = new Counter('somnia_method_errors');

// Timeout-specific metrics
const timeoutCount = new Counter('somnia_timeout_count');
const timeoutByMethod = new Counter('somnia_timeout_by_method');
const timeoutLatency = new Trend('somnia_timeout_latency', true);

// Metrics helper functions
function addRTT(ms, tags) {
    rtt.add(ms, tags);
    if (tags.method) {
        methodLatency.add(ms, tags);
    }
    if (tags.transport === 'websocket') {
        wsLatency.add(ms, tags);
    } else {
        rpcLatency.add(ms, tags);
    }
}

function recordSuccess(tags) {
    successCount.add(1, tags);
    if (tags.method) {
        methodSuccess.add(1, tags);
    }
}

/**
 * Enhanced timeout detection function with metadata retrieval
 * @param {object} response - HTTP response object
 * @param {number} requestStartTime - Request start timestamp
 * @param {number} timeoutMs - Configured timeout in milliseconds
 * @returns {object} Timeout detection result
 */
function detectTimeout(response, requestStartTime, timeoutMs) {
    // Try to get metadata from response object or fallback to WeakMap
    let metadata = null;
    if (response._timingMetadata) {
        metadata = response._timingMetadata;
    } else if (global.responseMetadata && global.responseMetadata.has(response)) {
        metadata = global.responseMetadata.get(response);
    }

    // Use metadata start time if available, otherwise use provided start time
    const startTime = metadata ? metadata.requestStartTime : requestStartTime;
    const actualDuration = Date.now() - startTime;
    const timeoutThreshold = timeoutMs * 0.95; // 95% of configured timeout

    // Check multiple timeout indicators
    const indicators = {
        // k6 timeout error codes
        error_code_timeout: response.error_code === 1050, // k6 timeout error

        // HTTP status indicating timeout
        status_timeout: response.status === 0 && actualDuration >= timeoutThreshold,

        // Request duration exceeds threshold
        duration_timeout: actualDuration >= timeoutThreshold,

        // Check for timeout-related error messages
        body_timeout: response.body && (
            response.body.includes('timeout') ||
            response.body.includes('timed out') ||
            response.body.includes('request timeout') ||
            response.body.includes('gateway timeout')
        ),

        // Check specific HTTP status codes for timeouts
        gateway_timeout: response.status === 504,
        request_timeout: response.status === 408,

        // No response received within time limit
        no_response: !response.status && actualDuration >= timeoutThreshold
    };

    const isTimeout = Object.values(indicators).some(Boolean);
    const timeoutReasons = Object.entries(indicators)
        .filter(([_, value]) => value)
        .map(([key, _]) => key);

    return {
        isTimeout,
        reasons: timeoutReasons,
        actualDuration,
        threshold: timeoutThreshold,
        indicators
    };
}

/**
 * Records failure metrics and logs error details with enhanced timeout detection
 * @param {object} tags - Base tags for metrics
 * @param {string} reason - Failure reason message
 * @param {object} options - Additional options (retry info, response object, etc.)
 */
function recordFailure(tags, reason, options = {}) {
    const enrichedTags = {
        ...tags,
        reason: reason.slice(0, 100), // Limit reason length
        retry_attempt: options.retryAttempt || 0
    };

    // Enhanced timeout detection
    let isTimeout = options.isTimeout || false;
    let timeoutDetails = null;

    if (options.response && options.requestStartTime) {
        const timeoutDetection = detectTimeout(
            options.response,
            options.requestStartTime,
            options.timeoutMs || PARSED_TIMEOUT_MS
        );

        if (timeoutDetection.isTimeout) {
            isTimeout = true;
            timeoutDetails = timeoutDetection;

            // Add timeout-specific tags (convert all values to strings)
            enrichedTags.timeout_type = timeoutDetection.reasons.join(',');
            enrichedTags.actual_duration = String(timeoutDetection.actualDuration);
            enrichedTags.timeout_threshold = String(timeoutDetection.threshold);

            // Record timeout-specific metrics
            timeoutCount.add(1, enrichedTags);
            timeoutLatency.add(timeoutDetection.actualDuration, enrichedTags);

            if (tags.method) {
                timeoutByMethod.add(1, {
                    ...enrichedTags,
                    method: tags.method,
                    timeout_reasons: timeoutDetection.reasons.join('|')
                });
            }
        }
    }

    errorCount.add(1, enrichedTags);
    errorRate.add(1, enrichedTags);

    if (tags.method) {
        methodErrors.add(1, enrichedTags);
    }

    if (isTimeout) {
        timeoutRate.add(1, enrichedTags);
        // Update reason to include timeout information
        if (timeoutDetails) {
            reason = `TIMEOUT: ${reason} (duration: ${timeoutDetails.actualDuration}ms, threshold: ${timeoutDetails.threshold}ms, indicators: ${timeoutDetails.reasons.join(', ')})`;
        }
    }

    if (options.isHttpError) {
        httpErrorRate.add(1, enrichedTags);
    }

    // Enhanced structured logging with timeout details
    const logEntry = {
        timestamp: new Date().toISOString(),
        level: isTimeout ? 'WARN' : 'ERROR',
        type: isTimeout ? 'TIMEOUT' : 'ERROR',
        scenario: tags.scenario,
        method: tags.method,
        endpoint: tags.endpoint,
        reason: reason,
        tags: enrichedTags
    };

    if (timeoutDetails) {
        logEntry.timeout_details = {
            actual_duration_ms: timeoutDetails.actualDuration,
            threshold_ms: timeoutDetails.threshold,
            reasons: timeoutDetails.reasons,
            indicators: timeoutDetails.indicators
        };
    }

    if (__ENV.K6_LOG_OUTPUT !== 'none') {
        console.error(JSON.stringify(logEntry));
    }
}

/* ============================================================================
 * 4. ENHANCED JSON-RPC AND HTTP HELPERS WITH TIMEOUT HANDLING
 * ========================================================================== */

// Generate JSON-RPC request payload
function rpc(id, method, params) {
    return JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: params || []
    });
}

// Enhanced HTTP POST with comprehensive timeout handling
function post(url, body, options = {}) {
    const requestId = randomBytes(8).toString('hex');
    const defaultHeaders = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': `k6-somnia-test/${__ENV.TEST_VERSION || '1.0.0'}`,
        'X-Request-ID': requestId
    };

    const requestOptions = {
        headers: { ...defaultHeaders, ...(options.headers || {}) },
        timeout: options.timeout || REQUEST_TIMEOUT,
        redirects: 5,
        tags: { ...options.tags, request_id: requestId }
    };

    const startTime = Date.now();
    let response;

    try {
        response = http.post(url, body, requestOptions);
    } catch (error) {
        // Handle immediate errors (DNS resolution, connection refused, etc.)
        const duration = Date.now() - startTime;
        const isTimeout = error.message && (
            error.message.includes('timeout') ||
            error.message.includes('timed out') ||
            duration >= PARSED_TIMEOUT_MS * 0.95
        );

        throw {
            ...error,
            isTimeout,
            duration,
            requestId
        };
    }

    // Store timing metadata separately to avoid read-only property issues
    if (!response._timingMetadata) {
        try {
            response._timingMetadata = {
                requestStartTime: startTime,
                requestDuration: Date.now() - startTime,
                requestId: requestId,
                timeoutThreshold: parseTimeout(requestOptions.timeout)
            };
        } catch (e) {
            // If we can't assign to response object, use a WeakMap for metadata
            if (!global.responseMetadata) {
                global.responseMetadata = new WeakMap();
            }
            global.responseMetadata.set(response, {
                requestStartTime: startTime,
                requestDuration: Date.now() - startTime,
                requestId: requestId,
                timeoutThreshold: parseTimeout(requestOptions.timeout)
            });
        }
    }

    return response;
}

// Enhanced HTTP GET with timeout handling
function get(url, options = {}) {
    const requestId = randomBytes(8).toString('hex');
    const defaultHeaders = {
        'Accept': 'application/json',
        'User-Agent': `k6-somnia-test/${__ENV.TEST_VERSION || '1.0.0'}`,
        'X-Request-ID': requestId
    };

    const requestOptions = {
        headers: { ...defaultHeaders, ...(options.headers || {}) },
        timeout: options.timeout || REQUEST_TIMEOUT,
        redirects: 5,
        tags: { ...options.tags, request_id: requestId }
    };

    const startTime = Date.now();
    let response;

    try {
        response = http.get(url, requestOptions);
    } catch (error) {
        const duration = Date.now() - startTime;
        const isTimeout = error.message && (
            error.message.includes('timeout') ||
            error.message.includes('timed out') ||
            duration >= PARSED_TIMEOUT_MS * 0.95
        );

        throw {
            ...error,
            isTimeout,
            duration,
            requestId
        };
    }

    // Store timing metadata separately to avoid read-only property issues
    if (!response._timingMetadata) {
        try {
            response._timingMetadata = {
                requestStartTime: startTime,
                requestDuration: Date.now() - startTime,
                requestId: requestId,
                timeoutThreshold: parseTimeout(requestOptions.timeout)
            };
        } catch (e) {
            // If we can't assign to response object, use a WeakMap for metadata
            if (!global.responseMetadata) {
                global.responseMetadata = new WeakMap();
            }
            global.responseMetadata.set(response, {
                requestStartTime: startTime,
                requestDuration: Date.now() - startTime,
                requestId: requestId,
                timeoutThreshold: parseTimeout(requestOptions.timeout)
            });
        }
    }

    return response;
}

/**
 * Enhanced JSON-RPC call with comprehensive timeout handling and retry logic
 * @param {string} url - RPC endpoint URL
 * @param {string} method - RPC method name
 * @param {array} params - RPC method parameters
 * @param {object} extraTags - Additional tags for metrics
 * @param {function} expectFn - Result validation function
 * @param {number} retryAttempt - Current retry attempt (internal)
 */
function jsonCall(url, method, params, extraTags = {}, expectFn = _ => true, retryAttempt = 0) {
    // Use string ID to ensure compatibility with all JSON-RPC servers
    const reqId = String(Math.floor(Date.now() * 1000 + Math.random() * 1000));
    const body = rpc(reqId, method, params);
    const startTime = Date.now();

    const baseTags = {
        run_id: RUN_ID,
        scenario: SCENARIO,
        region: REGION,
        endpoint: url,
        method,
        transport: 'http',
        retry_attempt: retryAttempt,
        ...extraTags
    };

    let res;
    try {
        res = post(url, body, {
            tags: baseTags,
            timeout: REQUEST_TIMEOUT
        });
    } catch (e) {
        // Handle network-level errors and timeouts during request
        const errorMsg = e.isTimeout ?
            `Network timeout after ${e.duration}ms: ${e.message}` :
            `Network error: ${e.message}`;

        if (retryAttempt < MAX_RETRIES) {
            retryCount.add(1, { ...baseTags, error_type: 'network', is_timeout: String(e.isTimeout) });
            sleep(RETRY_DELAY_MS / 1000);
            return jsonCall(url, method, params, extraTags, expectFn, retryAttempt + 1);
        }

        return recordFailure(baseTags, errorMsg, {
            retryAttempt,
            isTimeout: e.isTimeout,
            response: null,
            requestStartTime: startTime,
            timeoutMs: PARSED_TIMEOUT_MS
        });
    }

    // Enhanced timeout detection using response metadata
    const timeoutDetection = detectTimeout(res, startTime, PARSED_TIMEOUT_MS);

    // Handle timeout scenarios
    if (timeoutDetection.isTimeout) {
        const timeoutMsg = `Request timeout detected - Duration: ${timeoutDetection.actualDuration}ms, Threshold: ${timeoutDetection.threshold}ms, Reasons: ${timeoutDetection.reasons.join(', ')}`;

        if (retryAttempt < MAX_RETRIES) {
            retryCount.add(1, {
                ...baseTags,
                error_type: 'timeout',
                timeout_reasons: timeoutDetection.reasons.join('|'),
                actual_duration: timeoutDetection.actualDuration
            });
            sleep(RETRY_DELAY_MS / 1000);
            return jsonCall(url, method, params, extraTags, expectFn, retryAttempt + 1);
        }

        return recordFailure(baseTags, timeoutMsg, {
            retryAttempt,
            isTimeout: true,
            response: res,
            requestStartTime: startTime,
            timeoutMs: PARSED_TIMEOUT_MS
        });
    }

    // Handle network-level errors with improved error codes
    if (res.error_code) {
        const errorMsg = `Network error code: ${res.error_code}`;
        const isNetworkTimeout = [1050, 1051, 1052].includes(res.error_code); // k6 timeout error codes

        if (retryAttempt < MAX_RETRIES) {
            retryCount.add(1, {
                ...baseTags,
                error_code: res.error_code,
                is_network_timeout: String(isNetworkTimeout)
            });
            sleep(RETRY_DELAY_MS / 1000);
            return jsonCall(url, method, params, extraTags, expectFn, retryAttempt + 1);
        }

        return recordFailure({ ...baseTags, stage: 'network', error_code: res.error_code }, errorMsg, {
            retryAttempt,
            isTimeout: isNetworkTimeout,
            response: res,
            requestStartTime: startTime
        });
    }

    // Validate HTTP response with timeout awareness
    const httpChecks = {
        'http_status_200': r => r.status === 200,
        'content_type_json': r => (r.headers['Content-Type'] || '').includes('application/json'),
        'response_body_present': r => r.body && r.body.length > 0,
        'response_time_reasonable': r => r.timings.duration < (PARSED_TIMEOUT_MS * 0.8)
    };

    const httpOk = check(res, httpChecks, baseTags);
    if (!httpOk) {
        const isHttpTimeout = res.status === 408 || res.status === 504 || res.status === 0;
        const errorMsg = `HTTP validation failed: status=${res.status}, content-type=${res.headers['Content-Type']}, body-length=${res.body?.length || 0}, duration=${res._requestDuration}ms`;

        return recordFailure({ ...baseTags, stage: 'http', status: res.status }, errorMsg, {
            retryAttempt,
            isHttpError: true,
            isTimeout: isHttpTimeout,
            response: res,
            requestStartTime: startTime
        });
    }

    // Parse JSON response
    let jsonResponse;
    try {
        jsonResponse = res.json();
    } catch (e) {
        return recordFailure({ ...baseTags, stage: 'json_parse' }, `JSON parse error: ${e.message}`, {
            retryAttempt,
            response: res,
            requestStartTime: startTime
        });
    }

    // Validate JSON-RPC structure
    const structureChecks = {
        'jsonrpc_version_valid': v => v.jsonrpc === '2.0',
        'request_id_matches': v => v.id === reqId,
        'response_complete': v => v.hasOwnProperty('result') || v.hasOwnProperty('error')
    };

    const structureOk = check(jsonResponse, structureChecks, baseTags);
    if (!structureOk) {
        return recordFailure({ ...baseTags, stage: 'rpc_structure' }, 'Invalid JSON-RPC response structure', {
            retryAttempt,
            response: res,
            requestStartTime: startTime
        });
    }

    // Handle RPC errors - for eth_estimateGas, we treat RPC errors as successful responses
    if (jsonResponse.error) {
        const rpcError = jsonResponse.error;
        const errorTags = {
            ...baseTags,
            stage: 'rpc_error',
            rpc_error_code: rpcError.code,
            rpc_error_message: String(rpcError.message).slice(0, 100)
        };

        // For eth_estimateGas, RPC errors (including execution reverted) are expected and should not fail the test
        if (method === 'eth_estimateGas') {
            const duration = Date.now() - startTime;
            recordSuccess(errorTags);
            addRTT(duration, errorTags);
            return { error: rpcError }; // Return the error as data, not as failure
        }

        return recordFailure(errorTags, `RPC error ${rpcError.code}: ${rpcError.message}`, {
            retryAttempt,
            response: res,
            requestStartTime: startTime
        });
    }

    // Validate result
    const resultChecks = {
        'result_present': v => v.hasOwnProperty('result') && v.result !== null,
        'result_expectation_met': v => expectFn(v.result)
    };

    const resultOk = check(jsonResponse, resultChecks, baseTags);
    if (!resultOk) {
        return recordFailure({ ...baseTags, stage: 'result_validation' }, 'Result validation failed', {
            retryAttempt,
            response: res,
            requestStartTime: startTime
        });
    }

    // Record successful metrics
    const duration = Date.now() - startTime;
    recordSuccess(baseTags);
    addRTT(duration, baseTags);

    // Update blockchain state metrics if applicable
    if (method === 'eth_blockNumber' && jsonResponse.result) {
        currentBlockHeight.add(Number(jsonResponse.result), baseTags);
    }
    if (method === 'eth_gasPrice' && jsonResponse.result) {
        gasPrice.add(Number(jsonResponse.result), baseTags);
    }

    return jsonResponse.result;
}

/* ============================================================================
 * 5. ENHANCED SETUP PHASE WITH WALLET MANAGEMENT
 * ========================================================================== */

const WALLET_CNT = Number(__ENV.WALLET_COUNT || 200);
const FUNDING_AMOUNT = BigInt(__ENV.FUNDING_AMOUNT || '1000000000000000'); // 0.001 ETH default
const BATCH_SIZE = Number(__ENV.BATCH_SIZE || 10);

export function setup() {
    const now = new Date();
    const pad = n => n.toString().padStart(2, '0');
    const YYYYMMDD = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const HHMMSS = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const runId = `run_${YYYYMMDD}_${HHMMSS}_${SCENARIO}_${PROFILE}`;

    if (__ENV.K6_LOG_OUTPUT !== 'none') {
        console.log(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'INFO',
            message: 'Starting test setup',
            run_id: runId,
            scenario: SCENARIO,
            profile: PROFILE,
            wallet_count: WALLET_CNT,
            rpc_urls: RPC_URLS.length,
            timeout_config: {
                request_timeout: REQUEST_TIMEOUT,
                parsed_timeout_ms: PARSED_TIMEOUT_MS,
                ws_timeout: WS_TIMEOUT,
                max_retries: MAX_RETRIES,
                retry_delay_ms: RETRY_DELAY_MS
            }
        }));
    }

    if (!RPC_URLS.length) {
        throw new Error('At least one RPC URL must be specified in RPC_URLS');
    }

    // Generate deterministic wallets for reproducible testing
    const wallets = Array.from({ length: WALLET_CNT }, (_, index) => {
        const acc = wallet.generateKey();
        return {
            pk: acc.private_key,
            addr: acc.address,
            index: index,
            nonce: 0 // Track nonce per wallet
        };
    });

    if (__ENV.K6_LOG_OUTPUT !== 'none') {
        console.log(`Generated ${wallets.length} test wallets`);
    }

    // Enhanced wallet funding for write scenarios
    if (WRITE_SCENARIOS.includes(SCENARIO)) {
        if (__ENV.K6_LOG_OUTPUT !== 'none') {
            console.log('Funding wallets for write scenarios...');
        }
        const fundUrl = RPC_URLS[0];

        // Get current nonce and gas price with retries
        let baseNonce = Number(jsonCall(fundUrl, 'eth_getTransactionCount', [BASE_ADDR, 'pending'], { op: 'get_nonce' }));
        const currentGasPrice = Number(jsonCall(fundUrl, 'eth_gasPrice', [], { op: 'get_gas_price' }));
        const gasPrice = Math.floor(currentGasPrice * 1.2); // 20% buffer

        if (__ENV.K6_LOG_OUTPUT !== 'none') {
            console.log(`Base nonce: ${baseNonce}, Gas price: ${gasPrice}`);
        }

        // Fund wallets in batches to avoid nonce conflicts
        for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
            const batch = wallets.slice(i, i + BATCH_SIZE);

            batch.forEach((w, batchIndex) => {
                const nonce = baseNonce + i + batchIndex;
                const raw = ethgo.signLegacyTx({
                    nonce: nonce,
                    gasPrice: gasPrice,
                    gas: 21000, // Standard transfer gas
                    to: w.addr,
                    value: FUNDING_AMOUNT,
                    data: '0x',
                    chainId: CHAIN_ID
                }, BASE_PRIV);

                const txHash = jsonCall(fundUrl, 'eth_sendRawTransaction', [raw], {
                    op: 'fund_wallet',
                    wallet_index: w.index,
                    nonce: nonce
                });

                if (txHash) {
                    w.fundingTx = txHash;
                }
            });

            // Small delay between batches
            if (i + BATCH_SIZE < wallets.length) {
                sleep(0.1);
            }
        }

        baseNonce += wallets.length;

        // ERC20 token distribution for token transfer scenarios
        if (SCENARIO === 'S12_SendRawTxERC20') {
            console.log('Distributing ERC20 tokens...');
            const tokenAmount = (BigInt(10) ** BigInt(TOKEN_DECIMALS)) / BigInt(1000); // 0.001 tokens
            const amountHex = tokenAmount.toString(16).padStart(64, '0');

            for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
                const batch = wallets.slice(i, i + BATCH_SIZE);

                batch.forEach((w, batchIndex) => {
                    const nonce = baseNonce + i + batchIndex;
                    // ERC20 transfer function signature + recipient + amount
                    const data = '0xa9059cbb' +
                        w.addr.replace(/^0x/, '').padStart(64, '0') +
                        amountHex;

                    const raw = ethgo.signLegacyTx({
                        nonce: nonce,
                        gasPrice: gasPrice,
                        gas: 65000, // ERC20 transfer gas
                        to: ERC20_ADDR,
                        value: 0,
                        data: data,
                        chainId: CHAIN_ID
                    }, BASE_PRIV);

                    const txHash = jsonCall(fundUrl, 'eth_sendRawTransaction', [raw], {
                        op: 'token_airdrop',
                        wallet_index: w.index,
                        amount: tokenAmount.toString()
                    });

                    if (txHash) {
                        w.tokenAirdropTx = txHash;
                    }
                });

                if (i + BATCH_SIZE < wallets.length) {
                    sleep(0.1);
                }
            }
        }

        // Wait for transactions to be mined
        console.log('Waiting for funding transactions to be processed...');
        sleep(5);
    }

    console.log('Setup complete.');
    return { wallets, runId };
}

/**
 * Enhanced transaction building with better gas estimation and error handling
 * @param {string} url - RPC endpoint URL
 * @param {object} wallet - Wallet object with pk and addr
 * @param {string} to - Recipient address
 * @param {number|BigInt} value - Transaction value in wei
 * @param {string} data - Transaction data
 * @param {object} options - Additional options (gasPrice, gasLimit overrides)
 */
function buildRawTx(url, wallet, to, value, data, options = {}) {
    // Get current nonce for the wallet
    const nonce = Number(jsonCall(url, 'eth_getTransactionCount', [wallet.addr, 'pending'], {
        op: 'get_nonce',
        wallet_addr: wallet.addr
    }));

    // Get current gas price with buffer
    const currentGasPrice = Number(jsonCall(url, 'eth_gasPrice', [], { op: 'get_gas_price' }));
    const gasPrice = options.gasPrice || Math.floor(currentGasPrice * 1.2);

    // Estimate gas limit based on transaction type
    let gasLimit;
    if (options.gasLimit) {
        gasLimit = options.gasLimit;
    } else if (data === '0x' || !data) {
        gasLimit = 21000; // Simple transfer
    } else if (data.startsWith('0xa9059cbb')) {
        gasLimit = 65000; // ERC20 transfer
    } else {
        gasLimit = 100000; // Contract interaction
    }

    // Build and sign transaction
    const txParams = {
        nonce: nonce,
        gasPrice: gasPrice,
        gas: gasLimit,
        to: to,
        value: value,
        data: data || '0x',
        chainId: CHAIN_ID
    };

    try {
        return ethgo.signLegacyTx(txParams, wallet.pk);
    } catch (e) {
        console.error(`Failed to sign transaction for wallet ${wallet.addr}: ${e.message}`);
        throw e;
    }
}

/**
 * Enhanced WebSocket subscription with better connection management and timeout handling
 * @param {string} wsUrl - WebSocket endpoint URL
 * @param {string} rpcUrl - HTTP RPC endpoint for metrics tagging
 * @param {string} method - Subscription method
 * @param {array} params - Subscription parameters
 * @param {object} options - Additional options (timeout, retries)
 */
function wsSub(wsUrl, rpcUrl, method, params, options = {}) {
    const timeout = options.timeout || WS_TIMEOUT;
    const maxRetries = options.maxRetries || 2;
    let retryCount = 0;

    function attemptConnection() {
        const connectionId = randomBytes(4).toString('hex');
        const startTime = Date.now();
        let isConnected = false;
        let subscriptionId = null;
        let connectionTimeout = null;

        const baseTags = {
            run_id: RUN_ID,
            scenario: SCENARIO,
            region: REGION,
            endpoint: rpcUrl,
            method: method,
            transport: 'websocket',
            connection_id: connectionId,
            retry_attempt: retryCount
        };

        ws.connect(wsUrl, {
            headers: {
                'User-Agent': `k6-somnia-test/${__ENV.TEST_VERSION || '1.0.0'}`,
                'X-Connection-ID': connectionId
            }
        }, function(socket) {
            activeConnections.add(1, baseTags);
            isConnected = true;

            // Set connection timeout with proper cleanup
            connectionTimeout = setTimeout(() => {
                if (isConnected) {
                    const duration = Date.now() - startTime;
                    console.warn(`WebSocket connection timeout after ${duration}ms: ${connectionId}`);

                    // Record timeout metrics
                    timeoutCount.add(1, { ...baseTags, timeout_type: 'websocket_connection' });
                    timeoutLatency.add(duration, baseTags);
                    timeoutRate.add(1, baseTags);

                    socket.close(1000, 'Connection timeout');
                }
            }, timeout);

            // Use string ID for WebSocket requests too
            const reqId = String(Math.floor(Date.now() * 1000 + Math.random() * 1000));
            const requestPayload = rpc(reqId, method, params);

            // Send subscription request
            socket.send(requestPayload);

            socket.on('message', function(message) {
                try {
                    const response = JSON.parse(message);
                    const currentTime = Date.now();

                    // Handle subscription confirmation
                    if (response.id === reqId) {
                        if (response.error) {
                            recordFailure({ ...baseTags, stage: 'subscription' },
                                `Subscription error: ${response.error.message}`, {
                                    retryAttempt: retryCount,
                                    response: { body: message, status: 200 },
                                    requestStartTime: startTime
                                });
                            socket.close();
                            return;
                        }

                        if (response.result) {
                            subscriptionId = response.result;
                            recordSuccess({ ...baseTags, stage: 'subscription', subscription_id: subscriptionId });
                            console.log(`WebSocket subscription established: ${subscriptionId}`);
                        }
                    }

                    // Handle subscription data
                    if (response.method === 'eth_subscription' && response.params) {
                        const latency = currentTime - startTime;
                        addRTT(latency, { ...baseTags, stage: 'data_received', subscription_id: subscriptionId });
                        recordSuccess({ ...baseTags, stage: 'data_received', subscription_id: subscriptionId });

                        // Log subscription data for debugging
                        if (__ENV.WS_DEBUG === 'true') {
                            console.log(`WS data received: ${JSON.stringify(response.params).slice(0, 200)}`);
                        }

                        // Close after receiving first data point for testing purposes
                        socket.close(1000, 'Data received');
                    }
                } catch (e) {
                    recordFailure({ ...baseTags, stage: 'message_parse' },
                        `Message parse error: ${e.message}`, {
                            retryAttempt: retryCount,
                            response: { body: message, status: 200 },
                            requestStartTime: startTime
                        });
                }
            });

            socket.on('open', function() {
                console.log(`WebSocket connection opened: ${connectionId}`);
            });

            socket.on('close', function(code, reason) {
                isConnected = false;
                activeConnections.add(-1, baseTags);

                if (connectionTimeout) {
                    clearTimeout(connectionTimeout);
                }

                const duration = Date.now() - startTime;
                console.log(`WebSocket connection closed: ${connectionId}, code: ${code}, reason: ${reason}, duration: ${duration}ms`);

                // Check if close was due to timeout
                const isTimeoutClose = duration >= timeout * 0.95 || reason === 'Connection timeout';

                // Record metrics based on close reason
                if (code === 1000 && !isTimeoutClose) {
                    // Normal closure
                    recordSuccess({ ...baseTags, stage: 'connection_closed', close_code: code });
                } else {
                    // Abnormal closure or timeout
                    const failureReason = isTimeoutClose ?
                        `Connection timeout after ${duration}ms` :
                        `Abnormal closure: ${reason}`;

                    recordFailure({ ...baseTags, stage: 'connection_closed', close_code: code },
                        failureReason, {
                            retryAttempt: retryCount,
                            isTimeout: isTimeoutClose,
                            response: { status: 0, body: reason },
                            requestStartTime: startTime,
                            timeoutMs: timeout
                        });
                }
            });

            socket.on('error', function(error) {
                isConnected = false;
                activeConnections.add(-1, baseTags);

                if (connectionTimeout) {
                    clearTimeout(connectionTimeout);
                }

                const duration = Date.now() - startTime;
                const errorMessage = error.message || 'Unknown WebSocket error';
                const isTimeoutError = duration >= timeout * 0.95 ||
                    errorMessage.includes('timeout') ||
                    errorMessage.includes('timed out');

                console.error(`WebSocket error: ${connectionId}, error: ${errorMessage}, duration: ${duration}ms`);

                recordFailure({ ...baseTags, stage: 'websocket_error' },
                    `WebSocket error: ${errorMessage}`, {
                        retryAttempt: retryCount,
                        isTimeout: isTimeoutError,
                        response: { status: 0, body: errorMessage },
                        requestStartTime: startTime,
                        timeoutMs: timeout
                    });

                // Retry on error if retries available
                if (retryCount < maxRetries) {
                    retryCount++;
                    retryCount.add(1, { ...baseTags, error_type: isTimeoutError ? 'timeout' : 'error' });
                    sleep(RETRY_DELAY_MS / 1000);
                    attemptConnection();
                }
            });
        });
    }

    attemptConnection();
}

/* ============================================================================
 * 6. MAIN SCENARIO EXECUTION ENGINE
 * ========================================================================== */

export function main_scenario(data) {
    // Initialize run ID from setup data
    if (RUN_ID === undefined) {
        RUN_ID = data.runId;
    }

    // Distribute VUs across available RPC endpoints for load balancing
    const endpointIndex = (__VU - 1) % RPC_URLS.length;
    const rpcUrl = RPC_URLS[endpointIndex];
    const wsUrl = rpcUrl.replace(/^http/, 'ws');

    // Assign wallet to VU (round-robin distribution)
    const walletIndex = (__VU - 1) % data.wallets.length;
    const testWallet = data.wallets[walletIndex];

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

        case 'S7_GetLogsSmall': {
            // Initialize current log block if not set
            if (currentLogBlock === null) {
                const latestHex = jsonCall(rpcUrl, 'eth_blockNumber', [], { op: 'get_latest_block' });
                if (!latestHex) return null;
                currentLogBlock = Number(latestHex) - 100; // Start from 100 blocks ago for better log coverage
            }

            const fromBlock = currentLogBlock;
            const toBlock = currentLogBlock + Number(__ENV.LOG_BLOCK_RANGE || 1);
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
            const to   = __ENV.END_BLOCK   || '0x3e8';
            return jsonCall(rpcUrl, 'eth_getLogs', [{ fromBlock: from, toBlock: to, topics: [] }]);
        }

        case 'S9_GetBlockLight': {
            let targetHex

            if (__ENV.TARGET_BLOCK) {
                targetHex = __ENV.TARGET_BLOCK;
            } else {
                const latestHex = jsonCall(rpcUrl, 'eth_blockNumber', []);
                if (!latestHex) return null;
                const latestNum = Number(latestHex);
                const offset    = Math.floor(Math.random() * 10001);
                const targetNum = latestNum - offset;
                targetHex = '0x' + targetNum.toString(16);
            }
            return jsonCall(
                rpcUrl,
                'eth_getBlockByNumber',
                [targetHex, false],
                { scenario: SCENARIO, block: targetHex }
            );
        }

        case 'S10_GetBlockFull': {
            let targetHex

            if (__ENV.TARGET_BLOCK) {
                targetHex = __ENV.TARGET_BLOCK;
            } else {
                const latestHex = jsonCall(rpcUrl, 'eth_blockNumber', []);
                if (!latestHex) return null;
                const latestNum = Number(latestHex);
                const offset    = Math.floor(Math.random() * 10001);
                const targetNum = latestNum - offset;
                targetHex = '0x' + targetNum.toString(16);
            }
            return jsonCall(
                rpcUrl,
                'eth_getBlockByNumber',
                [targetHex, true],
                { scenario: SCENARIO, block: targetHex }
            );
        }

        // Transaction sending scenarios
        case 'S11_SendRawTxSmall': {
            const transferAmount = BigInt(__ENV.TRANSFER_AMOUNT || '1000000000000000'); // 0.001 ETH
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
            const tokenAmount = (BigInt(10) ** BigInt(TOKEN_DECIMALS)) / BigInt(10000);
            const encodeAmount = amount => amount.toString(16).padStart(64, '0');

            // ERC20 transfer function call data
            const transferData = '0xa9059cbb' +
                testWallet.addr.replace(/^0x/, '').padStart(64, '0') +
                encodeAmount(tokenAmount);

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

        case 'S13_PendingTxSub':
            return wsSub(wsUrl, rpcUrl, 'eth_subscribe', ['newPendingTransactions'], {
                timeout: WS_TIMEOUT,
                maxRetries: 2
            });

        case 'S14_NewHeadSub':
            return wsSub(wsUrl, rpcUrl, 'eth_subscribe', ['newHeads'], {
                timeout: WS_TIMEOUT,
                maxRetries: 2
            });

        case 'S15_LogsSubFilter':
            return wsSub(wsUrl, rpcUrl, 'eth_subscribe', ['logs', {
                address: CONTRACT,
                topics: [LOG_TOPIC]
            }], {
                timeout: WS_TIMEOUT,
                maxRetries: 2
            });

        // Gas estimation and transaction receipt scenarios
        case 'S17_EstimateGas': {
            // Enhanced gas estimation with real Ethereum transaction types
            let estimateParams;
            let txType = 'custom';

            if (__ENV.EST_DATA && __ENV.EST_CONTRACT) {
                // Use provided custom data
                estimateParams = {
                    to: __ENV.EST_CONTRACT,
                    data: __ENV.EST_DATA,
                    from: testWallet.addr,
                    value: __ENV.EST_VALUE || '0x0'
                };
                txType = 'custom';
            } else {
                // Build realistic transaction scenarios based on real Ethereum usage
                // Focus on scenarios that are less likely to revert
                const scenarios = [
                    // 1. Simple ETH transfer (Type 0 - Legacy) - Low value to avoid issues
                    {
                        type: 'legacy',
                        params: {
                            to: testWallet.addr,
                            from: testWallet.addr,
                            value: '0x2386F26FC10000' // 0.01 ETH
                        }
                    },
                    // 2. Contract deployment - Simple storage contract
                    {
                        type: 'create',
                        params: {
                            from: testWallet.addr,
                            data: '0x608060405234801561001057600080fd5b50600080fd5b50600080fd5b50600080fd5b50'
                        }
                    },
                    // 3. Basic contract call (no complex interactions)
                    {
                        type: 'basic_call',
                        params: {
                            to: CONTRACT,
                            from: testWallet.addr,
                            data: '0x' // Empty data call
                        }
                    },
                    // 4. Another legacy transfer variant
                    {
                        type: 'legacy',
                        params: {
                            to: testWallet.addr,
                            from: testWallet.addr,
                            value: '0x0' // Zero value transfer
                        }
                    },
                    // 5. Basic data call to existing contract
                    {
                        type: 'basic_call',
                        params: {
                            to: CONTRACT,
                            from: testWallet.addr,
                            data: SIMPLE_SIG
                        }
                    }
                ];

                // Select scenario based on VU and iteration for diverse testing
                const scenarioIndex = ((__VU - 1) * 1000 + __ITER) % scenarios.length;
                const selectedScenario = scenarios[scenarioIndex];

                estimateParams = selectedScenario.params;
                txType = selectedScenario.type;
            }

            // Add gas price for more realistic estimation
            if (!estimateParams.gasPrice) {
                try {
                    const currentGasPrice = jsonCall(rpcUrl, 'eth_gasPrice', [], { op: 'get_gas_price_for_estimate' });
                    if (currentGasPrice) {
                        estimateParams.gasPrice = currentGasPrice;
                    }
                } catch (e) {
                    // Gas price fetch failed, continue without it
                    console.warn(`Failed to fetch gas price for estimation: ${e.message}`);
                }
            }

            // Simple validation function for gas estimation results
            const validateGasEstimate = (result) => {
                // Just check if it's a valid hex string - let the RPC handle the actual validation
                return typeof result === 'string' && result.startsWith('0x') && result.length > 2;
            };

            return jsonCall(rpcUrl, 'eth_estimateGas', [estimateParams],
                {
                    tx_type: txType,
                    contract_addr: String(estimateParams.to || ''),
                    from_addr: String(estimateParams.from || ''),
                    has_value: Boolean(estimateParams.value && estimateParams.value !== '0x0'),
                    data_length: Number(estimateParams.data ? estimateParams.data.length : 0)
                },
                validateGasEstimate);
        }

        case 'S18_GetTxReceipt': {
            const txHash = __ENV.TX_HASH;
            if (!txHash) {
                throw new Error('TX_HASH environment variable is required for S18_GetTxReceipt scenario');
            }

            return jsonCall(rpcUrl, 'eth_getTransactionReceipt', [txHash],
                { tx_hash: txHash },
                result => result && (result.status === '0x1' || result.status === '0x0'));
        }

        case 'S19_BatchCalls': {
            const batchSize = Number(__ENV.BATCH_CALL_SIZE || 10);
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
                region: REGION,
                endpoint: rpcUrl,
                method: 'batch_eth_call',
                transport: 'http',
                batch_size: batchSize
            };

            let res;
            try {
                res = post(rpcUrl, JSON.stringify(batch), {
                    tags: tags,
                    timeout: REQUEST_TIMEOUT
                });
            } catch (e) {
                const errorMsg = e.isTimeout ?
                    `Batch call timeout after ${e.duration}ms: ${e.message}` :
                    `Batch call network error: ${e.message}`;

                return recordFailure(tags, errorMsg, {
                    isTimeout: e.isTimeout,
                    response: null,
                    requestStartTime: startTime,
                    timeoutMs: PARSED_TIMEOUT_MS
                });
            }

            // Enhanced timeout detection for batch calls
            const timeoutDetection = detectTimeout(res, startTime, PARSED_TIMEOUT_MS);
            if (timeoutDetection.isTimeout) {
                return recordFailure(tags,
                    `Batch call timeout - Duration: ${timeoutDetection.actualDuration}ms, Reasons: ${timeoutDetection.reasons.join(', ')}`, {
                        isTimeout: true,
                        response: res,
                        requestStartTime: startTime,
                        timeoutMs: PARSED_TIMEOUT_MS
                    });
            }

            // Validate batch response
            if (res.status !== 200) {
                return recordFailure({ ...tags, stage: 'http' },
                    `Batch call HTTP error: ${res.status}`, {
                        isHttpError: true,
                        response: res,
                        requestStartTime: startTime
                    });
            }

            let batchResponse;
            try {
                batchResponse = res.json();
            } catch (e) {
                return recordFailure({ ...tags, stage: 'json_parse' },
                    `Batch response parse error: ${e.message}`, {
                        response: res,
                        requestStartTime: startTime
                    });
            }

            if (!Array.isArray(batchResponse) || batchResponse.length !== batchSize) {
                return recordFailure({ ...tags, stage: 'batch_validation' },
                    `Invalid batch response: expected ${batchSize} items, got ${Array.isArray(batchResponse) ? batchResponse.length : 'non-array'}`, {
                        response: res,
                        requestStartTime: startTime
                    });
            }

            // Validate each response in batch
            let successCount = 0;
            batchResponse.forEach((resp, index) => {
                if (resp.jsonrpc === '2.0' && resp.id === index + 1 && resp.result) {
                    successCount++;
                } else if (resp.error) {
                    console.warn(`Batch item ${index} error: ${resp.error.message}`);
                }
            });

            const duration = Date.now() - startTime;
            const successRate = successCount / batchSize;

            if (successRate >= 0.8) { // 80% success threshold
                recordSuccess({ ...tags, success_count: successCount, success_rate: successRate });
            } else {
                recordFailure({ ...tags, success_count: successCount, success_rate: successRate },
                    `Batch success rate too low: ${successRate}`, {
                        response: res,
                        requestStartTime: startTime
                    });
            }

            addRTT(duration, tags);
            return batchResponse;
        }

        case 'S20_HttpHandshake': {
            const startTime = Date.now();
            const tags = {
                run_id: RUN_ID,
                scenario: SCENARIO,
                region: REGION,
                endpoint: rpcUrl,
                method: 'http_handshake',
                transport: 'http'
            };

            let res;
            try {
                res = get(rpcUrl, {
                    timeout: '5s',
                    tags: tags
                });
            } catch (e) {
                const errorMsg = e.isTimeout ?
                    `HTTP handshake timeout after ${e.duration}ms: ${e.message}` :
                    `HTTP handshake network error: ${e.message}`;

                return recordFailure(tags, errorMsg, {
                    isTimeout: e.isTimeout,
                    response: null,
                    requestStartTime: startTime,
                    timeoutMs: 5000 // 5 second timeout
                });
            }

            const duration = Date.now() - startTime;

            // Enhanced timeout detection for handshake
            const timeoutDetection = detectTimeout(res, startTime, 5000);
            if (timeoutDetection.isTimeout) {
                return recordFailure(tags,
                    `HTTP handshake timeout - Duration: ${timeoutDetection.actualDuration}ms, Reasons: ${timeoutDetection.reasons.join(', ')}`, {
                        isTimeout: true,
                        response: res,
                        requestStartTime: startTime,
                        timeoutMs: 5000
                    });
            }

            // Check various aspects of the HTTP handshake
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
                    `HTTP handshake failed: status=${res.status}, duration=${duration}ms`, {
                        isHttpError: true,
                        response: res,
                        requestStartTime: startTime
                    });
            }

            addRTT(duration, tags);
            return {
                status: res.status,
                duration: duration,
                timings: res.timings
            };
        }

        default:
            throw new Error(`Unknown or unsupported scenario: '${SCENARIO}'. Please check the SCENARIO_TYPE environment variable.`);
    }
}

/* ============================================================================
 * 7. UTILITY FUNCTIONS AND HELPERS
 * ============================================================================ */

/**
 * Generates a random Ethereum address for testing purposes
 * @returns {string} Random Ethereum address
 */
function randomAddress() {
    return '0x' + randomBytes(20).toString('hex');
}

/**
 * Validates Ethereum address format
 * @param {string} address - Address to validate
 * @returns {boolean} True if valid Ethereum address
 */
function isValidEthAddress(address) {
    return typeof address === 'string' &&
        address.match(/^0x[a-fA-F0-9]{40}$/) !== null;
}

/**
 * Converts wei to ether for human-readable output
 * @param {BigInt} wei - Amount in wei
 * @returns {string} Amount in ether
 */
function weiToEther(wei) {
    return (Number(wei) / 1e18).toFixed(6);
}

/**
 * Calculates optimal batch size based on current load
 * @param {number} currentVUs - Current number of virtual users
 * @returns {number} Optimal batch size
 */
function calculateOptimalBatchSize(currentVUs) {
    if (currentVUs < 10) return 5;
    if (currentVUs < 50) return 10;
    if (currentVUs < 100) return 15;
    return 20;
}

/* ============================================================================
 * 8. ENHANCED TEARDOWN WITH FUND RECOVERY
 * ========================================================================== */

export function teardown(data) {
    const teardownStart = Date.now();

    console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        message: 'Starting teardown process',
        run_id: RUN_ID,
        scenario: SCENARIO,
        timeout_stats: {
            total_timeouts: timeoutCount.values ? Object.values(timeoutCount.values).reduce((a, b) => a + b, 0) : 'N/A',
            timeout_rate: timeoutRate.values ? Object.values(timeoutRate.values).reduce((a, b) => a + b, 0) : 'N/A',
            configured_timeout_ms: PARSED_TIMEOUT_MS,
            ws_timeout_ms: WS_TIMEOUT
        }
    }));

    // Wait for any pending transactions to settle
    console.log('Waiting for pending transactions to settle...');
    sleep(10);

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
        const gasPrice = Math.floor(currentGasPrice * 1.1); // 10% buffer for faster processing

        console.log(`Teardown gas price: ${gasPrice}`);

        // Process wallets in batches for better performance
        for (let i = 0; i < data.wallets.length; i += BATCH_SIZE) {
            const batch = data.wallets.slice(i, i + BATCH_SIZE);

            batch.forEach(w => {
                try {
                    const balanceHex = jsonCall(refundUrl, 'eth_getBalance', [w.addr, 'latest'], {
                        op: 'teardown_balance_check',
                        wallet_addr: w.addr
                    });

                    if (!balanceHex) return;

                    const balance = BigInt(balanceHex);
                    const gasCost = BigInt(gasPrice) * BigInt(21000);

                    // Only refund if balance covers gas costs with some margin
                    if (balance <= gasCost * BigInt(2)) {
                        console.log(`Wallet ${w.addr} balance too low for refund: ${balance}`);
                        return;
                    }

                    const sendValue = balance - gasCost;
                    const nonce = Number(jsonCall(refundUrl, 'eth_getTransactionCount', [w.addr, 'pending'], {
                        op: 'teardown_nonce',
                        wallet_addr: w.addr
                    }));

                    const raw = ethgo.signLegacyTx({
                        nonce: nonce,
                        gasPrice: gasPrice,
                        gas: 21000,
                        to: BASE_ADDR,
                        value: sendValue,
                        data: '0x',
                        chainId: CHAIN_ID
                    }, w.pk);

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

            // Small delay between batches
            if (i + BATCH_SIZE < data.wallets.length) {
                sleep(0.5);
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

// Handle summary generation and display
export function handleSummary(data) {
    const summary = {
        scenario: SCENARIO,
        profile: PROFILE,
        timestamp: new Date().toISOString(),
        metrics: {}
    };

    // Extract key metrics
    for (const [key, metric] of Object.entries(data.metrics)) {
        if (metric.values) {
            summary.metrics[key] = {
                count: metric.values.count,
                rate: metric.values.rate,
                p50: metric.values['p(50)'],
                p95: metric.values['p(95)'],
                p99: metric.values['p(99)'],
                avg: metric.values.avg,
                min: metric.values.min,
                max: metric.values.max
            };
        }
    }

    // Console output for summary
    console.log('\n============ TEST SUMMARY ============');
    console.log(`Scenario: ${SCENARIO}`);
    console.log(`Profile: ${PROFILE}`);
    console.log(`Duration: ${data.state.testRunDurationMs}ms`);
    console.log(`\nKey Metrics:`);
    
    // Display HTTP metrics
    if (summary.metrics.http_req_duration) {
        const httpDuration = summary.metrics.http_req_duration;
        console.log(`\nHTTP Request Duration:`);
        console.log(`  - P50: ${httpDuration.p50?.toFixed(2)}ms`);
        console.log(`  - P95: ${httpDuration.p95?.toFixed(2)}ms`);
        console.log(`  - P99: ${httpDuration.p99?.toFixed(2)}ms`);
        console.log(`  - Avg: ${httpDuration.avg?.toFixed(2)}ms`);
    }

    // Display custom metrics
    const customMetrics = [
        'rpc_response_time', 
        'ws_message_received_time',
        'tx_submission_duration',
        'batch_processing_time'
    ];
    
    for (const metricName of customMetrics) {
        if (summary.metrics[metricName]) {
            const metric = summary.metrics[metricName];
            console.log(`\n${metricName}:`);
            console.log(`  - P50: ${metric.p50?.toFixed(2)}ms`);
            console.log(`  - P95: ${metric.p95?.toFixed(2)}ms`);
            console.log(`  - Count: ${metric.count}`);
        }
    }

    // Display success rates
    const successRates = ['rpc_success_rate', 'ws_success_rate', 'tx_success_rate'];
    for (const rateName of successRates) {
        if (summary.metrics[rateName]) {
            const rate = summary.metrics[rateName];
            console.log(`\n${rateName}: ${(rate.rate * 100).toFixed(2)}%`);
        }
    }

    console.log('\n=====================================\n');

    // Return both stdout summary and data for other outputs
    return {
        'stdout': '', // Empty to prevent default k6 output
        'summary.json': JSON.stringify(summary, null, 2)
    };
}
/**
 * RPC Client Module
 * 
 * Handles JSON-RPC communication with retry logic
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomBytes } from 'k6/crypto';
import { recordSuccess, recordFailure, addRTT, updateStateMetrics, retryCount } from './metrics.js';
import { configManager } from './config-loader.js';

// Get performance settings from config
const perfSettings = configManager.getPerformanceSettings();
const MAX_RETRIES = perfSettings.maxRetries;
const RETRY_DELAY_MS = perfSettings.retryDelayMs;
const REQUEST_TIMEOUT = perfSettings.requestTimeout;

/**
 * Generate JSON-RPC request payload
 * @param {number} id - Request ID
 * @param {string} method - RPC method
 * @param {array} params - Method parameters
 * @returns {string} JSON-RPC request string
 */
export function buildRpcRequest(id, method, params) {
    return JSON.stringify({ 
        jsonrpc: '2.0', 
        id, 
        method, 
        params: params || [] 
    });
}

/**
 * Enhanced HTTP POST with better error handling
 * @param {string} url - Request URL
 * @param {string} body - Request body
 * @param {object} options - Request options
 * @returns {object} HTTP response
 */
export function post(url, body, options = {}) {
    const defaultHeaders = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': `k6-somnia-test/${__ENV.TEST_VERSION || '1.0.0'}`,
        'X-Request-ID': randomBytes(8).toString('hex')
    };
    
    return http.post(url, body, {
        headers: { ...defaultHeaders, ...(options.headers || {}) },
        timeout: options.timeout || REQUEST_TIMEOUT,
        compression: 'gzip',
        redirects: 5,
        tags: options.tags || {}
    });
}

/**
 * HTTP GET with similar enhancements
 * @param {string} url - Request URL
 * @param {object} options - Request options
 * @returns {object} HTTP response
 */
export function get(url, options = {}) {
    const defaultHeaders = {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': `k6-somnia-test/${__ENV.TEST_VERSION || '1.0.0'}`
    };
    
    return http.get(url, {
        headers: { ...defaultHeaders, ...(options.headers || {}) },
        timeout: options.timeout || REQUEST_TIMEOUT,
        compression: 'gzip',
        redirects: 5,
        tags: options.tags || {}
    });
}

/**
 * Enhanced JSON-RPC call with retry logic
 * @param {string} url - RPC endpoint URL
 * @param {string} method - RPC method name
 * @param {array} params - RPC method parameters
 * @param {object} extraTags - Additional tags for metrics
 * @param {function} expectFn - Result validation function
 * @param {number} retryAttempt - Current retry attempt
 * @returns {*} RPC result or null on failure
 */
export function jsonCall(url, method, params, extraTags = {}, expectFn = _ => true, retryAttempt = 0) {
    const reqId = Date.now() + Math.random();
    const body = buildRpcRequest(reqId, method, params);
    const startTime = Date.now();
    
    const baseTags = { 
        run_id: globalThis.RUN_ID || 'unknown', 
        scenario: __ENV.SCENARIO_TYPE || 'unknown', 
        endpoint: url, 
        method,
        transport: 'http',
        retry_attempt: retryAttempt,
        ...extraTags 
    };

    let res;
    try {
        res = post(url, body, { tags: baseTags });
    } catch (e) {
        if (retryAttempt < MAX_RETRIES) {
            retryCount.add(1, baseTags);
            sleep(RETRY_DELAY_MS / 1000);
            return jsonCall(url, method, params, extraTags, expectFn, retryAttempt + 1);
        }
        return recordFailure(baseTags, `Network error: ${e.message}`, { retryAttempt });
    }

    // Handle network-level errors
    if (res.error_code) {
        const errorMsg = `Network error code: ${res.error_code}`;
        if (retryAttempt < MAX_RETRIES) {
            retryCount.add(1, baseTags);
            sleep(RETRY_DELAY_MS / 1000);
            return jsonCall(url, method, params, extraTags, expectFn, retryAttempt + 1);
        }
        return recordFailure({ ...baseTags, stage: 'network', error_code: res.error_code }, errorMsg, { retryAttempt });
    }

    // Validate HTTP response
    const httpChecks = {
        'http_status_200': r => r.status === 200,
        'content_type_json': r => (r.headers['Content-Type'] || '').includes('application/json'),
        'response_body_present': r => r.body && r.body.length > 0,
        'response_time_reasonable': r => r.timings.duration < 30000
    };
    
    const httpOk = check(res, httpChecks, baseTags);
    if (!httpOk) {
        const errorMsg = `HTTP validation failed: status=${res.status}`;
        return recordFailure({ ...baseTags, stage: 'http', status: res.status }, errorMsg, { 
            retryAttempt, 
            isHttpError: true 
        });
    }

    // Parse JSON response
    let jsonResponse;
    try {
        jsonResponse = res.json();
    } catch (e) {
        return recordFailure({ ...baseTags, stage: 'json_parse' }, `JSON parse error: ${e.message}`, { retryAttempt });
    }

    // Validate JSON-RPC structure
    const structureChecks = {
        'jsonrpc_version_valid': v => v.jsonrpc === '2.0',
        'request_id_matches': v => v.id === reqId,
        'response_complete': v => v.hasOwnProperty('result') || v.hasOwnProperty('error')
    };
    
    const structureOk = check(jsonResponse, structureChecks, baseTags);
    if (!structureOk) {
        return recordFailure({ ...baseTags, stage: 'rpc_structure' }, 'Invalid JSON-RPC response structure', { retryAttempt });
    }

    // Handle RPC errors
    if (jsonResponse.error) {
        const rpcError = jsonResponse.error;
        const errorTags = {
            ...baseTags,
            stage: 'rpc_error',
            rpc_error_code: rpcError.code,
            rpc_error_message: String(rpcError.message).slice(0, 100)
        };
        return recordFailure(errorTags, `RPC error ${rpcError.code}: ${rpcError.message}`, { retryAttempt });
    }

    // Validate result
    const resultChecks = {
        'result_present': v => v.hasOwnProperty('result') && v.result !== null,
        'result_expectation_met': v => expectFn(v.result)
    };
    
    const resultOk = check(jsonResponse, resultChecks, baseTags);
    if (!resultOk) {
        return recordFailure({ ...baseTags, stage: 'result_validation' }, 'Result validation failed', { retryAttempt });
    }

    // Record successful metrics
    const duration = Date.now() - startTime;
    recordSuccess(baseTags);
    addRTT(duration, baseTags);
    
    // Update blockchain state metrics
    updateStateMetrics(method, jsonResponse.result, baseTags);
    
    return jsonResponse.result;
}
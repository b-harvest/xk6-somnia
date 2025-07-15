/**
 * Metrics Module
 * 
 * Handles all k6 metrics creation and management
 */

import { Trend, Counter, Rate, Gauge } from 'k6/metrics';

// Core performance metrics
export const rtt = new Trend('somnia_http_rtt', true);
export const rpcLatency = new Trend('somnia_rpc_latency', true);
export const wsLatency = new Trend('somnia_ws_latency', true);

// Success/failure counters
export const successCount = new Counter('somnia_success_count');
export const errorCount = new Counter('somnia_error_count');
export const retryCount = new Counter('somnia_retry_count');

// Rate metrics
export const errorRate = new Rate('somnia_error_rate');
export const timeoutRate = new Rate('somnia_timeout_rate');
export const httpErrorRate = new Rate('somnia_http_error_rate');

// Gauges for real-time monitoring
export const activeConnections = new Gauge('somnia_active_ws_connections');
export const currentBlockHeight = new Gauge('somnia_current_block_height');
export const gasPrice = new Gauge('somnia_current_gas_price');

// Method-specific metrics
export const methodLatency = new Trend('somnia_method_latency', true);
export const methodSuccess = new Counter('somnia_method_success');
export const methodErrors = new Counter('somnia_method_errors');

/**
 * Add round-trip time metric
 * @param {number} ms - Duration in milliseconds
 * @param {object} tags - Metric tags
 */
export function addRTT(ms, tags) {
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

/**
 * Record successful operation
 * @param {object} tags - Metric tags
 */
export function recordSuccess(tags) {
    successCount.add(1, tags);
    if (tags.method) {
        methodSuccess.add(1, tags);
    }
}

/**
 * Record failed operation with detailed metrics
 * @param {object} tags - Base tags for metrics
 * @param {string} reason - Failure reason message
 * @param {object} options - Additional options (retry info, etc.)
 */
export function recordFailure(tags, reason, options = {}) {
    const enrichedTags = { 
        ...tags, 
        reason: reason.slice(0, 100), // Limit reason length
        retry_attempt: options.retryAttempt || 0
    };
    
    errorCount.add(1, enrichedTags);
    errorRate.add(1, enrichedTags);
    
    if (tags.method) {
        methodErrors.add(1, enrichedTags);
    }
    
    if (options.isTimeout) {
        timeoutRate.add(1, enrichedTags);
    }
    
    if (options.isHttpError) {
        httpErrorRate.add(1, enrichedTags);
    }
    
    // Log with structured format for better observability
    console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        scenario: tags.scenario,
        method: tags.method,
        endpoint: tags.endpoint,
        reason: reason,
        tags: enrichedTags
    }));
}

/**
 * Update blockchain state metrics
 * @param {string} method - RPC method name
 * @param {*} result - RPC result
 * @param {object} tags - Metric tags
 */
export function updateStateMetrics(method, result, tags) {
    if (method === 'eth_blockNumber' && result) {
        currentBlockHeight.add(Number(result), tags);
    }
    if (method === 'eth_gasPrice' && result) {
        gasPrice.add(Number(result), tags);
    }
}

/**
 * Metrics module exports
 */
export default {
    // Metrics
    rtt,
    rpcLatency,
    wsLatency,
    successCount,
    errorCount,
    retryCount,
    errorRate,
    timeoutRate,
    httpErrorRate,
    activeConnections,
    currentBlockHeight,
    gasPrice,
    methodLatency,
    methodSuccess,
    methodErrors,
    
    // Functions
    addRTT,
    recordSuccess,
    recordFailure,
    updateStateMetrics
};
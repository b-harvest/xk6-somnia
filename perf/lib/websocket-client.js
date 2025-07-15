/**
 * WebSocket Client Module
 * 
 * Handles WebSocket subscriptions with connection management
 */

import ws from 'k6/ws';
import { sleep } from 'k6';
import { randomBytes } from 'k6/crypto';
import { 
    recordSuccess, 
    recordFailure, 
    addRTT, 
    activeConnections,
    retryCount 
} from './metrics.js';
import { buildRpcRequest } from './rpc-client.js';
import { configManager } from './config-loader.js';

// Get performance settings
const perfSettings = configManager.getPerformanceSettings();
const WS_TIMEOUT = perfSettings.wsTimeout;
const RETRY_DELAY_MS = perfSettings.retryDelayMs;

/**
 * WebSocket subscription with connection management
 * @param {string} wsUrl - WebSocket endpoint URL
 * @param {string} rpcUrl - HTTP RPC endpoint for metrics
 * @param {string} method - Subscription method
 * @param {array} params - Subscription parameters
 * @param {object} options - Additional options
 */
export function wsSub(wsUrl, rpcUrl, method, params, options = {}) {
    const timeout = options.timeout || WS_TIMEOUT;
    const maxRetries = options.maxRetries || 2;
    let retryAttempt = 0;
    
    function attemptConnection() {
        const connectionId = randomBytes(4).toString('hex');
        const startTime = Date.now();
        let isConnected = false;
        let subscriptionId = null;
        
        const baseTags = {
            run_id: globalThis.RUN_ID || 'unknown',
            scenario: __ENV.SCENARIO_TYPE || 'unknown',
            endpoint: rpcUrl,
            method: method,
            transport: 'websocket',
            connection_id: connectionId,
            retry_attempt: retryAttempt
        };
        
        ws.connect(wsUrl, {
            headers: {
                'User-Agent': `k6-somnia-test/${__ENV.TEST_VERSION || '1.0.0'}`,
                'X-Connection-ID': connectionId
            }
        }, function(socket) {
            activeConnections.add(1, baseTags);
            isConnected = true;
            
            // Set connection timeout
            socket.setTimeout(() => {
                if (isConnected) {
                    socket.close(1000, 'Timeout reached');
                }
            }, timeout);
            
            const reqId = Date.now() + Math.random();
            const requestPayload = buildRpcRequest(reqId, method, params);
            
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
                                `Subscription error: ${response.error.message}`, { retryAttempt });
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
                        
                        // Close after receiving first data point for testing
                        socket.close(1000, 'Data received');
                    }
                } catch (e) {
                    recordFailure({ ...baseTags, stage: 'message_parse' }, 
                        `Message parse error: ${e.message}`, { retryAttempt });
                }
            });
            
            socket.on('open', function() {
                console.log(`WebSocket connection opened: ${connectionId}`);
            });
            
            socket.on('close', function(code, reason) {
                isConnected = false;
                activeConnections.add(-1, baseTags);
                
                const duration = Date.now() - startTime;
                console.log(`WebSocket connection closed: ${connectionId}, code: ${code}, reason: ${reason}, duration: ${duration}ms`);
                
                // Record metrics based on close reason
                if (code === 1000) {
                    recordSuccess({ ...baseTags, stage: 'connection_closed', close_code: code });
                } else {
                    recordFailure({ ...baseTags, stage: 'connection_closed', close_code: code }, 
                        `Abnormal closure: ${reason}`, { retryAttempt });
                }
            });
            
            socket.on('error', function(error) {
                isConnected = false;
                activeConnections.add(-1, baseTags);
                
                const errorMessage = error.message || 'Unknown WebSocket error';
                console.error(`WebSocket error: ${connectionId}, error: ${errorMessage}`);
                
                recordFailure({ ...baseTags, stage: 'websocket_error' }, 
                    `WebSocket error: ${errorMessage}`, { retryAttempt });
                
                // Retry on error if retries available
                if (retryAttempt < maxRetries) {
                    retryAttempt++;
                    retryCount.add(1, baseTags);
                    sleep(RETRY_DELAY_MS / 1000);
                    attemptConnection();
                }
            });
        });
    }
    
    attemptConnection();
}